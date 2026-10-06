import { WorkbenchError } from "@/lib/workbench/errors";
import { isJsonObject, parseJson, stringifyJson, type JsonObject, type JsonValue } from "@/lib/workbench/json";
import { exportTasks, getWorkbenchSnapshot, importTasks, removeHistory, removeTemplate, runWorkbench, saveTemplate, updateSettings } from "@/lib/workbench/service";
import { loadModel, stopModel, switchModel } from "@/lib/workbench/runtime";
import { localOriginFailure } from "@/lib/workbench/local-origin";
import { isModelId } from "@/lib/workbench/tasks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
};

function jsonResponse(value: JsonValue, status = 200): Response {
  return new Response(stringifyJson(value), {
    status,
    headers: { ...NO_STORE, "Content-Type": "application/json; charset=utf-8" },
  });
}

function failureResponse(error: unknown): Response {
  if (error instanceof WorkbenchError) {
    return jsonResponse({ error: { category: error.category, message: error.message } }, error.status);
  }
  return jsonResponse({ error: { category: "workbench_error", message: "The workbench could not complete this operation." } }, 500);
}

async function readBody(request: Request): Promise<JsonObject> {
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > 10_000_000) throw new WorkbenchError("Request is larger than the 10 MB workbench limit.", "invalid_input", 413);
  let value;
  try {
    value = parseJson(text);
  } catch (error) {
    throw new WorkbenchError(error instanceof Error ? error.message : "Request must contain valid JSON.", "invalid_input", 400);
  }
  if (!isJsonObject(value)) throw new WorkbenchError("Request must be a JSON object.", "invalid_input", 400);
  return value;
}

function requireAction(body: JsonObject, action: string, expectedKeys: string[]): void {
  if (body.action !== action || Object.keys(body).some((key) => !expectedKeys.includes(key))) {
    throw new WorkbenchError("The workbench action has an invalid shape.", "invalid_input", 400);
  }
}

export async function GET(request: Request): Promise<Response> {
  const failure = localOriginFailure(request, false);
  if (failure) return jsonResponse({ error: failure }, 403);
  try {
    return jsonResponse(await getWorkbenchSnapshot() as unknown as JsonValue);
  } catch (error) {
    return failureResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  const failure = localOriginFailure(request, true);
  if (failure) return jsonResponse({ error: failure }, 403);
  try {
    const body = await readBody(request);
    switch (body.action) {
      case "settings": {
        requireAction(body, "settings", ["action", "settings"]);
        updateSettings(body.settings);
        return jsonResponse(await getWorkbenchSnapshot() as unknown as JsonValue);
      }
      case "save-template": {
        requireAction(body, "save-template", ["action", "template"]);
        return jsonResponse(await saveTemplate(body.template) as unknown as JsonValue);
      }
      case "delete-template": {
        requireAction(body, "delete-template", ["action", "id"]);
        return jsonResponse(await removeTemplate(body.id) as unknown as JsonValue);
      }
      case "import": {
        requireAction(body, "import", ["action", "content"]);
        if (typeof body.content !== "string") throw new WorkbenchError("Import content must be text.", "invalid_input", 400);
        return jsonResponse(await importTasks(body.content) as unknown as JsonValue);
      }
      case "export": {
        requireAction(body, "export", ["action", "model"]);
        const result = exportTasks(body.model);
        return jsonResponse({ ...result, snapshot: await getWorkbenchSnapshot() } as unknown as JsonValue);
      }
      case "delete-history": {
        requireAction(body, "delete-history", ["action", "id"]);
        return jsonResponse(await removeHistory(body.id) as unknown as JsonValue);
      }
      case "run": {
        return jsonResponse({ record: await runWorkbench(body), snapshot: await getWorkbenchSnapshot() } as unknown as JsonValue);
      }
      case "load": {
        requireAction(body, "load", ["action", "model"]);
        if (!isModelId(body.model)) throw new WorkbenchError("Select one of the registered logical models.", "invalid_input", 400);
        await loadModel(body.model);
        return jsonResponse(await getWorkbenchSnapshot() as unknown as JsonValue);
      }
      case "switch": {
        requireAction(body, "switch", ["action", "model", "confirmRelease"]);
        if (!isModelId(body.model) || body.confirmRelease !== true) throw new WorkbenchError("Confirm the model switch and choose a registered model.", "confirmation_required", 409);
        await switchModel(body.model, true);
        return jsonResponse(await getWorkbenchSnapshot() as unknown as JsonValue);
      }
      case "stop": {
        requireAction(body, "stop", ["action", "confirmRelease"]);
        if (body.confirmRelease !== true) throw new WorkbenchError("Confirm model release before stopping.", "confirmation_required", 409);
        await stopModel(true);
        return jsonResponse(await getWorkbenchSnapshot() as unknown as JsonValue);
      }
      default:
        throw new WorkbenchError("Unknown workbench action.", "invalid_input", 400);
    }
  } catch (error) {
    return failureResponse(error);
  }
}
