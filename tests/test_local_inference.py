"""The configured local inference contract (issue #3, AC-3-v1): strict offline resolution, both task presets, the
batch CLI, and the separate-process fp32 parity check against a read-only baseline.

Unit cases build a synthetic registry plus a tiny config-only artifact, so they run with no weights and no network.
They cover the negative paths the contract names: unknown model/task, a missing or incomplete artifact, a source or
revision that disagrees with the checkpoint's own metadata, a row that tries to pick its own model, and a local load
that must not fall back to the Hub. `resolved()` asserts the offline flag is set, and `no_network` fails the case if
anything in the process opens a socket while it resolves.

Integration cases are opt-in and need real local artifacts:

    KEV_LOCAL_INFERENCE_CONFIG=$PWD/.local/local-inference.json \\
    KEV_REFERENCE_ROOT=$PWD/.local/worktrees/kev-main-local-inference \\
    HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \\
    uv run --extra serve python -m pytest tests/test_local_inference.py -q -k integration

`-k integration` runs the real-weight load, the batch CLI, and the two-process parity check. When the config or the
reference tree is absent they skip with that reason; an explicitly requested integration run must not pass by
skipping every case, so CI selection excludes them with `-k 'not integration'`.
"""
import json
import os
import socket
import subprocess
import sys
from pathlib import Path

import pytest

from kev.checkpoint import LoadOptions
from kev.local import LocalConfigError, config_path, load_registry, load_options, resolve

ROOT = Path(__file__).resolve().parents[1]
CONFIG = os.environ.get("KEV_LOCAL_INFERENCE_CONFIG")
REFERENCE = os.environ.get("KEV_REFERENCE_ROOT")
BASE_SHA = "dc7cdfe2ee4154fa7e30f5b51ca41bfa40174e68"
BASE_REPO = "Qwen/Qwen3.5-0.8B-Base"


def offline(monkeypatch):
    """The contract's precondition: the configured path runs with Hub and Transformers offline mode enabled."""
    monkeypatch.setenv("HF_HUB_OFFLINE", "1")
    monkeypatch.setenv("TRANSFORMERS_OFFLINE", "1")


class SocketSentinel:
    """Stands in for socket.socket / socket.create_connection: any network attempt in the guarded block is a failure."""

    def __init__(self):
        self.calls = []

    def __call__(self, *a, **kw):
        self.calls.append((a, kw))
        raise AssertionError(f"configured local mode attempted a network connection: {(a, kw)}")

    def check(self):
        assert not self.calls, f"configured local mode opened {len(self.calls)} socket(s)"


@pytest.fixture
def no_network(monkeypatch):
    sentinel = SocketSentinel()
    monkeypatch.setattr(socket, "socket", sentinel)
    monkeypatch.setattr(socket, "create_connection", sentinel)
    monkeypatch.setattr(socket, "getaddrinfo", sentinel)
    return sentinel


def artifact(root, kind, name, **files):
    """A config-only artifact directory of the shape a real acquisition has (no weights). `head.pt` goes through
    kev.checkpoint.write_meta, the one writer of that file (tests/test_conventions.py)."""
    from kev.checkpoint import Meta, write_meta
    d = root / kind / name
    d.mkdir(parents=True, exist_ok=True)
    body = {"config.json": json.dumps({"model_type": "qwen3_5", "layer_types": ["linear_attention"]})}
    if kind == "base":
        body["model.safetensors.index.json"] = json.dumps({"metadata": {}, "weight_map": {"w": "model.safetensors"}})
    body.update(files)
    for filename, text in body.items():
        (d / filename).write_text(text, encoding="utf-8")
    (d / ("adapter_model.safetensors" if kind == "checkpoint" else "model.safetensors")).write_bytes(b"\x00" * 8)
    if kind == "checkpoint":
        (d / "adapter_config.json").write_text(json.dumps({"peft_type": "LORA", "revision": None}), encoding="utf-8")
        write_meta(d, Meta(base=BASE_REPO, base_revision=BASE_SHA, head={}, lora=4))
    return d


