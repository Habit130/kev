# Kev personal fork

## Repository responsibility

Habit130/kev is a public personal-use and experimentation fork of jaredpalmer/kev.
The first use goal is local inference with public small checkpoints through the
TypeSafe-compatible System One API, followed by explicitly scoped small experiments.
This goal does not require reproducing every upstream result.

The repository owns the Python package, training/evaluation tools, local API server,
playground, Space source, label-review tool, tests, and agent guidance as one context.
The existing engineering and research system is retained. Work is delivered against
frozen issues under the fork's governance, not an inherited unattended-session budget.

## Non-goals

- Taking ownership of upstream releases, Hub repositories, public Space, cloud apps,
  private data builders, or an upstream author's knowledge graph.
- Rebuilding CI, dependency management, or the model architecture during initialization.
- Treating inherited benchmark numbers as measurements on habit's machine.
- Training on eval-only data, copying private records into this public repository,
  or repairing frozen files in place.
- Installing tools, downloading models, spending money, deploying, publishing, or
  deleting resources without an explicit task-specific authorization.

## Related repositories

| Repository or resource | Ownership and use |
| --- | --- |
| `Habit130/kev` | Write target for habit's issues, branches, and PRs; default branch `main` |
| `jaredpalmer/kev` | Upstream code and research reference; no upstream remote is configured here and no upstream PR is implied |
| Upstream `jaredpalmer/kev-*` Hub models and `jaredpalmer/kev-suites` | Published read sources with pinned revisions; downloads need a task authorization |
| Upstream private training/evaluation mirrors and kev-sft companion | Upstream-owned data/builders, not assumed accessible; manifests disclose permitted provenance only |
| Upstream Kev Space and Modal resources | Deployment references, not writable fork infrastructure |

Local account names, endpoints, model-cache locations, and explicitly authorized external
knowledge locations belong in ignored `.local/agent-context.md`. Never record credentials.

## Local use

`docs/local-inference.md` is the authoritative guide to configured local mode: project-local
tooling setup, the shared-base / project-checkpoint storage split, the machine-local task registry,
the batch and serving entry points, their failure behavior, and the constraints. Committed examples
live in `examples/local-inference/`; machine paths and receipts stay in ignored `.local/`.

## Language

| Canonical term | Meaning |
| --- | --- |
| state | Shared input content evaluated by all question branches in one request |
| question | One independently scored branch with instructions and typed candidate options |
| option | A candidate answer within a question; options in one question can interact |
| checkpoint | A loadable Kev model artifact with pointer head and either adapter or full weights |
| temperature | The scalar applied to logits for probability calibration; not an accuracy guarantee |
| workbench | The human-operated local interface in this repository; not a separate model or chat API |
| task template | Reusable named question definitions; portable task configs contain tasks and a logical model, not state inputs or answers |
| library draft | Unfinished in-tab template edits; routine Run uses saved definitions until these edits are explicitly saved |
| restored run draft | An explicitly restored history snapshot on Run; executable independently of its original template, without overwriting saved definitions |
| run | One submitted state and frozen question snapshot, associated with its actual model identity and outcome |
| model session | The existing owned fixed-model runtime; its residency does not depend on whether a browser tab is open |
| run history | Workbench-owned persisted run records in this checkout; not browser storage or a claim about business correctness |
| selected model | The logical model chosen for a future run, distinct from the checkpoint identity actually resident in a model session |
| Acceptance | A fresh, independent verification of the frozen delivery contract; avoid calling research confirmation Acceptance |
| confirmation | A registered research candidate's test/locked-read stage; it does not approve a PR or authorize publication |

Question isolation means a branch cannot read sibling questions. It does not mean option
order is irrelevant. Server admission length, training length, and validated context
length are different quantities; use the current README/model card for release evidence.
