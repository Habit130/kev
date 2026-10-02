"""Explicit local model registry and named task presets: one JSON format, no Hub fallback.

A machine-local JSON file holds everything that is specific to one machine, so nothing here is pinned to a
path in the repository:

    {
      "schema": "kev-local-inference/1",
      "project_root": "/abs/path/to/this/checkout",       # optional; relative local paths resolve against it
      "models": {
        "kev-0.8b": {
          "checkpoint": {"path": ".local/models/jaredpalmer/kev-0.8b",
                         "source": "jaredpalmer/kev-0.8b",
                         "revision": "bf75a6a8849..."},
          "base":       {"path": "/Users/me/Models/Qwen/Qwen3.5-0.8B-Base",
                         "source": "Qwen/Qwen3.5-0.8B-Base",
                         "revision": "dc7cdfe2ee4..."}
        }
      },
      "tasks": {
        "support-triage-0.8b": {"model": "kev-0.8b", "questions": {...}}
      }
    }

Source identity and local storage stay separate: `source`/`revision` name the pinned public artifact, `path`
is where this machine keeps it, and the loader never substitutes one for the other. A configured task
resolves exactly one checkpoint and its exact matching base, offline, and a contradiction (unknown id, missing
file, source or revision that disagrees with the artifact's own metadata) is a hard failure, never a download
or a different model.

`LOAD_OPTIONS` is the bridge to `kev.checkpoint`: the resolved local base path travels in
`LoadOptions.base_path`, so `kev.checkpoint` still owns the loader rule, the adapter/base pairing and the
backend choice. Nothing writes to `head.pt`, `config.json` or `adapter_config.json` to insert a local path.
"""
import json
import os
from dataclasses import dataclass, field, replace
from pathlib import Path

from .checkpoint import Checkpoint, LoadOptions, base_weights
from .model import is_hybrid

SCHEMA = "kev-local-inference/1"
MODE_ENV = "KEV_LOCAL_INFERENCE_CONFIG"


class LocalConfigError(ValueError):
    """A registry, task or artifact that configured local mode cannot resolve. Always a hard failure."""


def config_path(explicit=None, env=os.environ):
    """The local config file to use: the explicit argument, else KEV_LOCAL_INFERENCE_CONFIG, else None (legacy mode)."""
    return explicit or env.get(MODE_ENV) or None


@dataclass(frozen=True)
class Entry:
    """One artifact: where it is on this machine and which pinned public source it must be."""
    path: Path
    source: str
    revision: str | None = None


@dataclass(frozen=True)
class ModelEntry:
    """One logical model id: its Kev checkpoint and the exact base that checkpoint was trained on."""
    id: str
    checkpoint: Entry
    base: Entry


@dataclass(frozen=True)
class TaskPreset:
    """One named preset: a fixed model plus the questions every batch or served request asks about the state. The
    questions are either declared inline (`questions`) or included from a named `question_sets` entry (`include`);
    Registry.questions resolves either form, so the two never have two sources of truth."""
    id: str
    model: str
    questions: dict
    include: str | None = None
    description: str | None = None


@dataclass(frozen=True)
class Registry:
    """The parsed config file, with every local path already absolute."""
    path: Path
    models: dict
    tasks: dict
    question_sets: dict = field(default_factory=dict)

    def model(self, model_id):
        try:
            return self.models[model_id]
        except KeyError:
            raise LocalConfigError(f"{self.path}: unknown model id {model_id!r}; known ids: {sorted(self.models)}") from None

    def task(self, task_id):
        try:
            return self.tasks[task_id]
        except KeyError:
            raise LocalConfigError(f"{self.path}: unknown task id {task_id!r}; known ids: {sorted(self.tasks)}") from None

    def questions(self, task):
        """A task's questions, whether declared inline or included from 'question_sets'. Presets that differ only in
        their model share one set by name, so they cannot drift apart."""
        return self.question_sets[task.include] if task.include is not None else task.questions


