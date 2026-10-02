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
from dataclasses import replace
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]


def use_kev_from(root):
    """Import the `kev` package from `root`, whatever else is on sys.path.

    This runner lives in the delivery checkout and is started with `PYTHONPATH` pointing at the reference worktree, so
    the order of sys.path decides which `kev` a process gets. Getting it wrong makes the comparison meaningless — both
    processes would import the same package and could not detect a loader regression — so `--reference-root` is
    inserted ahead of every other entry instead of trusting the environment. The runner's own directory stays importable
    for `scripts.local_parity` itself."""
    root = str(Path(root).resolve())
    sys.path[:] = [p for p in sys.path if p not in ("", str(HERE), root)]
    sys.path.insert(0, root)
    return root


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
    if a.mode == "local":   # only the configured-local run needs kev.local, which the baseline revision does not have
        from kev.local import load_registry, resolve
        resolved = resolve(load_registry(a.config), a.task)
        ck, base_path = resolved.checkpoint, resolved.base_path
        source = {"repo": resolved.base_source, "revision": resolved.base_revision}
    else:
        ck, base_path = Checkpoint(a.checkpoint), None
        # the baseline revision predates Meta.base_identity, so read the identity the way that revision records it;
        # head.pt of these checkpoints carries the Hub id, which is what the delivery's base_identity returns for it.
        source = {"repo": ck.meta.base, "revision": ck.meta.base_revision}
    # one thread, CPU, fp32, eager: the settings numbers are reported from, in both processes. The baseline revision
    # has no LoadOptions.base_path, so it is only passed where the field exists — that is the change under test.
    torch.set_num_threads(1)
    torch.manual_seed(0)
    opts = LoadOptions(dtype=torch.float32, attn="eager", backend="torch")
    if base_path is not None:
        opts = replace(opts, base_path=base_path)
    return ck.load("cpu", opts) + (ck, source, base_path)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--mode", choices=("reference", "local"), required=True)
    ap.add_argument("--checkpoint", default=None, help="mode reference: the Kev checkpoint directory")
    ap.add_argument("--reference-root", default=None,
                    help="mode reference: the checkout whose kev package must be imported (default: PYTHONPATH's first kev)")
    ap.add_argument("--config", default=None, help="mode local: the machine-local JSON registry")
    ap.add_argument("--task", default=None, help="mode local: the task id")
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    if a.mode == "reference" and not a.checkpoint:
        ap.error("--mode reference needs --checkpoint")
    if a.mode == "local" and not (a.config and a.task):
        ap.error("--mode local needs --config and --task")
    if a.mode == "reference":
        root = a.reference_root or next((p for p in sys.path if (Path(p) / "kev" / "checkpoint.py").is_file()), None)
        if not root:
            ap.error("--mode reference needs --reference-root (or PYTHONPATH naming a kev checkout)")
        import kev
        if use_kev_from(root) and Path(kev.__file__).resolve().parent != Path(root).resolve() / "kev":
            ap.error(f"kev was already imported from {kev.__file__}; start a fresh process for the reference run")

    import torch
    from kev.api import SystemOneRequest, to_record
    from kev.model import admit
    from kev.predictors import kernel_environment
    tok, model, ck, source, base_path = load_model(a)
    body = {"mode": a.mode, "checkpoint": ck.path, "source": source,
            "base_path": str(base_path) if base_path else None,   # the baseline Checkpoint has no base_path
            "imported_kev": str(Path(__import__("kev").__file__).resolve()),
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
