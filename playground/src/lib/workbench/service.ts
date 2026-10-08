import { randomUUID } from "node:crypto";
import { WorkbenchError } from "@/lib/workbench/errors";
import { isLocale, type Locale } from "@/lib/workbench/locale";
import { cloneJson, isJsonObject, parseJson, type JsonObject, type JsonValue } from "@/lib/workbench/json";
import {
  createHistoryId,
  deleteHistory,
  exportTasksFile,
  importedAppFile,
  readAppFile,
  readHistory,
  readHistoryRecord,
  updateAppFile,
  writeAppFile,
  writeHistory,
  type HistoryRecord,
  type WorkbenchAppFile,
  type WorkbenchSettings,
} from "@/lib/workbench/storage";
import {
  deterministicIdentity,
  isDeterministicTestMode,
  readTestControls,
  setTestControls,
  shouldFailHistoryWrite,
  withReadyRuntime,
  runSystemOne,
  runtimeStatus,
  type TestControls,
} from "@/lib/workbench/runtime";
import { isModelId, validateQuestions, validateTemplateList, type ModelId, type WorkbenchTemplate } from "@/lib/workbench/tasks";

const activeRunKey = Symbol.for("kev.workbench.active-runs");

function activeRunIds(): Set<string> {
  const root = globalThis as typeof globalThis & { [activeRunKey]?: Set<string> };
  root[activeRunKey] ??= new Set<string>();
  return root[activeRunKey];
}

export type PublicSettings = Pick<WorkbenchSettings, "selectedModel" | "exportModel" | "theme" | "locale" | "projectDescription">;

export type WorkbenchSnapshot = {
  settings: PublicSettings;
  templates: WorkbenchTemplate[];
  history: HistoryRecord[];
  runtime: Awaited<ReturnType<typeof runtimeStatus>>;
};

function publicSettings(settings: WorkbenchSettings): PublicSettings {
  return {
    selectedModel: settings.selectedModel,
    exportModel: settings.exportModel,
    theme: settings.theme,
    locale: settings.locale,
    ...(settings.projectDescription === undefined ? {} : { projectDescription: settings.projectDescription }),
  };
}

export async function getWorkbenchSnapshot(): Promise<WorkbenchSnapshot> {
  const runtime = await runtimeStatus();
  const app = readAppFile();
  return {
    settings: publicSettings(app.settings),
    templates: app.templates,
    history: readHistory(activeRunIds()),
    runtime,
  };
}

export function updateSettings(value: unknown): WorkbenchAppFile {
  if (!isJsonObject(value)) throw new WorkbenchError("Settings must be a JSON object.", "invalid_input", 400);
  const supported = new Set(["selectedModel", "exportModel", "theme", "locale", "projectDescription"]);
  const unexpected = Object.keys(value).filter((key) => !supported.has(key));
  if (unexpected.length) throw new WorkbenchError(`Unsupported setting${unexpected.length === 1 ? "" : "s"}: ${unexpected.join(", ")}.`, "invalid_input", 400);
  if ("selectedModel" in value && !isModelId(value.selectedModel)) {
    throw new WorkbenchError("Select one of the registered logical models.", "invalid_input", 400);
  }
  if ("exportModel" in value && !isModelId(value.exportModel)) {
    throw new WorkbenchError("Select one of the registered logical models for export.", "invalid_input", 400);
  }
  if ("theme" in value && value.theme !== "light" && value.theme !== "dark") {
    throw new WorkbenchError("Theme must be light or dark.", "invalid_input", 400);
  }
  if ("locale" in value && !isLocale(value.locale)) {
    throw new WorkbenchError("Language must be zh-CN or en.", "invalid_input", 400);
  }
  if (isDeterministicTestMode() && readTestControls().settingsWriteFailure) {
    throw new WorkbenchError("Controlled settings persistence failure.", "storage_error", 500);
  }
  if ("projectDescription" in value && value.projectDescription !== undefined && typeof value.projectDescription !== "string") {
    if (value.projectDescription !== null) throw new WorkbenchError("Project description must be text.", "invalid_input", 400);
  }
  const app = updateAppFile((current) => {
    const settings: WorkbenchSettings = {
      ...current.settings,
      ...(value.selectedModel === undefined ? {} : { selectedModel: value.selectedModel as ModelId }),
      ...(value.exportModel === undefined ? {} : { exportModel: value.exportModel as ModelId }),
      ...(value.theme === undefined ? {} : { theme: value.theme as "light" | "dark" }),
      ...(value.locale === undefined ? {} : { locale: value.locale as Locale }),
      ...(typeof value.projectDescription === "string" ? { projectDescription: value.projectDescription } : {}),
    };
    if (value.projectDescription === null) delete settings.projectDescription;
    return { ...current, settings };
  });
  return app;
}

function requiredObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) throw new WorkbenchError(`${label} must be a JSON object.`, "invalid_input", 400);
  return value;
}

export async function saveTemplate(value: unknown): Promise<WorkbenchSnapshot> {
  const template = requiredObject(value, "Template");
  const nextTemplate: WorkbenchTemplate = {
    id: typeof template.id === "string" && template.id ? template.id : randomUUID(),
    taskId: typeof template.taskId === "string" ? template.taskId : "",
    name: typeof template.name === "string" ? template.name : "",
    ...(template.description === undefined ? {} : { description: template.description as string }),
    questions: requiredObject(template.questions, "Questions"),
  };
  validateQuestions(nextTemplate.questions);
  const app = readAppFile();
  const existingIndex = app.templates.findIndex((saved) => saved.id === nextTemplate.id);
  const templates = [...app.templates];
  if (existingIndex === -1) templates.push(nextTemplate);
  else templates[existingIndex] = nextTemplate;
  validateTemplateList(templates);
  writeAppFile({ ...app, templates });
  return getWorkbenchSnapshot();
}

export async function removeTemplate(id: unknown): Promise<WorkbenchSnapshot> {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) {
    throw new WorkbenchError("Template id is invalid.", "invalid_input", 400);
  }
  updateAppFile((app) => ({ ...app, templates: app.templates.filter((template) => template.id !== id) }));
  return getWorkbenchSnapshot();
}

export async function importTasks(raw: string): Promise<WorkbenchSnapshot> {
  const imported = importedAppFile(raw);
  writeAppFile(imported);
  return getWorkbenchSnapshot();
}

export function exportTasks(model: unknown): { file: string } {
  if (!isModelId(model)) throw new WorkbenchError("Select one of the registered logical models for export.", "invalid_input", 400);
  const app = readAppFile();
  if (app.templates.length === 0) throw new WorkbenchError("Save at least one task template before exporting.", "invalid_input", 400);
  return {
    file: exportTasksFile(model, app.settings.projectDescription, app.templates),
  };
}

export async function removeHistory(id: unknown): Promise<WorkbenchSnapshot> {
  if (typeof id !== "string") throw new WorkbenchError("Run id is invalid.", "invalid_input", 400);
  deleteHistory(id);
  return getWorkbenchSnapshot();
}

export function historyRecord(id: unknown): HistoryRecord {
  if (typeof id !== "string") throw new WorkbenchError("Run id is invalid.", "invalid_input", 400);
  const record = readHistoryRecord(id);
  if (!record) throw new WorkbenchError("Run history record was not found.", "not_found", 404);
  return record;
}

type RunInput = {
  stateMode: "text" | "json";
  stateText: string;
  questions: JsonObject;
  taskId: string;
  taskName: string;
};

function parseRunInput(value: unknown): RunInput & { state: JsonValue } {
  const body = requiredObject(value, "Run request");
  if (
    body.action !== "run" ||
    (body.stateMode !== "text" && body.stateMode !== "json") ||
    typeof body.stateText !== "string" ||
    typeof body.taskId !== "string" ||
    !body.taskId.trim() ||
    body.taskId.length > 200 ||
    typeof body.taskName !== "string" ||
    !body.taskName.trim() ||
    body.taskName.length > 200
  ) {
    throw new WorkbenchError("Run details are incomplete. Select a task and enter a state.", "invalid_input", 400);
  }
  const questions = requiredObject(body.questions, "Questions");
  validateQuestions(questions);
  let state: JsonValue;
  if (body.stateMode === "text") state = body.stateText;
  else {
    try {
      state = parseJson(body.stateText);
    } catch (error) {
      throw new WorkbenchError(error instanceof Error ? error.message : "JSON state is invalid.", "invalid_input", 400);
    }
  }
  return {
    stateMode: body.stateMode,
    stateText: body.stateText,
    questions: cloneJson(questions),
    taskId: body.taskId,
    taskName: body.taskName,
    state: cloneJson(state),
  };
}

