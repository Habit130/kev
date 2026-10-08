"use client";

import { useState } from "react";
import { useWorkbenchLocale } from "@/components/workbench-locale";
import { WorkbenchErrorMessage, type DisplayError } from "@/components/workbench-error";
import { CircleAlert, Clock3, Database, Eye, Gauge, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isJsonObject, orderedEntries, stringifyJson, type JsonValue } from "@/lib/workbench/json";
import type { HistoryRecord } from "@/lib/workbench/storage";
import { stableModelIdentity } from "@/lib/workbench/tasks";

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function ProbabilityBar({ label, probability, selected }: { label: string; probability: number; selected?: boolean }) {
  const { number } = useWorkbenchLocale();
  const safe = Math.max(0, Math.min(probability, 1));
  return (
    <div className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)_3.5rem] items-center gap-2.5 text-xs" title={label}>
      <span className={`break-words ${selected ? "font-medium text-foreground" : "text-muted-foreground"}`}>{label}</span>
      <span className="relative h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <span className={`absolute inset-y-0 left-0 rounded-full ${selected ? "bg-blue-600 dark:bg-blue-400" : "bg-blue-300 dark:bg-blue-900"}`} style={{ width: `${safe * 100}%` }} />
      </span>
      <span className="text-right font-mono tabular-nums">{number(probability, 3)}</span>
    </div>
  );
}

function Answer({ id, answer }: { id: string; answer: JsonValue }) {
  const { t, number } = useWorkbenchLocale();
  if (!isJsonObject(answer) || typeof answer.type !== "string") return null;
  const probabilities = isJsonObject(answer.probabilities) ? answer.probabilities : null;
  const confidence = numberValue(answer.confidence);
  if (answer.type === "choice") {
    const choice = typeof answer.choice === "string" ? answer.choice : "—";
    return (
      <article className="rounded-xl border border-border bg-background p-4" aria-label={t("{id} Choice result", { id })}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-mono text-xs text-muted-foreground">{id} <span className="font-sans">· {t("Choice")}</span></p>
            <p className="mt-1 break-words text-base font-semibold">{choice}</p>
          </div>
          {confidence !== null && <span className="rounded-full bg-muted px-2 py-1 font-mono text-[11px] tabular-nums">{t("confidence")} {number(confidence, 3)}</span>}
        </div>
        {probabilities && <div className="mt-4 flex flex-col gap-2">{orderedEntries(probabilities).map(([key, value]) => numberValue(value) === null ? null : <ProbabilityBar key={key} label={key} probability={numberValue(value)!} selected={key === choice} />)}</div>}
      </article>
    );
  }
  if (answer.type === "noul") {
    const yes = numberValue(answer.noul);
    if (yes === null) return null;
    return (
      <article className="rounded-xl border border-border bg-background p-4" aria-label={t("{id} Noul result", { id })}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-mono text-xs text-muted-foreground">{id} <span className="font-sans">· {t("Noul")}</span></p>
            <p className="mt-1 text-base font-semibold">{t("p(yes)")} {number(yes, 3)}</p>
          </div>
          <span className="rounded-full bg-muted px-2 py-1 text-[11px] text-muted-foreground">{t("canonical yes probability")}</span>
        </div>
        <div className="mt-4 flex flex-col gap-2">
          <ProbabilityBar label={t("Yes")} probability={yes} selected={yes >= 0.5} />
          <ProbabilityBar label={t("No")} probability={1 - yes} selected={yes < 0.5} />
        </div>
      </article>
    );
  }
  if (answer.type === "score") {
    const score = numberValue(answer.score);
    const legend = isJsonObject(answer.legend) ? answer.legend : null;
    if (score === null) return null;
    return (
      <article className="rounded-xl border border-border bg-background p-4" aria-label={t("{id} Score result", { id })}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-mono text-xs text-muted-foreground">{id} <span className="font-sans">· {t("Score")}</span></p>
            <p className="mt-1 text-base font-semibold">{t("Expected level")} {number(score, 3)}</p>
          </div>
          {confidence !== null && <span className="rounded-full bg-muted px-2 py-1 font-mono text-[11px] tabular-nums">{t("confidence")} {number(confidence, 3)}</span>}
        </div>
        {probabilities && <div className="mt-4 flex flex-col gap-2">{orderedEntries(probabilities).map(([key, value]) => numberValue(value) === null ? null : <ProbabilityBar key={key} label={`${key}${legend && typeof legend[key] === "string" ? ` · ${legend[key]}` : ""}`} probability={numberValue(value)!} selected={false} />)}</div>}
      </article>
    );
  }
  return null;
}

