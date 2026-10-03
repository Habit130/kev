"""Project-owned task configuration and on-demand local inference sessions."""

import argparse
import fcntl
import hashlib
import http.client
import json
import os
import secrets
import socket
import sys
import subprocess
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from pydantic import ValidationError

from .api import SystemOneRequest
from .checkpoint import Checkpoint
from .local import MODE_ENV, LocalConfigError, load_registry, require_artifact, resolved_meta

ROOT = Path(__file__).resolve().parents[1]
PROJECT_SCHEMA = "kev-project-tasks/1"
SESSION_SCHEMA = "kev-consumer-session/1"
PROJECT_KEYS = {"schema", "model", "tasks", "description"}
TASK_KEYS = {"questions", "description"}
QUESTION_KEYS = {
    "choice": {"type", "instructions", "criteria"},
    "noul": {"type", "instructions", "criteria"},
    "score": {"type", "instructions", "criteria"},
}
RUNTIME_ROOT = ROOT / ".local" / "consumer-runtime"
SLOT_LOCK = RUNTIME_ROOT / "slot.lock"
OWNER_FILE = RUNTIME_ROOT / "owner.json"
STARTUP_TIMEOUT = 300.0
SHUTDOWN_TIMEOUT = 15.0
POLL_INTERVAL = 0.1


class ConsumerError(Exception):
    """A stable public failure category and a human-readable explanation."""

    def __init__(self, category, message, details=None):
        super().__init__(message)
        self.category = category
        self.details = details or {}


def _description(where, value):
    if value is not None and not isinstance(value, str):
        raise ConsumerError("invalid_config", f"{where} must be a string when given")


def _validate_project_body(body, path):
    if not isinstance(body, dict):
        raise ConsumerError("invalid_config", f"{path}: project task configuration must be a JSON object")
    unknown = sorted(set(body) - PROJECT_KEYS)
    if unknown:
        raise ConsumerError("invalid_config", f"{path}: unknown project keys {unknown}")
    if body.get("schema") != PROJECT_SCHEMA:
        raise ConsumerError("invalid_config", f"{path}: schema must be {PROJECT_SCHEMA!r}")
    _description("description", body.get("description"))
    model_id = body.get("model")
    if not isinstance(model_id, str) or not model_id:
        raise ConsumerError("invalid_config", f"{path}: 'model' must name a registered logical model")
    tasks = body.get("tasks")
    if not isinstance(tasks, dict) or not tasks:
        raise ConsumerError("invalid_config", f"{path}: 'tasks' must be a non-empty object")

    for task_id, task in tasks.items():
        where = f"{path}: tasks[{task_id!r}]"
        if not isinstance(task_id, str) or not task_id:
            raise ConsumerError("invalid_config", f"{path}: task names must be non-empty strings")
        if not isinstance(task, dict):
            raise ConsumerError("invalid_config", f"{where} must be an object")
        unknown = sorted(set(task) - TASK_KEYS)
        if unknown:
            raise ConsumerError("invalid_config", f"{where}: unknown task keys {unknown}")
        _description(f"{where}.description", task.get("description"))
        questions = task.get("questions")
        if not isinstance(questions, dict) or not questions:
            raise ConsumerError("invalid_config", f"{where}: 'questions' must be a non-empty object")
        for question_id, question in questions.items():
            qwhere = f"{where}.questions[{question_id!r}]"
            if not isinstance(question_id, str) or not question_id:
                raise ConsumerError("invalid_config", f"{where}: question names must be non-empty strings")
            if not isinstance(question, dict):
                raise ConsumerError("invalid_config", f"{qwhere} must be an object")
            kind = question.get("type")
            if not isinstance(kind, str) or kind not in QUESTION_KEYS:
                raise ConsumerError("invalid_config", f"{qwhere}: type must be one of {sorted(QUESTION_KEYS)}")
            extra = sorted(set(question) - QUESTION_KEYS[kind])
            if extra:
                raise ConsumerError("invalid_config", f"{qwhere}: unknown {kind} question fields {extra}")
        try:
            SystemOneRequest.model_validate({"state": "", "model": model_id, "questions": questions})
        except ValidationError as exc:
            problems = "; ".join(
                f"{'.'.join(map(str, item['loc']))}: {item['msg']}"
                for item in exc.errors(include_input=False)
            )
            raise ConsumerError("invalid_config", f"{where}: invalid typed questions: {problems}") from None
    return model_id, tasks


