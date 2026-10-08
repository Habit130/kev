"use client";

import { useWorkbenchLocale } from "@/components/workbench-locale";
import type { Copy } from "@/lib/workbench/translations";

export type DisplayError = { category: string; message: string };

export function displayError(value: unknown, category = "workbench_error"): DisplayError {
  if (value instanceof Error) {
    return { category: "category" in value && typeof value.category === "string" ? value.category : category, message: value.message };
  }
  return { category, message: "Unexpected workbench error" };
}

const summaries: Record<string, Copy> = {
  invalid_input: "Invalid input. Check the JSON, questions or configuration and try again.",
  invalid_json: "Invalid input. Check the JSON, questions or configuration and try again.",
  storage_error: "Could not save or read local data. Check project storage and retry; success has not been recorded.",
  busy: "The model slot is busy. Wait for the current run or close it in its owning project, then retry.",
  model_not_ready: "The model is not ready. Load a model before running.",
  model_mismatch: "The selected model is not resident. Switch explicitly before running.",
  failed_startup: "Model startup failed. Check status and recover the owned session before retrying.",
  failed_close: "Model shutdown is not confirmed. Retry Stop; the slot is not considered free.",
  rejected_length: "Input exceeds the admitted length. Shorten it explicitly and retry; nothing was silently truncated.",
  model_error: "Inference failed. Check model status and retry; no successful result was saved.",
  unavailable_environment: "Local model prerequisites are unavailable. Check the local inference setup guide.",
  stale_runtime: "The saved model session is stale. Recover the owned session; unrelated processes were left untouched.",
  recovery_required: "Recover the saved model session before loading or switching.",
  interrupted: "The run was interrupted. Restore the snapshot and explicitly rerun when ready.",
};

export function WorkbenchErrorMessage({ error }: { error: DisplayError }) {
  const { t } = useWorkbenchLocale();
  return <div>
    <p>{t(summaries[error.category] ?? "The operation did not complete. Inspect the diagnostic detail, check status and retry.")}</p>
    <details className="mt-2 break-words"><summary className="cursor-pointer focus-visible:ring-2 focus-visible:ring-ring">{t("Diagnostic details")}</summary><p className="mt-1 whitespace-pre-wrap" lang="en">{error.category}: {error.message}</p></details>
  </div>;
}