def _entry(where, what, root):
    if not isinstance(where, dict):
        raise LocalConfigError(f"{what} must be an object with 'path' (and 'source'/'revision' pins), got {type(where).__name__}")
    unknown = sorted(set(where) - {"path", "source", "revision"})
    if unknown:
        raise LocalConfigError(f"{what}: unknown keys {unknown}; expected only path, source, revision")
    path = where.get("path")
    source = where.get("source")
    if not path or not isinstance(path, str):
        raise LocalConfigError(f"{what}: 'path' is required and must be a string")
    if not source or not isinstance(source, str):
        raise LocalConfigError(f"{what}: 'source' (the pinned public repository id) is required and must be a string")
    revision = where.get("revision")
    if revision is not None and not isinstance(revision, str):
        raise LocalConfigError(f"{what}: 'revision' must be a string when given")
    resolved = Path(path)
    if not resolved.is_absolute():
        if root is None:
            raise LocalConfigError(f"{what}: relative path {path!r} needs 'project_root' in the config file")
        resolved = root / resolved
    return Entry(path=resolved, source=source, revision=revision)


def load_registry(path):
    """Read and validate one local config file. Raises LocalConfigError, never falls back to anything."""
    path = Path(path)
    if not path.is_file():
        raise LocalConfigError(f"local inference config {path} does not exist (KEV_LOCAL_INFERENCE_CONFIG)")
    try:
        body = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise LocalConfigError(f"{path}: not valid JSON: {exc}") from exc
    if not isinstance(body, dict):
        raise LocalConfigError(f"{path}: the config file must be a JSON object")
    if body.get("schema") != SCHEMA:
        raise LocalConfigError(f"{path}: schema must be {SCHEMA!r}, got {body.get('schema')!r}")
    unknown = sorted(set(body) - {"schema", "project_root", "models", "tasks", "question_sets"})
    if unknown:
        raise LocalConfigError(f"{path}: unknown top-level keys {unknown}; expected schema, project_root, models, question_sets, tasks")
    root = Path(body["project_root"]) if isinstance(body.get("project_root"), str) else None
    models_raw = body.get("models")
    if not isinstance(models_raw, dict) or not models_raw:
        raise LocalConfigError(f"{path}: 'models' must be a non-empty object")
    models = {}
    for model_id, spec in models_raw.items():
        what = f"{path}: models[{model_id!r}]"
        if not isinstance(spec, dict):
            raise LocalConfigError(f"{what} must be an object")
        unknown = sorted(set(spec) - {"checkpoint", "base", "description"})
        if unknown:
            raise LocalConfigError(f"{what}: unknown keys {unknown}; expected checkpoint, base, description")
        if "checkpoint" not in spec or "base" not in spec:
            raise LocalConfigError(f"{what}: both 'checkpoint' and 'base' are required")
        models[model_id] = ModelEntry(id=model_id, checkpoint=_entry(spec["checkpoint"], f"{what}.checkpoint", root),
                                      base=_entry(spec["base"], f"{what}.base", root))
    question_sets_raw = body.get("question_sets") or {}
    if not isinstance(question_sets_raw, dict):
        raise LocalConfigError(f"{path}: 'question_sets' must be an object when given")
    for set_id, questions in question_sets_raw.items():
        if not isinstance(questions, dict) or not questions:
            raise LocalConfigError(f"{path}: question_sets[{set_id!r}] must be a non-empty object of questions")
    tasks_raw = body.get("tasks") or {}
    if not isinstance(tasks_raw, dict):
        raise LocalConfigError(f"{path}: 'tasks' must be an object when given")
    tasks = {}
    for task_id, spec in tasks_raw.items():
        what = f"{path}: tasks[{task_id!r}]"
        if not isinstance(spec, dict):
            raise LocalConfigError(f"{what} must be an object")
        unknown = sorted(set(spec) - {"model", "questions", "include", "description"})
        if unknown:
            raise LocalConfigError(f"{what}: unknown keys {unknown}; expected model, questions, include, description")
        model_id = spec.get("model")
        if not isinstance(model_id, str) or not model_id:
            raise LocalConfigError(f"{what}: 'model' must name a model id in this file")
        if model_id not in models:
            raise LocalConfigError(f"{what}: model {model_id!r} is not defined in 'models'; a task may not imply another model")
        include, questions = spec.get("include"), spec.get("questions")
        if (include is None) == (questions is None):
            raise LocalConfigError(f"{what}: declare exactly one of 'questions' or 'include'")
        if include is not None:
            if include not in question_sets_raw:
                raise LocalConfigError(f"{what}: question set {include!r} is not defined in 'question_sets'")
            questions = {}
        elif not isinstance(questions, dict) or not questions:
            raise LocalConfigError(f"{what}: 'questions' must be a non-empty object")
        tasks[task_id] = TaskPreset(id=task_id, model=model_id, questions=questions, include=include,
                                    description=spec.get("description"))
    return Registry(path=path, models=models, tasks=tasks, question_sets=dict(question_sets_raw))


