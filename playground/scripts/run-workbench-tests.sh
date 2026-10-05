#!/bin/sh
set -eu
umask 077

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
PLAYGROUND="$ROOT/playground"
NODE="$ROOT/.local/node/bin/node"
MODE=${KEV_WORKBENCH_TEST_MODE:?Set deterministic or native workbench test mode}

case "$MODE" in
    deterministic|native) ;;
    *) printf '%s\n' "kev-playground-tests: unsupported mode: $MODE" >&2; exit 2 ;;
esac

if [ ! -x "$NODE" ]; then
    printf '%s\n' "kev-playground-tests: project-local Node 22 is missing at $NODE" >&2
    exit 2
fi

RUN_ID=$("$NODE" -p '`${process.pid}-${Date.now()}`')
DATA_ROOT="$ROOT/.local/playground/verification/issue-7/a1/$MODE-$RUN_ID"
EVIDENCE_ROOT="$ROOT/.local/verification/local-model-workbench/a1/playwright/$MODE-$RUN_ID"
mkdir -p "$DATA_ROOT/tmp" "$DATA_ROOT/xdg" "$EVIDENCE_ROOT"

export KEV_WORKBENCH_DATA_ROOT="$DATA_ROOT"
export KEV_WORKBENCH_EVIDENCE_ROOT="$EVIDENCE_ROOT"
export PLAYWRIGHT_BROWSERS_PATH="$ROOT/.local/tools/playwright"

cd "$PLAYGROUND"
exec "$NODE" node_modules/@playwright/test/cli.js test --config=playwright.workbench.config.ts "$@"
