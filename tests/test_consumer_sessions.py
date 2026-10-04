"""Project-owned task configuration and on-demand consumer sessions (issue #5)."""

import json
import os
import subprocess
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
LAUNCHER = ROOT / "bin" / "kev"
BASE_REVISION = "dc7cdfe2ee4154fa7e30f5b51ca41bfa40174e68"
CONSUMER_REGISTRY = os.environ.get("KEV_LOCAL_INFERENCE_CONFIG")


def _artifact(root, kind, name):
    from kev.checkpoint import Meta, write_meta

    path = root / kind / name
    path.mkdir(parents=True)
    (path / "config.json").write_text(json.dumps({"model_type": "qwen3_5", "layer_types": ["linear_attention"]}), encoding="utf-8")
    (path / "tokenizer.json").write_text('{"version":"1.0"}', encoding="utf-8")
    (path / "tokenizer_config.json").write_text('{"model_max_length":8}', encoding="utf-8")
    if kind == "checkpoint":
        (path / "adapter_config.json").write_text('{"peft_type":"LORA"}', encoding="utf-8")
        (path / "adapter_model.safetensors").write_bytes(b"fixture")
        write_meta(path, Meta(base="Qwen/Qwen3.5-0.8B-Base", base_revision=BASE_REVISION, head={}, lora=4))
    else:
        (path / "model.safetensors.index.json").write_text('{"weight_map":{"weight":"model.safetensors"}}', encoding="utf-8")
        (path / "model.safetensors").write_bytes(b"fixture")
    return path


def _machine_registry(root, model_id="kev-fixture"):
    checkpoint = _artifact(root, "checkpoint", model_id)
    base = _artifact(root, "base", "qwen-fixture")
    registry = {
        "schema": "kev-local-inference/1",
        "models": {
            model_id: {
                "checkpoint": {"path": str(checkpoint), "source": f"example/{model_id}", "revision": "a" * 40},
                "base": {"path": str(base), "source": "Qwen/Qwen3.5-0.8B-Base", "revision": BASE_REVISION},
            }
        },
    }
    path = root / "machine-registry.json"
    path.write_text(json.dumps(registry), encoding="utf-8")
    return path


def _project_config(project, **changes):
    project.mkdir(parents=True)
    body = {
        "schema": "kev-project-tasks/1",
        "description": "Synthetic consumer project",
        "model": "kev-fixture",
        "tasks": {
            "route": {
                "questions": {
                    "department": {
                        "type": "choice",
                        "instructions": "Choose a team.",
                        "criteria": {"billing": "Payment issues", "shipping": "Delivery issues"},
                    }
                }
            },
            "audit": {
                "description": "Follow-up checks",
                "questions": {
                    "billing": {"type": "noul", "instructions": "Is this about billing?"},
                    "urgency": {"type": "score", "criteria": ["low", "medium", "high"]},
                },
            },
        },
    }
    body.update(changes)
    path = project / "kev-tasks.json"
    path.write_text(json.dumps(body), encoding="utf-8")
    return path


def _run(project, registry, *args):
    return subprocess.run(
        [str(LAUNCHER), *args, "--registry", str(registry)],
        cwd=project,
        capture_output=True,
        text=True,
    )


def _install_runtime_stub(
    monkeypatch,
    *,
    ready_delay=0,
    wrong_model=False,
    deny_shutdown=False,
    hold_shutdown=False,
    ready_event=None,
):
    import sys

    from kev import consumer

    traces = {}

    def command(registry_path, model_id, fd, port, owner_token, session_record):
        trace_path = Path(session_record).parent / "stub-trace.json"
        traces[str(Path(session_record).resolve())] = trace_path
        if ready_event is not None:
            ready_event.set()
        result = [
            sys.executable,
            str(ROOT / "tests" / "fixtures" / "consumer_runtime_stub.py"),
            "--config",
            str(registry_path),
            "--model-id",
            model_id,
            "--fd",
            str(fd),
            f"--owner-token={owner_token}",
            f"--session-record={session_record}",
            "--trace",
            str(trace_path),
            "--ready-delay",
            str(ready_delay),
        ]
        if wrong_model:
            result.append("--wrong-model")
        if deny_shutdown:
            result.append("--deny-shutdown")
        if hold_shutdown:
            result.append("--hold-shutdown")
        return result

    monkeypatch.setattr(consumer, "_server_command", command)
    return lambda session_path: traces[str(Path(session_path).resolve())]