def _read_project_config(config_path):
    path = Path(config_path).expanduser().absolute()
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise ConsumerError("invalid_config", f"project configuration {path} cannot be read: {exc.strerror}") from None
    try:
        body = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ConsumerError("invalid_config", f"{path}: not valid UTF-8 JSON: {exc}") from None
    model_id, tasks = _validate_project_body(body, path)
    return path, raw, body, model_id, tasks


def _registry_path(explicit):
    value = explicit or os.environ.get(MODE_ENV) or ROOT / ".local" / "local-inference.json"
    return Path(value).expanduser().resolve()


def _preflight(config_path, registry_path=None):
    """Validate project tasks and resolve the selected local artifacts without loading model weights."""
    path, raw, body, model_id, tasks = _read_project_config(config_path)
    registry_file = _registry_path(registry_path)
    try:
        registry = load_registry(registry_file)
    except LocalConfigError as exc:
        raise ConsumerError("unavailable_environment", str(exc)) from None
    model = registry.models.get(model_id)
    if model is None:
        raise ConsumerError("unknown_model", f"unknown registered model {model_id!r}; known ids: {sorted(registry.models)}")
    try:
        from .local import resolve_model

        resolved = resolve_model(registry, model_id)
    except Exception as exc:
        raise ConsumerError("unavailable_environment", str(exc)) from None
    return path, raw, body, model_id, tasks, registry_file, resolved


def validate(config_path, registry_path=None):
    """Validate consumer tasks and selected local model prerequisites without loading model weights."""
    path, _, _, model_id, tasks, _, _ = _preflight(config_path, registry_path)
    return {
        "valid": True,
        "schema": PROJECT_SCHEMA,
        "config": str(path),
        "model": model_id,
        "tasks": sorted(tasks),
    }


def _is_within(path, root):
    try:
        Path(path).relative_to(Path(root))
        return True
    except ValueError:
        return False


def _project_path(project_root, raw_path, what, *, must_exist=False):
    path = Path(raw_path).expanduser()
    candidate = path if path.is_absolute() else Path(project_root) / path
    try:
        resolved = candidate.resolve(strict=must_exist)
        root = Path(project_root).resolve(strict=True)
    except (OSError, RuntimeError, ValueError) as exc:
        detail = getattr(exc, "strerror", None) or str(exc)
        raise ConsumerError("invalid_input", f"{what} path cannot be resolved: {detail}") from None
    if not _is_within(resolved, root):
        raise ConsumerError("invalid_input", f"{what} must stay inside the consuming project")
    return resolved


def _project_session_dir(project_root, session_id):
    project_root = Path(project_root).resolve(strict=True)
    local_root = Path(project_root) / ".local"
    kev_root = local_root / "kev"
    sessions_root = kev_root / "sessions"
    for path in (local_root, kev_root, sessions_root):
        if path.is_symlink():
            raise ConsumerError("invalid_config", f"consumer runtime directory {path} may not be a symlink")
        if path.exists() and not path.is_dir():
            raise ConsumerError("invalid_config", f"consumer runtime path {path} is not a directory")
    for path in (local_root, kev_root, sessions_root):
        path.mkdir(mode=0o700, exist_ok=True)
        if not _is_within(path.resolve(strict=True), project_root):
            raise ConsumerError("invalid_config", f"consumer runtime directory {path} escapes the project")
    session_dir = sessions_root / session_id
    session_dir.mkdir(mode=0o700)
    return session_dir


def _write_json_atomic(path, value):
    path = Path(path)
    temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.partial")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, indent=2, ensure_ascii=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def _read_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None


