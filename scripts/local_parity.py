"""Score the same synthetic requests twice — the reference revision and the delivery checkout — and dump raw numbers.

    # reference (dispatch baseline worktree), reading the original local artifacts through ignored cache links:
    PYTHONPATH=<worktree> OMP_NUM_THREADS=1 <this checkout>/.venv/bin/python <worktree>/scripts/local_parity.py \\
        --mode reference --checkpoint <kev checkpoint dir> --out <dir>/reference.json

    # delivery (this checkout), through the configured local registry:
    OMP_NUM_THREADS=1 .venv/bin/python scripts/local_parity.py --mode local \\
        --config .local/local-inference.json --task support-triage-0.8b --out <dir>/delivery.json

The two runs must use the same original artifacts, the same synthetic requests, the same kernel environment — one
thread, CPU, fp32, eager attention — and each runs in its own process, so no comparison depends on module state both
revisions would otherwise share. A comparison script reads both JSON files; `--diff` does that directly.

`--mode local` resolves the base from the machine-local registry (kev.local), which is the change under test.
`--mode reference` resolves it the way the baseline does: the full commit pinned in `head.pt`, through the Hub cache.
Both write the raw logits and probabilities, the checkpoint's own identity, the pinned source, and the kernel
environment, so the pair is auditable without re-running the models.
"""
import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# The synthetic requests. Identical bytes in both runs; a case's inputs must not depend on anything that changed.
def cases():
    states = [
        "My running shoes arrived in the wrong size. I need a 10, not a 9. Can I swap them?",
        "The tracking page has not moved in six days and support has not replied to my last two emails.",
        "I was charged twice for one order. Please refund the duplicate payment today.",
    ]
    questions = {
        "department": {"type": "choice", "instructions": "Which team should handle this ticket?",
                       "criteria": {"returns": "Exchanges, refunds, wrong or damaged items",
                                    "shipping": "Delivery status, delays, lost packages",
                                    "billing": "Charges, invoices, payment problems"}},
        "needs_manager": {"type": "noul", "instructions": "Does this ticket need a manager to review it?",
                          "criteria": {"true": "The customer asks for a person, or the problem is still unresolved after earlier attempts",
                                       "false": "A first-line agent can resolve this from the standard policy"}},
        "urgency": {"type": "score", "instructions": "How urgent is this ticket?",
                    "criteria": ["can wait", "this week", "today"]},
    }
    return [{"model": "kev-local", "state": state, "questions": questions} for state in states]


def load_model(a):
    import torch
    from kev.checkpoint import Checkpoint, LoadOptions
    from kev.local import load_registry, resolve
    if a.mode == "local":
        resolved = resolve(load_registry(a.config), a.task)
        ck, base_path = resolved.checkpoint, resolved.base_path
        source = {"repo": resolved.base_source, "revision": resolved.base_revision}
    else:
        ck, base_path = Checkpoint(a.checkpoint), None
        source = {"repo": ck.meta.base_identity, "revision": ck.meta.base_revision}
    # one thread, CPU, fp32, eager: the settings numbers are reported from, in both processes.
    torch.set_num_threads(1)
    torch.manual_seed(0)
    opts = LoadOptions(dtype=torch.float32, attn="eager", backend="torch", base_path=base_path)
    return ck.load("cpu", opts) + (ck, source)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--mode", choices=("reference", "local"), required=True)
    ap.add_argument("--checkpoint", default=None, help="mode reference: the Kev checkpoint directory")
    ap.add_argument("--config", default=None, help="mode local: the machine-local JSON registry")
    ap.add_argument("--task", default=None, help="mode local: the task id")
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    if a.mode == "reference" and not a.checkpoint:
        ap.error("--mode reference needs --checkpoint")
    if a.mode == "local" and not (a.config and a.task):
        ap.error("--mode local needs --config and --task")

    import torch
    from kev.api import SystemOneRequest, to_record
    from kev.model import admit
    from kev.predictors import kernel_environment
    tok, model, ck, source = load_model(a)
    body = {"mode": a.mode, "checkpoint": ck.path, "source": source,
            "base_path": str(ck.base_path) if ck.base_path else None,
            "checkpoint_files": {p.name: {"bytes": p.stat().st_size, "sha256": sha256(p)}
                                 for p in sorted(Path(ck.path).iterdir()) if p.is_file() and not p.name.startswith(".")},
            "head_keys": sorted(ck.meta.to_dict()),
            "temperature": model.head.temperature, "threads": torch.get_num_threads(), "torch": torch.__version__,
            "kernel_environment": kernel_environment(model, "cpu"), "cases": []}
    with torch.no_grad():
        for i, raw in enumerate(cases()):
            req = SystemOneRequest.model_validate(raw)
            enc = admit(model, tok, to_record(req)[0])
            logits = torch.cat(model.forward(enc))
            probs = torch.cat(model.probs(enc))
            body["cases"].append({"index": i, "input_sha256": digest(raw),
                                  "logits": [float(x) for x in logits.tolist()],
                                  "probs": [float(x) for x in probs.tolist()],
                                  "probs_sum": float(sum(probs.tolist())),
                                  "state_tokens": enc["state_tokens"]})
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(body, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {a.out} ({len(body['cases'])} cases, {sum(len(c['logits']) for c in body['cases'])} logits)", flush=True)
    return 0


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def digest(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


if __name__ == "__main__":
    raise SystemExit(main())