def registry_file(tmp_path, *, base_source=None, base_revision=BASE_SHA, checkpoint_base=None, model_name="kev-local"):
    from kev.checkpoint import Meta, write_meta
    ck = artifact(tmp_path, "checkpoint", "ckpt-0.8b")
    base = artifact(tmp_path, "base", "Qwen3.5-0.8B-Base")
    if checkpoint_base is not None:
        write_meta(ck, Meta(base=checkpoint_base, base_revision=base_revision, head={}, lora=4))
    config = {"schema": "kev-local-inference/1", "project_root": str(tmp_path),
              "models": {model_name: {
                  "checkpoint": {"path": str(ck), "source": "acme/kev-local", "revision": "a" * 40},
                  "base": {"path": str(base), "source": base_source or "Qwen/Qwen3.5-0.8B-Base", "revision": base_revision}}},
              "question_sets": {"triage": {"billing": {"type": "noul", "instructions": "Billing?", "criteria": {"true": "yes", "false": "no"}}}},
              "tasks": {"task-a": {"model": model_name, "include": "triage"},
                        "task-b": {"model": model_name, "include": "triage"}}}
    path = tmp_path / "local-inference.json"
    path.write_text(json.dumps(config), encoding="utf-8")
    return path, ck, base


# --- registry validation -------------------------------------------------------------------------------------------

def test_load_registry_reads_both_presets_and_one_shared_question_set(tmp_path):
    path, _, _ = registry_file(tmp_path)
    reg = load_registry(path)
    assert sorted(reg.models) == ["kev-local"] and sorted(reg.tasks) == ["task-a", "task-b"]
    assert reg.questions(reg.task("task-a")) == reg.questions(reg.task("task-b"))
    assert reg.questions(reg.task("task-a"))["billing"]["type"] == "noul"


def test_registry_rejects_wrong_schema_and_unknown_keys(tmp_path):
    path, _, _ = registry_file(tmp_path)
    body = json.loads(path.read_text(encoding="utf-8"))
    body["schema"] = "kev-local-inference/2"
    path.write_text(json.dumps(body), encoding="utf-8")
    with pytest.raises(LocalConfigError, match="schema must be"):
        load_registry(path)
    body["schema"] = "kev-local-inference/1"
    body["extra"] = 1
    path.write_text(json.dumps(body), encoding="utf-8")
    with pytest.raises(LocalConfigError, match="unknown top-level keys"):
        load_registry(path)


def test_relative_path_needs_project_root(tmp_path):
    path, _, _ = registry_file(tmp_path)
    body = json.loads(path.read_text(encoding="utf-8"))
    del body["project_root"]
    body["models"]["kev-local"]["base"]["path"] = "relative/base"
    path.write_text(json.dumps(body), encoding="utf-8")
    with pytest.raises(LocalConfigError, match="needs 'project_root'"):
        load_registry(path)


def test_missing_source_pin_is_refused(tmp_path):
    path, _, _ = registry_file(tmp_path)
    body = json.loads(path.read_text(encoding="utf-8"))
    del body["models"]["kev-local"]["base"]["source"]
    path.write_text(json.dumps(body), encoding="utf-8")
    with pytest.raises(LocalConfigError, match="'source' .* is required"):
        load_registry(path)


def test_task_naming_an_undefined_model_is_refused(tmp_path):
    path, _, _ = registry_file(tmp_path)
    body = json.loads(path.read_text(encoding="utf-8"))
    body["tasks"]["task-a"]["model"] = "kev-9b"
    path.write_text(json.dumps(body), encoding="utf-8")
    with pytest.raises(LocalConfigError, match="not defined in 'models'"):
        load_registry(path)


def test_task_needs_exactly_one_of_questions_or_include(tmp_path):
    path, _, _ = registry_file(tmp_path)
    body = json.loads(path.read_text(encoding="utf-8"))
    body["tasks"]["task-a"]["questions"] = {"q": {"type": "noul", "criteria": {"true": "y", "false": "n"}}}
    path.write_text(json.dumps(body), encoding="utf-8")
    with pytest.raises(LocalConfigError, match="exactly one of"):
        load_registry(path)


def test_unknown_question_set_is_refused(tmp_path):
    path, _, _ = registry_file(tmp_path)
    body = json.loads(path.read_text(encoding="utf-8"))
    body["tasks"]["task-a"]["include"] = "nope"
    path.write_text(json.dumps(body), encoding="utf-8")
    with pytest.raises(LocalConfigError, match="not defined in 'question_sets'"):
        load_registry(path)


