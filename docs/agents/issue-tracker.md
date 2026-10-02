# Issue tracker: GitHub

Issues, delivery contracts, and PRDs live in `Habit130/kev` GitHub Issues. Use `gh`
with an explicit `--repo Habit130/kev`; the fork's parent is not the write target.
When a skill says publish to the issue tracker, create a GitHub issue, not a local copy.
The live issue body is the only acceptance-contract body.

## Operations

| Task | Command |
| --- | --- |
| Create | `gh issue create --repo Habit130/kev --title "..." --body-file <file>` |
| Read contract and comments | `gh issue view <number> --repo Habit130/kev --comments` |
| Read labels/assignees | `gh issue view <number> --repo Habit130/kev --json body,labels,assignees,state` |
| List open work | `gh issue list --repo Habit130/kev --state open --limit 100 --json number,title,labels,assignees` |
| Comment | `gh issue comment <number> --repo Habit130/kev --body-file <file>` |
| Label | `gh issue edit <number> --repo Habit130/kev --add-label <label> --remove-label <old-label>` |
| Claim | `gh issue edit <number> --repo Habit130/kev --add-assignee @me` |

Refresh dependencies, contract version, assignees, and existing PRs before claiming.
Multiple sessions may share a GitHub account; assignment alone does not establish a
session owner. Record role, acknowledged contract, branch/worktree, attempt, and resource
allocation in a claim comment. Follow `docs/agents/delivery.md`.

Executable issues use `.github/ISSUE_TEMPLATE/delivery.md` and expand every BASE criterion
in full. Render the issue number and all instructional comments before dispatch. A scope,
criterion, or accepted-boundary change needs a new contract version and acknowledgement.

## Pull requests as a triage surface

PRs as a request surface: no.

GitHub issues and PRs share a number space. Resolve the object type before acting on a
bare number. Feature PRs deliver existing issues; they are not a second requirements body.
Do not close a delivery issue during self-verification or Acceptance. habit squash-merges;
Orchestration verifies completion on the write-remote default branch afterward.

## Maps and dependencies

A planning map may be an issue with child issues linked as native sub-issues, or a task
list when that API is unavailable. Use native issue blocking dependencies when available;
otherwise put `Blocked by: #<number>` in the child body and verify blockers' actual states.
API dependency writes use database issue IDs, not displayed issue numbers. They require
the relevant planning scope; initialization creates no map labels or dependencies.

Non-delivery planning issues may close once their answer and references are recorded.
Delivery issue closure follows the completion gate, never a planning skill's generic
resolve/close example. Do not copy handoff bodies or machine-local context into GitHub.
