import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WorkbenchError } from "@/lib/workbench/errors";
import { storedLocale, type Locale } from "@/lib/workbench/locale";
import { isJsonObject, orderedObject, parseJson, parseJsonObject, setOrdered, stringifyJson, type JsonObject, type JsonValue } from "@/lib/workbench/json";
import {
  defaultTemplates,
  isModelId,
  parseProjectTasks,
  projectTasksConfig,
  stableModelIdentity,
  validateTemplateList,
  validateQuestions,
  type ModelId,
  type WorkbenchTemplate,
} from "@/lib/workbench/tasks";

const PROJECT_ROOT = path.resolve(process.cwd(), "..");
const PLAYGROUND_ROOT = path.join(PROJECT_ROOT, ".local", "playground");
const APP_SCHEMA = "kev-workbench/1";
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_RELATIVE = /^(?:runtime\/)?\.local\/kev\/sessions\/[0-9a-f]{32}\/session\.json$/;

export type WorkbenchSettings = {
  selectedModel: ModelId;
  exportModel: ModelId;
  theme: "light" | "dark";
  locale: Locale;
  projectDescription?: string;
  sessionPath: string | null;
  pendingModel: ModelId | null;
  recoverySessionPath: string | null;
};

export type WorkbenchAppFile = {
  schema: typeof APP_SCHEMA;
  settings: WorkbenchSettings;
  templates: WorkbenchTemplate[];
};

export type HistoryRecord = {
  id: string;
  submittedAt: string;
  status: "running" | "succeeded" | "failed" | "interrupted";
  stateMode: "text" | "json";
  taskId: string;
  taskName: string;
  state: JsonValue;
  questions: JsonObject;
  modelIdentity: JsonObject;
  response?: JsonObject;
  failure?: { category: string; message: string };
};

function storageError(message: string): WorkbenchError {
  return new WorkbenchError(message, "storage_error", 500);
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function ensureDirectoryTree(target: string, trustedBase = PROJECT_ROOT): void {
  const absolute = path.resolve(target);
  if (!within(trustedBase, absolute)) throw storageError("Workbench files must stay inside the Kev project's local data root.");
  const relative = path.relative(trustedBase, absolute);
  let current = trustedBase;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw storageError(`Workbench directory ${path.relative(trustedBase, current)} is not a real directory.`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(current, { mode: 0o700 });
    }
  }
}

export function dataRoot(): string {
  ensureDirectoryTree(PLAYGROUND_ROOT);
  const requested = process.env.KEV_WORKBENCH_DATA_ROOT;
  const root = path.resolve(requested || path.join(PLAYGROUND_ROOT, "workbench"));
  if (!within(PLAYGROUND_ROOT, root)) throw storageError("Configured workbench storage must stay under .local/playground/.");
  ensureDirectoryTree(root, PLAYGROUND_ROOT);
  for (const child of ["history", "exports", "runtime", "logs"]) {
    ensureDirectoryTree(path.join(root, child), root);
  }
  return root;
}

function checkedPath(relativePath: string): string {
  const root = dataRoot();
  const absolute = path.resolve(root, relativePath);
  if (!within(root, absolute)) throw storageError("Workbench path escaped its project data directory.");
  const parent = path.dirname(absolute);
  ensureDirectoryTree(parent, root);
  return absolute;
}

function assertRegularFile(file: string): void {
  let info;
  try {
    info = lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw storageError("Workbench data could not be inspected safely.");
  }
  if (info.isSymbolicLink() || !info.isFile()) throw storageError("Workbench data files must be regular project-local files.");
  const real = realpathSync(file);
  if (!within(dataRoot(), real)) throw storageError("Workbench data resolved outside its project directory.");
}

function readJsonFile(relativePath: string): JsonValue | null {
  const file = checkedPath(relativePath);
  if (!existsSync(file)) return null;
  assertRegularFile(file);
  try {
    return parseJson(readFileSync(file, "utf8"));
  } catch (error) {
    if (error instanceof WorkbenchError) throw error;
    throw storageError(`Workbench file ${relativePath} is not valid JSON.`);
  }
}

export function atomicWrite(relativePath: string, contents: string): void {
  const target = checkedPath(relativePath);
  if (existsSync(target)) assertRegularFile(target);
  const temp = `${target}.${randomUUID()}.partial`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temp, "wx", 0o600);
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temp, target);
    try {
      const directory = openSync(path.dirname(target), "r");
      fsyncSync(directory);
      closeSync(directory);
    } catch {
      // Some filesystems do not support fsync on a directory.
    }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temp);
    } catch {
      // Preserve the original write error.
    }
    if (error instanceof WorkbenchError) throw error;
    throw storageError(`Could not save ${relativePath} inside .local/playground/.`);
  }
}

function defaultAppFile(): WorkbenchAppFile {
  return {
    schema: APP_SCHEMA,
    settings: {
      selectedModel: "kev-4b",
      exportModel: "kev-4b",
      theme: "light",
      locale: "zh-CN",
      sessionPath: null,
      pendingModel: null,
      recoverySessionPath: null,
    },
    templates: defaultTemplates(),
  };
}

