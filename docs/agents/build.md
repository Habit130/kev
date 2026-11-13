# Build and verification

The commands, CI and Actions secrets that a Builder runs and checks, and that a Planner
draws on to write a ticket's Verification. The generator wrote this file at Initialize from
what it ran. It is repository-owned, kept current by this repository's own PRs, and it sits
under `docs/agents/`, a sensitive path with a medium floor, so a PR that edits it is at
least medium.

## Commands

Commands come from `pyproject.toml`, the lockfiles, the package scripts, the existing tests
and `.github/workflows/ci.yml`. Run the ones the ticket's change reaches. A governance-only
or documentation-only change does not justify downloading models or launching a GPU job.

Before downloading inputs, starting a model server, or using GPU or cloud resources, confirm
the task's authorization and allocate shared state (`AGENTS.md`, This repository).

### Order

1. Python: synchronize the project environment, run the fast suites, then the affected
   weight-backed, serving, or old/new parity checks from `.agents/skills/kev-verify/SKILL.md`.
2. Playground: read `playground/AGENTS.md`, install from its lockfile, lint, generate Next
   types, then typecheck. Run a build or browser verification when the ticket needs it.
3. Label-review tool: install from its own lockfile, then use its combined typecheck and build.

### Ran at Initialize

The generator's session ran these on `d5354e3c96fa311f4e595e3d3e9c32d6789d7df5`, in a
temporary worktree, with the project-local toolchain under the ignored `.local/` of habit's
checkout (uv, CPython 3.13, Node 22.23.3). Run from the repository root unless the
directory column says otherwise.

| Purpose | Directory | Command | Result |
| --- | --- | --- | --- |
| Python environment | root | `uv sync --extra serve` | worked, offline from the local uv cache |
| Fast Python suites | root | the command below | worked: 477 passed, 26 skipped, about 13 minutes on habit's machine, offline; needs no weights or server, only the tokenizer and config files, cached or downloaded from the Hub |
| Space syntax | root | `python3 -m py_compile space/app.py` | worked; syntax only, not live deployment verification |
| Playground dependencies | playground | `npm ci` | worked; existing `package-lock.json`, not a global install |
| Playground lint | playground | `npm run lint` | worked; ESLint with the React Compiler rules |
| Next type generation | playground | `npx --no-install next typegen` | worked; needs the dependencies |
| Playground typecheck | playground | `npx --no-install tsc --noEmit -p .` | worked; run after type generation |
| Playground build | playground | `npm run build` | worked; `next build`, not a CI check |
| Review-tool dependencies | tools/review | `npm ci` | worked online; fails with `ENOTCACHED` when npm is forced offline, since the local npm cache lacks the `vite` tarball |
| Review-tool build | tools/review | `npm run build` | worked; `tsc -p .` then `vite build` |

The fast suites, matching CI's test selection:

```bash
uv run --extra serve python -m pytest tests/test_unit.py tests/test_research.py tests/test_generators.py tests/test_conventions.py tests/test_documents_tools.py tests/test_hard_v1.py tests/test_devtools_v1.py tests/test_breadth_v1.py tests/test_rounds.py tests/test_skill_scripts.py -q
```

### Not run at Initialize

Each needs an authorization or a resource the Initialize run did not have, so none is
reported as working or failing.

| Purpose | Directory | Command | Needs |
| --- | --- | --- | --- |
| Explicit Python selection | root | `uv sync --extra serve --python 3.13` | that interpreter, or authorized provisioning |
| Model parity | root | `uv run --extra serve python -m pytest tests/test_model.py -q` | a checkpoint, base downloads, and affected-path authorization |
| MLX parity | root | `uv run --extra serve python -m pytest tests/test_mlx.py -q` | Apple Silicon, public weights, an isolated model workload |
| Local server | root | `uv run --extra serve python -m kev.serve --run jaredpalmer/kev-0.8b --port 8009` | the public small-model starting point; downloads and a port allocation |
| API tests | root | `KEV_BASE_URL=http://127.0.0.1:8009 uv run --extra serve python -m pytest tests/test_api.py -q` | a server already ready; the tests use the official SDK |
| Training smoke | root | `uv run python -m kev.train --n_per_source 40 --accum 4 --out runs/smoke` | downloads, training and output authorization; historically about one minute |
| Playground development | playground | `npm run dev -- -p 3001` | an allocated port; the proxy uses `KEV_API`, default local port 8009 |
| Workbench browser tests | playground | `npm run test:workbench` | the Playwright browser install in `playground/README.md`, and an allocated port |
| Workbench native tests | playground | `npm run test:workbench:native` | the same, plus a local model workload |