def _acquire_slot(*, required=True):
    if RUNTIME_ROOT.is_symlink():
        raise ConsumerError("unavailable_environment", "Kev runtime metadata directory may not be a symlink")
    try:
        RUNTIME_ROOT.mkdir(parents=True, mode=0o700, exist_ok=True)
        flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(SLOT_LOCK, flags, 0o600)
    except OSError as exc:
        raise ConsumerError("unavailable_environment", f"cannot open the managed-runtime slot: {exc.strerror}") from None
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        if required:
            raise ConsumerError("busy", "another managed project owns or is starting the inference session") from None
        return None
    except OSError as exc:
        os.close(fd)
        raise ConsumerError("unavailable_environment", f"cannot acquire the managed-runtime slot: {exc.strerror}") from None
    return fd


def _owner_document(session):
    process = session.get("process") or {}
    return {
        "schema": "kev-consumer-runtime/1",
        "session_id": session["id"],
        "owner_token": session["owner_token"],
        "model_id": session["model_id"],
        "state": session["state"],
        "endpoint": session.get("endpoint"),
        "pid": process.get("pid"),
        "process_started_at": process.get("started_at"),
    }


def _owner_matches(session, owner=None):
    owner = _read_json(OWNER_FILE) if owner is None else owner
    return bool(
        isinstance(owner, dict)
        and owner.get("schema") == "kev-consumer-runtime/1"
        and owner.get("session_id") == session.get("id")
        and owner.get("owner_token") == session.get("owner_token")
    )


def _remove_owner(session):
    owner = _read_json(OWNER_FILE)
    if _owner_matches(session, owner):
        OWNER_FILE.unlink(missing_ok=True)


def _server_command(registry_path, model_id, fd, port, owner_token, session_record):
    return [
        str(ROOT / ".venv" / "bin" / "python"),
        "-m",
        "kev.serve",
        "--config",
        str(registry_path),
        "--model-id",
        model_id,
        "--host",
        "127.0.0.1",
        "--port",
        str(port),
        "--fd",
        str(fd),
        f"--owner-token={owner_token}",
        f"--session-record={session_record}",
    ]


def _runtime_environment(registry_path, session_dir):
    keep = (
        "PATH",
        "HOME",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "OMP_NUM_THREADS",
        "VECLIB_MAXIMUM_THREADS",
        "OPENBLAS_NUM_THREADS",
        "MKL_NUM_THREADS",
        "DYLD_LIBRARY_PATH",
        "DYLD_FRAMEWORK_PATH",
    )
    env = {name: os.environ[name] for name in keep if name in os.environ}
    cache = Path(session_dir) / "cache"
    hf_home = cache / "huggingface"
    xdg = cache / "xdg"
    tmp = Path(session_dir) / "tmp"
    for path in (cache, hf_home, xdg, tmp):
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
    env.update(
        {
            "PYTHONPATH": str(ROOT),
            "PYTHONNOUSERSITE": "1",
            "KEV_LOCAL_INFERENCE_CONFIG": str(registry_path),
            "KEV_TRUNCATE_STATES": "0",
            "HF_HOME": str(hf_home),
            "HF_HUB_CACHE": str(hf_home / "hub"),
            "HUGGINGFACE_HUB_CACHE": str(hf_home / "hub"),
            "HF_XET_CACHE": str(hf_home / "xet"),
            "TRANSFORMERS_CACHE": str(hf_home / "transformers"),
            "HF_HUB_OFFLINE": "1",
            "TRANSFORMERS_OFFLINE": "1",
            "HF_HUB_DISABLE_IMPLICIT_TOKEN": "1",
            "HF_HUB_DISABLE_TELEMETRY": "1",
            "XDG_CACHE_HOME": str(xdg),
            "TORCH_HOME": str(cache / "torch"),
            "TMPDIR": str(tmp),
        }
    )
    return env


def _spawn_server(command, env, socket_fd, slot_fd, project_root, log_stream):
    return subprocess.Popen(
        command,
        cwd=project_root,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=log_stream,
        stderr=subprocess.STDOUT,
        close_fds=True,
        pass_fds=(socket_fd, slot_fd),
    )