def test_validate_uses_consumer_tasks_without_registering_them_in_kev(tmp_path):
    registry = _machine_registry(tmp_path / "machine")
    project = tmp_path / "consumer-a"
    config = _project_config(project)

    result = _run(project, registry, "validate", "--config", str(config))

    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    assert report["valid"] is True
    assert report["model"] == "kev-fixture"
    assert report["tasks"] == ["audit", "route"]
    assert report["config"] == str(config)


def test_checked_in_task_template_validates_from_a_simulated_consumer_project(tmp_path):
    registry = _machine_registry(tmp_path / "machine", model_id="kev-4b")
    project = tmp_path / "consumer-template"
    project.mkdir()
    template = json.loads((ROOT / "examples" / "consumer" / "kev-tasks.example.json").read_text(encoding="utf-8"))
    assert template["schema"] == "kev-project-tasks/1"
    assert set(template) <= {"schema", "description", "model", "tasks"}
    assert {question["type"] for task in template["tasks"].values() for question in task["questions"].values()} == {
        "choice",
        "noul",
        "score",
    }
    config = project / "kev-tasks.json"
    config.write_text(json.dumps(template), encoding="utf-8")

    result = _run(project, registry, "validate", "--config", str(config))

    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    assert report["model"] == "kev-4b"
    assert report["tasks"] == ["review", "triage"]
    machine_body = json.loads(registry.read_text(encoding="utf-8"))
    assert "tasks" not in machine_body and "question_sets" not in machine_body


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (lambda body: body.update(unexpected=True), "unknown project keys"),
        (lambda body: body["tasks"]["route"].update(unexpected=True), "unknown task keys"),
        (
            lambda body: body["tasks"]["route"]["questions"]["department"].update(confidence=0.5),
            "unknown choice question fields",
        ),
        (lambda body: body["tasks"]["audit"]["questions"]["urgency"].update(criteria=[]), "invalid typed questions"),
    ],
)
def test_validate_rejects_unknown_fields_and_malformed_questions(tmp_path, change, message):
    from kev.consumer import ConsumerError, validate

    registry = _machine_registry(tmp_path / "machine")
    config = _project_config(tmp_path / "consumer-a")
    body = json.loads(config.read_text(encoding="utf-8"))
    change(body)
    config.write_text(json.dumps(body), encoding="utf-8")

    with pytest.raises(ConsumerError, match=message) as error:
        validate(config, registry)
    assert error.value.category == "invalid_config"


def test_validate_unknown_model_is_distinct_from_invalid_project_config(tmp_path):
    from kev.consumer import ConsumerError, validate

    registry = _machine_registry(tmp_path / "machine")
    config = _project_config(tmp_path / "consumer-a")
    body = json.loads(config.read_text(encoding="utf-8"))
    body["model"] = "kev-not-registered"
    config.write_text(json.dumps(body), encoding="utf-8")

    with pytest.raises(ConsumerError, match="unknown registered model") as error:
        validate(config, registry)
    assert error.value.category == "unknown_model"


def test_validate_does_not_start_a_server_or_load_model_weights(tmp_path, monkeypatch):
    from kev.checkpoint import Checkpoint
    from kev.consumer import validate

    registry = _machine_registry(tmp_path / "machine")
    config = _project_config(tmp_path / "consumer-a")

    def unexpected(*args, **kwargs):
        raise AssertionError("validate must not start a process or load model weights")

    monkeypatch.setattr(Checkpoint, "load", unexpected)
    monkeypatch.setattr(subprocess, "Popen", unexpected)
    monkeypatch.setattr(subprocess, "run", unexpected)
    report = validate(config, registry)

    assert report["valid"] is True


def test_local_model_resolution_does_not_require_a_machine_task(tmp_path):
    from kev.local import load_registry, resolve_model

    registry_path = _machine_registry(tmp_path / "machine")
    resolved = resolve_model(load_registry(registry_path), "kev-fixture")

    assert resolved.task is None
    assert resolved.model.id == "kev-fixture"
    assert Path(resolved.checkpoint.path) == Path(
        json.loads(registry_path.read_text(encoding="utf-8"))["models"]["kev-fixture"]["checkpoint"]["path"]
    )
    assert resolved.base_revision == BASE_REVISION


