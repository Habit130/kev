# Delivery protocol

This document defines how issue-scoped work moves from a frozen contract to verified
completion. The GitHub issue is the only acceptance-contract body. The repository's
write target is `Habit130/kev`, its default branch is `main`, and no stacked PRs are used.

## Roles

### Orchestration

An Orchestration session owns an explicit set of included and excluded issues. One issue
cannot belong to two active orchestration scopes.

Orchestration may write governance artifacts: issues and tracker state, specifications,
ADRs, roadmaps, AGENTS and `docs/agents/`, frozen handoffs, and acceptance records. It
does not implement or repair product code. A governance validator is a governance artifact,
not authority to change product tests, CI, model behavior, or evaluation code.

Before dispatch, Orchestration:

1. refreshes issues, dependencies, assignees, branches, PRs, comments, and shared state;
2. freezes the complete issue contract;
3. decides `Independent acceptance: required|not required` and records the rationale;
4. allocates one branch/worktree and every applicable machine-level shared resource;
5. writes an immutable Execution handoff and records its path and SHA-256 on the issue.

Replacing Orchestration requires an `ORCH-<scope>-<timestamp>.md` handoff containing the
live frontier, issues, PRs, attempts, findings, and resource allocations. The replacement
refreshes live state before acting.

### Execution

Execution owns one issue, one branch/worktree, one PR, and one active writer. Before
editing, it assigns the issue to the session's GitHub identity and comments with role,
acknowledged contract ID, branch, worktree, attempt, and resource allocations. Sessions
sharing an account still need distinct ownership records.

Execution may choose implementation seams, code structure, and test design inside the
frozen contract. A product decision, scope expansion, or acceptance change stops affected
work for a new contract version. Read-only helpers are allowed; writing helpers do not
share the delivery. Delegation still follows the active session's global instructions.

Execution hands back:

- acknowledged contract ID and exact branch, PR, and head;
- `Criterion ID -> primary evidence -> Pass/Fail` for every BASE and ticket criterion;
- commands run and material output;
- deferred work and out-of-contract findings;
- decisions the contract intentionally left to implementation.

Execution leaves the issue and PR open and releases write ownership. Agents may branch,
commit, push feature branches, and create/update PRs. No agent merges, enables auto-merge,
force-pushes, rewrites remote history, or writes directly to the default branch.

### Acceptance

Acceptance is a fresh session started by habit. It may run checks and write issue/PR
acceptance records. It does not modify the delivery branch, product code, or governance
files. Verification-generated output may be local, but delivery fixes belong to Execution.

Acceptance reads the frozen issue contract, every PR commit, the full diff, directly
affected interaction edges, the delivery evidence matrix, verification output, and Codex
review. Execution reasoning and conclusions are leads, not facts.

Acceptance produces its own complete criterion/evidence Pass/Fail matrix and dispositions
for every Codex or newly observed finding. A Pass is the technical gate for habit; it does
not authorize Acceptance to merge.

## Issue contract

Every post-bootstrap PR links one executable issue. The issue contains:

- Goal;
- included and excluded Scope;
- Dependencies;
- independent acceptance decision and rationale;
- all six expanded BASE criteria;
- ticket criteria with stable IDs and expected evidence;
- exact applicable verification commands and order.

Use `.github/ISSUE_TEMPLATE/delivery.md`. Contract IDs are `AC-<issue>-v<contract>`.
Starting Execution from a frozen handoff confirms that version. A material clarification
creates a new version in the issue and a new immutable handoff. Acceptance uses only the
version acknowledged by the active Execution. Never silently edit acknowledged history.

## Repository baseline

Every executable issue expands these definitions in full:

- **BASE-EVIDENCE**: Execution maps every criterion to primary evidence and Pass/Fail.
  Independent Acceptance, when triggered, provides its own complete mapping.
- **BASE-VERIFY**: Every build, lint, test, typecheck, packaging, or focused command named
  in the issue succeeds in the required order, with output identified as evidence.
- **BASE-SEVERITY**: The PR introduces no independently confirmed P0/P1. Codex findings
  are explicitly confirmed or rejected with evidence under the narrow taxonomy below.
- **BASE-SCOPE**: Work outside included scope is untouched or explicitly recorded as
  deferred; excluded scope is not implemented.
- **BASE-DOCS**: Behavior, interface, workflow, or constraint changes update the
  authoritative documentation in the same delivery.
- **BASE-PR**: The PR links the issue and states Motivation, Changes, and Verification.

Ticket-specific criteria add finite behavior and evidence. They do not use a broad
"no bugs" or "all edge cases" clause. An unavailable environment is a recorded blocker,
not evidence that a named command passed.

## Severity taxonomy

- **P0**: a catastrophic defect introduced by the PR with system-wide or broadly
  irreversible impact, such as widespread unrecoverable data loss, a credential exposure
  that enables unauthorized access, or complete loss of the primary product for nearly
  all supported use. It has no reasonable containment before merge.
