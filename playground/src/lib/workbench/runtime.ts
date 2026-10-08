import { execFile as execFileCallback } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WorkbenchError } from "@/lib/workbench/errors";
import { withWorkbenchLock } from "@/lib/workbench/lock";
import {
  absoluteSessionPath,
  atomicWrite,
  dataRoot,
  lifecycleConfigPath,
  parseStoredJson,
  readAppFile,
  relativeSessionPath,
  sessionCandidates,
  updateAppFile,
} from "@/lib/workbench/storage";
import {
  isModelId,
  modelChoice,
  sameModelIdentity,
  stableModelIdentity,
  type ModelId,
  type StableModelIdentity,
} from "@/lib/workbench/tasks";
import { orderedEntries, orderedObject, parseJson, stringifyJson, type JsonObject, type JsonValue } from "@/lib/workbench/json";

const execFile = promisify(execFileCallback);
const PROJECT_ROOT = path.resolve(process.cwd(), "..");
const KEV_CLI = path.join(PROJECT_ROOT, "bin", "kev");
const LOCAL_CONFIG = path.join(PROJECT_ROOT, ".local", "local-inference.json");
const TEST_SESSION_FILE = "runtime/test-session.json";
const TEST_CONTROLS_FILE = "runtime/test-controls.json";
const SYSTEM_ONE_TIMEOUT_MS = 120_000;

type ConsumerReply = {
  session?: string;
  state?: string;
  endpoint?: string | null;
  identity?: unknown;
  error?: { category?: string; message?: string; session?: string };
};

type RuntimeStatus = {
  state: "unloaded" | "loading" | "ready" | "busy" | "recovery";
  selectedModel: ModelId;
  identity: StableModelIdentity | null;
  message: string;
};

type OwnedRuntime = {
  relativePath: string;
  endpoint: string;
  identity: StableModelIdentity;
};

export type TestControls = {
  delayMs: number;
  failure: "none" | "run" | "length" | "stale";
  loadFailure: "none" | "busy" | "unavailable" | "startup";
  closeFailure: boolean;
  historyWriteFailure: boolean;
  settingsWriteFailure: boolean;
};

const defaultControls: TestControls = {
  delayMs: 0,
  failure: "none",
  loadFailure: "none",
  closeFailure: false,
  historyWriteFailure: false,
  settingsWriteFailure: false,
};

class ConsumerFailure extends Error {
  constructor(
    readonly category: string,
    readonly recoverySession: string | null = null,
  ) {
    super(safeConsumerMessage(category));
  }
}

function safeConsumerMessage(category: string): string {
  switch (category) {
    case "busy":
      return "Another Kev project currently owns the model slot. It was left untouched; close it in that project, then retry.";
    case "unavailable_environment":
      return "Kev's local Python or model prerequisites are unavailable. Check the local inference setup guide.";
    case "unknown_model":
      return "This logical model is not registered in the machine's local inference configuration.";
    case "failed_startup":
      return "Model startup failed. Check the session status before retrying; the workbench will not assume the slot is free.";
    case "failed_close":
      return "Kev could not confirm model shutdown. The slot is not reported free; retry Stop or use the recovery guidance.";
    case "stale_runtime":
      return "The saved model session is stale or its identity changed. No unrelated process was stopped.";
    case "rejected_length":
      return "The state or a question exceeds the model's admitted length. Nothing was silently shortened.";
    case "changed_config":
      return "The stable workbench lifecycle configuration changed. Stop and recover the owned session before retrying.";
    case "invalid_input":
      return "The owned model session could not be verified. No process was signaled.";
    default:
      return "The local model operation failed. Check the workbench status and try again.";
  }
}

