#!/bin/sh
set -eu
umask 077

fail() {
    printf 'kev-playground: %s\n' "$1" >&2
    if [ "${STARTED:-0}" = 1 ]; then
        stop_started_server
    fi
    exit 1
}

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
PROJECT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd) || exit 1
PROJECT_ROOT_REAL=$(CDPATH= cd -- "$PROJECT_ROOT" && pwd -P) || exit 1
PATH="$PROJECT_ROOT/.local/node/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH
PLAYGROUND_ROOT="$PROJECT_ROOT/playground"
NODE="$PROJECT_ROOT/.local/node/bin/node"
NEXT_CLI="$PLAYGROUND_ROOT/node_modules/next/dist/bin/next"
LOCAL_ROOT="$PROJECT_ROOT/.local"
DATA_ROOT="$LOCAL_ROOT/playground"
WORKBENCH_ROOT="$DATA_ROOT/workbench"
RUNTIME_ROOT="$WORKBENCH_ROOT/runtime"
LAUNCH_DIR="$WORKBENCH_ROOT/launcher"
LOG_ROOT="$WORKBENCH_ROOT/logs"
PID_FILE="$LAUNCH_DIR/server.pid"
LOCK_DIR="$LAUNCH_DIR/start.lock"
LOG_FILE="$LOG_ROOT/launcher.log"
URL="http://127.0.0.1:3001/"
APP_PID=
STARTED=0
LOCKED=0

check_directory() {
    directory=$1
    expected=$2
    actual=$(CDPATH= cd -- "$directory" && pwd -P) || fail "Cannot resolve project-local directory $directory."
    if [ "$actual" != "$expected" ]; then
        fail "Refusing to use a workbench directory outside this checkout: $directory."
    fi
}

launcher_process_is_owned() {
    candidate=$1
    case "$candidate" in
        ''|*[!0-9]*) return 1 ;;
    esac
    kill -0 "$candidate" 2>/dev/null || return 1
    process_command=$(ps -p "$candidate" -o command= 2>/dev/null || true)
    case "$process_command" in
        *"$PROJECT_ROOT/bin/kev-playground.command"*) return 0 ;;
        *) return 1 ;;
    esac
}

server_is_owned() {
    candidate=$1
    case "$candidate" in
        ''|*[!0-9]*) return 1 ;;
    esac
    kill -0 "$candidate" 2>/dev/null || return 1
    process_command=$(ps -p "$candidate" -o command= 2>/dev/null || true)
    case "$process_command" in
        *"$NEXT_CLI"*'dev --hostname 127.0.0.1 --port 3001'*) return 0 ;;
        *) return 1 ;;
    esac
}

listener_pids() {
    lsof -nP -tiTCP:3001 -sTCP:LISTEN 2>/dev/null || true
}

process_descends_from_server() {
    child_pid=$1
    depth=0
    while [ "$child_pid" -gt 1 ] && [ "$depth" -lt 20 ]; do
        if [ "$child_pid" = "$APP_PID" ]; then
            return 0
        fi
        parent_pid=$(ps -p "$child_pid" -o ppid= 2>/dev/null | tr -d ' ' || true)
        case "$parent_pid" in
            ''|*[!0-9]*) return 1 ;;
        esac
        child_pid=$parent_pid
        depth=$((depth + 1))
    done
    return 1
}

listener_is_owned() {
    for listener_pid in $1; do
        if process_descends_from_server "$listener_pid"; then
            return 0
        fi
    done
    return 1
}

remove_pid_file() {
    if [ -f "$PID_FILE" ] && [ ! -L "$PID_FILE" ]; then
        saved_pid=$(cat "$PID_FILE" 2>/dev/null || true)
        if [ "$saved_pid" = "$1" ]; then
            rm -f "$PID_FILE"
        fi
    fi
}

stop_started_server() {
    if [ "${STARTED:-0}" = 1 ] && server_is_owned "$APP_PID"; then
        kill -TERM "$APP_PID" 2>/dev/null || true
        wait "$APP_PID" 2>/dev/null || true
    fi
    remove_pid_file "${APP_PID:-}"
    STARTED=0
}