def load_options(opts=LoadOptions(), base_path=None):
    """LoadOptions for a locally resolved artifact: same options, with the local base path the loader must use."""
    if base_path is None:
        return opts
    return replace(opts, base_path=Path(base_path))


def resolved_meta(ck, entry):
    """The checkpoint's own identity, checked against the registry pin. -> (base source, base revision).

    `head.pt` carries the base it was trained on; a registry entry that disagrees with it is a contradictory
    selection, not a reason to load a different base."""
    meta = ck.meta
    if entry.source != meta.base_identity:
        raise LocalConfigError(
            f"{entry.path}: head.pt says the base is {meta.base_identity!r} but the registry pins {entry.source!r}; "
            f"refusing to pair a checkpoint with a different base")
    if entry.revision and meta.base_revision and entry.revision != meta.base_revision:
        raise LocalConfigError(
            f"{entry.path}: head.pt pins base revision {meta.base_revision} but the registry pins {entry.revision}; "
            f"refusing to load a different revision of the base")
    return meta.base_identity, meta.base_revision


def artifact_problems(kind, path):
    """Missing or empty required files of an already-acquired artifact. -> a list of human-readable problems."""
    path = Path(path)
    if not path.is_dir():
        return [f"{kind} directory {path} does not exist"]
    problems = []
    if kind == "checkpoint":
        problems += [f"checkpoint {path}/{name} is missing" for name in ("head.pt", "adapter_config.json", "adapter_model.safetensors")
                     if not (path / name).is_file()]
    else:
        problems += [f"base {path}/{name} is missing" for name in ("config.json", "model.safetensors.index.json")
                     if not (path / name).is_file()]
        if not base_weights(path):
            problems.append(f"base {path} holds no model*.safetensors weights")
    problems += [f"{kind} {p} is empty" for p in sorted(path.rglob("*")) if p.is_file() and p.stat().st_size == 0]
    return problems


def require_artifact(kind, path):
    problems = artifact_problems(kind, path)
    if problems:
        raise LocalConfigError(f"incomplete local acquisition: " + "; ".join(problems))


def resolve(registry, task_id):
    """A configured task -> its checkpoint, its exact base, and the LoadOptions that keep both local.

    Every failure here is a hard failure; there is deliberately no network, cache or alternate-model path."""
    task = registry.task(task_id)
    model = registry.model(task.model)
    require_artifact("checkpoint", model.checkpoint.path)
    require_artifact("base", model.base.path)
    ck = Checkpoint(str(model.checkpoint.path))
    base_source, base_revision = resolved_meta(ck, model.base)
    return Resolved(registry=registry, task=task, model=model, checkpoint=ck, base_path=Path(model.base.path),
                    base_source=base_source, base_revision=base_revision, questions=registry.questions(task))


def hybrid_check(base_path):
    """Whether the configured base is a hybrid (Qwen3.5 Gated DeltaNet) backbone, read from its config.json."""
    from transformers import AutoConfig
    return is_hybrid(AutoConfig.from_pretrained(str(base_path)).get_text_config())


@dataclass(frozen=True)
class Resolved:
    """One task's fixed model selection: what the batch runner and the serving startup both use."""
    registry: Registry
    task: TaskPreset
    model: ModelEntry
    checkpoint: Checkpoint   # kev.checkpoint.Checkpoint, resolved locally
    base_path: Path
    base_source: str
    base_revision: str | None
    questions: dict

    def load_options(self, opts=LoadOptions()):
        return load_options(opts, self.base_path)

    def card(self, backend=None, dtype=None, device=None):
        """The identity a client can check: the actual checkpoint, base, sources and revisions — not the request alias."""
        return {
            "task": self.task.id,
            "model_id": self.model.id,
            "checkpoint": {"path": str(self.checkpoint.path), "source": self.model.checkpoint.source,
                           "revision": self.model.checkpoint.revision, "requested": self.checkpoint.requested},
            "base": {"path": str(self.base_path), "source": self.base_source, "revision": self.base_revision},
            "backend": backend, "dtype": dtype, "device": device,
        }