def test_missing_config_file_is_a_clear_failure(tmp_path):
    with pytest.raises(LocalConfigError, match="does not exist"):
        load_registry(tmp_path / "absent.json")


# --- strict resolution ---------------------------------------------------------------------------------------------

def test_unknown_task_and_unknown_model_fail_clearly(tmp_path, monkeypatch, no_network):
    offline(monkeypatch)
    path, _, _ = registry_file(tmp_path)
    reg = load_registry(path)
    with pytest.raises(LocalConfigError, match="unknown task id"):
        resolve(reg, "support-triage-9b")
    with pytest.raises(LocalConfigError, match="unknown model id"):
        reg.model("kev-27b")
    no_network.check()


def test_incomplete_artifact_is_refused_with_the_missing_file(tmp_path, monkeypatch, no_network):
    offline(monkeypatch)
    path, ck, _ = registry_file(tmp_path)
    (ck / "adapter_model.safetensors").unlink()
    with pytest.raises(LocalConfigError, match="adapter_model.safetensors is missing"):
        resolve(load_registry(path), "task-a")
    no_network.check()


def test_missing_base_directory_is_refused(tmp_path, monkeypatch, no_network):
    offline(monkeypatch)
    path, _, base = registry_file(tmp_path)
    for child in sorted(base.iterdir()):
        child.unlink()
    base.rmdir()
    with pytest.raises(LocalConfigError, match="base directory .* does not exist"):
        resolve(load_registry(path), "task-a")
    no_network.check()


def test_contradictory_base_source_is_refused(tmp_path, monkeypatch, no_network):
    offline(monkeypatch)
    path, _, _ = registry_file(tmp_path, base_source="Qwen/Qwen3.5-4B-Base")
    with pytest.raises(LocalConfigError, match="refusing to pair a checkpoint with a different base"):
        resolve(load_registry(path), "task-a")
    no_network.check()


def test_contradictory_base_revision_is_refused(tmp_path, monkeypatch, no_network):
    offline(monkeypatch)
    path, _, _ = registry_file(tmp_path, base_revision="b" * 40, checkpoint_base=None)
    with pytest.raises(LocalConfigError, match="refusing to load a different revision"):
        resolve(load_registry(path), "task-a")
    no_network.check()


def test_a_local_base_path_is_unwound_to_its_public_source(tmp_path, monkeypatch, no_network):
    """A checkpoint saved from a local base records that directory; its identity is still the published repository."""
    offline(monkeypatch)
    hub = tmp_path / "hub" / "models--Qwen--Qwen3.5-0.8B-Base" / "snapshots" / BASE_SHA
    hub.mkdir(parents=True)
    path, _, _ = registry_file(tmp_path, checkpoint_base=str(hub))
    resolved = resolve(load_registry(path), "task-a")
    assert resolved.base_source == "Qwen/Qwen3.5-0.8B-Base"
    assert resolved.base_revision == BASE_SHA
    no_network.check()


def test_resolved_carries_both_local_paths_and_the_pinned_identity(tmp_path, monkeypatch, no_network):
    offline(monkeypatch)
    path, ck, base = registry_file(tmp_path)
    resolved = resolve(load_registry(path), "task-a")
    assert Path(resolved.checkpoint.path) == ck and resolved.base_path == base
    assert resolved.base_source == "Qwen/Qwen3.5-0.8B-Base" and resolved.base_revision == BASE_SHA
    card = resolved.card()
    assert card["checkpoint"]["pin"] == {"source": "acme/kev-local", "revision": "a" * 40}
    assert card["base"]["pin"] == {"source": "Qwen/Qwen3.5-0.8B-Base", "revision": BASE_SHA}
    assert card["base"]["path"] == str(base) and card["verified_sha256"] is None
    opts = resolved.load_options(LoadOptions())
    assert opts.base_path == base   # the loader gets the directory; head.pt keeps the identity
    no_network.check()


def test_base_identity_of_a_local_and_a_hub_base(tmp_path):
    from kev.model import base_identity
    assert base_identity("Qwen/Qwen3.5-0.8B-Base") == "Qwen/Qwen3.5-0.8B-Base"
    hub = tmp_path / "hub" / "models--Qwen--Qwen3.5-4B-Base" / "snapshots" / ("c" * 40)
    hub.mkdir(parents=True)
    assert base_identity(hub) == "Qwen/Qwen3.5-4B-Base"
    plain = tmp_path / "models" / "Qwen3.5-0.8B-Base"
    plain.mkdir(parents=True)
    assert base_identity(plain) == "Qwen3.5-0.8B-Base"
    assert base_identity(tmp_path / "gone") == str(tmp_path / "gone")


