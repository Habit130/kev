"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Activity,
  ArrowDownToLine,
  ArrowRightLeft,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  FileInput,
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

function safeError(value: unknown): string {
  return value instanceof Error ? value.message : "The workbench operation did not complete.";
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
    throw new Error(message);
  }
  return data;
}

async function fetchSnapshot(): Promise<WorkbenchSnapshot> {
  const response = await fetch("/api/workbench", { cache: "no-store" });
  const data: unknown = await response.text().then((text) => parseJson(text)).catch(() => null);
  if (!response.ok || !isJsonObject(data) || !Array.isArray(data.templates) || !Array.isArray(data.history)) {
    const detail = isJsonObject(data) && isJsonObject(data.error) && typeof data.error.message === "string" ? data.error.message : "The local workbench data could not be loaded.";
    throw new Error(detail);
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

function displayTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function Workbench() {
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot | null>(null);
  const [projectDescription, setProjectDescription] = useState("");
  const [initialLoadError, setInitialLoadError] = useState<string | null>(null);
  const [stateMode, setStateMode] = useState<"text" | "json">("text");
  const [stateText, setStateText] = useState("");
  const [questions, setQuestions] = useState<JsonObject>(initialQuestions);
  const [templateId, setTemplateId] = useState("");
  const [taskId, setTaskId] = useState("support-review");
  const [taskName, setTaskName] = useState("支持请求");
  const [templateDescription, setTemplateDescription] = useState("");
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    fetchSnapshot().then((next) => {
      if (!current) return;
      setSnapshot(next);
      setProjectDescription(next.settings.projectDescription ?? "");
      const first = next.templates[0];
      if (first) {
        const draft = templateDraft(first);
        setTemplateId(draft.id);
        setTaskId(draft.taskId);
        setTaskName(draft.name);
        setTemplateDescription(draft.description);
        setQuestions(draft.questions);
      }
      setInitialLoadError(null);
    }).catch((error: unknown) => {
      if (current) setInitialLoadError(safeError(error));
    });
    return () => { current = false; };
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", snapshot?.settings.theme === "dark");
    document.documentElement.classList.toggle("light", snapshot?.settings.theme !== "dark");
  }, [snapshot?.settings.theme]);

  const selectedTemplate = snapshot?.templates.find((template) => template.id === templateId) ?? null;
  const displayedRecord = snapshot?.history.find((record) => record.id === selectedHistoryId) ?? null;
  const activeModel = snapshot?.runtime.identity?.modelId;
  const modelReadyForSelection = snapshot?.runtime.state === "ready" && activeModel === snapshot.settings.selectedModel;

  const questionValidationError = useMemo(() => {
    try {
      validateQuestions(questions);
      return null;
    } catch (error) {
      return safeError(error);
    }
  }, [questions]);

  const stateValidationError = useMemo(() => {
    if (stateMode !== "json" || stateText.length === 0) return null;
    try {
      parseJson(stateText);
      return null;
    } catch (error) {
      return safeError(error);
    }
  }, [stateMode, stateText]);

  const isRunDisabled = !snapshot || !modelReadyForSelection || pendingAction !== null || stateText.length === 0 || !!questionValidationError || !!stateValidationError || !!editorError;

  async function refreshSnapshot(): Promise<WorkbenchSnapshot | null> {
    try {
      const next = await fetchSnapshot();
      setSnapshot(next);
      setProjectDescription(next.settings.projectDescription ?? "");
      setInitialLoadError(null);
      return next;
    } catch (error) {
      setOperationError(safeError(error));
      return null;
    }
  }

  function acceptSnapshot(value: unknown): WorkbenchSnapshot | null {
    if (!isJsonObject(value)) return null;
    const candidate = isJsonObject(value.snapshot) ? value.snapshot : value;
    if (!Array.isArray(candidate.templates) || !Array.isArray(candidate.history) || !isJsonObject(candidate.settings)) return null;
    const next = candidate as unknown as WorkbenchSnapshot;
    setSnapshot(next);
    setProjectDescription(next.settings.projectDescription ?? "");
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
      setOperationError(safeError(error));
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
    setNotice("Template loaded into the editor. The resident model was not changed.");
  }

  function newTemplate() {
    setTemplateId("");
    setTaskId("new-task");
    setTaskName("New task");
    setTemplateDescription("");
    setQuestions(initialQuestions());
    setEditorError(null);
    setSelectedHistoryId(null);
    setNotice("New editable task draft. Save it to keep the template.");
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
      if (saved) setTemplateId(saved.id);
      setNotice("Template saved in project-local workbench storage.");
    }
  }

  async function deleteCurrentTemplate() {
    if (!selectedTemplate || !window.confirm(`Delete the saved template “${selectedTemplate.name}”? Run history will remain.`)) return;
    const data = await performOperation("delete-template", { id: selectedTemplate.id });
    if (data && isJsonObject(data) && Array.isArray(data.templates)) {
      const next = data as unknown as WorkbenchSnapshot;
      const first = next.templates[0];
      if (first) chooseTemplate(first);
      else newTemplate();
      setNotice("Template deleted. Existing run snapshots were kept.");
    }
  }

  async function updatePreference(key: "selectedModel" | "exportModel" | "theme" | "projectDescription", value: string) {
    const nextValue = key === "selectedModel" || key === "exportModel" ? value as ModelId : value;
    await performOperation("settings", { settings: { [key]: nextValue } as JsonObject });
  }

  async function loadSelectedModel() {
    if (!snapshot) return;
    if (snapshot.runtime.state === "ready" && activeModel !== snapshot.settings.selectedModel) {
      if (!window.confirm(`Stop ${modelChoice(activeModel as ModelId).label} and load ${modelChoice(snapshot.settings.selectedModel).label}? Only one model can be resident.`)) return;
      await performOperation("switch", { model: snapshot.settings.selectedModel, confirmRelease: true });
      return;
    }
    await performOperation("load", { model: snapshot.settings.selectedModel });
  }

  async function stopModel() {
    if (!snapshot || !window.confirm("Stop the workbench-owned model and release its exclusive local slot?")) return;
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
      : submittedPayload(stateMode, stateText, questions, taskId, taskName);
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
      setRunError(safeError(error));
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
    setQuestions(cloneJson(record.questions));
    setTaskId(record.taskId);
    setTaskName(record.taskName);
    setTemplateDescription("");
    setTemplateId("");
    setEditorError(null);
    setNotice("Saved request snapshot restored as a draft. It has not been submitted.");
  }

  async function deleteRun(record: HistoryRecord) {
    if (!window.confirm(`Delete this ${record.status} run from local history?`)) return;
    const data = await performOperation("delete-history", { id: record.id });
    if (data) {
      if (selectedHistoryId === record.id) setSelectedHistoryId(null);
      setNotice("Run history record deleted from the project.");
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
        const first = next.templates[0];
        if (first) chooseTemplate(first);
        setNotice(`Imported ${next.templates.length} task template${next.templates.length === 1 ? "" : "s"}. No model was loaded or switched.`);
      }
    } catch (error) {
      setOperationError(safeError(error));
      void refreshSnapshot();
    } finally {
      setPendingAction(null);
    }
  }

  async function exportConfiguration() {
    const data = await performOperation("export", { model: snapshot?.settings.exportModel ?? "kev-4b" });
    if (data && isJsonObject(data) && typeof data.file === "string") setNotice(`Task configuration exported to .local/playground/workbench/${data.file}`);
  }

  if (initialLoadError && !snapshot) {
    return (
      <main className="mx-auto flex min-h-svh w-full max-w-lg flex-col items-center justify-center px-6 text-center">
        <CircleHelp className="size-8 text-blue-600" />
        <h1 className="mt-4 text-2xl font-semibold">本地模型工作台</h1>
        <p role="alert" className="mt-2 text-sm text-muted-foreground">{initialLoadError}</p>
        <Button className="mt-5" onClick={() => { setInitialLoadError(null); void refreshSnapshot(); }}>Retry</Button>
      </main>
    );
  }

  if (!snapshot) {
    return (
      <main className="mx-auto flex min-h-svh w-full max-w-5xl flex-col px-5 py-6 sm:px-8">
        <div className="flex items-center gap-3"><span className="size-9 animate-pulse rounded-xl bg-blue-100 dark:bg-blue-950" /><div><p className="text-sm font-semibold">Kev local workbench</p><p className="text-xs text-muted-foreground">Loading project-owned templates and history…</p></div></div>
        <div className="mt-8 grid gap-4 lg:grid-cols-[230px_1fr_1fr]" aria-hidden="true">
          <div className="h-72 animate-pulse rounded-2xl bg-muted" /><div className="h-96 animate-pulse rounded-2xl bg-muted" /><div className="h-96 animate-pulse rounded-2xl bg-muted" />
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-svh bg-background text-foreground">
      {/* Shell structure adapts shadcn/ui's dashboard-01 Sidebar/Inset pattern; the workbench controls and data views are Kev-specific. */}
      <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85">
        <div className="mx-auto flex max-w-[1720px] flex-wrap items-center justify-between gap-x-5 gap-y-3 px-4 py-3 sm:px-6 xl:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm shadow-blue-950/15"><WandSparkles className="size-4" /></div>
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold tracking-tight">本地模型工作台</h1>
              <p className="truncate text-[11px] text-muted-foreground">Kev · local inference, typed answers</p>
            </div>
            <Link href="/chess" className="ml-2 hidden rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:inline-flex">Chess</Link>
            <Link href="/classic" className="hidden rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:inline-flex">旧版 Playground</Link>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-2.5 py-1.5">
              <span className={`size-2 rounded-full ${snapshot.runtime.state === "ready" ? "bg-emerald-500" : snapshot.runtime.state === "recovery" ? "bg-amber-500" : "bg-muted-foreground/40"}`} aria-hidden="true" />
              <label className="sr-only" htmlFor="selected-model">Selected model</label>
              <select id="selected-model" aria-label="Selected model" value={snapshot.settings.selectedModel} disabled={pendingAction !== null} onChange={(event) => {
                if (isModelId(event.target.value)) void updatePreference("selectedModel", event.target.value);
              }} className="h-7 min-w-28 bg-transparent text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
                {(["kev-4b", "kev-0.8b"] as ModelId[]).map((model) => <option key={model} value={model}>{modelChoice(model).label}</option>)}
              </select>
              <div className="hidden max-w-48 border-l border-border pl-2 sm:block">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{snapshot.runtime.state === "ready" ? "Actually ready" : snapshot.runtime.state}</p>
                <p className="truncate text-[11px] font-medium" title={snapshot.runtime.identity?.checkpoint.source ?? snapshot.runtime.message}>
                  {snapshot.runtime.state === "ready" ? snapshot.runtime.identity?.checkpoint.source : snapshot.runtime.message}
                </p>
              </div>
            </div>
            <Button type="button" size="sm" disabled={pendingAction !== null || (snapshot.runtime.state === "ready" && activeModel === snapshot.settings.selectedModel)} onClick={() => void loadSelectedModel()}>
              {pendingAction === "load" || pendingAction === "switch" ? <Activity className="size-3.5 animate-pulse" /> : snapshot.runtime.state === "ready" ? <ArrowRightLeft className="size-3.5" /> : <Play className="size-3.5" />}
              {pendingAction === "load" || pendingAction === "switch" ? "Loading…" : snapshot.runtime.state === "ready" ? "Switch model" : "加载模型"}
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={pendingAction !== null || (snapshot.runtime.state === "unloaded")} onClick={() => void stopModel()}>
              <span className="sr-only">Stop or recover the resident model</span><ArrowDownToLine className="size-3.5" /> Stop
            </Button>
            <Button type="button" variant="ghost" size="icon" aria-label={snapshot.settings.theme === "dark" ? "Use light theme" : "Use dark theme"} disabled={pendingAction !== null} onClick={() => void updatePreference("theme", snapshot.settings.theme === "dark" ? "light" : "dark")}>
              {snapshot.settings.theme === "dark" ? <Sun /> : <Moon />}
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1720px] gap-4 px-4 py-5 sm:px-6 lg:grid-cols-[214px_minmax(0,1fr)] xl:grid-cols-[226px_minmax(0,1.08fr)_minmax(330px,0.92fr)] xl:gap-5 xl:px-8">
        <aside className="min-w-0 rounded-2xl border border-border bg-card p-3 shadow-sm shadow-black/[0.025] lg:row-span-2 xl:row-span-1" aria-label="Tasks and run history">
          <div className="flex items-center justify-between px-2 py-1">
            <div><p className="text-xs font-semibold uppercase tracking-[0.15em] text-muted-foreground">Workspace</p><p className="mt-1 truncate text-sm font-semibold">Local tasks</p></div>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Create new task template" onClick={newTemplate}><Plus /></Button>
          </div>
          <div className="mt-3 flex flex-col gap-1">
            {snapshot.templates.map((template) => (
              <button key={template.id} type="button" aria-pressed={template.id === templateId} onClick={() => chooseTemplate(template)} className={`group flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${template.id === templateId ? "bg-blue-50 text-blue-950 dark:bg-blue-950/60 dark:text-blue-100" : "text-foreground hover:bg-muted"}`}>
                <span className={`flex size-7 shrink-0 items-center justify-center rounded-md ${template.id === templateId ? "bg-white/80 text-blue-700 dark:bg-blue-900 dark:text-blue-200" : "bg-muted text-muted-foreground"}`}><FolderOpen className="size-3.5" /></span>
                <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{template.name}</span><span className="block truncate font-mono text-[10px] text-muted-foreground">{template.taskId}</span></span>
                <ChevronRight className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            ))}
            {snapshot.templates.length === 0 && <p className="px-2.5 py-3 text-xs leading-5 text-muted-foreground">No saved templates. Add a draft with the plus button.</p>}
          </div>

          <div className="mt-5 border-t border-border pt-4">
            <div className="flex items-center justify-between px-2">
              <div><p className="text-xs font-semibold uppercase tracking-[0.15em] text-muted-foreground">History</p><p className="mt-1 text-xs text-muted-foreground">{snapshot.history.length} saved runs</p></div>
              <Clock3 className="size-4 text-muted-foreground" />
            </div>
            <div className="mt-2 flex max-h-[330px] flex-col gap-1 overflow-y-auto pr-1">
              {snapshot.history.map((record) => (
                <button key={record.id} type="button" aria-pressed={record.id === selectedHistoryId} onClick={() => { setSelectedHistoryId(record.id); setRunError(null); }} className={`min-w-0 rounded-lg px-2.5 py-2 text-left transition-colors ${record.id === selectedHistoryId ? "bg-muted ring-1 ring-border" : "hover:bg-muted/70"}`}>
                  <span className="flex items-center justify-between gap-2"><span className="truncate text-xs font-medium">{record.taskName}</span><span className={`shrink-0 text-[9px] font-semibold uppercase ${record.status === "succeeded" ? "text-emerald-700 dark:text-emerald-300" : record.status === "failed" || record.status === "interrupted" ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}>{record.status}</span></span>
                  <span className="mt-1 block truncate text-[10px] text-muted-foreground">{displayTime(record.submittedAt)}</span>
                  <span className="mt-1 block truncate font-mono text-[9px] text-muted-foreground">{typeof record.modelIdentity.modelId === "string" ? record.modelIdentity.modelId : "identity unavailable"}</span>
                </button>
              ))}
              {snapshot.history.length === 0 && <p className="px-2.5 py-3 text-xs leading-5 text-muted-foreground">Submitted runs and failures appear here automatically. Nothing is stored in browser history.</p>}
            </div>
          </div>

          <div className="mt-4 border-t border-border pt-3 text-[10px] leading-4 text-muted-foreground">
            <p className="flex items-start gap-1.5"><TriangleAlert className="mt-0.5 size-3 shrink-0" /> Probabilities and scores are model outputs, not guarantees of business accuracy.</p>
          </div>
        </aside>

        <section className="min-w-0 rounded-2xl border border-border bg-card p-4 shadow-sm shadow-black/[0.025] sm:p-5" aria-labelledby="input-heading">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700 dark:text-blue-300">Workbench</p>
              <h2 id="input-heading" className="mt-1 text-lg font-semibold tracking-tight">Build one typed run</h2>
            </div>
            <span className="rounded-full border border-border bg-background px-2.5 py-1 text-[10px] text-muted-foreground">{questions ? Object.keys(questions).length : 0} questions · one shared state</span>
          </div>

          {snapshot.runtime.state !== "ready" && (
            <div role="status" className={`mt-4 flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs leading-5 ${snapshot.runtime.state === "recovery" ? "border-amber-300/70 bg-amber-50/60 dark:border-amber-950 dark:bg-amber-950/20" : "border-border bg-background"}`}>
              {snapshot.runtime.state === "recovery" ? <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-700" /> : <CircleHelp className="mt-0.5 size-3.5 shrink-0 text-blue-600" />}
              <span>{snapshot.runtime.message}. Load a model before submitting; selecting or editing a task does not load one.</span>
            </div>
          )}
          {snapshot.runtime.state === "ready" && !modelReadyForSelection && (
            <div role="status" className="mt-4 rounded-lg border border-amber-300/70 bg-amber-50/60 px-3 py-2.5 text-xs leading-5 dark:border-amber-950 dark:bg-amber-950/20">
              {modelChoice(snapshot.runtime.identity?.modelId as ModelId).label} is resident, while {modelChoice(snapshot.settings.selectedModel).label} is selected. Switch explicitly before running.
            </div>
          )}

          <div className="mt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label htmlFor="state-input" className="text-sm">State input <span className="font-normal text-muted-foreground">· one shared request</span></Label>
              <div className="inline-flex rounded-lg border border-border bg-background p-0.5" role="group" aria-label="State input mode">
                <button type="button" aria-pressed={stateMode === "text"} onClick={() => setStateMode("text")} className={`rounded-md px-2.5 py-1 text-[11px] ${stateMode === "text" ? "bg-blue-600 text-white" : "text-muted-foreground hover:text-foreground"}`}>Text</button>
                <button type="button" aria-pressed={stateMode === "json"} onClick={() => setStateMode("json")} className={`rounded-md px-2.5 py-1 text-[11px] ${stateMode === "json" ? "bg-blue-600 text-white" : "text-muted-foreground hover:text-foreground"}`}>JSON</button>
              </div>
            </div>
            <Textarea id="state-input" aria-label="State input" value={stateText} onChange={(event) => setStateText(event.target.value)} spellCheck={stateMode === "text"} className="mt-2 min-h-28 resize-y rounded-xl bg-background font-mono text-xs leading-5 shadow-none" placeholder={stateMode === "text" ? "Paste the exact text the model should read. Delimiter-like strings remain literal." : '{\n  "message": "Paste a JSON object or value"\n}'} aria-invalid={!!stateValidationError} />
            {stateMode === "text" && <p className="mt-1 text-[10px] text-muted-foreground">Text is submitted literally; the workbench does not trim, translate, or rewrite it.</p>}
            {stateValidationError && <p role="alert" className="mt-1 text-xs text-destructive">{stateValidationError}</p>}
          </div>

          <div className="mt-4 flex items-center justify-between gap-2">
            <div><p className="text-sm font-semibold">Questions</p><p className="mt-0.5 text-[10px] text-muted-foreground">Choice · Noul · Score</p></div>
            {selectedTemplate && <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => chooseTemplate(selectedTemplate)}>Reset to saved</Button>}
          </div>

          <div className="mt-3 max-h-[520px] overflow-y-auto pr-1">
            <WorkbenchQuestionEditor
              questions={questions}
              onChange={setQuestions}
              taskName={taskName}
              setTaskName={setTaskName}
              taskId={taskId}
              setTaskId={setTaskId}
              description={templateDescription}
              setDescription={setTemplateDescription}
              onValidationError={setEditorError}
            />
          </div>
          {questionValidationError && !editorError && <p role="alert" className="mt-2 text-xs text-destructive">{questionValidationError}</p>}

          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
            <Button type="button" size="sm" className="rounded-lg px-3" disabled={isRunDisabled} onClick={() => void runDraft()}>
              {pendingAction === "run" ? <Activity className="size-3.5 animate-pulse" /> : <Play className="size-3.5" />}
              {pendingAction === "run" ? "Running…" : "Run task"}
            </Button>
            <Button type="button" variant="outline" size="sm" className="rounded-lg" disabled={pendingAction !== null || !taskName.trim() || !taskId.trim() || !!questionValidationError || !!editorError} onClick={() => void saveCurrentTemplate()}>
              <Save className="size-3.5" /> {templateId ? "Update template" : "Save template"}
            </Button>
            {selectedTemplate && <Button type="button" variant="ghost" size="sm" className="rounded-lg text-muted-foreground hover:text-destructive" disabled={pendingAction !== null} onClick={() => void deleteCurrentTemplate()}><Trash2 className="size-3.5" /> Delete template</Button>}
            {taskName.trim() && <span className="ml-auto text-[10px] text-muted-foreground">Edits do not change saved runs.</span>}
          </div>
        </section>

        <section className="min-w-0 space-y-4 xl:col-start-3 xl:row-start-1" aria-label="Run results and task file tools">
          <WorkbenchResults record={displayedRecord} busy={pendingAction === "run"} error={runError} />

          {displayedRecord && (
            <div className="flex flex-wrap gap-2 rounded-xl border border-border bg-card p-3 shadow-sm shadow-black/[0.02]">
              <Button type="button" variant="outline" size="sm" className="h-8 rounded-lg" onClick={() => restoreRun(displayedRecord)}><ArrowDownToLine className="size-3.5" /> Restore to editor</Button>
              <Button type="button" variant="outline" size="sm" className="h-8 rounded-lg" disabled={!modelReadyForSelection || pendingAction !== null} onClick={() => void runDraft({
                stateMode: displayedRecord.stateMode,
                stateText: formatState(displayedRecord),
                questions: cloneJson(displayedRecord.questions),
                taskId: displayedRecord.taskId,
                taskName: displayedRecord.taskName,
              })}><Play className="size-3.5" /> Rerun snapshot</Button>
              <Button type="button" variant="ghost" size="sm" className="ml-auto h-8 rounded-lg text-muted-foreground hover:text-destructive" disabled={pendingAction !== null} onClick={() => void deleteRun(displayedRecord)}><Trash2 className="size-3.5" /> Delete run</Button>
            </div>
          )}

          <section className="rounded-2xl border border-border bg-card p-4 shadow-sm shadow-black/[0.025] sm:p-5" aria-labelledby="interop-heading">
            <div className="flex items-start justify-between gap-3">
              <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700 dark:text-blue-300">Portability</p><h2 id="interop-heading" className="mt-1 text-base font-semibold">Task configuration</h2></div>
              <FileOutput className="size-4 text-muted-foreground" />
            </div>
            <label className="mt-3 block text-xs font-medium text-muted-foreground">
              Project description <span className="font-normal">(optional export metadata)</span>
              <Input aria-label="Project description" value={projectDescription} maxLength={1000} onBlur={(event) => {
                if (event.target.value !== (snapshot.settings.projectDescription ?? "")) void updatePreference("projectDescription", event.target.value);
              }} onChange={(event) => setProjectDescription(event.target.value)} className="mt-1 h-9 bg-background text-xs shadow-none" placeholder="A short description for consumer scripts" />
            </label>
            <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              <label className="text-xs font-medium text-muted-foreground">
                Export model
                <select aria-label="Export model" value={snapshot.settings.exportModel} disabled={pendingAction !== null} onChange={(event) => {
                  if (isModelId(event.target.value)) void updatePreference("exportModel", event.target.value);
                }} className="mt-1 h-9 w-full rounded-lg border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {(["kev-4b", "kev-0.8b"] as ModelId[]).map((model) => <option key={model} value={model}>{modelChoice(model).label}</option>)}
                </select>
              </label>
              <Button type="button" variant="outline" size="sm" className="mt-auto h-9 rounded-lg" disabled={pendingAction !== null || snapshot.templates.length === 0} onClick={() => void exportConfiguration()}><FileOutput className="size-3.5" /> Export</Button>
            </div>
            <label className="mt-3 flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-background px-3 py-2.5 text-xs font-medium transition-colors hover:border-blue-400 hover:bg-blue-50/50 dark:hover:bg-blue-950/20">
              <FileInput className="size-3.5 text-blue-700 dark:text-blue-300" /> Import kev-project-tasks/1
              <input aria-label="Import task configuration" type="file" accept="application/json,.json" className="sr-only" disabled={pendingAction !== null} onChange={(event) => {
                void importFile(event.target.files?.[0]);
                event.currentTarget.value = "";
              }} />
            </label>
            {notice?.includes("exported to") && <p role="status" className="mt-2 break-all rounded-lg bg-emerald-50 px-3 py-2 text-[11px] text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"><Check className="mr-1 inline size-3" />{notice}</p>}
            <p className="mt-2 text-[10px] leading-4 text-muted-foreground">Imports replace the saved template list only after full validation. Exports contain logical model IDs and task definitions, never state, history, or machine paths.</p>
          </section>

          {operationError && <div role="alert" className="flex gap-2 rounded-xl border border-destructive/25 bg-destructive/5 p-3 text-xs leading-5 text-destructive"><TriangleAlert className="mt-0.5 size-3.5 shrink-0" />{operationError}</div>}
          {notice && !notice.includes("exported to") && <div role="status" className="flex gap-2 rounded-xl border border-blue-200 bg-blue-50/60 p-3 text-xs leading-5 text-blue-950 dark:border-blue-950 dark:bg-blue-950/30 dark:text-blue-100"><Check className="mt-0.5 size-3.5 shrink-0" />{notice}</div>}
        </section>
      </div>

      <footer className="mx-auto flex max-w-[1720px] flex-wrap items-center justify-between gap-2 px-4 pb-5 text-[10px] text-muted-foreground sm:px-6 xl:px-8">
        <p className="flex items-center gap-1.5"><Activity className="size-3" /> One state, isolated typed questions, canonical System One response</p>
        <p>History stays in this checkout · <Link href="/classic" className="underline underline-offset-2 hover:text-foreground">Open classic Playground</Link></p>
      </footer>
    </main>
  );
}
