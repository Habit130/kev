import { WorkbenchError } from "@/lib/workbench/errors";
import { isJsonObject, parseJson, stringifyJson, type JsonValue } from "@/lib/workbench/json";
import { deterministicTestAction } from "@/lib/workbench/service";
import { isDeterministicTestMode, isNativeTestMode, testRuntimeEndpoint } from "@/lib/workbench/runtime";
import { localOriginFailure } from "@/lib/workbench/local-origin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0" };

function jsonResponse(value: JsonValue, status = 200): Response {
  return new Response(stringifyJson(value), {
    status,
    headers: { ...NO_STORE, "Content-Type": "application/json; charset=utf-8" },
  });
}

export async function GET(request: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production" || !isNativeTestMode()) {
    return jsonResponse({ error: { category: "not_found", message: "Not found." } }, 404);
  }
  const failure = localOriginFailure(request, false);
  if (failure) return jsonResponse({ error: failure }, 403);
  try {
    return jsonResponse({ endpoint: await testRuntimeEndpoint() } as unknown as JsonValue);
  } catch (error) {
    if (error instanceof WorkbenchError) {
      return jsonResponse({ error: { category: error.category, message: error.message } }, error.status);
    }
    return jsonResponse({ error: { category: "workbench_error", message: "The native test endpoint could not be verified." } }, 500);
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!isDeterministicTestMode()) {
    return jsonResponse({ error: { category: "not_found", message: "Not found." } }, 404);
  }
  const failure = localOriginFailure(request, true);
  if (failure) return jsonResponse({ error: failure }, 403);
  try {
    const raw = await request.text();
    const body = parseJson(raw);
    if (!isJsonObject(body)) throw new WorkbenchError("Test action must be a JSON object.", "invalid_input", 400);
    return jsonResponse(await deterministicTestAction(body) as unknown as JsonValue);
  } catch (error) {
    if (error instanceof WorkbenchError) {
      return jsonResponse({ error: { category: error.category, message: error.message } }, error.status);
    }
    return jsonResponse({ error: { category: "invalid_input", message: "Test action is invalid." } }, 400);
  }
}