function validateAppFile(value: JsonValue): WorkbenchAppFile {
  if (!value || Array.isArray(value) || typeof value !== "object") throw storageError("Workbench settings have an invalid shape.");
  const app = value as JsonObject;
  if (app.schema !== APP_SCHEMA || !app.settings || Array.isArray(app.settings) || typeof app.settings !== "object") {
    throw storageError("Workbench settings use an unsupported schema.");
  }
  const settings = app.settings as JsonObject;
  if (
    !isModelId(settings.selectedModel) ||
    !isModelId(settings.exportModel) ||
    (settings.theme !== "light" && settings.theme !== "dark") ||
    (settings.sessionPath !== null && typeof settings.sessionPath !== "string") ||
    (settings.pendingModel !== null && !isModelId(settings.pendingModel)) ||
    (settings.recoverySessionPath !== null && typeof settings.recoverySessionPath !== "string") ||
    (settings.projectDescription !== undefined && typeof settings.projectDescription !== "string")
  ) {
    throw storageError("Workbench settings contain an invalid model, theme, or session reference.");
  }
  for (const sessionPath of [settings.sessionPath, settings.recoverySessionPath]) {
    if (typeof sessionPath === "string" && !SESSION_RELATIVE.test(sessionPath)) {
      throw storageError("Workbench session reference is outside its private session directory.");
    }
  }
  validateTemplateList(app.templates);
  settings.locale = storedLocale(settings.locale);
  return value as unknown as WorkbenchAppFile;
}

export function readAppFile(): WorkbenchAppFile {
  const saved = readJsonFile("workbench.json");
  if (saved === null) {
    const defaults = defaultAppFile();
    writeAppFile(defaults);
    return defaults;
  }
  return validateAppFile(saved);
}

export function writeAppFile(app: WorkbenchAppFile): void {
  validateAppFile(app as unknown as JsonValue);
  atomicWrite("workbench.json", `${stringifyJson(app as unknown as JsonValue, 2)}\n`);
}

export function updateAppFile(update: (app: WorkbenchAppFile) => WorkbenchAppFile): WorkbenchAppFile {
  const next = update(readAppFile());
  writeAppFile(next);
  return next;
}

export function lifecycleConfigPath(modelId: ModelId): string {
  const questions = orderedObject([
    ["ready", orderedObject([["type", "noul"], ["instructions", "Workbench runtime readiness check."]])],
  ]);
  const config = orderedObject([
    ["schema", "kev-project-tasks/1"],
    ["model", modelId],
    [
      "tasks",
      orderedObject([
        ["workbench-lifecycle", orderedObject([["questions", questions]])],
      ]),
    ],
  ]);
  const relative = `runtime/lifecycle-${modelId}.json`;
  const file = checkedPath(relative);
  const contents = `${stringifyJson(config, 2)}\n`;
  if (existsSync(file)) {
    assertRegularFile(file);
    if (readFileSync(file, "utf8") !== contents) {
      throw storageError("The stable lifecycle configuration changed. Close the workbench model before repairing it.");
    }
  } else {
    atomicWrite(relative, contents);
  }
  return file;
}

export function relativeSessionPath(absolutePath: string): string {
  let resolved: string;
  try {
    resolved = realpathSync(absolutePath);
  } catch {
    throw storageError("The consumer session record is unavailable inside the workbench data directory.");
  }
  const root = dataRoot();
  if (!within(root, resolved)) throw storageError("The consumer session record resolved outside the workbench data directory.");
  const relative = path.relative(root, resolved).split(path.sep).join("/");
  if (!SESSION_RELATIVE.test(relative)) throw storageError("The consumer session record is not in the workbench-owned session directory.");
  assertRegularFile(resolved);
  return relative;
}

export function absoluteSessionPath(relativePath: string): string {
  if (!SESSION_RELATIVE.test(relativePath)) throw storageError("The saved consumer session reference is invalid.");
  const file = checkedPath(relativePath);
  assertRegularFile(file);
  return file;
}

