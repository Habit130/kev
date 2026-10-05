#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
PLAYGROUND="$ROOT/playground"
NODE="$ROOT/.local/node/bin/node"
DATA_ROOT=${KEV_WORKBENCH_DATA_ROOT:?Playwright must allocate an isolated workbench store}
MODE=${KEV_WORKBENCH_TEST_MODE:?Playwright must select deterministic or native mode}

case "$MODE" in
    deterministic|native) ;;
    *) printf '%s\n' "kev-playground-test: unsupported test mode: $MODE" >&2; exit 2 ;;
esac

mkdir -p "$DATA_ROOT/home" "$DATA_ROOT/tmp" "$DATA_ROOT/xdg"
exec /usr/bin/env -i \
    PATH="$ROOT/.local/node/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    HOME="$DATA_ROOT/home" \
    LANG="en_US.UTF-8" \
    TMPDIR="$DATA_ROOT/tmp" \
    XDG_CACHE_HOME="$DATA_ROOT/xdg" \
    KEV_WORKBENCH_DATA_ROOT="$DATA_ROOT" \
    KEV_WORKBENCH_TEST_MODE="$MODE" \
    KEV_LOCAL_INFERENCE_CONFIG="$ROOT/.local/local-inference.json" \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    UV_OFFLINE=1 \
    NEXT_TELEMETRY_DISABLED=1 \
    KEV_API= \
    "$NODE" "$PLAYGROUND/node_modules/next/dist/bin/next" dev --hostname 127.0.0.1 --port 3001
