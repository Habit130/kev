# Triage labels

Use these five canonical roles. Existing product labels remain unchanged.

| Role in Matt skills | Tracker label | Meaning | Color |
| --- | --- | --- | --- |
| needs-triage | `needs-triage` | Orchestration must evaluate the issue | `ededed` |
| needs-info | `needs-info` | Waiting for information needed to freeze the contract | `d876e3` |
| ready-for-agent | `ready-for-agent` | Contract complete and eligible for agent execution | `0e8a16` |
| ready-for-human | `ready-for-human` | Needs habit's decision or human implementation | `b60205` |
| wontfix | `wontfix` | No action will be taken | `ffffff` |

Use at most one of these triage-state labels per issue; retain orthogonal product labels.
`ready-for-agent` is eligibility, not an active ownership claim or Acceptance Pass.
Refresh assignees, claim comments, dependencies, and PR state before dispatch.
An ordinary environment blocker does not use up an execution attempt. Specification
blockers and exhausted repair attempts route to `ready-for-human`.

Governance setup reconciles these labels with `gh label create --repo Habit130/kev --force`.
Do not create synonyms, remove unrelated labels, or treat labels as a substitute for the
full frozen contract and acceptance records.