export function sessionCandidates(): { relativePath: string; modifiedAt: number }[] {
  const root = dataRoot();
  const candidates: { relativePath: string; modifiedAt: number }[] = [];
  for (const relativeRoot of [".local/kev/sessions", "runtime/.local/kev/sessions"]) {
    const sessions = path.join(root, ...relativeRoot.split("/"));
    ensureDirectoryTree(path.dirname(path.dirname(sessions)), root);
    if (!existsSync(sessions)) continue;
    const info = lstatSync(sessions);
    if (info.isSymbolicLink() || !info.isDirectory()) throw storageError("The workbench consumer-session directory is not a real directory.");
    for (const entry of readdirSync(sessions, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9a-f]{32}$/.test(entry.name)) continue;
      const file = path.join(sessions, entry.name, "session.json");
      try {
        assertRegularFile(file);
        candidates.push({
          relativePath: path.relative(root, file).split(path.sep).join("/"),
          modifiedAt: lstatSync(file).mtimeMs,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
  }
  return candidates.sort((left, right) => right.modifiedAt - left.modifiedAt);
}

function historyPath(id: string): string {
  if (!RUN_ID.test(id)) throw new WorkbenchError("Run id is invalid.", "invalid_input", 400);
  return `history/${id}.json`;
}

export function createHistoryId(): string {
  return randomUUID();
}

export function writeHistory(record: HistoryRecord): void {
  validateHistoryRecord(record as unknown as JsonValue);
  atomicWrite(historyPath(record.id), `${stringifyJson(record as unknown as JsonValue, 2)}\n`);
}

function validateHistoryRecord(value: JsonValue): HistoryRecord {
  if (!value || Array.isArray(value) || typeof value !== "object") throw storageError("A run history record has an invalid shape.");
  const record = value as JsonObject;
  if (
    typeof record.id !== "string" ||
    !RUN_ID.test(record.id) ||
    typeof record.submittedAt !== "string" ||
    !Number.isFinite(Date.parse(record.submittedAt)) ||
    (record.status !== "running" && record.status !== "succeeded" && record.status !== "failed" && record.status !== "interrupted") ||
    (record.stateMode !== "text" && record.stateMode !== "json") ||
    typeof record.taskId !== "string" ||
    !record.taskId.trim() ||
    typeof record.taskName !== "string" ||
    !record.taskName.trim() ||
    !isJsonObject(record.questions) ||
    !isJsonObject(record.modelIdentity) ||
    !stableModelIdentity(record.modelIdentity)
  ) {
    throw storageError("A run history record is invalid or incomplete.");
  }
  validateQuestions(record.questions, "saved questions");
  if (record.status === "succeeded" && !isJsonObject(record.response)) throw storageError("A successful run is missing its canonical response.");
  if (record.response !== undefined && !isJsonObject(record.response)) throw storageError("A run response has an invalid shape.");
  if (record.status === "failed" || record.status === "interrupted") {
    if (!isJsonObject(record.failure) || typeof record.failure.category !== "string" || typeof record.failure.message !== "string") {
      throw storageError("A failed run is missing its failure record.");
    }
  }
  return value as unknown as HistoryRecord;
}

export function readHistory(activeRunIds: ReadonlySet<string>): HistoryRecord[] {
  const root = dataRoot();
  const directory = path.join(root, "history");
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && RUN_ID.test(entry.name.replace(/\.json$/, "")) && entry.name.endsWith(".json"))
    .map((entry) => {
      const id = entry.name.slice(0, -5);
      const record = readJsonFile(`history/${entry.name}`);
      if (!record) return null;
      const value = validateHistoryRecord(record);
      if (value.id !== id) throw storageError(`Run history ${id} is invalid.`);
      if (value.status === "running" && !activeRunIds.has(id)) {
        const interrupted = setOrdered(
          setOrdered(value as unknown as JsonObject, "status", "interrupted"),
          "failure",
          orderedObject([
            ["category", "interrupted"],
            ["message", "The workbench stopped before saving a response."],
          ]),
        ) as unknown as HistoryRecord;
        writeHistory(interrupted);
        return interrupted;
      }
      return value;
    })
    .filter((record): record is HistoryRecord => record !== null)
    .sort((left, right) => right.submittedAt.localeCompare(left.submittedAt));
}

export function readHistoryRecord(id: string): HistoryRecord | null {
  const record = readJsonFile(historyPath(id));
  return record === null ? null : validateHistoryRecord(record);
}

export function deleteHistory(id: string): void {
  const relative = historyPath(id);
  const file = checkedPath(relative);
  if (!existsSync(file)) return;
  assertRegularFile(file);
  unlinkSync(file);
}

export function exportTasksFile(model: ModelId, description: string | undefined, templates: WorkbenchTemplate[]): string {
  const config = projectTasksConfig(model, description, templates);
  const fileName = `kev-project-tasks-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.json`;
  const relative = `exports/${fileName}`;
  atomicWrite(relative, `${stringifyJson(config, 2)}\n`);
  return relative;
}

export function importedAppFile(raw: string): WorkbenchAppFile {
  if (Buffer.byteLength(raw, "utf8") > 1_000_000) throw new WorkbenchError("Import is larger than 1 MB.", "invalid_input", 413);
  let value: JsonValue;
  try {
    value = parseJson(raw);
  } catch (error) {
    throw new WorkbenchError(error instanceof Error ? error.message : "Import is not valid JSON.", "invalid_input", 400);
  }
  const imported = parseProjectTasks(value);
  const app = readAppFile();
  const templates = imported.templates.map((template) => ({ ...template, id: randomUUID() }));
  const next: WorkbenchAppFile = {
    ...app,
    settings: {
      ...app.settings,
      selectedModel: imported.model,
      exportModel: imported.model,
      ...(imported.description === undefined ? {} : { projectDescription: imported.description }),
    },
    templates,
  };
  if (imported.description === undefined) delete next.settings.projectDescription;
  // Validate the whole candidate before the atomic replacement. A bad import leaves saved work untouched.
  validateAppFile(next as unknown as JsonValue);
  return next;
}

export function parseStoredJson(text: string): JsonObject {
  return parseJsonObject(text);
}
