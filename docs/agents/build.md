# Build and verification

Commands below come from `pyproject.toml`, lockfiles, package scripts, existing tests,
and `.github/workflows/ci.yml`. Choose the paths the frozen issue actually changes.
Governance-only work does not justify downloading models or launching a GPU job.

## Required order

1. Governance-only delivery: `python3 scripts/verify_governance.py`, then `git diff --check`.
   Reread GitHub settings and exact PR head when the issue changes host state.
2. Python implementation: synchronize the project environment, run the fast suites,
   then affected weight-backed, serving, or old/new parity checks from `kev-verify`.
3. Playground: read `playground/AGENTS.md`, install from its lockfile, lint, generate
   Next types, then typecheck. Run a build or browser verification when the issue needs it.
4. Label-review tool: install from its own lockfile, then use its combined typecheck/build.

Before downloading inputs, starting a model server, or using GPU/cloud resources, confirm
the task authorization and allocate shared state. Put local instances in `.local`.

## Environment

Python is `>=3.12,<3.14`; `.python-version` selects 3.13. The package is installed editable
by `uv sync` through setuptools. The serve extra adds FastAPI, the TypeSafe SDK, and
Apple Silicon `mlx-lm`; `--extra mlx` enables library-only MLX use. The lockfile and
manifest own versions: transformers `>=5.17,<6`, peft `>=0.21`, torch `>=2.6,<2.9`,
and dev tooling including pytest, matplotlib, and Modal 1.5.5.

Use Node 22, the version in CI, for the playground. Its locked AI SDK also requires
Node 22; the older upstream README's Node 20.9 minimum is insufficient for that dependency.
Do not change dependency bounds or regenerate lockfiles as incidental governance work.

## Commands

Run from repository root unless the directory column says otherwise.

| Task | Directory | Command | Evidence and prerequisites |
| --- | --- | --- | --- |
| Environment | root | `uv sync --extra serve` | Project environment; no global software installation |
| Explicit Python selection | root | `uv sync --extra serve --python 3.13` | Requires that interpreter or authorized provisioning |
| Fast Python suites | root | command below | No weights or server; tokenizer download may be needed |
| Model parity | root | `uv run --extra serve python -m pytest tests/test_model.py -q` | Checkpoint, base downloads, and affected-path authorization |
| MLX parity | root | `uv run --extra serve python -m pytest tests/test_mlx.py -q` | Apple Silicon, public weights, isolated model workload |
| Local server | root | `uv run --extra serve python -m kev.serve --run jaredpalmer/kev-0.8b --port 8009` | Public small-model starting point; downloads and port allocation required |
| API tests | root | `KEV_BASE_URL=http://127.0.0.1:8009 uv run --extra serve python -m pytest tests/test_api.py -q` | Server must already be ready; tests use the official SDK |
| Training smoke | root | `uv run python -m kev.train --n_per_source 40 --accum 4 --out runs/smoke` | Historical estimate about one minute; downloads/training/output authorization required |
| Playground dependencies | playground | `npm ci` | Existing package-lock; not a global install |
| Playground lint | playground | `npm run lint` | Existing ESLint/React Compiler rules |
| Next type generation | playground | `npx --no-install next typegen` | Local locked Next package, after dependency setup |
| Playground typecheck | playground | `npx --no-install tsc --noEmit -p .` | Run after Next type generation |
| Playground build | playground | `npm run build` | `next build`; not currently a CI check |
| Playground development | playground | `npm run dev -- -p 3001` | Allocated port; proxy uses `KEV_API`, default local port 8009 |
| Review-tool dependencies | tools/review | `npm ci` | Separate package-lock |
| Review-tool build | tools/review | `npm run build` | `tsc -p .` followed by `vite build` |
| Space syntax | root | `python3 -m py_compile space/app.py` | Syntax only, not live deployment verification |

Fast suites, matching CI's test selection:

```bash
uv run --extra serve python -m pytest tests/test_unit.py tests/test_research.py tests/test_generators.py tests/test_conventions.py tests/test_documents_tools.py tests/test_hard_v1.py tests/test_devtools_v1.py tests/test_breadth_v1.py tests/test_rounds.py tests/test_skill_scripts.py -q
```

There is no configured Python lint/typecheck command, no task runner, and no installed
repository hook. Python packaging uses setuptools; initialization adds no release command.
Train/benchmark/study/release details remain in `docs/agents/kev-reference.md` and the
relevant skills. They are not baseline checks to run for every delivery.

## CI and affected paths

The existing workflow runs `python` and `playground`. It synchronizes Python before fast
tests, and runs playground `npm ci`, lint, Next type generation, and TypeScript typecheck.
Those names were verified on upstream main at the initialization baseline. This fork had
no workflow-run history at reconnaissance. No required checks are configured initially;
record actual PR results and do not assume CI ran or passed.

Model/loader/trainer/scoring changes need the existing affected-path parity evidence.
Round reproduction may skip reads absent from this checkout; record skips. Private or
archived inputs need separate access authorization, not a test success assertion.

Read Next's relevant local documentation before playground code changes. React Compiler
forbids synchronous effect setState. Use a real browser to verify hydration; curl only
proves an HTTP response. Ports and browser tooling in upstream examples are not proof of
current availability. Space vendoring/publication needs a separately authorized target.

## Initialization environment

At initialization, `uv`, project Python/frontend environments, `qmd`, and browser tooling
were absent. Record current machine details and later provisioning in ignored local context.
The stdlib governance validator requires no package installation. Product suites were not
run for this documentation-only initialization; they are not reported as passing.
