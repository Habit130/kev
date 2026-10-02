# AGENTS.md

Local OpenCode sessions inherit global collaboration and safety instructions.
This file defines Habit130/kev boundaries, workflow, review rules, and context routes.
Repository workflow overrides inherited skill examples. Technical detail is loaded on demand.

## Repository boundary

- This public fork supports habit's personal Kev use and small experiments.
  Start with local inference on public small checkpoints and the System One API.
- One repository owns `kev/`, `scripts/`, `modal_app.py`, `tests/`, `playground/`,
  `space/`, and `tools/review/`. Use one root `CONTEXT.md`.
- Preserve upstream attribution, release evidence, model cards, and frozen suite bytes.
  New data needs a new version and manifest. Never commit weights or private records.
- `jaredpalmer/kev`, its Hub repositories, Space, private data builders, and cloud
  resources are upstream-owned references, not writable resources granted to this fork.
- Model downloads, training, paid calls, deployment, publication, resource deletion,
  and access outside this workspace need explicit task-specific authorization.
- `PLAN.md` records inherited research history and methods, not habit's current budget
  or permission. Published skill examples do not override this boundary.
- Follow `playground/AGENTS.md` before playground work. Machine instances belong in
  ignored `.local/agent-context.md`; no credentials belong in governance artifacts.

## Session roles

- Every writing session declares Orchestration, Execution, or Acceptance in its
  initiating prompt.
- Orchestration owns an explicit issue scope and writes only governance artifacts.
  It freezes contracts and handoffs; it does not implement or repair product code.
- Execution owns one issue, branch/worktree, PR, and active writer. It implements
  the frozen contract and returns a complete criterion/evidence Pass/Fail matrix.
- Acceptance is a fresh session that independently verifies the same contract.
  It writes tracker acceptance records only and never repairs the delivery.
- habit starts Execution and Acceptance, owns scope decisions, and alone squash-merges.
  Dispatch, review, handoffs, repair, and completion follow `docs/agents/delivery.md`.

## Git remotes and workflow

- `origin` = `https://github.com/Habit130/kev.git`, the write remote and PR target.
  The existing default branch is `main`; local `main` tracks `origin/main`.
- Start each independent `<type>/<kebab-slug>` branch from the latest `origin/main`.
  Every post-bootstrap delivery has one frozen GitHub issue and one feature PR.
  Do not use stacked PRs. Parallel issues use separate worktrees.
- Use English Conventional Commits and English PR text with Motivation, Changes,
  Verification, and `Closes #<issue>`.
- Agents may branch, commit, push feature branches, and create/update PRs.
  Never merge, enable auto-merge, force-push, or write directly to `main`.
- habit squash-merges. Merged remote branches are deleted automatically.
  Orchestration verifies completion on `origin/main` before safe local cleanup.
- Request Codex with exactly `@codex review`. Record the actual review result;
  a trigger comment is not completed review. Initialization requires independent
  Acceptance even if Codex reports no P0/P1.
- GitHub protects `main` with PR-only delivery and no force-push or deletion.
  Merge methods are squash-only. No required checks or approval count are added
  initially; keep existing CI and report its observed state without assuming success.

## Code Review Rules

- Report a blocking finding only for a concrete P0/P1 introduced on a supported path.
  State trigger, impact, primary evidence, and safe path or exception.
  Style, optional refactors, and stronger-than-contract tests are non-blocking.
  Use `docs/agents/delivery.md` severity definitions; Acceptance confirms Codex findings.
- Flag consequential violations of question isolation or input integrity: sibling
  question leakage, forged delimiters, or silently dropped state content.
  Use `kev.model.encode`, `user_tokens`, and `admit`; an explicit truncation opt-in
  must report truncation. Verify affected paths with existing isolation/parity tests.
- Flag consequential data/privacy violations: private text or family-list disclosure,
  in-place frozen-data edits, or training/evaluation contamination.
  Use new suite versions, hash-pinned manifests, private mirrors, `validate_training`,
  and `pool_conflicts`. Historical reproduction must stay labelled as historical;
  it does not authorize a new contaminated fit or training on eval-only sources.

## Agent skills

Load only the rows triggered by the task.

| Task | Required context |
| --- | --- |
| Issue operations | `docs/agents/issue-tracker.md` |
| Triage and labels | `docs/agents/triage-labels.md` |
| Planning, dispatch, handback, Acceptance, repair, parallel work | `docs/agents/delivery.md` |
| Setup, build, tests, packaging, CI | `docs/agents/build.md` |
| Terms, ownership, architectural decisions | `docs/agents/domain.md`, `CONTEXT.md`, `docs/adr/` |
| Model, serving, training, data, calibration, or module changes | `docs/agents/kev-reference.md`, `.agents/skills/kev-verify/SKILL.md` |
| Registered research or Modal work | `docs/autoresearch.md`, `.agents/skills/kev-modal-study/SKILL.md` |
| Structural review | `.agents/skills/thermonuclear-code-review/SKILL.md` |
| PR writing | `.agents/skills/kev-pr-description/SKILL.md` |
| Earlier research history | `PLAN.md`; `.agents/skills/kev-knowledge/SKILL.md` only after access authorization |
| Published deploy/fine-tune workflows | `skills/kev-deploy/SKILL.md` or `skills/kev-finetune/SKILL.md`, within this fork's boundaries |

## Shared-state gate

- Parallel Execution uses a separate worktree per issue and one active writer per PR.
- Before dispatch, allocate exclusive ownership of each applicable GPU/Metal workload,
  model-server process, listening port, mutable environment, and output directory.
- Cloud work also allocates the confirmed account/app, study/run names, mutable volume
  paths, watcher/pull ownership, and spend budget. Existing leases remain mandatory.
- Record allocations on the issue and handoff; store machine instances in `.local`.
  An unallocated or already-owned resource blocks its use, not unrelated work.