release_lock() {
    if [ "$LOCKED" = 1 ] && [ -d "$LOCK_DIR" ] && [ ! -L "$LOCK_DIR" ]; then
        if [ -f "$LOCK_DIR/pid" ] && [ ! -L "$LOCK_DIR/pid" ] && [ "$(cat "$LOCK_DIR/pid" 2>/dev/null || true)" = "$$" ]; then
            rm -f "$LOCK_DIR/pid"
            rmdir "$LOCK_DIR" 2>/dev/null || true
        fi
    fi
    LOCKED=0
}

handle_signal() {
    status=$1
    trap - INT TERM HUP
    stop_started_server
    exit "$status"
}

trap 'release_lock' EXIT
trap 'handle_signal 130' INT
trap 'handle_signal 143' TERM HUP

if [ ! -x "$NODE" ]; then
    fail "Project-local Node 22 is missing at $NODE. Follow playground/README.md setup; do not install Node globally."
fi
node_version=$("$NODE" --version 2>/dev/null || true)
case "$node_version" in
    v22.*) ;;
    *) fail "Expected project-local Node 22 at $NODE; found ${node_version:-no version}. Follow playground/README.md setup." ;;
esac
if [ ! -f "$NEXT_CLI" ] || [ ! -d "$PLAYGROUND_ROOT/node_modules" ]; then
    fail "Playground dependencies are missing. From the checkout root, run PATH=\"\$PWD/.local/node/bin:\$PATH\" npm ci --prefix playground."
fi
for command_name in curl lsof open ps; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
        fail "Required macOS command '$command_name' is unavailable; resolve this prerequisite before launching."
    fi
done
if [ ! -d "$PLAYGROUND_ROOT" ]; then
    fail "The playground directory is missing from this checkout."
fi
if [ -L "$LOCAL_ROOT" ]; then
    fail "Refusing to follow a .local symlink outside this checkout."
fi
check_directory "$LOCAL_ROOT" "$PROJECT_ROOT_REAL/.local"
if [ -L "$DATA_ROOT" ]; then
    fail "Refusing to follow a .local/playground symlink outside this checkout."
fi
mkdir -p "$DATA_ROOT"
check_directory "$DATA_ROOT" "$PROJECT_ROOT_REAL/.local/playground"
for directory in "$WORKBENCH_ROOT" "$LAUNCH_DIR" "$RUNTIME_ROOT" "$RUNTIME_ROOT/home" "$RUNTIME_ROOT/tmp" "$RUNTIME_ROOT/xdg" "$LOG_ROOT"; do
    if [ -L "$directory" ]; then
        fail "Refusing to follow a symlink in the project-local workbench data tree: $directory."
    fi
done
mkdir -p "$LAUNCH_DIR" "$RUNTIME_ROOT/home" "$RUNTIME_ROOT/tmp" "$RUNTIME_ROOT/xdg" "$LOG_ROOT"
check_directory "$WORKBENCH_ROOT" "$PROJECT_ROOT_REAL/.local/playground/workbench"
check_directory "$LAUNCH_DIR" "$PROJECT_ROOT_REAL/.local/playground/workbench/launcher"
check_directory "$RUNTIME_ROOT" "$PROJECT_ROOT_REAL/.local/playground/workbench/runtime"
check_directory "$RUNTIME_ROOT/home" "$PROJECT_ROOT_REAL/.local/playground/workbench/runtime/home"
check_directory "$RUNTIME_ROOT/tmp" "$PROJECT_ROOT_REAL/.local/playground/workbench/runtime/tmp"
check_directory "$RUNTIME_ROOT/xdg" "$PROJECT_ROOT_REAL/.local/playground/workbench/runtime/xdg"
check_directory "$LOG_ROOT" "$PROJECT_ROOT_REAL/.local/playground/workbench/logs"

for file in "$PID_FILE" "$LOG_FILE"; do
    if [ -L "$file" ] || { [ -e "$file" ] && [ ! -f "$file" ]; }; then
        fail "Refusing to use a non-regular launcher file: $file."
    fi
done
: >> "$LOG_FILE"