function failureDetails(error: unknown): { category: string; message: string } {
  if (error instanceof WorkbenchError) return { category: error.category, message: error.message };
  return { category: "model_error", message: "The model run did not complete." };
}

export async function runWorkbench(value: unknown): Promise<HistoryRecord> {
  const input = parseRunInput(value);
  const app = readAppFile();
  const selectedModel = app.settings.selectedModel;
  return withReadyRuntime(async (runtime) => {
    if (runtime.identity.modelId !== selectedModel) {
      throw new WorkbenchError("The selected model is not the resident model. Switch explicitly before running.", "model_mismatch", 409);
    }
    const id = createHistoryId();
    const record: HistoryRecord = {
      id,
      submittedAt: new Date().toISOString(),
      status: "running",
      stateMode: input.stateMode,
      taskId: input.taskId,
      taskName: input.taskName,
      state: input.state,
      questions: input.questions,
      modelIdentity: runtime.identity as unknown as JsonObject,
    };
    activeRunIds().add(id);
    try {
      writeHistory(record);
      let response: JsonObject;
      try {
        response = await runSystemOne(runtime, selectedModel, input.state, input.questions);
      } catch (error) {
        const failure = failureDetails(error);
        writeHistory({ ...record, status: "failed", failure });
        throw error;
      }
      if (shouldFailHistoryWrite()) {
        throw new WorkbenchError("Model response returned, but local run history could not be saved. The result is not marked successful.", "storage_error", 500);
      }
      const completed: HistoryRecord = { ...record, status: "succeeded", response };
      writeHistory(completed);
      return completed;
    } catch (error) {
      if (error instanceof WorkbenchError) throw error;
      throw new WorkbenchError("The run could not be saved to project-local history.", "storage_error", 500);
    } finally {
      activeRunIds().delete(id);
    }
  });
}

export async function deterministicTestAction(value: unknown): Promise<{ ok: true }> {
  if (!isDeterministicTestMode()) throw new WorkbenchError("Test controls are unavailable.", "not_found", 404);
  const body = requiredObject(value, "Test controls");
  if (body.action === "configure") {
    const permitted = new Set(["action", "delayMs", "failure", "loadFailure", "closeFailure", "historyWriteFailure", "settingsWriteFailure"]);
    if (Object.keys(body).some((key) => !permitted.has(key))) throw new WorkbenchError("Unsupported test control.", "invalid_input", 400);
    const current = readTestControls();
    const next: TestControls = {
      delayMs: body.delayMs === undefined ? current.delayMs : typeof body.delayMs === "number" ? body.delayMs : -1,
      failure: body.failure === undefined ? current.failure : body.failure === "none" || body.failure === "run" || body.failure === "length" || body.failure === "stale" ? body.failure : "invalid" as TestControls["failure"],
      loadFailure: body.loadFailure === undefined ? current.loadFailure : body.loadFailure === "none" || body.loadFailure === "busy" || body.loadFailure === "unavailable" || body.loadFailure === "startup" ? body.loadFailure : "invalid" as TestControls["loadFailure"],
      closeFailure: body.closeFailure === undefined ? current.closeFailure : body.closeFailure === true,
      historyWriteFailure: body.historyWriteFailure === undefined ? current.historyWriteFailure : body.historyWriteFailure === true,
      settingsWriteFailure: body.settingsWriteFailure === undefined ? current.settingsWriteFailure : body.settingsWriteFailure === true,
    };
    if (next.delayMs < 0 || next.delayMs > 5_000 || next.failure === ("invalid" as TestControls["failure"]) || next.loadFailure === ("invalid" as TestControls["loadFailure"])) {
      throw new WorkbenchError("Test control values are invalid.", "invalid_input", 400);
    }
    setTestControls(next);
    return { ok: true };
  }
  if (body.action === "interrupt-run" && Object.keys(body).length === 1) {
    const app = readAppFile();
    const template = app.templates[0];
    if (!template) throw new WorkbenchError("Save a task template before adding a test history record.", "invalid_input", 400);
    const id = createHistoryId();
    const identity = deterministicIdentity(app.settings.selectedModel);
    writeHistory({
      id,
      submittedAt: new Date().toISOString(),
      status: "running",
      stateMode: "text",
      taskId: template.taskId,
      taskName: template.name,
      state: "Synthetic interrupted test run",
      questions: template.questions,
      modelIdentity: identity as unknown as JsonObject,
    });
    return { ok: true };
  }
  throw new WorkbenchError("Unsupported test control action.", "invalid_input", 400);
}