def test_server_can_serve_registered_model_without_machine_task_or_new_loader(tmp_path, monkeypatch):
    import socket
    import sys
    from types import SimpleNamespace

    from kev import serve
    from kev.checkpoint import Checkpoint

    registry = _machine_registry(tmp_path / "machine")
    loaded = {}

    def load(checkpoint, device, options):
        loaded["checkpoint"] = checkpoint
        loaded["device"] = device
        loaded["base_path"] = options.base_path
        return "tokenizer", SimpleNamespace(backend="mlx", dtype="bfloat16", hybrid=True, head=SimpleNamespace(temperature=1.0))

    class FakeServer:
        def __init__(self, checkpoint, tok, model, device, **kwargs):
            loaded["local"] = kwargs["local"]
            self.truncate_states = False

    monkeypatch.setattr(Checkpoint, "load", load)
    monkeypatch.setattr(serve, "default_device", lambda: "mps")
    monkeypatch.setattr(serve, "Server", FakeServer)
    class FakeUvicornServer:
        def __init__(self, config):
            loaded["uvicorn_config"] = config

        def run(self, sockets):
            loaded["socket_address"] = sockets[0].getsockname()

    fake_uvicorn = SimpleNamespace(
        Config=lambda app, **kwargs: {"app": app, **kwargs},
        Server=FakeUvicornServer,
    )
    monkeypatch.setitem(sys.modules, "uvicorn", fake_uvicorn)
    inherited_socket = socket.socket()
    inherited_socket.bind(("127.0.0.1", 0))
    inherited_socket.listen()
    inherited_fd = inherited_socket.detach()

    result = serve.main(
        ["--config", str(registry), "--model-id", "kev-fixture", "--host", "127.0.0.1", "--port", "43123", "--fd", str(inherited_fd), "--owner-token", "fixture", "--session-record", str(tmp_path / "session.json")]
    )

    assert result == 0
    assert loaded["local"].task is None
    assert loaded["checkpoint"].meta.base == "Qwen/Qwen3.5-0.8B-Base"
    assert Path(loaded["base_path"]) == Path(
        json.loads(registry.read_text(encoding="utf-8"))["models"]["kev-fixture"]["base"]["path"]
    )
    assert loaded["socket_address"][0] == "127.0.0.1"
    assert loaded["socket_address"][1] != 0


def test_open_returns_record_only_after_owned_runtime_identity_is_ready(tmp_path, monkeypatch, capsys):
    from kev import consumer

    registry = _machine_registry(tmp_path / "machine")
    project = tmp_path / "consumer-a"
    config = _project_config(project)
    trace_for = _install_runtime_stub(monkeypatch)

    exit_code = consumer.main(["open", "--config", str(config), "--registry", str(registry)])
    opened = json.loads(capsys.readouterr().out)

    assert exit_code == 0
    assert opened["state"] == "ready"
    assert opened["session"] == str((project / ".local" / "kev" / "sessions" / opened["id"] / "session.json").resolve())
    assert opened["endpoint"].startswith("http://127.0.0.1:")
    assert opened["identity"]["model_id"] == "kev-fixture"
    trace = trace_for(opened["session"])
    assert json.loads(trace.read_text(encoding="utf-8"))["loads"] == 1

    from kev.consumer import close_session

    assert close_session(opened["session"])["state"] == "closed"
    assert close_session(opened["session"])["state"] == "closed"


def test_named_calls_reuse_one_runtime_and_write_only_consumer_owned_results(tmp_path, monkeypatch, capsys):
    import io
    from types import SimpleNamespace

    from kev import consumer

    registry = _machine_registry(tmp_path / "machine")
    project = tmp_path / "consumer-a"
    config = _project_config(project)
    trace_for = _install_runtime_stub(monkeypatch)

    assert consumer.main(["open", "--config", str(config), "--registry", str(registry)]) == 0
    opened = json.loads(capsys.readouterr().out)
    session = opened["session"]

    (project / "route-input.json").write_text('{"state":"A synthetic shipping request."}', encoding="utf-8")
    assert consumer.main(
        ["call", "--session", session, "--task", "route", "--input", "route-input.json", "--out", "results/route.json"]
    ) == 0
    first = json.loads(capsys.readouterr().out)
    result_file = project / "results" / "route.json"
    assert json.loads(result_file.read_text(encoding="utf-8")) == first
    assert first["answers"]["department"]["type"] == "choice"

    monkeypatch.setattr(consumer.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(b'{"state":"Another synthetic request."}')))
    assert consumer.main(["call", "--session", session, "--task", "audit", "--input", "-"]) == 0
    second = json.loads(capsys.readouterr().out)
    assert {answer["type"] for answer in second["answers"].values()} == {"noul", "score"}

    trace = json.loads(trace_for(session).read_text(encoding="utf-8"))
    assert trace["loads"] == 1
    assert trace["calls"] == 2
    assert trace["requests"] == [
        {"model": "kev-fixture", "questions": {"department": "choice"}},
        {"model": "kev-fixture", "questions": {"billing": "noul", "urgency": "score"}},
    ]

    assert consumer.main(
        ["call", "--session", session, "--task", "route", "--input", "route-input.json", "--out", "results/route.json"]
    ) == 2
    failure = json.loads(capsys.readouterr().out)
    assert failure["error"]["category"] == "occupied_output"
    assert json.loads(trace_for(session).read_text(encoding="utf-8"))["calls"] == 2

    assert consumer.main(["status", "--session", session]) == 0
    assert json.loads(capsys.readouterr().out)["state"] == "ready"
    assert consumer.main(["close", "--session", session]) == 0
    assert json.loads(capsys.readouterr().out)["state"] == "closed"