lock_attempt=0
while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    if [ -L "$LOCK_DIR" ] || [ ! -d "$LOCK_DIR" ]; then
        fail "Launcher lock path is not a real directory: $LOCK_DIR."
    fi
    if [ -f "$LOCK_DIR/pid" ] && [ ! -L "$LOCK_DIR/pid" ]; then
        lock_pid=$(cat "$LOCK_DIR/pid" 2>/dev/null || true)
        if ! launcher_process_is_owned "$lock_pid"; then
            sleep 1
            lock_pid=$(cat "$LOCK_DIR/pid" 2>/dev/null || true)
            if ! launcher_process_is_owned "$lock_pid"; then
                rm -f "$LOCK_DIR/pid"
                rmdir "$LOCK_DIR" 2>/dev/null || true
            fi
        fi
    fi
    lock_attempt=$((lock_attempt + 1))
    if [ "$lock_attempt" -ge 120 ]; then
        fail "Another launcher operation is still active. Wait for it to finish, then try again."
    fi
    sleep 1
done
LOCKED=1
printf '%s\n' "$$" > "$LOCK_DIR/pid"

if [ -f "$PID_FILE" ]; then
    APP_PID=$(cat "$PID_FILE" 2>/dev/null || true)
    if ! server_is_owned "$APP_PID"; then
        rm -f "$PID_FILE"
        APP_PID=
    fi
fi

listeners=$(listener_pids)
if [ -n "$listeners" ]; then
    if [ -z "$APP_PID" ] || ! listener_is_owned "$listeners"; then
        fail "Port 3001 is occupied by a server this launcher does not own. It will not attach to or stop it; close that app intentionally and run this launcher again."
    fi
elif [ -z "$APP_PID" ]; then
    (
        CDPATH= cd -- "$PLAYGROUND_ROOT"
        exec /usr/bin/env -i \
            PATH="$PROJECT_ROOT/.local/node/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
            HOME="$RUNTIME_ROOT/home" \
            LANG="en_US.UTF-8" \
            NODE_ENV=development \
            NEXT_TELEMETRY_DISABLED=1 \
            KEV_LOCAL_INFERENCE_CONFIG="$PROJECT_ROOT/.local/local-inference.json" \
            KEV_API="http://127.0.0.1:8009" \
            KEV_TRUNCATE_STATES=0 \
            HF_HUB_OFFLINE=1 \
            TRANSFORMERS_OFFLINE=1 \
            UV_OFFLINE=1 \
            PYTHONNOUSERSITE=1 \
            TMPDIR="$RUNTIME_ROOT/tmp" \
            XDG_CACHE_HOME="$RUNTIME_ROOT/xdg" \
            "$NODE" "$NEXT_CLI" dev --hostname 127.0.0.1 --port 3001
    ) >> "$LOG_FILE" 2>&1 </dev/null &
    APP_PID=$!
    STARTED=1
    PID_TEMP="$PID_FILE.tmp.$$"
    if [ -e "$PID_TEMP" ] || [ -L "$PID_TEMP" ]; then
        fail "A temporary launcher PID file already exists; inspect it before retrying: $PID_TEMP."
    fi
    printf '%s\n' "$APP_PID" > "$PID_TEMP"
    mv "$PID_TEMP" "$PID_FILE"
fi

ready=0
attempt=0
while [ "$attempt" -lt 120 ]; do
    if ! server_is_owned "$APP_PID"; then
        tail -n 30 "$LOG_FILE" >&2 || true
        fail "The workbench server exited before becoming ready. See $LOG_FILE."
    fi
    listeners=$(listener_pids)
    if [ -n "$listeners" ] && ! listener_is_owned "$listeners"; then
        fail "Port 3001 is listening under a different process. The launcher will not use or stop it."
    fi
    if [ -n "$listeners" ] && curl --fail --silent --output /dev/null "$URL" 2>/dev/null; then
        ready=1
        break
    fi
    sleep 1
    attempt=$((attempt + 1))
done
if [ "$ready" != 1 ]; then
    tail -n 30 "$LOG_FILE" >&2 || true
    fail "The workbench did not become ready within 120 seconds. See $LOG_FILE; rerun after resolving the reported startup error."
fi

printf 'Kev workbench is ready at %s\n' "$URL"
if ! open "$URL"; then
    printf 'kev-playground: The browser could not be opened automatically. Open %s manually.\n' "$URL" >&2
fi

release_lock
if [ "$STARTED" = 1 ]; then
    printf 'Leave this Terminal window open to keep the workbench server running. Press Ctrl-C to stop the web app; stop the model in the page first if its slot should be released.\n'
    set +e
    wait "$APP_PID"
    server_status=$?
    set -e
    STARTED=0
    remove_pid_file "$APP_PID"
    exit "$server_status"
fi