function testMode(): "deterministic" | "native" | null {
  const mode = process.env.KEV_WORKBENCH_TEST_MODE;
  if (!mode) return null;
  if (mode === "deterministic" || mode === "native") return mode;
  throw new WorkbenchError("Workbench test mode is invalid.", "invalid_environment", 500);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function testFile(value: JsonValue, relative: string): void {
  atomicWrite(relative, `${stringifyJson(value, 2)}\n`);
}

export function readTestControls(): TestControls {
  if (testMode() !== "deterministic") return defaultControls;
  try {
    const raw = parseStoredJson(readFileSync(path.join(dataRoot(), TEST_CONTROLS_FILE), "utf8"));
    return {
      delayMs: typeof raw.delayMs === "number" ? Math.max(0, Math.min(raw.delayMs, 5_000)) : 0,
      failure: raw.failure === "run" || raw.failure === "length" || raw.failure === "stale" ? raw.failure : "none",
      loadFailure: raw.loadFailure === "busy" || raw.loadFailure === "unavailable" || raw.loadFailure === "startup" ? raw.loadFailure : "none",
      closeFailure: raw.closeFailure === true,
      historyWriteFailure: raw.historyWriteFailure === true,
      settingsWriteFailure: raw.settingsWriteFailure === true,
    };
  } catch {
    return defaultControls;
  }
}

export function setTestControls(value: TestControls): void {
  if (testMode() !== "deterministic") throw new WorkbenchError("Test controls are only available in deterministic verification.", "not_found", 404);
  testFile(value as unknown as JsonValue, TEST_CONTROLS_FILE);
}

export function isDeterministicTestMode(): boolean {
  return testMode() === "deterministic";
}

export function isNativeTestMode(): boolean {
  return testMode() === "native";
}

export function deterministicIdentity(modelId: ModelId): StableModelIdentity {
  if (!isDeterministicTestMode()) throw new WorkbenchError("Test identities are only available in deterministic verification.", "not_found", 404);
  return testIdentity(modelId);
}

export function shouldFailHistoryWrite(): boolean {
  return testMode() === "deterministic" && readTestControls().historyWriteFailure;
}

async function runConsumer(args: string[]): Promise<ConsumerReply> {
  const home = path.join(dataRoot(), "runtime", "home");
  try {
    const { stdout } = await execFile(KEV_CLI, args, {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      env: {
        PATH: `${path.join(PROJECT_ROOT, ".local", "bin")}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
        HOME: home,
        LANG: "en_US.UTF-8",
        NODE_ENV: process.env.NODE_ENV ?? "development",
        KEV_LOCAL_INFERENCE_CONFIG: LOCAL_CONFIG,
        KEV_TRUNCATE_STATES: "0",
        HF_HUB_OFFLINE: "1",
        TRANSFORMERS_OFFLINE: "1",
        UV_OFFLINE: "1",
        PYTHONNOUSERSITE: "1",
      },
    });
    const decoded: unknown = JSON.parse(stdout);
    if (!isJsonObject(decoded)) throw new Error("invalid consumer response");
    return decoded as ConsumerReply;
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    if (typeof stdout === "string") {
      try {
        const decoded: unknown = JSON.parse(stdout);
        if (isJsonObject(decoded) && isJsonObject(decoded.error)) {
          const category = typeof decoded.error.category === "string" ? decoded.error.category : "unknown";
          const session = typeof decoded.error.session === "string" ? decoded.error.session : null;
          throw new ConsumerFailure(category, session);
        }
      } catch (decodeError) {
        if (decodeError instanceof ConsumerFailure) throw decodeError;
      }
    }
    throw new ConsumerFailure("unavailable_environment");
  }
}

function endpointUrl(value: unknown): string {
  if (typeof value !== "string") throw new WorkbenchError("The owned runtime did not report a loopback endpoint.", "stale_runtime", 409);
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new WorkbenchError("The owned runtime endpoint is invalid.", "stale_runtime", 409);
  }
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port || endpoint.pathname !== "/") {
    throw new WorkbenchError("The owned runtime endpoint is not loopback HTTP.", "stale_runtime", 409);
  }
  return endpoint.origin;
}

function ensureIdentity(value: unknown): StableModelIdentity {
  const identity = stableModelIdentity(value);
  if (!identity) throw new WorkbenchError("The owned runtime did not report a complete actual model identity.", "stale_runtime", 409);
  return identity;
}

function testIdentity(modelId: ModelId): StableModelIdentity {
  const source = `jaredpalmer/${modelId}`;
  const base = modelChoice(modelId).base;
  return {
    modelId,
    checkpoint: { source, revision: "a".repeat(40) },
    base: { source: base, revision: "b".repeat(40) },
    backend: "deterministic-test-double",
    dtype: "float32",
    device: "test",
  };
}

function testIdentityDocument(modelId: ModelId): JsonObject {
  const identity = testIdentity(modelId);
  return orderedObject([
    ["model_id", identity.modelId],
    ["checkpoint", orderedObject([["source", identity.checkpoint.source], ["revision", identity.checkpoint.revision]])],
    ["base", orderedObject([["source", identity.base.source], ["revision", identity.base.revision]])],
    ["backend", identity.backend],
    ["dtype", identity.dtype],
    ["device", identity.device],
  ]);
}

function readTestSession(): { model: ModelId; state: "ready" | "closed"; identity: StableModelIdentity } | null {
  if (testMode() !== "deterministic") return null;
  try {
    const value = parseStoredJson(readFileSync(path.join(dataRoot(), TEST_SESSION_FILE), "utf8"));
    if (!isModelId(value.model) || (value.state !== "ready" && value.state !== "closed")) return null;
    const identity = ensureIdentity(value.identity);
    if (identity.modelId !== value.model) return null;
    return { model: value.model, state: value.state, identity };
  } catch {
    return null;
  }
}

function writeTestSession(model: ModelId, state: "ready" | "closed"): void {
  testFile({ model, state, identity: testIdentityDocument(model) } as unknown as JsonValue, TEST_SESSION_FILE);
}

async function sessionStatus(relativePath: string): Promise<ConsumerReply> {
  return runConsumer(["status", "--session", absoluteSessionPath(relativePath)]);
}

function updateSessionReference(
  update: (settings: ReturnType<typeof readAppFile>["settings"]) => ReturnType<typeof readAppFile>["settings"],
): void {
  updateAppFile((app) => ({ ...app, settings: update(app.settings) }));
}

async function inspectSavedSession(): Promise<{ runtime: RuntimeStatus; owned: OwnedRuntime | null }> {
  const app = readAppFile();
  const settings = app.settings;
  if (testMode() === "deterministic") {
    const session = readTestSession();
    if (session?.state === "ready") {
      return {
        runtime: { state: "ready", selectedModel: settings.selectedModel, identity: session.identity, message: "Model ready" },
        owned: { relativePath: TEST_SESSION_FILE, endpoint: "test://systemone", identity: session.identity },
      };
    }
    return { runtime: { state: "unloaded", selectedModel: settings.selectedModel, identity: null, message: "No model is loaded" }, owned: null };
  }

  const savedPath = settings.sessionPath ?? settings.recoverySessionPath;
  if (savedPath) {
    try {
      const status = await sessionStatus(savedPath);
      const identity = status.state === "ready" ? ensureIdentity(status.identity) : null;
      if (status.state === "ready" && identity) {
        const actualModelId = identity.modelId;
        if (!isModelId(actualModelId)) throw new WorkbenchError("The saved runtime has an unknown logical model identity.", "stale_runtime", 409);
        const safePath = relativeSessionPath(status.session ?? absoluteSessionPath(savedPath));
        updateSessionReference((current) => ({
          ...current,
          sessionPath: safePath,
          recoverySessionPath: null,
          pendingModel: null,
        }));
        return {
          runtime: { state: "ready", selectedModel: settings.selectedModel, identity, message: "Model ready" },
          owned: { relativePath: safePath, endpoint: endpointUrl(status.endpoint), identity },
        };
      }
      if (status.state === "closed" || status.state === "failed") {
        updateSessionReference((current) => ({
          ...current,
          sessionPath: null,
          recoverySessionPath: null,
          pendingModel: null,
        }));
        return { runtime: { state: "unloaded", selectedModel: settings.selectedModel, identity: null, message: "No model is loaded" }, owned: null };
      }
      updateSessionReference((current) => ({
        ...current,
        sessionPath: null,
        recoverySessionPath: savedPath,
      }));
      return {
        runtime: { state: "recovery", selectedModel: settings.selectedModel, identity, message: safeConsumerMessage("stale_runtime") },
        owned: null,
      };
    } catch (error) {
      const recovery = error instanceof ConsumerFailure ? error.recoverySession : null;
      if (recovery) {
        try {
          const relative = relativeSessionPath(recovery);
          updateSessionReference((current) => ({ ...current, sessionPath: null, recoverySessionPath: relative }));
        } catch {
          // The public consumer interface remains the only authority for recovering a session.
        }
      }
      return {
        runtime: { state: "recovery", selectedModel: settings.selectedModel, identity: null, message: safeConsumerMessage(error instanceof ConsumerFailure ? error.category : "unknown") },
        owned: null,
      };
    }
  }

  if (settings.pendingModel) {
    const candidates = sessionCandidates();
    const attempts = await Promise.all(candidates.map(async (candidate) => {
      try {
        const status = await sessionStatus(candidate.relativePath);
        const identity = status.state === "ready" ? stableModelIdentity(status.identity) : null;
        return { candidate, status, identity };
      } catch {
        return { candidate, status: null, identity: null };
      }
    }));
    const recovered = attempts.filter(({ status, identity }) => status?.state === "ready" && identity?.modelId === settings.pendingModel);
    if (recovered.length === 1) {
      const candidate = recovered[0].candidate;
      updateSessionReference((current) => ({
        ...current,
        selectedModel: settings.pendingModel!,
        sessionPath: candidate.relativePath,
        recoverySessionPath: null,
        pendingModel: null,
      }));
      return inspectSavedSession();
    }
    if (attempts.length > 0) {
      updateSessionReference((current) => ({
        ...current,
        sessionPath: null,
        recoverySessionPath: attempts.length === 1 ? attempts[0].candidate.relativePath : current.recoverySessionPath,
      }));
      return {
        runtime: { state: "recovery", selectedModel: settings.selectedModel, identity: null, message: "An interrupted model startup needs status/close confirmation before another load." },
        owned: null,
      };
    }
    updateSessionReference((current) => ({ ...current, pendingModel: null }));
  }
  return { runtime: { state: "unloaded", selectedModel: settings.selectedModel, identity: null, message: "No model is loaded" }, owned: null };
}

export async function runtimeStatus(): Promise<RuntimeStatus> {
  return (await inspectSavedSession()).runtime;
}

async function closeOwnedSession(): Promise<void> {
  const app = readAppFile();
  if (testMode() === "deterministic") {
    if (readTestControls().closeFailure) throw new WorkbenchError(safeConsumerMessage("failed_close"), "failed_close", 409);
    const session = readTestSession();
    if (session?.state === "ready") writeTestSession(session.model, "closed");
    updateSessionReference((settings) => ({ ...settings, sessionPath: null, recoverySessionPath: null, pendingModel: null }));
    return;
  }
  const relativePath = app.settings.sessionPath ?? app.settings.recoverySessionPath;
  if (!relativePath) return;
  try {
    const reply = await runConsumer(["close", "--session", absoluteSessionPath(relativePath)]);
    if (reply.state !== "closed") throw new ConsumerFailure("failed_close");
    updateSessionReference((settings) => ({ ...settings, sessionPath: null, recoverySessionPath: null, pendingModel: null }));
  } catch (error) {
    const recovery = error instanceof ConsumerFailure ? error.recoverySession : null;
    if (recovery) {
      try {
        const safePath = relativeSessionPath(recovery);
        updateSessionReference((settings) => ({ ...settings, sessionPath: null, recoverySessionPath: safePath }));
      } catch {
        // Keep the existing recovery reference.
      }
    }
    throw new WorkbenchError(safeConsumerMessage(error instanceof ConsumerFailure ? error.category : "failed_close"), "failed_close", 409);
  }
}

async function openOwnedSession(modelId: ModelId): Promise<void> {
  if (testMode() === "deterministic") {
    const controls = readTestControls();
    if (controls.loadFailure === "busy") throw new WorkbenchError(safeConsumerMessage("busy"), "busy", 409);
    if (controls.loadFailure === "unavailable") throw new WorkbenchError(safeConsumerMessage("unavailable_environment"), "unavailable_environment", 503);
    if (controls.loadFailure === "startup") throw new WorkbenchError(safeConsumerMessage("failed_startup"), "failed_startup", 503);
    writeTestSession(modelId, "ready");
    updateSessionReference((settings) => ({ ...settings, selectedModel: modelId, sessionPath: null, recoverySessionPath: null, pendingModel: null }));
    return;
  }

  updateSessionReference((settings) => ({ ...settings, selectedModel: modelId, pendingModel: modelId, sessionPath: null }));
  const config = lifecycleConfigPath(modelId);
  try {
    const reply = await runConsumer(["open", "--config", config]);
    if (!reply.session || reply.state !== "ready") throw new ConsumerFailure("failed_startup");
    const safePath = relativeSessionPath(reply.session);
    const identity = ensureIdentity(reply.identity);
    if (identity.modelId !== modelId) throw new ConsumerFailure("failed_startup", reply.session);
    const verified = await sessionStatus(safePath);
    const verifiedIdentity = ensureIdentity(verified.identity);
    if (verified.state !== "ready" || !sameModelIdentity(identity, verifiedIdentity)) {
      throw new ConsumerFailure("stale_runtime", reply.session);
    }
    updateSessionReference((settings) => ({
      ...settings,
      selectedModel: modelId,
      sessionPath: safePath,
      recoverySessionPath: null,
      pendingModel: null,
    }));
  } catch (error) {
    const recovery = error instanceof ConsumerFailure ? error.recoverySession : null;
    if (recovery) {
      try {
        const safePath = relativeSessionPath(recovery);
        updateSessionReference((settings) => ({ ...settings, sessionPath: null, recoverySessionPath: safePath }));
      } catch {
        // Do not replace a valid saved recovery reference with an untrusted path.
      }
    }
    const category = error instanceof ConsumerFailure ? error.category : "failed_startup";
    throw new WorkbenchError(safeConsumerMessage(category), category, category === "busy" ? 409 : 503);
  }
}

export async function loadModel(modelId: ModelId): Promise<RuntimeStatus> {
  if (!isModelId(modelId)) throw new WorkbenchError("Select one of the registered logical models.", "invalid_input", 400);
  return withWorkbenchLock(async () => {
    const current = await inspectSavedSession();
    if (current.runtime.state === "ready" && current.runtime.identity?.modelId === modelId) return current.runtime;
    if (current.runtime.state === "ready") {
      throw new WorkbenchError("A different model is resident. Confirm a switch before releasing it.", "conflict", 409);
    }
    if (current.runtime.state !== "unloaded") {
      throw new WorkbenchError("Resolve the saved model session before loading another model.", "recovery_required", 409);
    }
    updateSessionReference((settings) => ({ ...settings, selectedModel: modelId }));
    await openOwnedSession(modelId);
    return runtimeStatus();
  });
}

export async function switchModel(modelId: ModelId, confirmRelease: boolean): Promise<RuntimeStatus> {
  if (!isModelId(modelId)) throw new WorkbenchError("Select one of the registered logical models.", "invalid_input", 400);
  if (!confirmRelease) throw new WorkbenchError("Switching releases the resident model and requires confirmation.", "confirmation_required", 409);
  return withWorkbenchLock(async () => {
    const current = await inspectSavedSession();
    if (current.runtime.state === "ready" && current.runtime.identity?.modelId === modelId) return current.runtime;
    if (current.runtime.state === "ready") await closeOwnedSession();
    else if (current.runtime.state !== "unloaded") {
      throw new WorkbenchError("Resolve the saved model session before switching.", "recovery_required", 409);
    }
    updateSessionReference((settings) => ({ ...settings, selectedModel: modelId }));
    const afterClose = await inspectSavedSession();
    if (afterClose.runtime.state !== "unloaded") {
      throw new WorkbenchError("The previous model is not confirmed closed; the new model was not started.", "failed_close", 409);
    }
    await openOwnedSession(modelId);
    return runtimeStatus();
  });
}

export async function stopModel(confirmRelease: boolean): Promise<RuntimeStatus> {
  if (!confirmRelease) throw new WorkbenchError("Stopping releases the resident model and requires confirmation.", "confirmation_required", 409);
  return withWorkbenchLock(async () => {
    const current = await inspectSavedSession();
    if (current.runtime.state === "recovery") {
      await closeOwnedSession();
    } else if (current.runtime.state === "ready") {
      await closeOwnedSession();
    }
    const result = await runtimeStatus();
    if (result.state !== "unloaded") throw new WorkbenchError("Model shutdown is not confirmed; keep the recovery controls available.", "failed_close", 409);
    return result;
  });
}

export async function withReadyRuntime<T>(operation: (runtime: OwnedRuntime) => Promise<T>): Promise<T> {
  return withWorkbenchLock(async () => {
    const inspected = await inspectSavedSession();
    if (inspected.runtime.state !== "ready" || !inspected.owned) {
      throw new WorkbenchError(inspected.runtime.message, inspected.runtime.state === "busy" ? "busy" : "model_not_ready", 409);
    }
    return operation(inspected.owned);
  });
}

function testResponse(questions: JsonObject, modelId: string): JsonObject {
  const answers: (readonly [string, JsonValue])[] = orderedEntries(questions).map(([questionId, raw]): readonly [string, JsonValue] => {
    const question = raw as JsonObject;
    if (question.type === "choice") {
      const criteria = question.criteria as JsonObject;
      const entries = orderedEntries(criteria).map(([key]) => key);
      const probabilities = orderedObject(entries.map((key, index) => [key, entries.length === 1 ? 1 : index === 0 ? 0.62 : 0.38 / (entries.length - 1)]));
      const confidence = entries.length === 1 ? 1 : (0.62 - 1 / entries.length) / (1 - 1 / entries.length);
      return [questionId, orderedObject([["type", "choice"], ["choice", entries[0]], ["confidence", confidence], ["probabilities", probabilities]])];
    }
    if (question.type === "noul") return [questionId, orderedObject([["type", "noul"], ["noul", 0.73]])];
    const criteria = question.criteria as JsonValue[];
    const weights = criteria.map((_, index) => criteria.length - index);
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    const distribution = weights.map((weight) => weight / totalWeight);
    const probabilities = orderedObject(distribution.map((probability, index) => [String(index), probability]));
    const legend = orderedObject(criteria.map((level, index) => [String(index), typeof level === "string" ? level : stringifyJson(level)]));
    const score = distribution.reduce((sum, probability, index) => sum + index * probability, 0);
    const mode = distribution.indexOf(Math.max(...distribution));
    const deviation = distribution.reduce((sum, probability, index) => sum + probability * Math.abs(index - mode), 0);
    const uniformDeviation = distribution.length === 1 ? 0 : distribution.reduce((sum, _, index) => sum + Math.abs(index - (distribution.length - 1) / 2), 0) / distribution.length;
    const confidence = distribution.length === 1 ? 1 : Math.max(0, 1 - deviation / uniformDeviation);
    return [questionId, orderedObject([["type", "score"], ["score", score], ["confidence", confidence], ["legend", legend], ["probabilities", probabilities]])];
  });
  return orderedObject([
    ["model", modelId],
    ["answers", orderedObject(answers)],
    ["usage", orderedObject([["input_tokens", 120], ["output_tokens", 12]])],
    ["latency_ms", 42],
  ]);
}

export async function runSystemOne(
  runtime: OwnedRuntime,
  modelId: ModelId,
  state: JsonValue,
  questions: JsonObject,
): Promise<JsonObject> {
  if (testMode() === "deterministic") {
    const controls = readTestControls();
    if (controls.delayMs) await new Promise((resolve) => setTimeout(resolve, controls.delayMs));
    if (controls.failure === "length") throw new WorkbenchError(safeConsumerMessage("rejected_length"), "rejected_length", 422);
    if (controls.failure === "stale") throw new WorkbenchError(safeConsumerMessage("stale_runtime"), "stale_runtime", 409);
    if (controls.failure === "run") throw new WorkbenchError("The deterministic model returned a controlled failure.", "model_error", 503);
    return testResponse(questions, modelId);
  }

  const before = await sessionStatus(runtime.relativePath);
  const beforeIdentity = ensureIdentity(before.identity);
  if (before.state !== "ready" || !sameModelIdentity(runtime.identity, beforeIdentity)) {
    throw new WorkbenchError(safeConsumerMessage("stale_runtime"), "stale_runtime", 409);
  }

  let response: Response;
  try {
    response = await fetch(`${runtime.endpoint}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(SYSTEM_ONE_TIMEOUT_MS),
      body: stringifyJson({ state, model: modelId, questions } as unknown as JsonValue),
    });
  } catch {
    throw new WorkbenchError("The owned System One runtime did not return a response. Check its status before retrying.", "stale_runtime", 503);
  }
  if (!response.ok) {
    if (response.status === 422) throw new WorkbenchError(safeConsumerMessage("rejected_length"), "rejected_length", 422);
    throw new WorkbenchError("The owned System One runtime rejected this request.", "model_error", 502);
  }
  let value: unknown;
  try {
    value = parseJson(await response.text());
  } catch {
    throw new WorkbenchError("The owned System One runtime returned invalid JSON.", "model_error", 502);
  }
  const after = await sessionStatus(runtime.relativePath);
  const afterIdentity = ensureIdentity(after.identity);
  if (after.state !== "ready" || !sameModelIdentity(beforeIdentity, afterIdentity)) {
    throw new WorkbenchError(safeConsumerMessage("stale_runtime"), "stale_runtime", 409);
  }
  return validateSystemOneResponse(value, modelId, questions);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validateSystemOneResponse(value: unknown, modelId: string, questions: JsonObject): JsonObject {
  if (!isJsonObject(value) || value.model !== modelId || !isJsonObject(value.answers) || !isJsonObject(value.usage)) {
    throw new WorkbenchError("The model returned a response that does not match the submitted run.", "model_error", 502);
  }
  if (!finiteNumber(value.latency_ms) || !finiteNumber(value.usage.input_tokens) || !finiteNumber(value.usage.output_tokens)) {
    throw new WorkbenchError("The model returned invalid latency or usage metrics.", "model_error", 502);
  }
  if (value.latency_ms < 0 || value.usage.input_tokens < 0 || value.usage.output_tokens < 0 || value.truncated === true) {
    throw new WorkbenchError("The model reported invalid metrics or truncated input; the run was not accepted.", "model_error", 502);
  }
  const answers = value.answers;
  if (!isJsonObject(answers)) throw new WorkbenchError("The model returned answers in an invalid shape.", "model_error", 502);
  const expectedIds = orderedEntries(questions).map(([id]) => id);
  const answerIds = orderedEntries(answers).map(([id]) => id);
  if (expectedIds.length !== answerIds.length || expectedIds.some((id, index) => answerIds[index] !== id)) {
    throw new WorkbenchError("The model returned answers for a different set of questions.", "model_error", 502);
  }
  for (const [id, rawQuestion] of orderedEntries(questions)) {
    const question = rawQuestion as JsonObject;
    const answer = answers[id];
    if (!isJsonObject(answer) || answer.type !== question.type) {
      throw new WorkbenchError(`The model returned an invalid typed answer for ${id}.`, "model_error", 502);
    }
    if (answer.type === "choice") {
      const criteria = isJsonObject(question.criteria) ? question.criteria : null;
      if (typeof answer.choice !== "string" || !finiteNumber(answer.confidence) || answer.confidence < 0 || answer.confidence > 1 || !criteria || !isJsonObject(answer.probabilities)) {
        throw new WorkbenchError(`The model returned an invalid Choice answer for ${id}.`, "model_error", 502);
      }
      validateProbabilityMap(answer.probabilities, orderedEntries(criteria).map(([key]) => key), id);
      if (!(answer.choice in answer.probabilities)) throw new WorkbenchError(`The model selected an unknown Choice option for ${id}.`, "model_error", 502);
    } else if (answer.type === "noul") {
      if (!finiteNumber(answer.noul) || answer.noul < 0 || answer.noul > 1) {
        throw new WorkbenchError(`The model returned an invalid Noul answer for ${id}.`, "model_error", 502);
      }
    } else {
      const criteria = Array.isArray(question.criteria) ? question.criteria : null;
      const legend = answer.legend;
      const probabilities = answer.probabilities;
      if (!finiteNumber(answer.score) || !finiteNumber(answer.confidence) || answer.confidence < 0 || answer.confidence > 1 || !criteria || !isJsonObject(legend) || !isJsonObject(probabilities)) {
        throw new WorkbenchError(`The model returned an invalid Score answer for ${id}.`, "model_error", 502);
      }
      const keys = criteria.map((_, index) => String(index));
      validateProbabilityMap(probabilities, keys, id);
      const legendKeys = orderedEntries(legend).map(([key]) => key);
      if (legendKeys.length !== keys.length || keys.some((key, index) => legendKeys[index] !== key || typeof legend[key] !== "string")) {
        throw new WorkbenchError(`The model returned an invalid Score legend for ${id}.`, "model_error", 502);
      }
      const expectedScore = keys.reduce((sum, key) => sum + Number(key) * Number(probabilities[key]), 0);
      if (Math.abs(expectedScore - answer.score) > 0.002) throw new WorkbenchError(`The model returned a Score that does not match its distribution for ${id}.`, "model_error", 502);
    }
  }
  return value as JsonObject;
}

function validateProbabilityMap(value: JsonObject, keys: string[], questionId: string): void {
  const actualKeys = orderedEntries(value).map(([key]) => key);
  if (actualKeys.length !== keys.length || keys.some((key) => !finiteNumber(value[key]) || (value[key] as number) < 0 || (value[key] as number) > 1)) {
    throw new WorkbenchError(`The model returned an invalid probability distribution for ${questionId}.`, "model_error", 502);
  }
  if (keys.some((key, index) => actualKeys[index] !== key)) {
    throw new WorkbenchError(`The model changed the submitted probability order for ${questionId}.`, "model_error", 502);
  }
  const total = keys.reduce((sum, key) => sum + (value[key] as number), 0);
  if (Math.abs(total - 1) >= 0.02) throw new WorkbenchError(`The model returned a probability distribution that does not sum to one for ${questionId}.`, "model_error", 502);
}

export async function testRuntimeEndpoint(): Promise<string | null> {
  if (testMode() !== "native") return null;
  const inspected = await inspectSavedSession();
  return inspected.owned?.endpoint ?? null;
}

export function newTestRunId(): string {
  return randomUUID();
}