def _process_info(process_record, session_record):
    if not isinstance(process_record, dict):
        return "missing", None
    try:
        pid = int(process_record["pid"])
        token = process_record["owner_token"]
        started_at = process_record.get("started_at")
    except (KeyError, TypeError, ValueError):
        return "missing", None
    if not isinstance(token, str) or not token or (started_at is not None and not isinstance(started_at, str)):
        return "missing", None
    start = subprocess.run(["/bin/ps", "-p", str(pid), "-o", "lstart="], capture_output=True, text=True)
    command = subprocess.run(["/bin/ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True)
    if start.returncode != 0 or command.returncode != 0 or not start.stdout.strip() or not command.stdout.strip():
        return "missing", None
    start_text = start.stdout.strip()
    command_text = command.stdout.strip()
    if (
        (started_at is not None and start_text != started_at)
        or f"--owner-token={token}" not in command_text
        or f"--session-record={session_record}" not in command_text
    ):
        return "reused", None
    return "owned", {"pid": pid, "started_at": start_text, "owner_token": token}


def _http_json(endpoint, method, path, body=None, headers=None, timeout=1.0):
    from urllib.parse import urlsplit

    try:
        parsed = urlsplit(endpoint)
        port = parsed.port
    except (TypeError, ValueError):
        raise OSError("managed endpoint is not loopback HTTP") from None
    if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or port is None:
        raise OSError("managed endpoint is not loopback HTTP")
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        encoded = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        request_headers = dict(headers or {})
        if encoded is not None:
            request_headers["Content-Type"] = "application/json"
        connection.request(method, path, body=encoded, headers=request_headers)
        response = connection.getresponse()
        raw = response.read()
        if not raw:
            decoded = None
        else:
            decoded = json.loads(raw.decode("utf-8"))
        return response.status, decoded
    finally:
        connection.close()


def _local_identity(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get("models"), list):
        return None
    for model in payload["models"]:
        if isinstance(model, dict) and isinstance(model.get("local"), dict):
            return model["local"]
    return None


def _identity_matches(expected, actual):
    if not isinstance(actual, dict):
        return False
    for field in ("model_id", "checkpoint", "base"):
        if actual.get(field) != expected.get(field):
            return False
    return all(isinstance(actual.get(field), str) and actual[field] for field in ("backend", "dtype", "device"))


def _runtime_identity(endpoint, timeout=1.0):
    try:
        status, payload = _http_json(endpoint, "GET", "/v1/models", timeout=timeout)
    except (OSError, http.client.HTTPException, json.JSONDecodeError, UnicodeDecodeError):
        return None
    if status != 200:
        return None
    return _local_identity(payload)


def _wait_until_gone(process, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            return True
        time.sleep(POLL_INTERVAL)
    return process.poll() is not None


def _stop_startup_child(process, session):
    if process is None or process.poll() is not None:
        return True
    endpoint = session.get("endpoint")
    if endpoint:
        try:
            _http_json(
                endpoint,
                "POST",
                "/__kev/consumer/shutdown",
                headers={"x-kev-owner-token": session["owner_token"]},
                timeout=0.5,
            )
        except (OSError, http.client.HTTPException, json.JSONDecodeError, UnicodeDecodeError):
            pass
    if _wait_until_gone(process, min(2.0, SHUTDOWN_TIMEOUT)):
        return True
    # This is still our unreaped direct child; Popen owns its PID and no other
    # process can reuse it before wait() reaps it.
    if process.poll() is None:
        process.terminate()
    try:
        process.wait(timeout=SHUTDOWN_TIMEOUT)
        return True
    except subprocess.TimeoutExpired:
        return False


def _open_result(record_path, session):
    return {
        "session": str(record_path),
        "id": session["id"],
        "state": session["state"],
        "endpoint": session.get("endpoint"),
        "identity": session.get("identity"),
    }


def open_session(config_path, registry_path=None):
    """Open one fixed-model consumer session, retaining the exclusive slot in its server process."""
    path, raw, body, model_id, tasks, registry_file, resolved = _preflight(config_path, registry_path)
    project_root = path.parent.resolve(strict=True)
    session_id = uuid.uuid4().hex
    owner_token = secrets.token_hex(24)
    slot_fd = _acquire_slot()
    session_dir = None
    record_path = None
    server_socket = None
    process = None
    log_stream = None
    session = None
    try:
        session_dir = _project_session_dir(project_root, session_id)
        record_path = session_dir / "session.json"
        log_path = session_dir / "runtime.log"
        session = {
            "schema": SESSION_SCHEMA,
            "id": session_id,
            "owner_token": owner_token,
            "state": "starting",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "project_root": str(project_root),
            "source_config": str(path),
            "source_config_sha256": hashlib.sha256(raw).hexdigest(),
            "description": body.get("description"),
            "model_id": model_id,
            "tasks": tasks,
            "endpoint": None,
            "identity": None,
            "process": None,
            "runtime_log": str(log_path),
        }
        _write_json_atomic(record_path, session)
        server_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server_socket.bind(("127.0.0.1", 0))
        server_socket.listen()
        port = server_socket.getsockname()[1]
        session["endpoint"] = f"http://127.0.0.1:{port}"
        owner = _owner_document(session)
        _write_json_atomic(OWNER_FILE, owner)
        _write_json_atomic(record_path, session)

        command = _server_command(registry_file, model_id, server_socket.fileno(), port, owner_token, record_path)
        env = _runtime_environment(registry_file, session_dir)
        log_fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        log_stream = os.fdopen(log_fd, "ab")
        process = _spawn_server(command, env, server_socket.fileno(), slot_fd, project_root, log_stream)
        server_socket.close()
        server_socket = None
        log_stream.close()
        log_stream = None
        session["process"] = {"pid": process.pid, "started_at": None, "owner_token": owner_token}
        _write_json_atomic(record_path, session)
        _write_json_atomic(OWNER_FILE, _owner_document(session))

        started_at = None
        identity_deadline = time.monotonic() + 3.0
        while time.monotonic() < identity_deadline:
            if process.poll() is not None:
                break
            probe = subprocess.run(["/bin/ps", "-p", str(process.pid), "-o", "lstart="], capture_output=True, text=True)
            if probe.returncode == 0 and probe.stdout.strip():
                started_at = probe.stdout.strip()
                break
            time.sleep(POLL_INTERVAL)
        if process.poll() is not None or started_at is None:
            raise ConsumerError("failed_startup", "managed runtime exited before its process identity was recorded")

        session["process"]["started_at"] = started_at
        _write_json_atomic(record_path, session)
        _write_json_atomic(OWNER_FILE, _owner_document(session))

        deadline = time.monotonic() + STARTUP_TIMEOUT
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise ConsumerError("failed_startup", "managed runtime exited before becoming ready")
            actual = _runtime_identity(session["endpoint"], timeout=min(1.0, max(0.1, deadline - time.monotonic())))
            if actual is not None:
                if not _identity_matches(resolved.card(backend=None, dtype=None, device=None), actual):
                    raise ConsumerError("failed_startup", "ready endpoint reported a different model identity")
                session["identity"] = actual
                session["state"] = "ready"
                _write_json_atomic(record_path, session)
                _write_json_atomic(OWNER_FILE, _owner_document(session))
                return _open_result(record_path, session)
            time.sleep(POLL_INTERVAL)
        raise ConsumerError("failed_startup", "managed runtime did not become ready before the startup deadline")
    except ConsumerError as exc:
        if session is not None:
            stopped = _stop_startup_child(process, session)
            session["state"] = "failed" if stopped else "failed_close"
            session["startup_error"] = {"category": exc.category, "message": str(exc)}
            if not stopped:
                _write_json_atomic(OWNER_FILE, _owner_document(session))
            else:
                _remove_owner(session)
            _write_json_atomic(record_path, session)
            details = {**exc.details, "session": str(record_path)}
            exc = ConsumerError(exc.category, str(exc), details)
        raise exc
    except (OSError, subprocess.SubprocessError) as exc:
        if session is not None:
            stopped = _stop_startup_child(process, session)
            session["state"] = "failed" if stopped else "failed_close"
            session["startup_error"] = {"category": "failed_startup", "message": "managed runtime could not start"}
            if not stopped:
                _write_json_atomic(OWNER_FILE, _owner_document(session))
            else:
                _remove_owner(session)
            _write_json_atomic(record_path, session)
        raise ConsumerError("failed_startup", f"managed runtime could not start: {type(exc).__name__}",
                            {"session": str(record_path)} if record_path else None) from None
    finally:
        if server_socket is not None:
            server_socket.close()
        if log_stream is not None:
            log_stream.close()
        if slot_fd is not None:
            os.close(slot_fd)


def _load_session(session_path):
    path = Path(session_path).expanduser().absolute()
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ConsumerError("invalid_input", f"session record {path} cannot be read: {type(exc).__name__}") from None
    if not isinstance(record, dict) or record.get("schema") != SESSION_SCHEMA:
        raise ConsumerError("invalid_input", f"{path}: not a {SESSION_SCHEMA} session record")
    try:
        actual_path = path.resolve(strict=True)
    except (OSError, RuntimeError, ValueError):
        raise ConsumerError("invalid_input", f"{path}: invalid project-owned session path") from None
    if not isinstance(record.get("id"), str) or not isinstance(record.get("tasks"), dict):
        raise ConsumerError("invalid_input", f"{path}: incomplete session record")
    session_dir = actual_path.parent
    if (
        actual_path.name != "session.json"
        or session_dir.name != record["id"]
        or session_dir.parent.name != "sessions"
        or session_dir.parent.parent.name != "kev"
        or session_dir.parent.parent.parent.name != ".local"
        or len(actual_path.parents) < 5
    ):
        raise ConsumerError("invalid_input", "session record must remain in its consuming project's .local/kev/sessions area")
    project_root = actual_path.parents[4]
    try:
        recorded_root = Path(record["project_root"]).resolve(strict=True)
    except (KeyError, OSError, RuntimeError, TypeError, ValueError):
        raise ConsumerError("invalid_input", f"{path}: invalid consuming-project root") from None
    if recorded_root != project_root:
        raise ConsumerError("invalid_input", "session record consuming-project root does not match its location")
    for task_id, task in record["tasks"].items():
        if not isinstance(task_id, str) or not isinstance(task, dict) or not isinstance(task.get("questions"), dict):
            raise ConsumerError("invalid_input", f"{path}: incomplete frozen task configuration")
    return actual_path, record


def _status_result(path, session, state):
    return {
        "session": str(path),
        "id": session["id"],
        "state": state,
        "endpoint": session.get("endpoint"),
        "identity": session.get("identity"),
    }


def _live_identity(session, path):
    process = session.get("process")
    if not isinstance(process, dict):
        return None
    state, _ = _process_info(process, path)
    if state != "owned" or not _owner_matches(session):
        return None
    actual = _runtime_identity(session.get("endpoint"))
    if not _identity_matches(session.get("identity"), actual):
        return None
    return actual


def status_session(session_path):
    """Report readiness or staleness from the consumer-owned record without consulting its source config."""
    path, session = _load_session(session_path)
    if session.get("state") in {"closed", "failed"}:
        return _status_result(path, session, session["state"])
    if _live_identity(session, path) is not None:
        return _status_result(path, session, session.get("state", "stale"))
    return _status_result(path, session, "stale")


def _require_current_config(session):
    try:
        raw = Path(session["source_config"]).read_bytes()
    except (KeyError, OSError):
        raise ConsumerError("changed_config", "the source task configuration is missing; close and reopen the session") from None
    if hashlib.sha256(raw).hexdigest() != session.get("source_config_sha256"):
        raise ConsumerError("changed_config", "the source task configuration changed; close and reopen the session")


def _decode_state_input(project_root, input_path):
    if input_path == "-":
        raw = sys.stdin.buffer.read()
    else:
        path = _project_path(project_root, input_path, "input", must_exist=True)
        try:
            raw = path.read_bytes()
        except OSError as exc:
            raise ConsumerError("invalid_input", f"input file cannot be read: {exc.strerror}") from None

    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON object key")
            result[key] = value
        return result

    try:
        body = json.loads(raw, object_pairs_hook=unique_object)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        raise ConsumerError("invalid_input", "input must be one valid JSON object with exactly one 'state' field") from None
    if not isinstance(body, dict) or set(body) != {"state"}:
        raise ConsumerError("invalid_input", "input must be a JSON object with exactly one 'state' field")
    return body["state"]


def _output_target(project_root, output_path):
    path = _project_path(project_root, output_path, "output")
    if path.exists() or path.is_symlink():
        raise ConsumerError("occupied_output", f"output already exists: {output_path}")
    return path


def _write_result(target, result):
    target = Path(target)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        encoded = (json.dumps(result, ensure_ascii=False) + "\n").encode("utf-8")
        temp = target.with_name(f".{target.name}.{uuid.uuid4().hex}.partial")
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(encoded)
                stream.flush()
                os.fsync(stream.fileno())
            os.link(temp, target)
        finally:
            temp.unlink(missing_ok=True)
    except FileExistsError:
        raise ConsumerError("occupied_output", "output already exists") from None
    except OSError as exc:
        raise ConsumerError("unavailable_environment", f"cannot write consumer result: {exc.strerror}") from None


def _require_live_session(path, session):
    if session.get("state") != "ready":
        raise ConsumerError("stale_runtime", f"session is {session.get('state', 'unknown')}, not ready")
    if _live_identity(session, path) is None:
        raise ConsumerError("stale_runtime", "the owned runtime is no longer ready with this session identity")


def call_session(session_path, task_id, input_path, output_path=None):
    """Submit one consumer-owned state using the session's frozen named-task questions."""
    path, session = _load_session(session_path)
    _require_current_config(session)
    tasks = session["tasks"]
    if task_id not in tasks:
        raise ConsumerError("unknown_task", f"unknown task {task_id!r}; known ids: {sorted(tasks)}")
    target = _output_target(session["project_root"], output_path) if output_path is not None else None
    state = _decode_state_input(session["project_root"], input_path)
    try:
        request = SystemOneRequest.model_validate(
            {"state": state, "model": session["model_id"], "questions": tasks[task_id]["questions"]}
        )
    except ValidationError as exc:
        problems = "; ".join(item["msg"] for item in exc.errors(include_input=False))
        raise ConsumerError("invalid_input", f"state cannot form a System One request: {problems}") from None
    _require_live_session(path, session)
    try:
        status, response = _http_json(
            session["endpoint"],
            "POST",
            "/v1/systemone",
            body=request.model_dump(mode="json"),
            timeout=120.0,
        )
    except (OSError, http.client.HTTPException, json.JSONDecodeError, UnicodeDecodeError):
        raise ConsumerError("stale_runtime", "the owned runtime did not return a valid System One response") from None
    if status == 422:
        raise ConsumerError("rejected_length", "the state or a question exceeds the serving context")
    if status != 200 or not isinstance(response, dict):
        raise ConsumerError("stale_runtime", f"the owned runtime returned HTTP {status}")
    if response.get("model") != session["model_id"] or not isinstance(response.get("answers"), dict):
        raise ConsumerError("stale_runtime", "the owned runtime returned an unexpected System One response")
    if set(response["answers"]) != set(request.questions):
        raise ConsumerError("stale_runtime", "the owned runtime returned answers for different questions")
    if target is not None:
        _write_result(target, response)
    return response


def _finalize_close(path, session):
    deadline = time.monotonic() + SHUTDOWN_TIMEOUT
    while True:
        slot_fd = _acquire_slot(required=False)
        if slot_fd is not None:
            try:
                _remove_owner(session)
            finally:
                os.close(slot_fd)
            break
        owner = _read_json(OWNER_FILE)
        if owner is not None and not _owner_matches(session, owner):
            break  # a later session owns the slot; never touch its metadata
        if time.monotonic() >= deadline:
            reason = "the runtime still owns the exclusive slot" if owner is not None else "the exclusive slot owner cannot be verified"
            raise ConsumerError("failed_close", f"{reason}; it was not reported closed")
        time.sleep(POLL_INTERVAL)
    session["state"] = "closed"
    session["closed_at"] = datetime.now(timezone.utc).isoformat()
    _write_json_atomic(path, session)
    return _status_result(path, session, "closed")


def close_session(session_path):
    """Close only the identified loopback runtime; leave ownership intact if shutdown cannot be confirmed."""
    path, session = _load_session(session_path)
    if session.get("state") == "closed":
        return _status_result(path, session, "closed")
    process = session.get("process")
    if not isinstance(process, dict):
        return _finalize_close(path, session)
    process_state, _ = _process_info(process, path)
    owner = _read_json(OWNER_FILE)
    if process_state == "reused":
        if _owner_matches(session, owner):
            raise ConsumerError("stale_runtime", "saved PID no longer matches the owned process; no process was signaled")
        return _finalize_close(path, session)
    if process_state == "missing":
        return _finalize_close(path, session)
    if not _owner_matches(session, owner):
        raise ConsumerError("stale_runtime", "managed-resource metadata does not match this session; no process was signaled")

    session["state"] = "closing"
    _write_json_atomic(path, session)
    _write_json_atomic(OWNER_FILE, _owner_document(session))
    try:
        status, response = _http_json(
            session["endpoint"],
            "POST",
            "/__kev/consumer/shutdown",
            headers={"x-kev-owner-token": session["owner_token"]},
            timeout=1.0,
        )
    except (OSError, http.client.HTTPException, json.JSONDecodeError, UnicodeDecodeError):
        status, response = None, None
    if status != 200 or not isinstance(response, dict) or response.get("state") != "closing":
        session["state"] = "failed_close"
        _write_json_atomic(path, session)
        _write_json_atomic(OWNER_FILE, _owner_document(session))
        raise ConsumerError("failed_close", "owned runtime did not confirm its shutdown request", {"session": str(path)})

    deadline = time.monotonic() + SHUTDOWN_TIMEOUT
    while time.monotonic() < deadline:
        process_state, _ = _process_info(process, path)
        if process_state != "owned":
            return _finalize_close(path, session)
        time.sleep(POLL_INTERVAL)
    session["state"] = "failed_close"
    _write_json_atomic(path, session)
    _write_json_atomic(OWNER_FILE, _owner_document(session))
    raise ConsumerError("failed_close", "owned runtime remained alive past the shutdown deadline", {"session": str(path)})


class _ArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise ConsumerError("invalid_input", message)


def _parser():
    parser = _ArgumentParser(prog="kev")
    commands = parser.add_subparsers(dest="command", required=True, parser_class=_ArgumentParser)
    validate_parser = commands.add_parser("validate")
    validate_parser.add_argument("--config", required=True)
    validate_parser.add_argument("--registry")
    open_parser = commands.add_parser("open")
    open_parser.add_argument("--config", required=True)
    open_parser.add_argument("--registry")
    call_parser = commands.add_parser("call")
    call_parser.add_argument("--session", required=True)
    call_parser.add_argument("--task", required=True)
    call_parser.add_argument("--input", required=True)
    call_parser.add_argument("--out")
    for command in ("status", "close"):
        command_parser = commands.add_parser(command)
        command_parser.add_argument("--session", required=True)
    return parser


def main(argv=None):
    try:
        args = _parser().parse_args(argv)
        if args.command == "validate":
            result = validate(args.config, args.registry)
        elif args.command == "open":
            result = open_session(args.config, args.registry)
        elif args.command == "call":
            result = call_session(args.session, args.task, args.input, args.out)
        elif args.command == "status":
            result = status_session(args.session)
        elif args.command == "close":
            result = close_session(args.session)
        else:
            raise ConsumerError("invalid_input", f"unsupported command {args.command!r}")
    except ConsumerError as exc:
        error = {"category": exc.category, "message": str(exc), **exc.details}
        json.dump({"error": error}, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        print(f"kev: {exc.category}: {exc}", file=sys.stderr)
        return 2
    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
