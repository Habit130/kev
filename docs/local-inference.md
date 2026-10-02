# Local inference with a fixed task preset

This fork's first goal is running Kev locally on Apple Silicon through the System One API from
**pinned, verified local artifacts**, without a Hub lookup at inference time. This document is the
authoritative guide to that mode: the environment, the model-storage split, the task registry, both
entry points, and the failure behavior.

Upstream `README.md` documents the general (Hub-resolving) path and stays upstream-attributed.
This page documents the fork's configured local mode, which is additive: `--run` is unchanged.

## What "local mode" means

- A machine-local JSON file decides **which** checkpoint and **which** base a task uses.
- Source identity (`org/model` plus a full commit) and the local directory are separate fields. The
  loader reads the directory; the registry keeps the identity for verification and receipts.
- With a task configured, there is **no** Hub resolution, no fallback to another checkpoint, no
  substitution of a different base, and no download: an unknown id, an incomplete artifact, or a
  revision that disagrees with the checkpoint's own `head.pt` is a hard error.
- The request field `model` is an **alias the response echoes**, never a hot-switch. One server
  serves one checkpoint, chosen once at startup.

## Storage semantics

Two different stores, on purpose:

| Artifact | Home | Why |
| --- | --- | --- |
| Qwen native bases (`Qwen/Qwen3.5-0.8B-Base`, `Qwen/Qwen3.5-4B-Base`) | the machine's shared cross-project model store, at its original `org/model` path | generic weights several projects can reuse; the store holds original payloads only |
| Kev checkpoints (`jaredpalmer/kev-0.8b`, `jaredpalmer/kev-4b`) | this repository's ignored `.local/models/<org>/<name>/` | project-specific adapters and pointer heads |

Rules that follow from that split:

- Acquire by **full commit**, never a branch or tag, and verify the official SHA-256 of every weight
  file before using it. `head.pt`'s `base_revision` is the base the checkpoint was trained on.
- Original artifacts are **read-only**. Local mode never rewrites `head.pt`, `config.json`, or
  `adapter_config.json` to insert a local path — the mapping lives in the registry.
- A completed shared destination holds original model payloads only: no `.cache`, no `.gitattributes`,
  no scripts, no Git history, no second copy of framework weights.
- Machine paths belong in the ignored registry and local context, never in committed examples.

The two presets shipped here are:

| Task id | Model | Base | Role |
| --- | --- | --- | --- |
| `support-triage-4b` | `jaredpalmer/kev-4b` | `Qwen/Qwen3.5-4B-Base` | **primary preset** |
| `support-triage-0.8b` | `jaredpalmer/kev-0.8b` | `Qwen/Qwen3.5-0.8B-Base` | validation and simple tasks |

Both use the same three short English synthetic states (`examples/local-inference/support.jsonl`)
and the same `choice` / `noul` / `score` questions, which are declared once in a shared
`question_sets` entry — the presets differ only in their model selection.

## Setup

Project-local tooling only; nothing global, no shell-profile edits:

```bash
export UV_CACHE_DIR="$PWD/.local/cache/uv"
export UV_PYTHON_INSTALL_DIR="$PWD/.local/python"
export UV_PYTHON_BIN_DIR="$PWD/.local/bin"
export UV_TOOL_DIR="$PWD/.local/tools"
export UV_TOOL_BIN_DIR="$PWD/.local/bin"
export XDG_CACHE_HOME="$PWD/.local/cache"
export HF_HOME="$PWD/.local/cache/huggingface"
export HF_HUB_CACHE="$HF_HOME/hub"

# official uv, then managed Python 3.13, then the locked serve environment
curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR="$PWD/.local/bin" sh
.local/bin/uv python install 3.13
.local/bin/uv sync --frozen --extra serve --python 3.13 --managed-python
```

Then copy the committed example and fill in two things — your checkout root and where your machine
keeps the shared bases:

```bash
cp examples/local-inference/local-inference.example.json .local/local-inference.json
$EDITOR .local/local-inference.json
```

`.local/local-inference.json` is gitignored. `.local/` holds machine paths, receipts, and verification
output; it is never committed.

## Configuration format

```jsonc
{
  "schema": "kev-local-inference/1",
  "project_root": "/abs/path/to/this/checkout",   // relative local paths resolve against this
  "models": {
    "kev-0.8b": {
      "checkpoint": { "path": ".local/models/jaredpalmer/kev-0.8b",
                      "source": "jaredpalmer/kev-0.8b", "revision": "<full commit>" },
      "base":       { "path": "/abs/path/to/shared/models/Qwen/Qwen3.5-0.8B-Base",
                      "source": "Qwen/Qwen3.5-0.8B-Base", "revision": "<full commit>" }
    }
  },
  "question_sets": { "support-triage": { /* choice | noul | score questions */ } },
  "tasks": {
    "support-triage-0.8b": { "model": "kev-0.8b", "include": "support-triage" }
  }
}
```

- `models.<id>` — one logical model: its Kev `checkpoint` and the exact `base` that checkpoint was
  trained on. `path` is where this machine keeps the artifact; `source` and `revision` are the pinned
  public identity the artifact must match.
- `question_sets.<id>` — reusable question definitions (`choice`, `noul`, `score`).
- `tasks.<id>` — a fixed `model` plus its questions, either inline (`questions`) or by reference
  (`include`). A task may not name a model that `models` does not define.

Any unknown key, a missing `source`, a relative path with no `project_root`, an undefined model or
question set, and a task declaring both or neither of `questions`/`include` are configuration errors.

## Running a batch