def test_call_rejects_forged_input_and_changed_config_but_recovery_ignores_source(tmp_path, monkeypatch, capsys):
    from kev import consumer

    registry = _machine_registry(tmp_path / "machine")
    project = tmp_path / "consumer-a"
    config = _project_config(project)
    trace_for = _install_runtime_stub(monkeypatch)
    assert consumer.main(["open", "--config", str(config), "--registry", str(registry)]) == 0
    opened = json.loads(capsys.readouterr().out)
    session = opened["session"]
    bad_input = project / "bad-input.json"

    for body in ('{"state":"synthetic","model":"kev-other"}', '{"state":"one","state":"two"}'):
        bad_input.write_text(body, encoding="utf-8")
        assert consumer.main(["call", "--session", session, "--task", "route", "--input", "bad-input.json"]) == 2
        assert json.loads(capsys.readouterr().out)["error"]["category"] == "invalid_input"

    bad_input.write_text('{"state":"synthetic"}', encoding="utf-8")
    assert consumer.main(
        ["call", "--session", session, "--task", "unknown", "--input", "bad-input.json", "--out", "results/rejected.json"]
    ) == 2
    assert json.loads(capsys.readouterr().out)["error"]["category"] == "unknown_task"
    assert not (project / "results" / "rejected.json").exists()

    config.write_text(config.read_text(encoding="utf-8") + "\n", encoding="utf-8")
    assert consumer.main(["call", "--session", session, "--task", "route", "--input", "bad-input.json"]) == 2
    assert json.loads(capsys.readouterr().out)["error"]["category"] == "changed_config"
    assert json.loads(trace_for(session).read_text(encoding="utf-8"))["calls"] == 0

    assert consumer.main(["status", "--session", session]) == 0
    assert json.loads(capsys.readouterr().out)["state"] == "ready"
    config.unlink()
    assert consumer.main(["close", "--session", session]) == 0
    assert json.loads(capsys.readouterr().out)["state"] == "closed"


def test_exclusive_slot_covers_loading_and_releases_for_the_next_project(tmp_path, monkeypatch):
    import threading

    from kev import consumer
    from kev.consumer import ConsumerError

    registry = _machine_registry(tmp_path / "machine")
    project_a = tmp_path / "consumer-a"
    project_b = tmp_path / "consumer-b"
    config_a = _project_config(project_a)
    config_b = _project_config(project_b)
    server_starting = threading.Event()
    trace_for = _install_runtime_stub(monkeypatch, ready_delay=0.4, ready_event=server_starting)
    opened = []
    errors = []

    def open_a():
        try:
            opened.append(consumer.open_session(config_a, registry))
        except Exception as exc:
            errors.append(exc)

    thread = threading.Thread(target=open_a)
    thread.start()
    assert server_starting.wait(timeout=5)
    with pytest.raises(ConsumerError) as busy:
        consumer.open_session(config_b, registry)
    assert busy.value.category == "busy"
    assert not (project_b / ".local").exists()

    thread.join(timeout=10)
    assert not thread.is_alive() and not errors
    session_a = opened[0]["session"]
    owner = json.loads(consumer.OWNER_FILE.read_text(encoding="utf-8"))
    assert owner["state"] == "ready"
    assert not {"project_root", "tasks", "questions"}.intersection(owner)
    assert json.loads(trace_for(session_a).read_text(encoding="utf-8"))["loads"] == 1
    record_a = json.loads(Path(session_a).read_text(encoding="utf-8"))
    assert consumer._process_info(record_a["process"], Path(session_a))[0] == "owned"

    assert consumer.close_session(session_a)["state"] == "closed"
    session_b = consumer.open_session(config_b, registry)
    assert session_b["state"] == "ready"
    assert json.loads(trace_for(session_b["session"]).read_text(encoding="utf-8"))["loads"] == 1
    assert consumer.close_session(session_b["session"])["state"] == "closed"


