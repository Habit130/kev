"""Batch runner for one named task preset: one fixed checkpoint, one state per input row.

    python -m kev.task --config .local/local-inference.json --task support-triage-0.8b \
        --input examples/local-inference/support.jsonl --out .local/verification/task-0.8b

The config file is the explicit local registry (kev.local). The task supplies the model and the questions; each
input row supplies one `state` (a string, or any JSON the encoder renders). Because the model is resolved once
from the task, no row can change the checkpoint for the invocation: a row that carries a `model` field is refused
rather than honoured, and the run's `task.json` records the actual checkpoint, base, source and revisions that
produced the answers, not the alias.

Every row is answered by the same canonical path the API uses (`kev.api.to_record` / `to_answers`, the model's
packed `probs_batch` and the task's questions), so a batch answer and a served answer are the same numbers.
Nothing here downloads anything: the registry must already point at complete local artifacts.
"""
import argparse
import json
import os
import sys
import time
from dataclasses import replace
from pathlib import Path

from .api import SystemOneRequest, output_tokens, to_answers, to_record
from .checkpoint import LoadOptions
from .device import allocated_bytes, default_device, sync
from .local import LocalConfigError, load_registry, resolve, verify_artifacts
from .model import admit

BATCH_ROWS = 8   # input rows per forward pass (a pass holds every row's state at once, so keep it small on a laptop)


