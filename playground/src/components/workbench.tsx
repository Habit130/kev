"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { WorkbenchLocale, useWorkbenchLocale } from "@/components/workbench-locale";
import { displayError, WorkbenchErrorMessage, type DisplayError } from "@/components/workbench-error";
import type { Locale } from "@/lib/workbench/locale";
import type { Copy } from "@/lib/workbench/translations";
import Link from "next/link";
import {
  Activity,
  ArrowDownToLine,
  ArrowRightLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  FileOutput,
  FolderOpen,
  Moon,
  Play,
  Plus,
  Save,
  Sun,
  Trash2,
  TriangleAlert,
  WandSparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { WorkbenchQuestionEditor } from "@/components/workbench-question-editor";
import { WorkbenchResults } from "@/components/workbench-results";
import { cloneJson, isJsonObject, orderedObject, parseJson, stringifyJson, type JsonObject, type JsonValue } from "@/lib/workbench/json";
import { isModelId, modelChoice, validateQuestions, type ModelId, type WorkbenchTemplate } from "@/lib/workbench/tasks";
import type { HistoryRecord } from "@/lib/workbench/storage";
import type { WorkbenchSnapshot } from "@/lib/workbench/service";

class RequestError extends Error {
  constructor(message: string, readonly category: string) { super(message); }
}

async function postWorkbench(body: JsonObject): Promise<unknown> {
  const response = await fetch("/api/workbench", {
    method: "POST",
    headers: { "content-type": "application/json" },
    cache: "no-store",
    body: stringifyJson(body as unknown as JsonValue),
  });
  const data: unknown = await response.text().then((text) => parseJson(text)).catch(() => null);
  if (!response.ok) {
    const message = isJsonObject(data) && isJsonObject(data.error) && typeof data.error.message === "string" ? data.error.message : `Workbench request failed (${response.status}).`;
    throw new RequestError(message, isJsonObject(data) && isJsonObject(data.error) && typeof data.error.category === "string" ? data.error.category : "workbench_error");
  }
  return data;
}

async function fetchSnapshot(): Promise<WorkbenchSnapshot> {
  const response = await fetch("/api/workbench", { cache: "no-store" });
  const data: unknown = await response.text().then((text) => parseJson(text)).catch(() => null);
  if (!response.ok || !isJsonObject(data) || !Array.isArray(data.templates) || !Array.isArray(data.history)) {
    const detail = isJsonObject(data) && isJsonObject(data.error) && typeof data.error.message === "string" ? data.error.message : "The local workbench data could not be loaded.";
    throw new RequestError(detail, isJsonObject(data) && isJsonObject(data.error) && typeof data.error.category === "string" ? data.error.category : "workbench_error");
  }
  return data as unknown as WorkbenchSnapshot;
}

function templateDraft(template: WorkbenchTemplate) {
  return {
    id: template.id,
    taskId: template.taskId,
    name: template.name,
    description: template.description ?? "",
    questions: cloneJson(template.questions),
  };
}

function initialQuestions(): JsonObject {
  return orderedObject([["request_type", orderedObject([
      ["type", "choice"],
      ["instructions", "What kind of synthetic request is this?"],
      ["criteria", orderedObject([["question", "A question or information request"], ["problem", "A problem needing follow-up"]])],
    ])]]);
}

function formatState(record: HistoryRecord): string {
  if (record.stateMode === "text" && typeof record.state === "string") return record.state;
  return stringifyJson(record.state, 2);
}

export function Workbench({ initialLocale = "zh-CN" }: { initialLocale?: Locale }) {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  return <WorkbenchLocale value={locale}><WorkbenchContent locale={locale} setLocale={setLocale} /></WorkbenchLocale>;
}

function WorkbenchContent({ locale, setLocale }: { locale: Locale; setLocale: (locale: Locale) => void }) {
  const { t, number, time } = useWorkbenchLocale();
  const localeRevision = useRef(0);
  const currentLocale = useRef(locale);
  const [savingLocale, setSavingLocale] = useState(false);
  const [localeError, setLocaleError] = useState<DisplayError | null>(null);
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot | null>(null);
  const [projectDescription, setProjectDescription] = useState("");
  const [initialLoadError, setInitialLoadError] = useState<DisplayError | null>(null);
  const [stateMode, setStateMode] = useState<"text" | "json">("text");
  const [stateText, setStateText] = useState("");
  const [questions, setQuestions] = useState<JsonObject>(initialQuestions);
  const [templateId, setTemplateId] = useState("");
  const [taskId, setTaskId] = useState("support-review");
  const [taskName, setTaskName] = useState("支持请求");
  const [templateDescription, setTemplateDescription] = useState("");
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [runError, setRunError] = useState<DisplayError | null>(null);
  const [operationError, setOperationError] = useState<DisplayError | null>(null);
  const [notice, setNotice] = useState<{ copy: Copy; values?: Record<string, string | number> } | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [view, setView] = useState<"run" | "library" | "history">("run");
  const [runTemplateId, setRunTemplateId] = useState("");
  const [restoredDraft, setRestoredDraft] = useState<HistoryRecord | null>(null);

  useEffect(() => {
    let current = true;
    fetchSnapshot().then((next) => {
      if (!current) return;
      setSnapshot(next);
      currentLocale.current = next.settings.locale;
      setLocale(next.settings.locale);
      setProjectDescription(next.settings.projectDescription ?? "");
      const first = next.templates[0];
      if (first) {
        setRunTemplateId(first.id);
        const draft = templateDraft(first);
        setTemplateId(draft.id);
        setTaskId(draft.taskId);
        setTaskName(draft.name);
        setTemplateDescription(draft.description);
        setQuestions(draft.questions);
      }
      setInitialLoadError(null);
    }).catch((error: unknown) => {
      if (current) setInitialLoadError(displayError(error));
    });
    return () => { current = false; };
  }, [setLocale]);

  useEffect(() => {
    const previous = document.documentElement.lang;
    const previousTitle = document.title;
    document.documentElement.lang = locale;
    document.title = locale === "zh-CN" ? "Kev · 本地模型工作台" : "Kev · Local Model Workbench";
    return () => { document.documentElement.lang = previous; document.title = previousTitle; };
  }, [locale]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", snapshot?.settings.theme === "dark");
    document.documentElement.classList.toggle("light", snapshot?.settings.theme !== "dark");
  }, [snapshot?.settings.theme]);

  const selectedTemplate = snapshot?.templates.find((template) => template.id === templateId) ?? null;
  const runTemplate = snapshot?.templates.find((template) => template.id === runTemplateId) ?? null;
  const runTask = restoredDraft ?? runTemplate;
  const displayedRecord = snapshot?.history.find((record) => record.id === selectedHistoryId) ?? null;
  const activeModel = snapshot?.runtime.identity?.modelId;
  const modelReadyForSelection = snapshot?.runtime.state === "ready" && activeModel === snapshot.settings.selectedModel;

  const questionValidationError = useMemo(() => {
    try {
      validateQuestions(questions);
      return null;
    } catch (error) {
      return displayError(error, "invalid_input");
    }
  }, [questions]);

  const stateValidationError = useMemo(() => {
    if (stateMode !== "json" || stateText.length === 0) return null;
    try {
      parseJson(stateText);
      return null;
    } catch (error) {
      return displayError(error, "invalid_input");
    }
  }, [stateMode, stateText]);

  const isRunDisabled = !snapshot || !modelReadyForSelection || pendingAction !== null || stateText.length === 0 || !runTask || !!stateValidationError;

  async function refreshSnapshot(): Promise<WorkbenchSnapshot | null> {
    try {
      const next = await fetchSnapshot();
      setSnapshot(next);
      if (localeRevision.current === 0) {
        currentLocale.current = next.settings.locale;
        setLocale(next.settings.locale);
      }
      setInitialLoadError(null);
      return next;
    } catch (error) {
      setOperationError(displayError(error));
      if (!snapshot) setInitialLoadError(displayError(error));
      return null;
    }
  }

  function acceptSnapshot(value: unknown): WorkbenchSnapshot | null {
    if (!isJsonObject(value)) return null;
    const candidate = isJsonObject(value.snapshot) ? value.snapshot : value;
    if (!Array.isArray(candidate.templates) || !Array.isArray(candidate.history) || !isJsonObject(candidate.settings)) return null;
    const next = candidate as unknown as WorkbenchSnapshot;
    setSnapshot({ ...next, settings: { ...next.settings, locale: currentLocale.current } });
    setInitialLoadError(null);
    return next;
  }

  async function performOperation(action: string, body: JsonObject): Promise<unknown | null> {
    setPendingAction(action);
    setOperationError(null);
    setNotice(null);
    try {
      const data = await postWorkbench({ action, ...body });
      acceptSnapshot(data);
      return data;
    } catch (error) {
      setOperationError(displayError(error));
      void refreshSnapshot();
      return null;
    } finally {
      setPendingAction(null);
    }
  }

  function chooseTemplate(template: WorkbenchTemplate) {
    const draft = templateDraft(template);
    setTemplateId(draft.id);
    setTaskId(draft.taskId);
    setTaskName(draft.name);
    setTemplateDescription(draft.description);
    setQuestions(draft.questions);
    setEditorError(null);
    setOperationError(null);
    setNotice({ copy: "Template loaded into the editor. The resident model was not changed." });
  }

  function newTemplate() {
    setTemplateId("");
    setTaskId("new-task");
    setTaskName("New task");
    setTemplateDescription("");
    setQuestions(initialQuestions());
    setEditorError(null);
    setNotice({ copy: "New editable task draft. Save it to keep the template." });
  }

  async function saveCurrentTemplate() {
    const payload = {
      ...(templateId ? { id: templateId } : {}),
      taskId,
      name: taskName,
      ...(templateDescription ? { description: templateDescription } : {}),
      questions: questions as unknown as JsonValue,
    } as JsonObject;
    const data = await performOperation("save-template", { template: payload });
    if (data && isJsonObject(data) && isJsonObject(data.settings) && Array.isArray(data.templates)) {
      const next = data as unknown as WorkbenchSnapshot;
      const saved = next.templates.find((item) => item.taskId === taskId);
      if (saved) {
        setTemplateId(saved.id);
        if (!runTemplate) setRunTemplateId(saved.id);
      }
      setNotice({ copy: "Template saved in project-local workbench storage." });
    }
  }

  async function deleteCurrentTemplate() {
    if (!selectedTemplate || !window.confirm(t("Delete the saved template “{name}”? Run history will remain.", { name: selectedTemplate.name }))) return;
    const data = await performOperation("delete-template", { id: selectedTemplate.id });
    if (data && isJsonObject(data) && Array.isArray(data.templates)) {
      const next = data as unknown as WorkbenchSnapshot;
      const first = next.templates[0];
      if (first) chooseTemplate(first);
      else newTemplate();
      setNotice({ copy: "Template deleted. Existing run snapshots were kept." });
    }
  }

  async function updatePreference(key: "selectedModel" | "exportModel" | "theme" | "projectDescription", value: string) {
    const nextValue = key === "selectedModel" || key === "exportModel" ? value as ModelId : value;
    await performOperation("settings", { settings: { [key]: nextValue } as JsonObject });
  }

  async function updateLocale(value: Locale) {
    if (savingLocale) return;
    setSavingLocale(true);
    setLocaleError(null);
    try {
      await postWorkbench({ action: "settings", settings: { locale: value } });
      localeRevision.current += 1;
      currentLocale.current = value;
      setLocale(value);
      setSnapshot((current) => current ? { ...current, settings: { ...current.settings, locale: value } } : current);
    } catch (error) {
      setLocaleError(displayError(error));
    } finally {
      setSavingLocale(false);
    }
  }

  async function loadSelectedModel() {
    if (!snapshot) return;
    if (snapshot.runtime.state === "ready" && activeModel !== snapshot.settings.selectedModel) {
      if (!window.confirm(t("Stop {current} and load {next}? Only one model can be resident.", { current: modelChoice(activeModel as ModelId).label, next: modelChoice(snapshot.settings.selectedModel).label }))) return;
      await performOperation("switch", { model: snapshot.settings.selectedModel, confirmRelease: true });
      return;
    }
    await performOperation("load", { model: snapshot.settings.selectedModel });
  }

  async function stopModel() {
    if (!snapshot || !window.confirm(t("Stop the workbench-owned model and release its exclusive local slot?"))) return;
    await performOperation("stop", { confirmRelease: true });
  }

  function submittedPayload(
    stateModeValue: "text" | "json",
    stateTextValue: string,
    questionValue: JsonObject,
    taskIdValue: string,
    taskNameValue: string,
  ): JsonObject {
    return {
      action: "run",
      stateMode: stateModeValue,
      stateText: stateTextValue,
      questions: cloneJson(questionValue),
      taskId: taskIdValue,
      taskName: taskNameValue,
    };
  }

  async function runDraft(overrides?: {
    stateMode: "text" | "json";
    stateText: string;
    questions: JsonObject;
    taskId: string;
    taskName: string;
  }) {
    const payload = overrides
      ? submittedPayload(overrides.stateMode, overrides.stateText, overrides.questions, overrides.taskId, overrides.taskName)
      : runTask ? submittedPayload(stateMode, stateText, runTask.questions, runTask.taskId, "taskName" in runTask ? runTask.taskName : runTask.name) : null;
    if (!payload) return;
    setPendingAction("run");
    setRunError(null);
    setOperationError(null);
    setNotice(null);
    setSelectedHistoryId(null);
    try {
      const data = await postWorkbench(payload);
      if (!isJsonObject(data) || !isJsonObject(data.record) || !isJsonObject(data.snapshot)) throw new Error("The saved run record was incomplete.");
      const record = data.record as unknown as HistoryRecord;
      acceptSnapshot(data);
      setSelectedHistoryId(record.id);
    } catch (error) {
      setRunError(displayError(error));
      const next = await refreshSnapshot();
      const latest = next?.history[0];
      if (latest && latest.status !== "succeeded" && new Date(latest.submittedAt).getTime() >= Date.now() - 60_000) setSelectedHistoryId(latest.id);
    } finally {
      setPendingAction(null);
    }
  }

  function restoreRun(record: HistoryRecord) {
    setStateMode(record.stateMode);
    setStateText(formatState(record));
    setRestoredDraft(record);
    setView("run");
    setNotice({ copy: "Saved request snapshot restored as a draft. It has not been submitted." });
  }

  async function deleteRun(record: HistoryRecord) {
    if (!window.confirm(t("Delete this {status} run from local history?", { status: t(record.status) }))) return;
    const data = await performOperation("delete-history", { id: record.id });
    if (data) {
      if (selectedHistoryId === record.id) setSelectedHistoryId(null);
      setNotice({ copy: "Run history record deleted from the project." });
    }
  }

  async function importFile(file: File | undefined) {
    if (!file) return;
    setPendingAction("import");
    setOperationError(null);
    setNotice(null);
    try {
      const content = await file.text();
      const data = await postWorkbench({ action: "import", content } as unknown as JsonObject);
      const next = acceptSnapshot(data);
      if (next) {
        setProjectDescription(next.settings.projectDescription ?? "");
        const first = next.templates[0];
        if (first) {
          chooseTemplate(first);
          setRunTemplateId(first.id);
        }
        setNotice({ copy: "Imported {count} task templates. No model was loaded or switched.", values: { count: number(next.templates.length) } });
      }
    } catch (error) {
      setOperationError(displayError(error));
      void refreshSnapshot();
    } finally {
      setPendingAction(null);
    }
  }

  async function exportConfiguration() {
    const data = await performOperation("export", { model: snapshot?.settings.exportModel ?? "kev-4b" });
    if (data && isJsonObject(data) && typeof data.file === "string") setNotice({ copy: "Task configuration exported to .local/playground/workbench/{file}", values: { file: data.file } });
  }

  if (initialLoadError && !snapshot) {
    return (
      <main className="mx-auto flex min-h-svh w-full max-w-lg flex-col items-center justify-center px-6 text-center">
        <CircleHelp className="size-8 text-blue-600" />
        <h1 className="mt-4 text-2xl font-semibold">{t("Local model workbench")}</h1>
        <div role="alert" className="mt-2 text-sm text-muted-foreground"><WorkbenchErrorMessage error={initialLoadError} /></div>
        <Button className="mt-5" onClick={() => { setInitialLoadError(null); void refreshSnapshot(); }}>{t("Retry")}</Button>
      </main>
    );
  }

  if (!snapshot) {
    return (
      <main className="mx-auto flex min-h-svh w-full max-w-5xl flex-col px-5 py-6 sm:px-8">
        <div className="flex items-center gap-3"><span className="size-9 animate-pulse rounded-xl bg-blue-100 dark:bg-blue-950" /><div><p className="text-sm font-semibold">{t("Local model workbench")}</p><p className="text-xs text-muted-foreground">{t("Loading project-owned templates and history…")}</p></div></div>
        <div className="mt-8 grid gap-4 lg:grid-cols-[230px_1fr_1fr]" aria-hidden="true">
          <div className="h-72 animate-pulse rounded-2xl bg-muted" /><div className="h-96 animate-pulse rounded-2xl bg-muted" /><div className="h-96 animate-pulse rounded-2xl bg-muted" />
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-svh bg-background text-foreground">
      {/* Shell structure adapts shadcn/ui's dashboard-01 Sidebar/Inset pattern; the workbench controls and data views are Kev-specific. */}
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex max-w-[1720px] flex-wrap items-center justify-between gap-x-5 gap-y-3 px-4 py-3 sm:px-6 xl:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm shadow-blue-950/15"><WandSparkles className="size-4" /></div>
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold tracking-tight">{t("Local model workbench")}</h1>
              <p className="truncate text-[11px] text-muted-foreground">{t("Kev · local inference, typed answers")}</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2 text-xs"><span>{t("Interface language")}</span>
              <div role="group" aria-label={t("Interface language")} className="inline-flex rounded-lg border border-input p-0.5">
                {([['zh-CN', '简体中文'], ['en', 'English']] as const).map(([value, name]) => <Button key={value} type="button" size="sm" variant={locale === value ? "secondary" : "ghost"} aria-pressed={locale === value} disabled={savingLocale} onClick={() => void updateLocale(value)}>{name}</Button>)}
              </div>
            </div>
            {savingLocale && <span role="status" className="text-xs">{t("Saving language…")}</span>}
            <details className="relative" aria-label={t("Model controls")}>
              <summary className="cursor-pointer rounded-lg border border-border px-3 py-2 text-xs focus-visible:ring-2 focus-visible:ring-ring">
                {t("Model")} · {t(snapshot.runtime.state)} · {activeModel ?? t("none resident")}
                {activeModel && activeModel !== snapshot.settings.selectedModel && <span> · {t("selected")} {snapshot.settings.selectedModel}</span>}
              </summary>
              <div className="mt-2 flex w-80 max-w-[90vw] flex-wrap gap-2 rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-2.5 py-1.5">
              <span className={`size-2 rounded-full ${snapshot.runtime.state === "ready" ? "bg-emerald-500" : snapshot.runtime.state === "recovery" ? "bg-amber-500" : "bg-muted-foreground/40"}`} aria-hidden="true" />
              <label className="sr-only" htmlFor="selected-model">{t("Selected model")}</label>
              <select id="selected-model" aria-label={t("Selected model")} value={snapshot.settings.selectedModel} disabled={pendingAction !== null} onChange={(event) => {
                if (isModelId(event.target.value)) void updatePreference("selectedModel", event.target.value);
              }} className="h-7 min-w-28 bg-transparent text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
                {(["kev-4b", "kev-0.8b"] as ModelId[]).map((model) => <option key={model} value={model}>{modelChoice(model).label}</option>)}
              </select>
              <div className="hidden max-w-48 border-l border-border pl-2 sm:block">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{snapshot.runtime.state === "ready" ? t("Actually ready") : t(snapshot.runtime.state)}</p>
                <p className="truncate text-[11px] font-medium" title={snapshot.runtime.identity?.checkpoint.source ?? t(snapshot.runtime.state)}>
                  {snapshot.runtime.state === "ready" ? snapshot.runtime.identity?.checkpoint.source : t(snapshot.runtime.state)}
                </p>
              </div>
            </div>
            <Button type="button" size="sm" disabled={pendingAction !== null || (snapshot.runtime.state === "ready" && activeModel === snapshot.settings.selectedModel)} onClick={() => void loadSelectedModel()}>
              {pendingAction === "load" || pendingAction === "switch" ? <Activity className="size-3.5 animate-pulse" /> : snapshot.runtime.state === "ready" ? <ArrowRightLeft className="size-3.5" /> : <Play className="size-3.5" />}
              {pendingAction === "load" || pendingAction === "switch" ? t("Loading…") : snapshot.runtime.state === "ready" ? t("Switch model") : t("Load model")}
            </Button>
            <Button type="button" variant="outline" size="sm" title={t("Stop or recover the resident model")} disabled={pendingAction !== null || (snapshot.runtime.state === "unloaded")} onClick={() => void stopModel()}>
              <ArrowDownToLine className="size-3.5" /> {t("Stop")}
            </Button>
              <p className="text-xs text-muted-foreground">{t(snapshot.runtime.state === "ready" ? "Model ready" : snapshot.runtime.state === "recovery" ? "Recover the saved model session before loading or switching." : "No model is loaded")}. {t("Selection is for the next run; load, switch and stop are explicit.")}</p>
              <details className="w-full text-xs"><summary>{t("Diagnostic details")}</summary><p lang="en">{snapshot.runtime.message}</p></details>
              </div>
            </details>
            <Button type="button" variant="ghost" size="icon" aria-label={t(snapshot.settings.theme === "dark" ? "Use light theme" : "Use dark theme")} disabled={pendingAction !== null} onClick={() => void updatePreference("theme", snapshot.settings.theme === "dark" ? "light" : "dark")}>
              {snapshot.settings.theme === "dark" ? <Sun /> : <Moon />}
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1720px] gap-6 px-4 py-7 sm:px-6 lg:grid-cols-[160px_minmax(0,1fr)] xl:px-8">
        <aside className="min-w-0" aria-label={t("Workspace navigation")}>
          <nav aria-label={t("Primary")} className="flex gap-2 lg:flex-col">
            {([['run', 'Run'], ['library', 'Task library'], ['history', 'History']] as const).map(([destination, label]) => (
              <Button key={destination} variant={view === destination ? "secondary" : "ghost"} className="justify-start" aria-current={view === destination ? "page" : undefined} onClick={() => setView(destination)}>{t(label)}</Button>
            ))}
          </nav>
          <details className="mt-6 text-xs">
            <summary className="cursor-pointer rounded-lg p-2 focus-visible:ring-2 focus-visible:ring-ring">{t("More tools")}</summary>
            <div className="space-y-3 p-2 text-muted-foreground">
              <p>{t("Independent tools. A loaded workbench model does not make these ready. Configure their separate Kev API backend (KEV_API).")}</p>
              <Link href="/classic" className="block underline">{t("Classic Playground")}</Link>
              <Link href="/chess" className="block underline">{t("Chess")}</Link>
            </div>
          </details>
          <p className="mt-6 text-[11px] leading-5 text-muted-foreground">{t("Probabilities and scores are model outputs, not guarantees of business accuracy.")}</p>
        </aside>

        <div className="min-w-0 space-y-5">
          {localeError && <div role="alert" className="rounded-xl border border-destructive/25 bg-destructive/5 p-3 text-xs text-destructive"><WorkbenchErrorMessage error={localeError} /></div>}
          {operationError && <div role="alert" className="rounded-xl border border-destructive/25 bg-destructive/5 p-3 text-xs text-destructive"><WorkbenchErrorMessage error={operationError} /></div>}
          {notice && <div role="status" className="rounded-xl bg-muted p-3 text-xs">{t(notice.copy, notice.values)}</div>}
          <div className={view === "library" ? "grid gap-5 xl:grid-cols-[200px_minmax(0,1fr)_300px]" : "hidden"}>
        <aside className="min-w-0 rounded-2xl border border-border bg-card p-3" aria-label={t("Saved templates")}>
          <div className="flex items-center justify-between px-2 py-1">
            <div><p className="text-xs font-semibold uppercase tracking-[0.15em] text-muted-foreground">{t("Workspace")}</p><p className="mt-1 truncate text-sm font-semibold">{t("Local tasks")}</p></div>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={t("Create new task template")} onClick={newTemplate}><Plus /></Button>
          </div>
          <div className="mt-3 flex flex-col gap-1">
            {snapshot.templates.map((template) => (
              <button key={template.id} type="button" aria-pressed={template.id === templateId} onClick={() => chooseTemplate(template)} className={`group flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${template.id === templateId ? "bg-blue-50 text-blue-950 dark:bg-blue-950/60 dark:text-blue-100" : "text-foreground hover:bg-muted"}`}>
                <span className={`flex size-7 shrink-0 items-center justify-center rounded-md ${template.id === templateId ? "bg-white/80 text-blue-700 dark:bg-blue-900 dark:text-blue-200" : "bg-muted text-muted-foreground"}`}><FolderOpen className="size-3.5" /></span>
                <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{template.name}</span><span className="block truncate font-mono text-[10px] text-muted-foreground">{template.taskId}</span></span>
                <ChevronRight className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            ))}
            {snapshot.templates.length === 0 && <p className="px-2.5 py-3 text-xs leading-5 text-muted-foreground">{t("No saved templates. Add a draft with the plus button.")}</p>}
          </div>

          </aside>
          <section className="min-w-0 rounded-2xl border border-border bg-card p-5" aria-label={t("Task editor")}>
            <h2 className="mb-4 text-lg font-semibold">{t("Task library")}</h2>
            <p className="mb-4 text-xs text-muted-foreground">{t("Unfinished edits stay in this tab. Run uses the saved version, not these edits.")}</p>
            <WorkbenchQuestionEditor questions={questions} onChange={setQuestions} taskName={taskName} setTaskName={setTaskName} taskId={taskId} setTaskId={setTaskId} description={templateDescription} setDescription={setTemplateDescription} onValidationError={setEditorError} />
            {questionValidationError && !editorError && <div role="alert" className="mt-2 text-xs text-destructive"><WorkbenchErrorMessage error={questionValidationError} /></div>}
            <div className="mt-5 flex flex-wrap gap-2">
              <Button size="sm" disabled={pendingAction !== null || !taskName.trim() || !taskId.trim() || !!questionValidationError || !!editorError} onClick={() => void saveCurrentTemplate()}><Save />{t(templateId ? "Update template" : "Save template")}</Button>
              {selectedTemplate && <><Button variant="outline" size="sm" onClick={() => chooseTemplate(selectedTemplate)}>{t("Reset to saved")}</Button><Button variant="ghost" size="sm" disabled={pendingAction !== null} onClick={() => void deleteCurrentTemplate()}><Trash2 />{t("Delete template")}</Button></>}
            </div>
          </section>
          <section className="min-w-0 rounded-2xl border border-border bg-card p-5" aria-label={t("Task configuration")}>
            <h2 className="text-base font-semibold">{t("Task configuration")}</h2>
            <label className="mt-3 block text-xs">{t("Project description (optional export metadata)")}
              <Input aria-label={t("Project description")} value={projectDescription} maxLength={1000} onChange={(event) => setProjectDescription(event.target.value)} onBlur={(event) => { if (event.target.value !== (snapshot.settings.projectDescription ?? "")) void updatePreference("projectDescription", event.target.value); }} />
            </label>
            <label className="mt-3 block text-xs">{t("Export model")}
              <select aria-label={t("Export model")} value={snapshot.settings.exportModel} disabled={pendingAction !== null} onChange={(event) => { if (isModelId(event.target.value)) void updatePreference("exportModel", event.target.value); }} className="mt-2 h-9 w-full rounded border border-input bg-background px-2 focus-visible:ring-2 focus-visible:ring-ring">
                {(["kev-4b", "kev-0.8b"] as ModelId[]).map((model) => <option key={model} value={model}>{modelChoice(model).label}</option>)}
              </select>
            </label>
            <Button variant="outline" size="sm" className="mt-3" disabled={pendingAction !== null || snapshot.templates.length === 0} onClick={() => void exportConfiguration()}><FileOutput />{t("Export")}</Button>
            <p className="mt-5 text-xs leading-5 text-muted-foreground">{t("Import replaces the entire saved template library after full validation; it does not merge. Existing run history is kept. Exports exclude input, history and machine paths.")}</p>
            <label className="mt-3 block text-xs">{t("Import kev-project-tasks/1")}
              <input aria-label={t("Import task configuration")} type="file" accept="application/json,.json" className="mt-2 w-full min-w-0 rounded border border-input p-2 focus-visible:ring-2 focus-visible:ring-ring" disabled={pendingAction !== null} onChange={(event) => { void importFile(event.target.files?.[0]); event.currentTarget.value = ""; }} />
            </label>
          </section>
          </div>

          {view === "history" && <div className="grid gap-5 xl:grid-cols-[300px_minmax(0,1fr)]">
          <section className="min-w-0 rounded-2xl border border-border bg-card p-4">
            <div className="flex items-center justify-between px-2">
              <div><p className="text-xs font-semibold uppercase tracking-[0.15em] text-muted-foreground">{t("History")}</p><p className="mt-1 text-xs text-muted-foreground">{t("{count} saved runs", { count: number(snapshot.history.length) })}</p></div>
              <Clock3 className="size-4 text-muted-foreground" />
            </div>
            <div className="mt-2 flex max-h-[330px] flex-col gap-1 overflow-y-auto pr-1">
              {snapshot.history.map((record) => (
                <button key={record.id} type="button" aria-pressed={record.id === selectedHistoryId} onClick={() => { setSelectedHistoryId(record.id); setRunError(null); }} className={`min-w-0 rounded-lg px-2.5 py-2 text-left transition-colors ${record.id === selectedHistoryId ? "bg-muted ring-1 ring-border" : "hover:bg-muted/70"}`}>
                  <span className="flex items-center justify-between gap-2"><span className="truncate text-xs font-medium">{record.taskName}</span><span className={`shrink-0 text-[9px] font-semibold uppercase ${record.status === "succeeded" ? "text-emerald-700 dark:text-emerald-300" : record.status === "failed" || record.status === "interrupted" ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}>{t(record.status)}</span></span>
                  <span className="mt-1 block truncate text-[10px] text-muted-foreground">{time(record.submittedAt)}</span>
                  <span className="mt-1 block truncate font-mono text-[9px] text-muted-foreground">{typeof record.modelIdentity.modelId === "string" ? record.modelIdentity.modelId : t("identity unavailable")}</span>
                </button>
              ))}
              {snapshot.history.length === 0 && <p className="px-2.5 py-3 text-xs leading-5 text-muted-foreground">{t("Submitted runs and failures appear here automatically. Nothing is stored in browser history.")}</p>}
            </div>

          </section>
          <div className="min-w-0 space-y-4">
            <WorkbenchResults key={displayedRecord?.id ?? "history"} record={displayedRecord} busy={pendingAction === "run"} error={runError} />
            {displayedRecord && <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => restoreRun(displayedRecord)}>{t("Restore to draft")}</Button>
              <Button variant="outline" size="sm" disabled={!modelReadyForSelection || pendingAction !== null} onClick={() => void runDraft({ stateMode: displayedRecord.stateMode, stateText: formatState(displayedRecord), questions: cloneJson(displayedRecord.questions), taskId: displayedRecord.taskId, taskName: displayedRecord.taskName })}>{t("Rerun snapshot")}</Button>
              <Button variant="ghost" size="sm" disabled={pendingAction !== null} onClick={() => void deleteRun(displayedRecord)}>{t("Delete run")}</Button>
              <p className="w-full text-xs text-muted-foreground">{t("Rerun uses the currently selected ready model: {model}. Restore does not submit or overwrite a template.", { model: snapshot.settings.selectedModel })}</p>
            </div>}
          </div>
          </div>}

          {view === "run" && <div className="grid gap-6 xl:grid-cols-2">

        <section className="min-w-0 rounded-2xl border border-border bg-card p-4 shadow-sm shadow-black/[0.025] sm:p-5" aria-labelledby="input-heading">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700 dark:text-blue-300">{t("Workbench")}</p>
              <h2 id="input-heading" className="mt-1 text-lg font-semibold tracking-tight">{t("Run a saved task")}</h2>
            </div>
            <span className="rounded-full border border-border bg-background px-2.5 py-1 text-[10px] text-muted-foreground">{t("{count} questions · one shared state", { count: number(runTask ? Object.keys(runTask.questions).length : 0) })}</span>
          </div>
          <label className="mt-5 block text-sm font-medium">{t("Saved task")}
            <select aria-label={t("Saved task")} value={restoredDraft ? "restored" : runTemplate?.id ?? ""} className="mt-2 h-10 w-full rounded-lg border border-input bg-background px-3 text-sm focus-visible:ring-2 focus-visible:ring-ring" onChange={(event) => { setRunTemplateId(event.target.value); setRestoredDraft(null); }}>
              <option value="" disabled>{t("Select a saved task")}</option>
              {restoredDraft && <option value="restored">{t("Restored draft · {name}", { name: restoredDraft.taskName })}</option>}
              {snapshot.templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
            </select>
          </label>
          {runTask ? <div className="mt-3 text-xs leading-5 text-muted-foreground">
            <p className="font-medium text-foreground">{restoredDraft ? t("Restored draft · {name}", { name: restoredDraft.taskName }) : runTemplate?.name}</p>
            <p>{restoredDraft ? t("Snapshot from run {id}. Runs independently, even if the saved template was deleted.", { id: restoredDraft.id }) : runTemplate?.description}</p>
            <p>{Object.entries(runTask.questions).map(([id, question]) => `${id} (${isJsonObject(question) ? question.type : "unknown"})`).join(" · ")}</p>
          </div> : <p className="mt-3 text-xs text-muted-foreground">{t("No saved task selected. Create or import a template in Task library.")}</p>}

          {snapshot.runtime.state !== "ready" && (
            <div role="status" className={`mt-4 flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs leading-5 ${snapshot.runtime.state === "recovery" ? "border-amber-300/70 bg-amber-50/60 dark:border-amber-950 dark:bg-amber-950/20" : "border-border bg-background"}`}>
              {snapshot.runtime.state === "recovery" ? <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-700" /> : <CircleHelp className="mt-0.5 size-3.5 shrink-0 text-blue-600" />}
              <span>{t(snapshot.runtime.state === "recovery" ? "Recover the saved model session before loading or switching." : "No model is loaded")}. {t("Load a model before submitting; selecting or editing a task does not load one.")}</span>
            </div>
          )}
          {snapshot.runtime.state === "ready" && !modelReadyForSelection && (
            <div role="status" className="mt-4 rounded-lg border border-amber-300/70 bg-amber-50/60 px-3 py-2.5 text-xs leading-5 dark:border-amber-950 dark:bg-amber-950/20">
              {t("{current} is resident, while {next} is selected. Switch explicitly before running.", { current: modelChoice(snapshot.runtime.identity?.modelId as ModelId).label, next: modelChoice(snapshot.settings.selectedModel).label })}
            </div>
          )}

          <div className="mt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label htmlFor="state-input" className="text-sm">{t("State input")} <span className="font-normal text-muted-foreground">{t("· one shared request")}</span></Label>
              <div className="inline-flex rounded-lg border border-border bg-background p-0.5" role="group" aria-label={t("State input mode")}>
                <button type="button" aria-pressed={stateMode === "text"} onClick={() => setStateMode("text")} className={`rounded-md px-2.5 py-1 text-[11px] ${stateMode === "text" ? "bg-blue-600 text-white" : "text-muted-foreground hover:text-foreground"}`}>{t("Text")}</button>
                <button type="button" aria-pressed={stateMode === "json"} onClick={() => setStateMode("json")} className={`rounded-md px-2.5 py-1 text-[11px] ${stateMode === "json" ? "bg-blue-600 text-white" : "text-muted-foreground hover:text-foreground"}`}>JSON</button>
              </div>
            </div>
            <Textarea id="state-input" aria-label={t("State input")} value={stateText} onChange={(event) => setStateText(event.target.value)} spellCheck={stateMode === "text"} className="mt-2 min-h-28 resize-y rounded-xl bg-background font-mono text-xs leading-5 shadow-none" placeholder={stateMode === "text" ? t("Paste the exact text the model should read. Delimiter-like strings remain literal.") : `{\n  "message": "${t("Paste a JSON object or value")}"\n}`} aria-invalid={!!stateValidationError} />
            {stateMode === "text" && <p className="mt-1 text-[10px] text-muted-foreground">{t("Text is submitted literally; the workbench does not trim, translate, or rewrite it.")}</p>}
            {stateValidationError && <div role="alert" className="mt-1 text-xs text-destructive"><WorkbenchErrorMessage error={stateValidationError} /></div>}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
            <Button type="button" size="sm" className="rounded-lg px-3" disabled={isRunDisabled} onClick={() => void runDraft()}>
              {pendingAction === "run" ? <Activity className="size-3.5 animate-pulse" /> : <Play className="size-3.5" />}
              {t(pendingAction === "run" ? "Running…" : "Run task")}
            </Button>
            <span className="text-xs text-muted-foreground">{t("Results belong to the submitted snapshot, not later input changes.")}</span>
          </div>
        </section>

        <section className="min-w-0 space-y-4" aria-label={t("Run results")}>
          <WorkbenchResults key={displayedRecord?.id ?? "run"} record={displayedRecord} busy={pendingAction === "run"} error={runError} />
        </section>
          </div>}
        </div>
      </div>

      <footer className="mx-auto flex max-w-[1720px] flex-wrap items-center justify-between gap-2 px-4 pb-5 text-[10px] text-muted-foreground sm:px-6 xl:px-8">
        <p className="flex items-center gap-1.5"><Activity className="size-3" /> {t("One state, isolated typed questions, canonical System One response")}</p>
         <p>{t("History stays in this checkout")}</p>
      </footer>
    </main>
  );
}