export function WorkbenchResults({ record, busy, error }: { record: HistoryRecord | null; busy: boolean; error: DisplayError | null }) {
  const { t, number, time } = useWorkbenchLocale();
  const [showRaw, setShowRaw] = useState(false);
  const response = record?.response;
  const answers = response && isJsonObject(response.answers) ? response.answers : null;
  const identity = record ? stableModelIdentity(record.modelIdentity) : null;
  const usage = response && isJsonObject(response.usage) ? response.usage : null;
  const latency = response ? numberValue(response.latency_ms) : null;

  return (
    <section className="min-w-0 rounded-2xl border border-border bg-card p-4 shadow-sm shadow-black/[0.025] sm:p-5" aria-labelledby="results-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700 dark:text-blue-300">{t("Run output")}</p>
          <h2 id="results-heading" className="mt-1 text-lg font-semibold tracking-tight">{t("Typed results")}</h2>
        </div>
        {record?.status === "succeeded" && (
          <Button type="button" variant="outline" size="sm" className="h-8 rounded-lg" onClick={() => setShowRaw((shown) => !shown)} aria-expanded={showRaw}>
            <Eye className="size-3.5" /> {t(showRaw ? "Hide raw" : "Inspect raw")}
          </Button>
        )}
      </div>

      {record && <div className="mt-4 rounded-lg bg-muted/50 p-3 text-xs leading-5" aria-label={t("Result provenance")}>
        <p className="break-words font-semibold">{t("Submitted task")} · {record.taskName} ({record.taskId})</p>
        <p className="break-all">{t("Run")} · {record.id} · {time(record.submittedAt)}</p>
        <p>{t("Actual model")} · {identity?.modelId ?? t("unknown")} · {identity?.backend ?? t("unknown")}</p>
        <p className="text-muted-foreground">{t("Saved snapshot — independent of the current task selection and input.")}</p>
      </div>}

      {busy && (
        <div role="status" className="mt-5 flex min-h-36 flex-col items-center justify-center rounded-xl border border-dashed border-blue-300 bg-blue-50/70 p-6 text-center dark:border-blue-950 dark:bg-blue-950/30">
          <span className="size-6 animate-spin rounded-full border-2 border-blue-300 border-t-blue-700 dark:border-blue-800 dark:border-t-blue-300" aria-hidden="true" />
          <p className="mt-3 text-sm font-medium">{t("Running one submitted state against the ready model…")}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t("This panel will show the frozen request’s result, not later editor changes.")}</p>
        </div>
      )}

      {!busy && error && (
        <div role="alert" className="mt-5 flex gap-3 rounded-xl border border-destructive/25 bg-destructive/5 p-4 text-sm">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div><p className="font-semibold text-destructive">{t("Run not completed")}</p><WorkbenchErrorMessage error={error} /></div>
        </div>
      )}

      {!busy && !error && !record && (
        <div className="mt-5 flex min-h-40 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-background/60 px-5 text-center">
          <Sparkles className="size-5 text-blue-600 dark:text-blue-300" />
          <p className="mt-3 text-sm font-medium">{t("No run selected")}</p>
          <p className="mt-1 max-w-xs text-xs leading-5 text-muted-foreground">{t("Load a model, add a state, and run a task to see typed probabilities here.")}</p>
        </div>
      )}

      {!busy && !error && record && record.status !== "succeeded" && (
        <div role="status" className="mt-5 rounded-xl border border-amber-300/70 bg-amber-50/60 p-4 text-sm dark:border-amber-950 dark:bg-amber-950/20">
          <p className="font-semibold">{t(record.status === "interrupted" ? "Run interrupted" : record.status === "running" ? "Run still in progress" : "Run failed")}</p>
          {record.failure ? <WorkbenchErrorMessage error={record.failure} /> : <p className="mt-1 break-words text-muted-foreground">{t("No completed response was saved.")}</p>}
        </div>
      )}

      {!busy && !error && record?.status === "succeeded" && answers && (
        <>
          <div className="mt-4 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
            {latency !== null && <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1"><Clock3 className="size-3" /> {number(latency, 1)} {t("ms")}</span>}
            {usage && typeof usage.input_tokens === "number" && <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1"><Database className="size-3" /> {number(usage.input_tokens)} {t("input tokens")}</span>}
            {usage && typeof usage.output_tokens === "number" && <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1"><Gauge className="size-3" /> {number(usage.output_tokens)} {t("output tokens")}</span>}
          </div>
          <details className="mt-3 rounded-lg border border-border/80 bg-background px-3 py-2 text-[11px] leading-5 text-muted-foreground">
            <summary className="cursor-pointer focus-visible:ring-2 focus-visible:ring-ring">{t("Actual model details")}</summary>
            <p className="break-all"><span className="font-medium text-foreground">{t("Checkpoint")}</span> · {identity?.checkpoint.source ?? t("Unknown")} · {identity?.checkpoint.revision ?? t("pin unavailable")}</p>
            <p className="break-all"><span className="font-medium text-foreground">{t("Base")}</span> · {identity?.base.source ?? t("Unknown")} · {identity?.base.revision ?? t("pin unavailable")}</p>
            <p className="break-words">{t("Actual runtime")} · {identity?.backend ?? t("unknown")} · {identity?.dtype ?? t("unknown")} · {identity?.device ?? t("unknown")}</p>
          </details>
          <div className="mt-3 flex flex-col gap-2.5">
            {orderedEntries(answers).map(([id, answer]) => <Answer key={id} id={id} answer={answer} />)}
          </div>
          {showRaw && (
            <section className="mt-4 rounded-xl border border-border bg-background p-3" aria-label={t("Raw request and response")}>
              <p className="text-xs font-semibold">{t("Submitted snapshot and canonical response")}</p>
              <pre className="mt-2 max-h-[34rem] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/50 p-3 font-mono text-[11px] leading-5">{stringifyJson({
                request: { state: record.state, model: identity?.modelId ?? "unknown", questions: record.questions },
                response: response as JsonValue,
              }, 2)}</pre>
            </section>
          )}
        </>
      )}

      {record && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-[11px] text-muted-foreground">
          <span className="truncate">{record.taskName} · {time(record.submittedAt)}</span>
          <span className="shrink-0 font-mono uppercase">{t(record.status)}</span>
        </div>
      )}
    </section>
  );
}