def read_states(path):
    """-> (row index, state) for every non-blank JSONL line. `state` may be any JSON the encoder renders."""
    rows = []
    for number, line in enumerate(Path(path).read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            raise LocalConfigError(f"{path}:{number}: not valid JSON: {exc}") from exc
        if not isinstance(row, dict) or "state" not in row:
            raise LocalConfigError(f"{path}:{number}: every row needs a 'state' key")
        if "model" in row:
            raise LocalConfigError(f"{path}:{number}: a row may not select a model; the task {row.get('task')!r} fixes it for the whole batch")
        rows.append((number, row["state"]))
    if not rows:
        raise LocalConfigError(f"{path}: no input rows")
    return rows


def task_request(resolved, state):
    """The one request shape a task asks about a state: its questions, exactly as declared, and no per-row overrides."""
    return SystemOneRequest.model_validate({"model": resolved.model.id, "state": state, "questions": resolved.questions})


def _device_memory(device, model):
    """Bytes to report as this run's peak device memory.

    The MLX backend's buffers are not torch's, so torch's counters read 0 for it; MLX is asked directly
    (mx.get_peak_memory, a true peak since the process started). The torch backend reports its own peak/current counter
    through kev.device.allocated_bytes. Returns (bytes, definition), and (None, reason) when neither applies."""
    if getattr(model, "backend", "torch") == "mlx":
        try:
            import mlx.core as mx
        except ImportError:
            return None, "MLX reported no memory counter"
        return mx.get_peak_memory(), "mlx.core.get_peak_memory(): peak Metal memory since this process started"
    if device == "cpu":
        return None, "cpu: no device memory counter"
    peak = allocated_bytes(device)
    return peak, ("kev.device.allocated_bytes: MPS currently allocated / CUDA peak since start"
                  if peak else f"{device}: the counter reported 0 bytes (nothing device-resident was measured)")


def run(config, task_id, input_path, out_dir, limit=None, opts=None, device=None, batch=BATCH_ROWS, receipt=None):
    """Resolve the task once, load its checkpoint, and answer every input row with it. -> the run summary dict."""
    registry = load_registry(config)
    resolved = resolve(registry, task_id)
    verified = verify_artifacts(registry, receipt, task_id=task_id) if receipt else None
    states = read_states(input_path)
    if limit is not None:
        states = states[:limit]
    dev = device or default_device()
    if opts is None:
        opts = LoadOptions.from_env()
        if opts.backend is None:
            opts = replace(opts, backend="auto")   # the same serving default: MLX for a hybrid base on Apple Silicon
    opts = resolved.load_options(opts)
    print(f"task {task_id}: {resolved.model.id} checkpoint={resolved.checkpoint.path} base={resolved.base_path} "
          f"on {dev} (backend={opts.backend or 'torch'}, dtype={opts.dtype or 'the checkpoint default'})", flush=True)
    tok, model = resolved.checkpoint.load(dev, opts)

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    rows_path, answers_path, summary_path = out / "rows.jsonl", out / "answers.jsonl", out / "task.json"
    started = time.time()
    latencies = []
    # All three outputs are staged as sibling temp files and published together only after every row is answered, so a
    # run that fails on a later chunk (an over-length state, an out-of-memory pass) leaves the previous run's directory
    # exactly as it was, and a reader never sees new rows beside the previous run's summary (_AtomicOutputs).
    with _AtomicOutputs(rows_path, answers_path, summary_path) as (rows_file, answers_file, summary_file):
        for chunk in _batches(states, batch):
            reqs = [(number, state, task_request(resolved, state)) for number, state in chunk]
            # the canonical serving admission: a state over the serving context is refused (422-equivalent) here,
            # never silently truncated; each record is encoded once and the same encodings are scored.
            encs = [(admit(model, tok, rec), meta) for rec, meta in (to_record(req) for _, _, req in reqs)]
            # no prefix cache in batch mode: one pass per batch (None/False per row), every row the same questions
            # about its own state. The per-row lists must match encs: both backends zip and would answer nothing.
            sync(dev)
            t = time.time()
            probs = model.probs_batch([enc for enc, _ in encs], [None] * len(encs), [False] * len(encs))[0]
            sync(dev)
            latency_ms = round((time.time() - t) * 1000, 1)
            latencies.append(latency_ms)
            for (number, state, _), (enc, meta), p in zip(reqs, encs, probs):
                answers = to_answers(p, meta)
                body = {"model": resolved.model.id, "answers": answers,
                        "usage": {"input_tokens": len(enc["ids"]), "output_tokens": output_tokens(tok, answers)},
                        "latency_ms": latency_ms}
                rows_file.write(json.dumps({"row": number, "state": state, "answers": answers}, ensure_ascii=False) + "\n")
                answers_file.write(json.dumps({"row": number, **body}, ensure_ascii=False) + "\n")
        if not latencies:
            raise LocalConfigError(f"{input_path}: no state was answered; {out} was left as it was")
        peak_bytes, memory_definition = _device_memory(dev, model)
        summary = {
            "task": resolved.task.id, "model_id": resolved.model.id,
            "identity": resolved.card(backend=model.backend, dtype=model.dtype, device=dev, verified=verified),
            "device": dev, "backend": model.backend, "dtype": model.dtype,
            "temperature": model.head.temperature,
            "input": str(input_path), "rows": len(states), "output": str(out),
            "latency_ms": latencies, "wall_ms": round((time.time() - started) * 1000, 1),
            "latency_definition": "per batch: wall clock around the device-synchronised forward pass (no queue wait)",
            "peak_device_bytes": peak_bytes, "memory_definition": memory_definition,
        }
        summary_file.write(json.dumps(summary, indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {rows_path} ({len(states)} rows) and {summary_path}", flush=True)
    return summary


class _AtomicOutputs:
    """`with _AtomicOutputs(*paths) as handles:` — write to sibling temp files, publish every file on a clean exit
    (one os.replace each, rows before the summary, because the caller passes them in that order), discard them on any
    exception including KeyboardInterrupt. A reader therefore sees either the previous run's set or the new one."""

    def __init__(self, *paths):
        self.paths = [Path(p) for p in paths]
        self.tmp = [p.with_name(f".{p.name}.partial") for p in self.paths]
        self.handles = []

    def __enter__(self):
        self.handles = [p.open("w", encoding="utf-8") for p in self.tmp]
        return tuple(self.handles)

    def __exit__(self, exc_type, exc, tb):
        for handle in self.handles:
            handle.close()
        self.handles = []
        if exc_type is None:
            # the last path is the summary: unlink it first, so an interruption between the two row renames cannot leave
            # a complete-looking directory (new rows beside the previous run's summary). Replaced again below.
            self.paths[-1].unlink(missing_ok=True)
            for tmp, final in zip(self.tmp, self.paths):
                os.replace(tmp, final)
        else:
            for tmp in self.tmp:
                tmp.unlink(missing_ok=True)
        return False   # never swallow the exception


def _batches(items, size):
    for i in range(0, len(items), max(1, size)):
        yield items[i:i + max(1, size)]


def main(argv=None):
    ap = argparse.ArgumentParser(prog="kev.task", description="answer one states-JSONL with one configured task")
    ap.add_argument("--config", required=True, help="machine-local JSON registry (kev.local)")
    ap.add_argument("--task", required=True, help="task id declared in that config")
    ap.add_argument("--input", required=True, help="JSONL, one {'state': ...} per row")
    ap.add_argument("--out", required=True, help="output directory (rows.jsonl, answers.jsonl, task.json)")
    ap.add_argument("--limit", type=int, default=None, help="answer only the first N rows (smoke checks)")
    ap.add_argument("--batch", type=int, default=BATCH_ROWS, help=f"input rows per forward pass, at least 1 (default {BATCH_ROWS})")
    ap.add_argument("--receipt", default=None, help="acquisition receipt JSON: re-hash every payload against it before loading")
    a = ap.parse_args(argv)
    if a.batch < 1 or (a.limit is not None and a.limit < 1):
        ap.error("--batch and --limit must be at least 1")
    try:
        run(a.config, a.task, a.input, a.out, limit=a.limit, batch=a.batch, receipt=a.receipt)
    except LocalConfigError as exc:
        print(f"local inference error: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
