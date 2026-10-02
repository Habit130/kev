---
name: kev-verify
description: Verify a Kev change has no regression and prepare an issue-scoped PR. Use when refactoring, editing kev/*.py, scripts, the Space or the playground, and when handing a verified Kev pull request back for habit's squash merge.
---

# Verify and ship a Kev change

Read root `AGENTS.md` and `docs/agents/delivery.md` for the frozen issue contract and
authority. Execution verifies the affected paths; Orchestration writes governance only.
Model downloads, servers, cloud jobs, and publication need explicit task authorization
and resource allocation. A governance-only diff does not require model or training runs.

Behaviour is defined by numbers: probabilities, saved weights, frozen-suite bytes. A refactor is done when the numbers
are bit-identical to `main`, not when the tests are green. Work bottom-up: unit suites, then weight-backed parity, then
the harness below for anything that touches the model, the loader, the trainer, the data converters or the metrics.

## 1. Fast suites (also CI)

```bash
uv run --extra serve python -m pytest tests/test_unit.py tests/test_research.py tests/test_generators.py tests/test_conventions.py tests/test_documents_tools.py tests/test_hard_v1.py tests/test_devtools_v1.py tests/test_breadth_v1.py tests/test_rounds.py tests/test_skill_scripts.py -q
```

`test_rounds.py` recomputes the committed read-outs of rounds 5-18 and their verdicts from saved rows and compares every
number exactly; main carries only the rows of round 5's read-out and round 15's locked verdict (the rest are on the tag
`research-archive-2026-09-24` or gitignored), so after touching `kev/rounds.py`, `kev/metrics.py` or a round spec also run
it against a checkout that holds them:
`KEV_ROUNDS_ROOT=/path/to/kev uv run --extra serve python -m pytest tests/test_rounds.py -q` (0 skips, 0 differences).

`test_conventions.py` fails when a rule that has a canonical home is re-derived elsewhere (head.pt access, KEV_* env
reads, option keys, the context literal, device selection). Do not add an allowlist entry to make it pass; call the
helper. Add a row when a new helper becomes canonical.

## 2. Weight-backed parity (local, ~3 min)

```bash
uv run --extra serve python -m pytest tests/test_model.py -q     # needs runs/smoke-hl/00-trial-0/checkpoint
```

Merged vs unmerged LoRA, prefix cache vs full pass, shape-bucket padding, row form vs packed mask, hybrid isolation on
Qwen3.5-0.8B-Base, `--init_from` end to end. The Qwen2.5 checkpoint in `runs/smoke-hl` is only there for the packed mask,
which the hybrid Qwen3.5 bases never use. Run it for any change under `kev/model.py`, `kev/checkpoint.py`, `kev/serve.py`, `kev/train.py`.

## 3. Serving

```bash
uv run --extra serve python -m kev.serve --run runs/smoke-hl/00-trial-0/checkpoint --port 8009 &
KEV_BASE_URL=http://127.0.0.1:8009 uv run --extra serve python -m pytest tests/test_api.py -q
```

Space changes: `python3 -m py_compile space/app.py`; the Space vendors `kev/{model,api,checkpoint}.py` via
`scripts/publish_space.sh`, so serving changes need a separately authorized republish to
the confirmed target. Never infer permission to write the upstream Space. Playground
command order is in `docs/agents/build.md`, including Next type generation before typecheck.

### Browser end-to-end checks

- If there is no local checkpoint, `--run jaredpalmer/kev-0.6b` provides a small public CPU fallback.
  This verifies serving integration, not parity with the released Qwen3.5 family.
- Start the playground with `cd playground && npm run dev -- -p 3001`; it proxies `/kev/*` to :8009.
  Wait for the server's Uvicorn ready log before loading the page, since model metadata is fetched once on mount.
- At `/`, click **Support triage**, then **Run**: expect six answer cards covering Choice, Noul, and Score.
  The header displays the base and checkpoint run, not the API model alias. Inspect `/v1/models` separately
  when testing the model-card contract.
- The Questions textarea is `#questions`; it accepts JSON directly, so API edge cases can be tested through
  the real UI without changing TypeScript types or mocking requests. Capture the POST response as well as pixels.
- At `/chess`, use **Model vs model**, **New game**, then **Step** for a bounded one-move test.
  Expect a legal move, populated move/evaluation panels, and Black to move. Avoid **Play** for a one-request test.
- `KEV_API_KEY` is read at server startup. habit provisions any test key without exposing
  its value to the agent. Verify rejection without a bearer header and acceptance through
  habit's configured client. The playground has no key input and will show 401 in this mode.
  Restore the open server afterward. `/openapi.json` remains accessible without a key.
- If desktop tools cannot connect to a display, use real headless Chromium via an isolated Playwright environment
  when approved; save full-page screenshots and network responses. Do not substitute mocked frontend responses.
  A full-page capture can include a sticky footer over a card; also capture a scrolled viewport when needed.

#### Credential prerequisites

Public local checks need no private-resource credentials. Private checkpoints or protected
endpoints require habit-managed authentication. Never read, print, generate, or record
credential values through the agent; habit provisions them outside governance artifacts.

## 4. Parity harness against main

Run the *old* code from a worktree and the new code from the checkout on the same inputs, then compare bytes. Both halves
run on **Qwen3.5**, the architecture the family ships: the benchmark scores the released Kev-0.8B (hybrid Gated DeltaNet,
row form, prefix cache) and the trainer fine-tunes Qwen3.5-0.8B-Base. CPU with fixed seeds is deterministic on these too
(checked 2026-09-22: max |Δ| = 0.0 on the benchmark rows and on all 372 adapter tensors).

```bash
ROOT="$PWD"
REFERENCE="$ROOT/.local/worktrees/kev-main"
git worktree add "$REFERENCE" origin/main
OLD=(env "PYTHONPATH=$REFERENCE" "$ROOT/.venv/bin/python")     # explicitly resolve imports to the reference worktree
SUITE="$ROOT/evals/smoke-v1"                                   # the reference process reads this checkout's inputs
# benchmark rows/report (model, loader, metrics, api, data), ~15 s per tree on an M-series CPU
(cd "$REFERENCE" && "${OLD[@]}" -m kev.benchmark --run jaredpalmer/kev-0.8b --suite "$SUITE" --out "$ROOT/.local/bench-main")
uv run python -m kev.benchmark --run jaredpalmer/kev-0.8b --suite "$SUITE" --out .local/bench-new
# -> rows.json must be identical; report.json identical on every numeric field
# training (trainer, losses, augmentation), ~5 min per tree (reference DeltaNet kernels on CPU): same args, then compare
# head.pt["head"] tensors and adapter_model.safetensors
ARGS=(--n_per_source 4 --epochs 1 --accum 2 --batch 2 --device cpu --base Qwen/Qwen3.5-0.8B-Base --lr 1e-4 --perm_kl 0.2 --perm_frac 1 --p_none_pair 0.5 --ord_w 0.3)
(cd "$REFERENCE" && OMP_NUM_THREADS=4 "${OLD[@]}" -m kev.train "${ARGS[@]}" --out "$ROOT/.local/train-main")
OMP_NUM_THREADS=4 uv run python -m kev.train "${ARGS[@]}" --out .local/train-new
# data converters: json.dumps(build(3, "test", 0, only=[...])) from both trees must be equal
```

Everything the worktree process opens must be an absolute path into this checkout. "max |Δ| = 0.0" is the bar; a nonzero
difference is a behaviour change to explain in the PR or fix. The packed block-causal mask exists only on attention-only
bases, so a change to that path also needs the Qwen2.5 checkpoint in `runs/smoke-hl` (`tests/test_model.py` covers it);
nothing else should be verified on Qwen2.5. Anything that depends on CUDA kernels, bf16 or the 4B / 9B sizes is verified on
Modal with the real base (`kev-modal-study`), not here.

## 5. Ship

- One frozen issue, feature branch from latest `origin/main`, PR, and active writer per
  delivery. Parallel issues use separate worktrees, never stacked PRs.
- Write the English Conventional Commit title and body with `kev-pr-description`. Put
  re-runnable commands, measured evidence, and the complete criterion matrix in Verification.
- Use `thermonuclear-code-review` for structural review. It has caught dropped imports and
  doubled temperatures, but P2/P3 structure suggestions are non-blocking follow-up. Do not
  broaden the frozen contract or spawn helpers without the session's delegation authority.
- Request `@codex review`, record the actual result, and follow the conditional independent
  Acceptance protocol. Leave issue and PR open; habit alone squash-merges. Never enable
  auto-merge, force-push, or run an agent merge/rebase chain from an inherited example.
- Never commit regenerated `runs/leaderboard.*` or frozen `evals/` files as part of a refactor.