```bash
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  .local/bin/uv run --frozen --extra serve python -m kev.task \
    --config .local/local-inference.json \
    --task support-triage-4b \
    --input examples/local-inference/support.jsonl \
    --out .local/verification/task-4b
```

Each input row supplies a `state` (a string, or any JSON the encoder renders). The task supplies the
questions and the model, so **no row can change the checkpoint**; a row carrying its own `model` field
is refused instead of honoured. The run writes three files into `--out`:

- `rows.jsonl` — per row: its state and its typed answers.
- `answers.jsonl` — per row: the same answers in the API's response shape, with usage and latency.
- `task.json` — the run's actual identity: task, model id, checkpoint and base **paths**, their pinned
  sources and revisions, temperature, device, backend, dtype, per-batch latency and device memory,
  each with its measurement definition. Latency and memory are observations on this machine, not
  performance guarantees.

`--batch N` sizes the rows per forward pass (default 8). Rows are independent: batching changes speed
and memory, never an answer.

`--receipt <acquisition-receipt.json>` re-hashes every payload against the acquisition record before
loading and writes the checked digests into `task.json`. Without it, the reported `pin` values are the
declarations the artifact was *acquired and verified* against (registry entry, required to agree with
the checkpoint's own `head.pt`) rather than a hash of the bytes read now; use the receipt when the
storage is not trusted to be unchanged since acquisition.

## Serving one task

```bash
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  .local/bin/uv run --frozen --extra serve python -m kev.serve \
    --config .local/local-inference.json --task support-triage-4b \
    --host 127.0.0.1 --port 8009
```

`--receipt <acquisition-receipt.json>` verifies the payload digests again at startup, and a
configured startup that fails exits nonzero with `local inference error: ...` on stderr.

The task is resolved once at startup and its checkpoint is the only one served. Wait for readiness,
then confirm what is actually loaded instead of trusting the alias:

```bash
curl -s localhost:8009/v1/models | python3 -m json.tool
```

`/v1/models` reports the task, the checkpoint and base **paths**, the pinned `source` and `revision`
of each under `pin`, the device, the backend (MLX on Apple Silicon for these hybrid bases), the dtype,
and the serving temperature. `run` keeps the local path, and the request's `model` field stays an
alias. `pin_source` says what those values are, and `verified_sha256` carries the digests re-hashed in
this process when `--receipt` was given (`null` otherwise).

Legacy startup is unchanged when `--config`/`--task` are absent:

```bash
.local/bin/uv run --frozen --extra serve python -m kev.serve --run jaredpalmer/kev-4b --port 8009
```

`--run` and `--config`/`--task` are mutually exclusive: a configured server takes its checkpoint from
the task.

## Failure behavior

Every one of these fails with a clear message and **no** network call, no substitute model, and no
mutation of any artifact:

| Situation | Result |
| --- | --- |
| config file missing or not valid JSON | `local inference error: ... does not exist` / parse error, exit 2 |
| wrong `schema`, unknown key, missing `source`, unpinned relative path | `LocalConfigError` naming the key |
| unknown task id or model id | error listing the known ids |
| checkpoint or base directory absent | error naming the directory |
| required file missing (`head.pt`, `adapter_config.json`, `adapter_model.safetensors`, `config.json`, the index, the weights) | error naming the file |
| an empty file under either artifact | error naming the file |
| registry `source` disagrees with the checkpoint's `head.pt` | `refusing to pair a checkpoint with a different base` |
| registry `revision` disagrees with `head.pt`'s `base_revision` | `refusing to load a different revision of the base` |
| an input row names a `model` | `a row may not select a model` |
| a state over the serving context | refused, not truncated (`kev.model.admit`); `KEV_TRUNCATE_STATES=1` opts into truncation and then every response is marked |

## Verification

```bash
# unit contract (no weights, no network)
.local/bin/uv run --frozen --extra serve python -m pytest tests/test_local_inference.py -q -k 'not integration'

# opt-in real-weight cases, including the separate-process fp32 parity check against a read-only baseline
KEV_LOCAL_INFERENCE_CONFIG="$PWD/.local/local-inference.json" \
KEV_REFERENCE_ROOT="$PWD/.local/worktrees/kev-main-local-inference" \
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  .local/bin/uv run --frozen --extra serve python -m pytest tests/test_local_inference.py -q -k integration
```

Parity is exact, not tolerance-based: both processes score the same synthetic requests on CPU in fp32
with one thread and eager attention, from the same original artifacts, and their logits and
probabilities must be identical. `scripts/local_parity.py` writes each side's raw numbers together
with its kernel environment; `scripts/refcache.py` creates the ignored Hub-cache metadata links that
let the reference revision resolve the already-acquired originals offline without a second weight copy.

The reference run must be given `--reference-root <baseline checkout>`: the runner lives in the
delivery checkout, so `sys.path` alone would let both processes import the same `kev` and make the
comparison vacuous. Each dump records `imported_kev`, and the integration test requires the two
paths to differ.

## Constraints

- One model phase at a time on a laptop: run the 4B preset alone, and stop the previous server before
  starting the next one.
- No fallback or network lookup in configured local mode. Run with `HF_HUB_OFFLINE=1` and
  `TRANSFORMERS_OFFLINE=1` to make that a hard guarantee rather than an intention.
- The task determines model selection. There is no per-request switching, no multiple resident model
  services, and no automatic complexity classification.
- The serialized precision of probabilities is unchanged (`kev.api.round_prob`), so a batch answer and
  a served answer for the same state and questions are the same numbers.
- Question isolation, delimiter escaping, admission, and default refusal instead of silent truncation
  are preserved from the serving path; configured local mode changes resolution only, not scoring.