def test_reused_pid_metadata_is_stale_and_never_signaled(tmp_path, monkeypatch):
    from kev import consumer
    from kev.consumer import ConsumerError

    registry = _machine_registry(tmp_path / "machine")
    project = tmp_path / "consumer-a"
    config = _project_config(project)
    trace_for = _install_runtime_stub(monkeypatch)
    opened = consumer.open_session(config, registry)
    record_path = Path(opened["session"])
    record = json.loads(record_path.read_text(encoding="utf-8"))
    original_process = record["process"]
    record["process"] = {**original_process, "pid": os.getpid()}
    record_path.write_text(json.dumps(record), encoding="utf-8")

    assert consumer.status_session(record_path)["state"] == "stale"
    with pytest.raises(ConsumerError) as stale:
        consumer.close_session(record_path)
    assert stale.value.category == "stale_runtime"
    assert consumer._process_info(original_process, record_path)[0] == "owned"
    assert json.loads(trace_for(record_path).read_text(encoding="utf-8"))["loads"] == 1

    record["process"] = {**original_process, "started_at": None}
    record["state"] = "ready"
    record_path.write_text(json.dumps(record), encoding="utf-8")
    assert consumer._process_info(record["process"], record_path)[0] == "owned"
    assert consumer.close_session(record_path)["state"] == "closed"


def test_dead_owned_process_can_be_recovered_without_leaving_the_slot_owned(tmp_path, monkeypatch):
    from kev import consumer

    registry = _machine_registry(tmp_path / "machine")
    project = tmp_path / "consumer-a"
    config = _project_config(project)
    _install_runtime_stub(monkeypatch)
    spawned = []
    spawn = consumer._spawn_server

    def record_spawn(*args, **kwargs):
        process = spawn(*args, **kwargs)
        spawned.append(process)
        return process

    monkeypatch.setattr(consumer, "_spawn_server", record_spawn)
    opened = consumer.open_session(config, registry)
    record_path = Path(opened["session"])
    record = json.loads(record_path.read_text(encoding="utf-8"))
    assert consumer._process_info(record["process"], record_path)[0] == "owned"

    spawned[0].terminate()
    spawned[0].wait(timeout=3)

    assert consumer.status_session(record_path)["state"] == "stale"
    assert consumer.close_session(record_path)["state"] == "closed"
    assert consumer._read_json(consumer.OWNER_FILE) is None
    slot_fd = consumer._acquire_slot(required=False)
    assert slot_fd is not None
    os.close(slot_fd)