def test_config_path_prefers_the_explicit_argument_and_else_the_environment(monkeypatch):
    monkeypatch.setenv("KEV_LOCAL_INFERENCE_CONFIG", "/tmp/from-env.json")
    assert config_path() == "/tmp/from-env.json"
    assert config_path("/tmp/explicit.json") == "/tmp/explicit.json"
    monkeypatch.delenv("KEV_LOCAL_INFERENCE_CONFIG")
    assert config_path() is None   # legacy mode: --run, unchanged


def test_a_legacy_load_options_is_untouched_by_local_mode():
    opts = LoadOptions(merge=False, backend="torch")
    assert load_options(opts).base_path is None
    assert load_options(opts, "/some/base").base_path == Path("/some/base")
    assert load_options(opts, "/some/base").merge is False


def test_receipt_verification_matches_the_acquired_bytes(tmp_path):
    """--receipt re-hashes every payload, so the pins a card reports are the bytes actually on disk (Codex P2 on #4:
    without this, a swapped artifact with the expected filenames still resolves and claims the official pin)."""
    import hashlib
    from kev.local import verify_artifacts
    from kev.suite import write_json
    path, ck, base = registry_file(tmp_path)
    reg = load_registry(path)
    payloads = {"kev-local.checkpoint": (ck / "adapter_model.safetensors", "acme/kev-local", "a" * 40),
                "kev-local.base": (base / "model.safetensors", "Qwen/Qwen3.5-0.8B-Base", BASE_SHA)}
    receipt = tmp_path / "receipt.json"
    write_json(receipt, {key: {"repo": repo, "revision": rev,
                               "sha256": {p.name: hashlib.sha256(p.read_bytes()).hexdigest()}}
                         for key, (p, repo, rev) in payloads.items()})
    checked = verify_artifacts(reg, receipt)
    assert set(checked) == {"kev-local.checkpoint", "kev-local.base"}
    payloads["kev-local.base"][0].write_bytes(b"\x01" * 8)      # the same filename, different weights
    with pytest.raises(LocalConfigError, match="refusing to serve this artifact as Qwen/Qwen3.5-0.8B-Base"):
        verify_artifacts(reg, receipt)
    payloads["kev-local.base"][0].unlink()
    with pytest.raises(LocalConfigError, match="records it as acquired"):
        verify_artifacts(reg, receipt)


def test_receipt_verification_refuses_a_missing_or_contradictory_entry(tmp_path):
    import hashlib
    from kev.local import verify_artifacts
    from kev.suite import write_json
    path, ck, base = registry_file(tmp_path)
    reg = load_registry(path)
    empty = tmp_path / "empty.json"
    write_json(empty, {})
    with pytest.raises(LocalConfigError, match="no receipt entry for checkpoint"):
        verify_artifacts(reg, empty)
    digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()   # noqa: E731
    wrong = tmp_path / "wrong.json"
    write_json(wrong, {"kev-local.checkpoint": {"repo": "someone/else", "revision": "a" * 40,
                                                "sha256": {"adapter_model.safetensors": digest(ck / "adapter_model.safetensors")}},
                       "kev-local.base": {"repo": "Qwen/Qwen3.5-0.8B-Base", "revision": BASE_SHA,
                                          "sha256": {"model.safetensors": digest(base / "model.safetensors")}}})
    with pytest.raises(LocalConfigError, match="but the registry pins 'acme/kev-local'"):
        verify_artifacts(reg, wrong)


# --- batch inputs --------------------------------------------------------------------------------------------------

def test_read_states_rejects_bad_rows(tmp_path):
    from kev.task import read_states
    good = tmp_path / "good.jsonl"
    good.write_text('{"state": "one"}\n\n{"state": {"document": "two"}}\n', encoding="utf-8")
    assert [s for _, s in read_states(good)] == ["one", {"document": "two"}]
    for body, message in [('{"state": 1}\n{"nope": 2}\n', "needs a 'state' key"),
                          ('not json\n', "not valid JSON"),
                          ('{"state": "x", "model": "kev-4b"}\n', "may not select a model"),
                          ('\n', "no input rows")]:
        bad = tmp_path / "bad.jsonl"
        bad.write_text(body, encoding="utf-8")
        with pytest.raises(LocalConfigError, match=message):
            read_states(bad)


