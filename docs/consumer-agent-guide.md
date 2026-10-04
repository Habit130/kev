# Kev consumer-agent guide

Use this guide when an agent in another project needs Kev's local System One
interface. The consumer project owns its task questions, state inputs, answers,
session records, and run logs. Kev owns model provisioning and the machine-local
registry; do not copy those paths or pins into the consumer configuration.

## Configure named tasks

Copy [`examples/consumer/kev-tasks.example.json`](../examples/consumer/kev-tasks.example.json)
into the consuming project and edit it there. The `kev-project-tasks/1` schema
selects one registered logical model and declares one or more named tasks. Each
task has a non-empty `questions` object using the existing `choice`, `noul`, or
`score` types. Optional descriptions are documentation only.

The project file must not contain checkpoint/base paths, source identities,
revision pins, executable hooks, or machine-registry tasks. Keep project-specific
configuration in the project; do not edit Kev's machine registry to add business
tasks. Kev validates question shapes through the canonical System One request
types. It does not add a scoring implementation.

## Run one session

Set `KEV` to the absolute path of this checkout's `bin/kev`. These commands may
run from the consuming project, which does not need a Kev environment or model
dependencies of its own:

```sh
set -eu
KEV=/absolute/path/to/kev/bin/kev
CONFIG="$PWD/kev-tasks.json"

"$KEV" validate --config "$CONFIG"
OPEN_JSON=$("$KEV" open --config "$CONFIG")
SESSION=$(printf '%s' "$OPEN_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["session"])')

close_session() {
  "$KEV" close --session "$SESSION" >/dev/null || {
    "$KEV" status --session "$SESSION" >&2 || true
    return 1
  }
}
trap close_session EXIT HUP INT TERM

# The input file contains exactly one JSON field named "state".
"$KEV" call --session "$SESSION" --task triage \
  --input state.json --out .local/kev/results/triage.json

# Stdin works for dynamically arriving states; state text is not placed in argv.
"$KEV" call --session "$SESSION" --task review --input - <<'JSON'
{"state":"Synthetic example: the delivery is delayed and the tracking page is unchanged."}
JSON

"$KEV" status --session "$SESSION"
"$KEV" close --session "$SESSION"
trap - EXIT HUP INT TERM
```

`validate` checks the project configuration, registered model, and local
prerequisites without loading weight tensors or starting a process. `open`
returns JSON only after its owned loopback server is ready and reports the actual
checkpoint/base identity, pins, backend, and dtype. An optional `--registry`
override is available to `validate` and `open`; it is normally unnecessary.

One session fixes its model and snapshots all named tasks. Calls may arrive over
time and use different task names without reloading the model. A model field in
input is invalid; task names cannot switch the model. If the source config changes,
calls stop with `changed_config`; close/status use the session record and still
work if that source file was removed. Close explicitly unloads the owned runtime;
there is no idle shutdown, automatic restart, fallback, download, or silent
truncation.

Session records, runtime logs, inputs, and optional result files stay in the
consuming project's `.local/kev/` tree or the caller's project-owned paths. The
tool's ignored `.local/consumer-runtime/` area contains only generic minimal
ownership metadata. Runtime logs do not include state text or task questions by
default. Do not copy consumer rules, snapshots, state, or answers into Kev.

## Errors and recovery

Successful commands print parseable JSON on stdout. Failures exit nonzero, print
structured JSON to stdout, and send human diagnostics to stderr. Stable error
categories are `invalid_config`, `invalid_input`, `unknown_model`,
`unknown_task`, `busy`, `unavailable_environment`, `failed_startup`,
`stale_runtime`, `changed_config`, `rejected_length`, `occupied_output`, and
`failed_close`.

- If `open` returns `busy`, another managed session is loading or owns the
  exclusive slot. Do not retry in a loop, adopt its endpoint, or interrupt it.
- If a workflow is interrupted, use the session path saved from `open`: run
  `status`, then `close`. Never signal a saved PID or delete ownership metadata.
- If the `open` caller is interrupted before it can return or save that path,
  discover session paths only inside this consuming project's
  `.local/kev/sessions/` directory, for example with
  `find "$PWD/.local/kev/sessions" -type f -name session.json -print`. Use the
  path for the interrupted open with the public `status` command, then `close`
  and verify it reports `closed`. A partial record without a saved runtime
  identity may report `stale`; that does not confirm the slot is free. `close`
  verifies ownership and termination before releasing it. If ownership cannot
  be verified, stop and ask the project maintainer rather than signaling a PID
  or editing a record. Do not inspect or print raw session/owner records or
  search other projects.
- A `failed_close` means termination was not confirmed. The slot remains owned;
  inspect status and retry close when possible. Do not start another model or
  claim the slot is free until close confirms it.
- If the source task config changed, close the old session and validate/open a
  new one. `status` and `close` do not need the source config to remain present.
- `--out` refuses an existing destination and only writes after a successful
  answer. Keep results in the consuming project and preserve them according to
  that project's data policy.

The interface is additive: the existing machine registry, batch CLI, and
TypeSafe-compatible `/v1/systemone` request/answer types continue to work.
`call` is a convenience mapping from task names to canonical typed questions,
not a new HTTP task allowlist or a cross-project authorization boundary.

Kev returns typed Choice, Noul, and Score answers; it does not generate free-form
text or trigger business actions. Synthetic examples test wiring, not business
accuracy. Review labelled examples and set thresholds/actions in the consuming
project; model probabilities and scores are not guarantees.