def test_interrupted_startup_status_and_close_recover_owned_runtime(tmp_path, monkeypatch, capsys):
    from kev import consumer

    registry = _machine_registry(tmp_path / "machine")
    project = tmp_path / "consumer-a"
    config = _project_config(project)
    _install_runtime_stub(monkeypatch)
    interrupted = {}
    write_json = consumer._write_json_atomic

    def interrupt_after_owner_record(path, value):
        write_json(path, value)
        if (
            Path(path) == consumer.OWNER_FILE
            and value.get("state") == "starting"
            and value.get("pid") is not None
            and value.get("process_started_at") is None
        ):
            interrupted["session"] = project / ".local" / "kev" / "sessions" / value["session_id"] / "session.json"
            raise SystemExit("simulated interruption after owned process metadata was saved")

    monkeypatch.setattr(consumer, "_write_json_atomic", interrupt_after_owner_record)
    try:
        with pytest.raises(SystemExit, match="simulated interruption"):
            consumer.open_session(config, registry)
        session_path = interrupted["session"]
        record = json.loads(session_path.read_text(encoding="utf-8"))
        assert record["state"] == "starting"
        assert record["identity"] is None
        assert record["process"]["started_at"] is None

        discovered = subprocess.run(
            [
                "find",
                str(project / ".local" / "kev" / "sessions"),
                "-type",
                "f",
                "-name",
                "session.json",
                "-print",
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        session_paths = [Path(line) for line in discovered.stdout.splitlines()]
        assert session_paths == [session_path]
        session_path = session_paths[0]

        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            record = json.loads(session_path.read_text(encoding="utf-8"))
            if (
                consumer._process_info(record["process"], session_path)[0] == "owned"
                and consumer._runtime_identity(record["endpoint"]) is not None
            ):
                break
            time.sleep(0.05)
        else:
            pytest.fail("interrupted consumer runtime did not become ready and remain owned")

        assert consumer.main(["status", "--session", str(session_path)]) == 0
        status = capsys.readouterr()
        status_json = json.loads(status.out)
        assert status_json["state"] == "stale"
        assert "Traceback" not in status.err

        assert consumer.main(["open", "--config", str(config), "--registry", str(registry)]) == 2
        busy = capsys.readouterr()
        assert json.loads(busy.out)["error"]["category"] == "busy"
        assert "Traceback" not in busy.err

        assert consumer.main(["close", "--session", str(session_path)]) == 0
        closed = capsys.readouterr()
        assert json.loads(closed.out)["state"] == "closed"
        assert "Traceback" not in closed.err
        assert consumer._process_info(record["process"], session_path)[0] == "missing"
        with pytest.raises(OSError):
            consumer._http_json(record["endpoint"], "GET", "/v1/models", timeout=0.2)
        assert consumer._read_json(consumer.OWNER_FILE) is None
        slot_fd = consumer._acquire_slot(required=False)
        assert slot_fd is not None
        os.close(slot_fd)
    finally:
        session_path = interrupted.get("session")
        if session_path is not None and session_path.exists():
            latest = json.loads(session_path.read_text(encoding="utf-8"))
            if latest.get("state") != "closed":
                consumer.close_session(session_path)


def test_session_record_cannot_expand_project_ownership_by_changing_its_root(tmp_path, monkeypatch):
    from kev import consumer
    from kev.consumer import ConsumerError

    registry = _machine_registry(tmp_path / "machine")
    project = tmp_path / "consumer-a"
    config = _project_config(project)
    _install_runtime_stub(monkeypatch)
    opened = consumer.open_session(config, registry)
    record_path = Path(opened["session"])
    record = json.loads(record_path.read_text(encoding="utf-8"))
    record["project_root"] = str(tmp_path)
    record_path.write_text(json.dumps(record), encoding="utf-8")
    external_input = tmp_path / "external-state.json"
    external_input.write_text('{"state":"must not be read"}', encoding="utf-8")
    external_output = tmp_path / "external-result.json"

    try:
        with pytest.raises(ConsumerError, match="root does not match") as failure:
            consumer.call_session(record_path, "route", external_input, external_output)
        assert failure.value.category == "invalid_input"
        assert not external_output.exists()
    finally:
        record["project_root"] = str(project)
        record_path.write_text(json.dumps(record), encoding="utf-8")
        assert consumer.close_session(record_path)["state"] == "closed"


def test_wrong_ready_identity_is_closed_and_does_not_leave_a_false_free_owner(tmp_path, monkeypatch):
    from kev import consumer
    from kev.consumer import ConsumerError

    registry = _machine_registry(tmp_path / "machine")
    project = tmp_path / "consumer-a"
    config = _project_config(project)
    _install_runtime_stub(monkeypatch, wrong_model=True)

    with pytest.raises(ConsumerError) as failure:
        consumer.open_session(config, registry)
    assert failure.value.category == "failed_startup"
    failed_record = json.loads(Path(failure.value.details["session"]).read_text(encoding="utf-8"))
    assert failed_record["state"] == "failed"
    assert not consumer.OWNER_FILE.exists()

    _install_runtime_stub(monkeypatch)
    opened = consumer.open_session(config, registry)
    assert opened["state"] == "ready"
    assert consumer.close_session(opened["session"])["state"] == "closed"


def test_startup_timeout_terminates_its_direct_child_and_releases_slot(tmp_path, monkeypatch):
    from kev import consumer
    from kev.consumer import ConsumerError

    registry = _machine_registry(tmp_path / "machine")
    project = tmp_path / "consumer-a"
    config = _project_config(project)
    _install_runtime_stub(monkeypatch, ready_delay=5)
    monkeypatch.setattr(consumer, "STARTUP_TIMEOUT", 0.2)
    monkeypatch.setattr(consumer, "SHUTDOWN_TIMEOUT", 0.2)

    with pytest.raises(ConsumerError) as failure:
        consumer.open_session(config, registry)
    assert failure.value.category == "failed_startup"
    failed_record = json.loads(Path(failure.value.details["session"]).read_text(encoding="utf-8"))
    assert failed_record["state"] == "failed"
    assert not consumer.OWNER_FILE.exists()


def test_failed_close_keeps_slot_owned_until_confirmed_termination(tmp_path, monkeypatch):
    from kev import consumer
    from kev.consumer import ConsumerError

    registry = _machine_registry(tmp_path / "machine")
    project_a = tmp_path / "consumer-a"
    project_b = tmp_path / "consumer-b"
    config_a = _project_config(project_a)
    config_b = _project_config(project_b)
    _install_runtime_stub(monkeypatch, deny_shutdown=True)
    opened = consumer.open_session(config_a, registry)

    with pytest.raises(ConsumerError) as failed_close:
        consumer.close_session(opened["session"])
    assert failed_close.value.category == "failed_close"
    assert json.loads(Path(opened["session"]).read_text(encoding="utf-8"))["state"] == "failed_close"
    with pytest.raises(ConsumerError) as busy:
        consumer.open_session(config_b, registry)
    assert busy.value.category == "busy"

    status, body = consumer._http_json(opened["endpoint"], "POST", "/__test/shutdown")
    assert status == 200 and body["state"] == "closing"
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline and consumer._process_info(
        json.loads(Path(opened["session"]).read_text(encoding="utf-8"))["process"], Path(opened["session"])
    )[0] == "owned":
        time.sleep(0.05)
    assert consumer.close_session(opened["session"])["state"] == "closed"


def test_shutdown_deadline_does_not_release_a_live_runtime(tmp_path, monkeypatch):
    from kev import consumer
    from kev.consumer import ConsumerError

    registry = _machine_registry(tmp_path / "machine")
    project_a = tmp_path / "consumer-a"
    project_b = tmp_path / "consumer-b"
    config_a = _project_config(project_a)
    config_b = _project_config(project_b)
    trace_for = _install_runtime_stub(monkeypatch, hold_shutdown=True)
    monkeypatch.setattr(consumer, "SHUTDOWN_TIMEOUT", 0.2)
    opened = consumer.open_session(config_a, registry)
    record_path = Path(opened["session"])
    record = json.loads(record_path.read_text(encoding="utf-8"))
    assert consumer._process_info(record["process"], record_path)[0] == "owned"

    started = time.monotonic()
    with pytest.raises(ConsumerError) as failure:
        consumer.close_session(record_path)
    assert time.monotonic() - started < 2
    assert failure.value.category == "failed_close"
    assert consumer._process_info(record["process"], record_path)[0] == "owned"
    assert json.loads(consumer.OWNER_FILE.read_text(encoding="utf-8"))["state"] == "failed_close"
    with pytest.raises(ConsumerError) as busy:
        consumer.open_session(config_b, registry)
    assert busy.value.category == "busy"

    status, body = consumer._http_json(opened["endpoint"], "POST", "/__test/shutdown")
    assert status == 200 and body["state"] == "closing"
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline and consumer._process_info(record["process"], record_path)[0] == "owned":
        time.sleep(0.05)
    assert consumer.close_session(record_path)["state"] == "closed"
    assert json.loads(trace_for(record_path).read_text(encoding="utf-8"))["loads"] == 1


def test_cli_returns_structured_config_errors_on_stdout_and_diagnostic_on_stderr(tmp_path):
    registry = _machine_registry(tmp_path / "machine")
    project = tmp_path / "consumer-a"
    config = _project_config(project)
    body = json.loads(config.read_text(encoding="utf-8"))
    body["tasks"]["route"]["questions"]["department"]["extra"] = "no"
    config.write_text(json.dumps(body), encoding="utf-8")

    result = _run(project, registry, "validate", "--config", str(config))

    assert result.returncode != 0
    assert json.loads(result.stdout)["error"]["category"] == "invalid_config"
    assert "invalid_config" in result.stderr and "Traceback" not in result.stderr


@pytest.mark.integration
@pytest.mark.skipif(not CONSUMER_REGISTRY, reason="KEV_LOCAL_INFERENCE_CONFIG is not set: provisioned local artifacts are required")
@pytest.mark.parametrize("model_id", ["kev-0.8b", "kev-4b"])
def test_integration_mlx_consumer_session_reuses_one_local_model(tmp_path, model_id):
    """A public project workflow uses one offline MLX load for multiple named tasks and closes it."""
    from kev.local import load_registry, resolve_model

    registry_path = CONSUMER_REGISTRY
    project = tmp_path / f"consumer-{model_id}"
    config = _project_config(project, model=model_id)
    env = os.environ.copy()
    env.update({"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"})
    session_path = None
    session = None

    try:
        opened = subprocess.run(
            [str(LAUNCHER), "open", "--config", str(config)],
            cwd=project,
            env=env,
            capture_output=True,
            text=True,
            timeout=900,
        )
        assert opened.returncode == 0, opened.stderr + "\n" + opened.stdout
        assert not opened.stderr
        session = json.loads(opened.stdout)
        session_path = Path(session["session"])
        record = json.loads(session_path.read_text(encoding="utf-8"))
        identity = session["identity"]
        expected = resolve_model(load_registry(registry_path), model_id).card(backend=None, dtype=None, device=None)
        assert session["state"] == "ready"
        assert identity["model_id"] == model_id
        for field in ("model_id", "checkpoint", "base"):
            assert identity[field] == expected[field]
        assert identity["backend"] == "mlx" and identity["device"] == "mps"
        assert identity["dtype"]
        assert Path(record["runtime_log"]).is_relative_to(project)

        owner = json.loads((ROOT / ".local/consumer-runtime/owner.json").read_text(encoding="utf-8"))
        assert not {"project_root", "tasks", "questions", "state_text"}.intersection(owner)

        route_input = project / "route-input.json"
        route_input.write_text('{"state":"Synthetic native-session example A."}', encoding="utf-8")
        route = subprocess.run(
            [str(LAUNCHER), "call", "--session", str(session_path), "--task", "route", "--input", "route-input.json",
             "--out", "results/route.json"],
            cwd=project,
            env=env,
            capture_output=True,
            text=True,
            timeout=300,
        )
        assert route.returncode == 0, route.stderr + "\n" + route.stdout
        assert not route.stderr
        route_response = json.loads(route.stdout)
        assert route_response["model"] == model_id
        assert route_response["answers"]["department"]["type"] == "choice"
        assert json.loads((project / "results/route.json").read_text(encoding="utf-8")) == route_response

        audit = subprocess.run(
            [str(LAUNCHER), "call", "--session", str(session_path), "--task", "audit", "--input", "-"],
            cwd=project,
            env=env,
            input='{"state":"Synthetic native-session example B."}\n',
            capture_output=True,
            text=True,
            timeout=300,
        )
        assert audit.returncode == 0, audit.stderr + "\n" + audit.stdout
        assert not audit.stderr
        audit_response = json.loads(audit.stdout)
        assert set(audit_response["answers"]) == {"billing", "urgency"}
        assert {answer["type"] for answer in audit_response["answers"].values()} == {"noul", "score"}

        log_path = Path(record["runtime_log"])
        runtime_log = log_path.read_text(encoding="utf-8")
        load_trace = [line for line in runtime_log.splitlines() if line.startswith("consumer session model loaded:")]
        assert len(load_trace) == 1 and model_id in load_trace[0] and "mlx" in load_trace[0]
        assert "Synthetic native-session" not in runtime_log
        hf_home = session_path.parent / "cache" / "huggingface"
        assert not [path for path in hf_home.rglob("*") if path.is_file()]

        status = subprocess.run(
            [str(LAUNCHER), "status", "--session", str(session_path)],
            cwd=project,
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )
        assert status.returncode == 0 and json.loads(status.stdout)["state"] == "ready", status.stderr
        close = subprocess.run(
            [str(LAUNCHER), "close", "--session", str(session_path)],
            cwd=project,
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
        )
        assert close.returncode == 0 and json.loads(close.stdout)["state"] == "closed", close.stderr
        closed_again = subprocess.run(
            [str(LAUNCHER), "close", "--session", str(session_path)],
            cwd=project,
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )
        assert closed_again.returncode == 0 and json.loads(closed_again.stdout)["state"] == "closed"
        from kev import consumer

        assert consumer._process_info(record["process"], session_path)[0] != "owned"

        evidence = {
            "model_id": model_id,
            "working_directory": str(project),
            "launcher": str(LAUNCHER),
            "session": str(session_path),
            "endpoint": session["endpoint"],
            "identity": identity,
            "process": {key: record["process"][key] for key in ("pid", "started_at")},
            "loader_trace_count": len(load_trace),
            "tasks": {"route": sorted(route_response["answers"]), "audit": sorted(audit_response["answers"])},
            "hf_home": str(hf_home),
            "hf_home_file_count": 0,
            "closed": json.loads(close.stdout),
        }
        (project / "native-session-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    finally:
        if session_path is not None and session is not None:
            current = json.loads(session_path.read_text(encoding="utf-8"))
            if current.get("state") != "closed":
                subprocess.run(
                    [str(LAUNCHER), "close", "--session", str(session_path)],
                    cwd=project,
                    env=env,
                    capture_output=True,
                    text=True,
                    timeout=60,
                )