- **P1**: a concrete defect introduced by the PR on a supported path that breaks a core
  operation, corrupts canonical or persisted data, or violates an established security or
  privacy boundary, with substantial impact and no acceptable workaround for the affected
  path.
- **P2/P3**: all lower-severity defects, maintainability concerns, optional refactors,
  stronger test suggestions, and out-of-contract improvements. Record them as non-blocking
  follow-up work.

A Codex P0/P1 blocks only after Acceptance independently confirms its trigger, impact,
primary evidence, and severity. An ordinary override comment cannot waive a confirmed
P0/P1. Changing the underlying product or security boundary requires a new issue/ADR and
a new contract. Structural-review preferences do not broaden the severity definitions.

## Codex and conditional independent Acceptance

Request review with a PR comment containing exactly `@codex review`. Read all commits,
comments, reviews, and check/status rollups before reporting one of:

- completed with no P0/P1;
- completed with findings, each awaiting independent disposition;
- unavailable or incomplete.

A trigger comment is not a completed review. Available Codex review is mandatory evidence,
not the final Acceptance decision. No automatic Codex mode is assumed in this fork.

Before dispatch, Orchestration decides whether independent Acceptance is required based
on blast radius, reversibility, cross-boundary effects, implementation judgment, and
deterministic verification strength. It records both the decision and its rationale.

Independent Acceptance is required when:

- Orchestration predeclares it;
- Codex reports a P0/P1;
- Codex review is unavailable or incomplete;
- the repository has no GitHub review path.

Initialization governance delivery always requires independent Acceptance. When Acceptance
was `not required`, a complete Execution self-check plus completed Codex review with no
P0/P1 is the technical merge recommendation, not agent merge authority.

Acceptance cannot fail a delivery against a newly preferred implementation, stronger test,
or unlisted scenario. A finding outside ticket criteria is non-blocking unless it is a
confirmed P0/P1 under BASE-SEVERITY.

## Review boundary

Acceptance reviews the contract, all PR commits, the diff, and direct interaction edges
changed by the diff. It does not audit unrelated unchanged code.

After repair, reopen:

- each failed criterion;
- each previously passed criterion whose implementation, evidence, or direct interaction
  edge changed in the repair diff.

Other passed criteria stay closed unless primary evidence proves regression.

## Failure routing and bounded repair

Classify every Fail:

- **Local defect**: the approach remains valid and a finite correction needs no new design
  judgment. Resume the original Execution for one focused revision when possible.
- **Capability mismatch**: the attempt lacked necessary exploration, integration, or
  judgment. habit starts a fresh, genuinely stronger Execution takeover.
- **Specification blocker**: progress needs a product, scope, or contract decision. Apply
  `ready-for-human` and stop affected work for habit.
- **Execution-environment blocker**: tooling, credentials, platform, or allocated shared
  state prevents a fair attempt. Pause and resolve it without consuming an attempt.

The execution chain has at most three attempts: initial, one focused revision, and one
fresh escalated takeover. Failure after the last available attempt moves the issue to
`ready-for-human` with the evidence and recommended decision.

## Handoffs and shared state

Frozen handoffs live under `docs/orchestration/handoffs/` and are gitignored. The issue
records repository-relative path, contract version, attempt, role, and SHA-256.

```text
AC-<issue>-v<contract>-a<attempt>-execution.md
AC-<issue>-v<contract>-a<attempt>-acceptance.md
ORCH-<scope>-<timestamp>.md
```

Never overwrite a handoff after publishing its digest. An Execution handoff pins the
contract, scope, branch/worktree, resource ownership, verification order, and attempt.
An Acceptance handoff also pins exact PR head, every delivery commit, full diff boundary,
the complete evidence matrix, verification output, Codex status/findings, changed host
settings, and affected interaction edges. habit supplies an ignored artifact when moving
to another machine; the receiving session verifies its published digest.

Parallel issues use separate worktrees from latest `origin/main`, not stacked branches.
Allocate GPU/Metal workloads, server processes, ports, mutable environments, output paths,
cloud apps/studies/volume paths, watchers/pulls, and budgets before use. Record ownership
in issues/handoffs and instance details in `.local/agent-context.md`. Unrelated work can
continue when one resource is blocked. Existing research leases are not optional.

## Completion

Acceptance Pass marks the PR ready for habit. habit squash-merges. The PR uses
`Closes #<issue>`, but Orchestration records Completed only after verifying the exact
delivery on `origin/main`. Remote merged branches are deleted automatically. Local
cleanup follows verification and never deletes a worktree or branch containing unrelated
or unmerged work.

There are no required checks or positive approval count initially. Existing CI remains
evidence; inspect its actual results. This host choice does not waive issue verification,
Codex observation, independent Acceptance when triggered, or habit-only merge authority.