def test_task_request_uses_the_task_questions_and_the_task_model(tmp_path, monkeypatch, no_network):
    offline(monkeypatch)
    path, _, _ = registry_file(tmp_path)
    resolved = resolve(load_registry(path), "task-a")
    req = __import__("kev.task", fromlist=["task_request"]).task_request(resolved, "hello")
    assert req.state == "hello" and req.model == "kev-local"
    assert set(req.questions) == {"billing"} and req.questions["billing"].type == "noul"
    no_network.check()


# --- both presets agree on states and questions --------------------------------------------------------------------

def test_both_presets_share_one_question_set_in_the_committed_example():
    example = json.loads((ROOT / "examples/local-inference/local-inference.example.json").read_text(encoding="utf-8"))
    assert set(example["tasks"]) == {"support-triage-0.8b", "support-triage-4b"}
    first, second = example["tasks"]["support-triage-0.8b"], example["tasks"]["support-triage-4b"]
    assert first["include"] == second["include"]
    assert example["models"][first["model"]]["base"]["path"] != example["models"][second["model"]]["base"]["path"]
    assert first["model"] != second["model"]   # they differ only in the model selection
    questions = example["question_sets"][first["include"]]
    assert {q["type"] for q in questions.values()} == {"choice", "noul", "score"}


def test_the_committed_example_carries_no_machine_path():
    text = (ROOT / "examples/local-inference/local-inference.example.json").read_text(encoding="utf-8")
    assert "/Users/" not in text and "/home/" not in text and "C:\\\\" not in text
    assert "jaredpalmer/kev-0.8b" in text and "jaredpalmer/kev-4b" in text