Train, benchmark, study and release commands stay in `docs/agents/kev-reference.md` and the
relevant skills. They are not baseline checks for every delivery.

### Environment

Python is `>=3.12,<3.14`; `.python-version` selects 3.13. The package is installed editable
by `uv sync` through setuptools. The serve extra adds FastAPI, the TypeSafe SDK and Apple
Silicon `mlx-lm`; `--extra mlx` enables library-only MLX use. The lockfile and manifest own
versions: transformers `>=5.17,<6`, peft `>=0.21`, torch `>=2.6,<2.9`, and dev tooling
including pytest, matplotlib and Modal 1.5.5.

Use Node 22, the version in CI, for the playground. Its locked AI SDK also requires Node 22;
the older upstream README's Node 20.9 minimum is insufficient for that dependency. Do not
change dependency bounds or regenerate lockfiles as incidental work.

There is no configured Python lint or typecheck command, no task runner and no installed
repository hook. Python packaging uses setuptools, and there is no release command.

On habit's machine the toolchain is project-local, under the ignored `.local/` of the
checkout: `uv`, a managed CPython 3.13, Node 22 and the uv, npm and Hugging Face caches.
`.local/agent-context.md` records the instances. Nothing is installed globally.

### Notes on affected paths

- Model, loader, trainer and scoring changes need the existing affected-path parity
  evidence. Round reproduction may skip reads absent from this checkout; record the skips.
  Private or archived inputs need separate access authorization, not a test success
  assertion.
- Offline optional private inputs: `kev.suite.load_split` and `scripts.private_rows.restore`
  translate a Hub `LocalEntryNotFoundError` whose direct cause is `OfflineModeIsEnabled` into
  the existing `PermissionError` signal only for the canonical private mirrors
  (`PRIVATE_DATASET` and `DATASET`). This lets existing optional-input branches handle an
  uncached private file without weakening test selection. Public or unknown mirrors,
  ordinary local misses, corrupt local or cache bytes, integrity mismatches and unrelated
  errors retain their failures; available files still pass through the normal hash checks.
  Synthetic regressions block socket connections and use controlled Hub and cache doubles,
  so they require no private input or network access.
- Read Next's relevant local documentation before playground code changes. React Compiler
  forbids synchronous effect setState. Use a real browser to verify hydration; curl only
  proves an HTTP response. Ports and browser tooling in upstream examples are not proof of
  current availability. Space vendoring or publication needs a separately authorized target.

## CI

One workflow, `.github/workflows/ci.yml`, named `ci`. It runs on every `pull_request`, with
no path filter, and on each `push` to `main`.

| Job | What it runs | Required check |
| --- | --- | --- |
| `python` | `uv sync --extra serve`, then the fast suites above; the tokenizer is downloaded from the Hub | yes |
| `playground` | in `playground`: `npm ci`, `npm run lint`, `npx next typegen && npx tsc --noEmit -p .`, on Node 22 | yes |

The governance gate is the third required check. The `push` run on `main` is the product
smoke for a merged commit (`builder.md`, After merge).

No run of this workflow existed on this fork at Initialize: GitHub Actions had never run
here, and habit enabled it during the Initialize run. Until a run is observed, whether
either job passes in Actions is unverified; inspect actual results and do not assume them.

## Actions secrets

CI uses no Actions secret.

Only habit writes Actions secrets (`AGENTS.md`, Secrets).