def test_the_synthetic_input_has_three_short_english_states():
    rows = [json.loads(line) for line in (ROOT / "examples/local-inference/support.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    assert len(rows) == 3
    for row in rows:
        assert isinstance(row["state"], str) and 20 < len(row["state"]) < 200
        assert row["state"].isascii()


# --- the CLI -------------------------------------------------------------------------------------------------------

def test_cli_reports_a_missing_config_as_a_clear_error(tmp_path):
    out = subprocess.run([sys.executable, "-m", "kev.task", "--config", str(tmp_path / "absent.json"), "--task", "t",
                          "--input", str(tmp_path / "in.jsonl"), "--out", str(tmp_path / "out")],
                         cwd=ROOT, capture_output=True, text=True)
    assert out.returncode == 2 and "does not exist" in out.stderr and "Traceback" not in out.stderr


def test_cli_reports_an_unknown_task_as_a_clear_error(tmp_path):
    path, _, _ = registry_file(tmp_path)
    rows = tmp_path / "in.jsonl"
    rows.write_text('{"state": "one"}\n', encoding="utf-8")
    out = subprocess.run([sys.executable, "-m", "kev.task", "--config", str(path), "--task", "nope",
                          "--input", str(rows), "--out", str(tmp_path / "out")],
                         cwd=ROOT, capture_output=True, text=True)
    assert out.returncode == 2 and "unknown task id" in out.stderr and "Traceback" not in out.stderr


def test_serve_requires_config_and_task_together(tmp_path):
    out = subprocess.run([sys.executable, "-m", "kev.serve", "--config", str(tmp_path / "c.json")],
                         cwd=ROOT, capture_output=True, text=True)
    assert out.returncode == 2 and "--config and --task are used together" in out.stderr


def test_serve_refuses_run_together_with_a_task(tmp_path):
    out = subprocess.run([sys.executable, "-m", "kev.serve", "--run", "runs/x", "--config", str(tmp_path / "c.json"),
                          "--task", "t"], cwd=ROOT, capture_output=True, text=True)
    assert out.returncode == 2 and "mutually exclusive" in out.stderr


def test_cli_refuses_a_batch_size_below_one(tmp_path):
    out = subprocess.run([sys.executable, "-m", "kev.task", "--config", str(tmp_path / "c.json"), "--task", "t",
                          "--input", str(tmp_path / "in.jsonl"), "--out", str(tmp_path / "out"), "--batch", "0"],
                         cwd=ROOT, capture_output=True, text=True)
    assert out.returncode == 2 and "at least 1" in out.stderr


def test_device_memory_definition_never_claims_an_unmeasured_peak():
    """Every reported memory figure carries the mechanism that produced it (TICKET-SMOKE), including the no-counter case."""
    from kev.task import _device_memory
    class Torch:
        backend = "torch"
    class MLX:
        backend = "mlx"
    assert _device_memory("cpu", Torch()) == (None, "cpu: no device memory counter")
    bytes_, definition = _device_memory("mps", Torch())
    assert bytes_ >= 0 and ("allocated_bytes" in definition or "reported 0 bytes" in definition)
    mlx_bytes, mlx_definition = _device_memory("mps", MLX())
    assert mlx_bytes >= 0   # 0 only when this process has not put anything on Metal yet
    assert "mlx.core.get_peak_memory" in mlx_definition and "peak Metal memory" in mlx_definition


# --- integration: real artifacts -----------------------------------------------------------------------------------

pytestmark_integration = pytest.mark.skipif(not CONFIG, reason="KEV_LOCAL_INFERENCE_CONFIG is not set: real local artifacts are needed")


@pytest.mark.integration
@pytestmark_integration
def test_integration_local_config_resolves_offline(monkeypatch):
    offline(monkeypatch)
    reg = load_registry(CONFIG)
    for task_id in ("support-triage-0.8b", "support-triage-4b"):
        resolved = resolve(reg, task_id)
        assert Path(resolved.checkpoint.path).is_dir() and resolved.base_path.is_dir()
        assert resolved.base_source.startswith("Qwen/Qwen3.5-") and len(resolved.base_revision) == 40
    assert reg.questions(reg.task("support-triage-0.8b")) == reg.questions(reg.task("support-triage-4b"))


@pytest.mark.integration
@pytestmark_integration
def test_integration_offline_native_weight_load_uses_the_local_base(monkeypatch):
    """The configured path loads real native weights with Hub and Transformers offline, and the base it read is the
    registry's directory — not the Hub id in head.pt. The checkpoint's own head.pt is untouched by the load."""
    import torch
    offline(monkeypatch)
    resolved = resolve(load_registry(CONFIG), "support-triage-0.8b")
    before = (Path(resolved.checkpoint.path) / "head.pt").read_bytes()
    tok, model = resolved.checkpoint.load("cpu", resolved.load_options(LoadOptions(dtype=torch.float32, attn="eager", backend="torch")))
    assert model.backend == "torch" and model.hybrid is True and model.dtype == "float32"
    assert str(model.lm.config._name_or_path) == str(resolved.base_path), "the backbone must be the registry's local base"
    assert (Path(resolved.checkpoint.path) / "head.pt").read_bytes() == before, "the load must not rewrite head.pt"
    enc = model.encode(tok, {"state": "The tracking page has not moved in six days.", "questions": [
        {"instr": "Which team should handle this ticket?", "options": ["returns", "shipping", "billing"], "label": 0}]})
    probs = model.probs(enc)[0]
    assert abs(float(sum(probs)) - 1.0) < 1e-4 and all(0.0 <= float(p) <= 1.0 for p in probs)


@pytest.mark.integration
@pytestmark_integration
def test_integration_local_load_does_not_reach_the_network(monkeypatch):
    """The same configured load with every socket entry point replaced: an offline load must not open one."""
    import torch
    offline(monkeypatch)
    sentinel = SocketSentinel()
    monkeypatch.setattr(socket, "socket", sentinel)
    monkeypatch.setattr(socket, "create_connection", sentinel)
    monkeypatch.setattr(socket, "getaddrinfo", sentinel)
    resolved = resolve(load_registry(CONFIG), "support-triage-0.8b")
    resolved.checkpoint.load("cpu", resolved.load_options(LoadOptions(dtype=torch.float32, attn="eager", backend="torch")))
    sentinel.check()


@pytest.mark.integration
@pytestmark_integration
def test_integration_batch_cli_answers_the_synthetic_states(tmp_path):
    """The real batch CLI on the real checkpoint, one model at a time, with the Hub and Transformers offline."""
    env = {**os.environ, "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"}
    out = subprocess.run([sys.executable, "-m", "kev.task", "--config", CONFIG, "--task", "support-triage-0.8b",
                          "--input", str(ROOT / "examples/local-inference/support.jsonl"), "--out", str(tmp_path)],
                         cwd=ROOT, capture_output=True, text=True, env=env)
    assert out.returncode == 0, out.stderr[-4000:]
    rows = [json.loads(line) for line in (tmp_path / "rows.jsonl").read_text(encoding="utf-8").splitlines()]
    assert len(rows) == 3
    for row in rows:
        answers = row["answers"]
        assert set(answers) == {"department", "needs_manager", "urgency"}
        assert answers["department"]["choice"] in answers["department"]["probabilities"]
        assert 0.0 <= answers["needs_manager"]["noul"] <= 1.0
        probs = answers["urgency"]["probabilities"]
        assert set(probs) == {"0", "1", "2"} and 0.0 <= answers["urgency"]["score"] <= 2.0
        assert abs(sum(probs.values()) - 1.0) < 0.03 and all(0.0 <= v <= 1.0 for v in probs.values())
    summary = json.loads((tmp_path / "task.json").read_text(encoding="utf-8"))
    assert summary["identity"]["checkpoint"]["pin"]["source"] == "jaredpalmer/kev-0.8b"
    assert summary["identity"]["base"]["pin"] == {"source": "Qwen/Qwen3.5-0.8B-Base", "revision": BASE_SHA}


@pytest.mark.integration
@pytestmark_integration
@pytest.mark.skipif(not REFERENCE, reason="KEV_REFERENCE_ROOT is not set: the read-only baseline worktree is needed")
def test_integration_separate_process_fp32_parity(tmp_path):
    """The reference revision and this checkout score the same synthetic requests in two processes on CPU/fp32/eager,
    from the same original artifacts, and the logits and probabilities must match exactly (no tolerance)."""
    sys.path.insert(0, str(ROOT))
    from scripts.local_parity import cases   # noqa: E402  the same inputs in both processes
    _digest = __import__("scripts.local_parity", fromlist=["digest"]).digest
    expected_inputs = [_digest(case) for case in cases()]
    resolved = resolve(load_registry(CONFIG), "support-triage-0.8b")
    base = {"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "OMP_NUM_THREADS": "1", "MKL_NUM_THREADS": "1"}
    reference_json, delivery_json = tmp_path / "reference.json", tmp_path / "delivery.json"
    # Both processes run THIS checkout's runner, so the measured inputs and dumps are identical; only the kev package
    # differs — PYTHONPATH puts the reference revision's kev/ first for the baseline run.
    runner = ROOT / "scripts/local_parity.py"
    assert (Path(REFERENCE) / "kev/checkpoint.py").is_file(), f"{REFERENCE} is not a kev checkout"
    ref = subprocess.run([sys.executable, str(runner), "--mode", "reference",
                          "--checkpoint", str(resolved.checkpoint.path), "--out", str(reference_json)],
                         cwd=REFERENCE, capture_output=True, text=True,
                         env={**os.environ, **base, "PYTHONPATH": str(REFERENCE)})
    assert ref.returncode == 0, ref.stderr[-4000:]
    new = subprocess.run([sys.executable, str(ROOT / "scripts/local_parity.py"), "--mode", "local",
                          "--config", CONFIG, "--task", "support-triage-0.8b", "--out", str(delivery_json)],
                         cwd=ROOT, capture_output=True, text=True, env={**os.environ, **base})
    assert new.returncode == 0, new.stderr[-4000:]
    a, b = json.loads(reference_json.read_text(encoding="utf-8")), json.loads(delivery_json.read_text(encoding="utf-8"))
    assert a["checkpoint_files"] == b["checkpoint_files"], "the two processes must read the same original checkpoint bytes"
    assert a["kernel_environment"] == b["kernel_environment"], "the two processes must run the same kernels"
    assert a["temperature"] == b["temperature"]
    assert [c["input_sha256"] for c in a["cases"]] == expected_inputs
    assert [c["input_sha256"] for c in b["cases"]] == expected_inputs, "both processes must score the same synthetic inputs"
    for one, two in zip(a["cases"], b["cases"]):
        assert one["logits"] == two["logits"], f"case {one['index']}: logits differ"
        assert one["probs"] == two["probs"], f"case {one['index']}: probabilities differ"
        assert one["probs_sum"] == two["probs_sum"]
    assert not a["base_path"] and b["base_path"], "only the delivery resolves the base from the local registry"
