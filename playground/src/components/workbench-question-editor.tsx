"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Code2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cloneJson, deleteOrdered, isJsonObject, orderedEntries, orderedObject, parseJson, setOrdered, stringifyJson, type JsonObject, type JsonValue } from "@/lib/workbench/json";
import { validateQuestions } from "@/lib/workbench/tasks";

type Props = {
  questions: JsonObject;
  onChange: (questions: JsonObject) => void;
  taskName: string;
  setTaskName: (value: string) => void;
  taskId: string;
  setTaskId: (value: string) => void;
  description: string;
  setDescription: (value: string) => void;
  onValidationError: (message: string | null) => void;
};

const fieldClass = "mt-1 h-9 rounded-lg bg-background text-sm shadow-none";
const miniButtonClass = "h-7 rounded-md px-2 text-xs";

function jsonField(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : stringifyJson(value, 2);
}

function nextId(existing: string[], prefix: string): string {
  let suffix = existing.length + 1;
  while (existing.includes(`${prefix}_${suffix}`)) suffix += 1;
  return `${prefix}_${suffix}`;
}

function defaultQuestion(type: string): JsonObject {
  if (type === "noul") return orderedObject([["type", "noul"], ["instructions", ""]]);
  if (type === "score") return orderedObject([["type", "score"], ["instructions", ""], ["criteria", ["Level 1", "Level 2"]]]);
  return orderedObject([["type", "choice"], ["instructions", ""], ["criteria", orderedObject([["option_a", "Option A"], ["option_b", "Option B"]])]]);
}

export function WorkbenchQuestionEditor({
  questions,
  onChange,
  taskName,
  setTaskName,
  taskId,
  setTaskId,
  description,
  setDescription,
  onValidationError,
}: Props) {
  const [advanced, setAdvanced] = useState(false);
  const [advancedText, setAdvancedText] = useState("");
  const [editorError, setEditorError] = useState<string | null>(null);
  const entries = orderedEntries(questions);

  function showEditorError(message: string | null) {
    setEditorError(message);
    onValidationError(message);
  }

  function replaceQuestion(id: string, question: JsonObject) {
    onChange(setOrdered(questions, id, question));
    showEditorError(null);
  }

  function renameQuestion(oldId: string, newId: string) {
    if (!newId.trim()) {
      showEditorError("Question IDs cannot be empty.");
      return;
    }
    if (newId !== oldId && Object.prototype.hasOwnProperty.call(questions, newId)) {
      showEditorError(`Question ID “${newId}” is already used.`);
      return;
    }
    onChange(orderedObject(orderedEntries(questions).map(([id, question]) => [id === oldId ? newId : id, question])));
    showEditorError(null);
  }

  function addQuestion() {
    const id = nextId(entries.map(([key]) => key), "question");
    onChange(setOrdered(questions, id, defaultQuestion("choice")));
    showEditorError(null);
  }

  function changeType(id: string, type: string) {
    const question = cloneJson(questions[id] as JsonObject);
    const next = defaultQuestion(type);
    if ("instructions" in question) next.instructions = question.instructions;
    replaceQuestion(id, next);
  }

  function changeInstructions(id: string, text: string) {
    const question = cloneJson(questions[id] as JsonObject);
    replaceQuestion(id, setOrdered(question, "instructions", text));
  }

  function addChoiceOption(questionId: string, question: JsonObject) {
    const criteria = isJsonObject(question.criteria) ? question.criteria : orderedObject([]);
    const id = nextId(Object.keys(criteria), "option");
    replaceQuestion(questionId, setOrdered(question, "criteria", setOrdered(criteria, id, "")));
  }

  function renameOption(questionId: string, question: JsonObject, oldId: string, newId: string) {
    const criteria = isJsonObject(question.criteria) ? question.criteria : orderedObject([]);
    if (!newId.trim()) {
      showEditorError("Option IDs cannot be empty.");
      return;
    }
    if (newId !== oldId && Object.prototype.hasOwnProperty.call(criteria, newId)) {
      showEditorError(`Option ID “${newId}” is already used in this question.`);
      return;
    }
    const nextCriteria = orderedObject(orderedEntries(criteria).map(([id, value]) => [id === oldId ? newId : id, value]));
    replaceQuestion(questionId, setOrdered(question, "criteria", nextCriteria));
  }

  function changeOptionValue(questionId: string, question: JsonObject, optionId: string, value: string) {
    const criteria = isJsonObject(question.criteria) ? question.criteria : orderedObject([]);
    replaceQuestion(questionId, setOrdered(question, "criteria", setOrdered(criteria, optionId, value)));
  }

  function addScoreLevel(questionId: string, question: JsonObject) {
    const levels = Array.isArray(question.criteria) ? question.criteria : [];
    replaceQuestion(questionId, setOrdered(question, "criteria", [...levels, `Level ${levels.length + 1}`]));
  }

  function moveScoreLevel(questionId: string, question: JsonObject, index: number, direction: -1 | 1) {
    const levels = Array.isArray(question.criteria) ? [...question.criteria] : [];
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= levels.length) return;
    [levels[index], levels[nextIndex]] = [levels[nextIndex], levels[index]];
    replaceQuestion(questionId, setOrdered(question, "criteria", levels));
  }

  function editNoulCriterion(questionId: string, question: JsonObject, key: "true" | "false", value: string) {
    const existing = isJsonObject(question.criteria) ? question.criteria : orderedObject([]);
    const criteria = value.length === 0 ? deleteOrdered(existing, key) : setOrdered(existing, key, value);
    const next = Object.keys(criteria).length === 0 ? deleteOrdered(question, "criteria") : setOrdered(question, "criteria", criteria);
    replaceQuestion(questionId, next);
  }

  function applyAdvanced() {
    try {
      const parsed = parseJson(advancedText);
      if (!isJsonObject(parsed)) throw new Error("Questions must be a JSON object.");
      validateQuestions(parsed);
      onChange(parsed);
      setAdvanced(false);
      showEditorError(null);
    } catch (error) {
      showEditorError(error instanceof Error ? error.message : "Questions JSON is invalid.");
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="rounded-xl border border-border bg-card p-4 shadow-sm shadow-black/[0.02]">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Task template</p>
            <p className="mt-1 text-sm text-muted-foreground">Edits stay in the draft until saved.</p>
          </div>
          <Button type="button" variant="outline" size="sm" className={miniButtonClass} onClick={() => {
            setAdvancedText(stringifyJson(questions, 2));
            setAdvanced((open) => !open);
            showEditorError(null);
          }} aria-expanded={advanced}>
            <Code2 className="size-3.5" /> {advanced ? "Close JSON editor" : "Advanced JSON"}
          </Button>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="min-w-0 text-xs font-medium text-muted-foreground">
            Template name
            <Input aria-label="Template name" value={taskName} onChange={(event) => setTaskName(event.target.value)} className={fieldClass} maxLength={200} />
          </label>
          <label className="min-w-0 text-xs font-medium text-muted-foreground">
            Export task ID
            <Input aria-label="Export task ID" value={taskId} onChange={(event) => setTaskId(event.target.value)} className={`${fieldClass} font-mono`} maxLength={200} />
          </label>
          <label className="min-w-0 text-xs font-medium text-muted-foreground sm:col-span-2">
            Description <span className="font-normal">(optional)</span>
            <Input aria-label="Template description" value={description} onChange={(event) => setDescription(event.target.value)} className={fieldClass} maxLength={1000} />
          </label>
        </div>
      </div>

      {advanced ? (
        <section className="rounded-xl border border-blue-300/70 bg-card p-4 shadow-sm dark:border-blue-900" aria-label="Advanced questions JSON editor">
          <Label htmlFor="advanced-questions" className="text-sm">Questions JSON <span className="font-normal text-muted-foreground">(preserves structured values and ordering)</span></Label>
          <Textarea id="advanced-questions" value={advancedText} onChange={(event) => setAdvancedText(event.target.value)} className="mt-2 min-h-72 resize-y font-mono text-xs leading-5" spellCheck={false} aria-invalid={!!editorError} />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">Duplicate JSON keys are rejected; option and score order is retained.</p>
            <Button type="button" onClick={applyAdvanced}>Apply JSON</Button>
          </div>
        </section>
      ) : (
        <div className="flex min-w-0 flex-col gap-3">
          {entries.length === 0 && (
            <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              No questions yet. Add a typed question to start building this task.
            </div>
          )}
          {entries.map(([id, rawQuestion], index) => {
            const question = rawQuestion as JsonObject;
            const type = typeof question.type === "string" ? question.type : "choice";
            const criteria = isJsonObject(question.criteria) ? question.criteria : orderedObject([]);
            const levels = Array.isArray(question.criteria) ? question.criteria : [];
            const instructions = jsonField(question.instructions as JsonValue | undefined);
            const structuredInstructions = question.instructions !== undefined && question.instructions !== null && typeof question.instructions !== "string";
            return (
              <section key={id} className="min-w-0 rounded-xl border border-border bg-card p-4 shadow-sm shadow-black/[0.02]" aria-label={`Question ${id}`}>
                <div className="flex flex-wrap items-start gap-2">
                  <span className="mt-2 flex size-6 shrink-0 items-center justify-center rounded-full bg-blue-50 text-[11px] font-semibold text-blue-700 dark:bg-blue-950 dark:text-blue-200">{String(index + 1).padStart(2, "0")}</span>
                  <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-[minmax(0,1fr)_130px]">
                    <label className="min-w-0 text-xs font-medium text-muted-foreground">
                      Question ID
                      <Input aria-label={`Question ${id} ID`} value={id} onChange={(event) => renameQuestion(id, event.target.value)} className={`${fieldClass} font-mono`} />
                    </label>
                    <label className="text-xs font-medium text-muted-foreground">
                      Type
                      <select aria-label={`Question ${id} type`} value={type} onChange={(event) => changeType(id, event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        <option value="choice">Choice</option>
                        <option value="noul">Noul</option>
                        <option value="score">Score</option>
                      </select>
                    </label>
                  </div>
                  <Button type="button" variant="ghost" size="icon-sm" className="mt-5 text-muted-foreground hover:text-destructive" aria-label={`Remove question ${id}`} onClick={() => onChange(deleteOrdered(questions, id))}>
                    <Trash2 />
                  </Button>
                </div>

                <label className="mt-3 block text-xs font-medium text-muted-foreground">
                  Instructions {structuredInstructions && <span className="font-normal">(structured value; edit in Advanced JSON)</span>}
                  <Textarea aria-label={`Question ${id} instructions`} value={instructions} onChange={(event) => changeInstructions(id, event.target.value)} disabled={structuredInstructions} className="mt-1 min-h-16 resize-y bg-background text-sm shadow-none disabled:opacity-75" placeholder="What should the model decide?" />
                </label>

                {type === "choice" && (
                  <div className="mt-4 rounded-lg bg-muted/45 p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <p className="text-xs font-semibold">Choice options <span className="font-normal text-muted-foreground">(order is preserved)</span></p>
                      <Button type="button" variant="outline" size="sm" className={miniButtonClass} onClick={() => addChoiceOption(id, question)}><Plus /> Add option</Button>
                    </div>
                    <div className="flex flex-col gap-2">
                      {orderedEntries(criteria).map(([optionId, description], optionIndex) => (
                        <div key={optionId} className="grid min-w-0 gap-2 sm:grid-cols-[minmax(8rem,0.8fr)_minmax(0,1.2fr)_30px]">
                          <Input aria-label={`Question ${id} option ${optionId} ID`} value={optionId} onChange={(event) => renameOption(id, question, optionId, event.target.value)} className="h-8 min-w-0 bg-background font-mono text-xs shadow-none" />
                          <Input aria-label={`Question ${id} option ${optionId} description`} value={jsonField(description)} onChange={(event) => changeOptionValue(id, question, optionId, event.target.value)} className="h-8 min-w-0 bg-background text-xs shadow-none" placeholder="Option description (optional)" />
                          <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove option ${optionId}`} onClick={() => replaceQuestion(id, setOrdered(question, "criteria", deleteOrdered(criteria, optionId)))}><Trash2 className="size-3.5" /></Button>
                          {description !== null && typeof description !== "string" && <span className="sm:col-span-2 text-[11px] text-blue-700 dark:text-blue-300">Structured description shown as JSON; use Advanced JSON for nested edits. Order {optionIndex + 1} is retained.</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {type === "noul" && (
                  <div className="mt-4 rounded-lg bg-muted/45 p-3">
                    <p className="mb-2 text-xs font-semibold">Optional criteria <span className="font-normal text-muted-foreground">(leave blank to omit)</span></p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {(["true", "false"] as const).map((key) => (
                        <label key={key} className="text-xs font-medium text-muted-foreground">
                          {key === "true" ? "Yes (true)" : "No (false)"}
                          <Input aria-label={`Question ${id} ${key} criteria`} value={jsonField(criteria[key])} onChange={(event) => editNoulCriterion(id, question, key, event.target.value)} className="mt-1 h-8 bg-background text-xs shadow-none" placeholder="Optional definition" />
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {type === "score" && (
                  <div className="mt-4 rounded-lg bg-muted/45 p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <p className="text-xs font-semibold">Ordered score levels</p>
                      <Button type="button" variant="outline" size="sm" className={miniButtonClass} onClick={() => addScoreLevel(id, question)}><Plus /> Add level</Button>
                    </div>
                    <div className="flex flex-col gap-2">
                      {levels.map((level, levelIndex) => (
                        <div key={levelIndex} className="grid min-w-0 grid-cols-[30px_minmax(0,1fr)_30px_30px] items-center gap-2">
                          <span className="text-center font-mono text-[11px] text-muted-foreground">{levelIndex}</span>
                          <Input aria-label={`Question ${id} score level ${levelIndex}`} value={jsonField(level)} onChange={(event) => {
                            const next = [...levels];
                            next[levelIndex] = event.target.value;
                            replaceQuestion(id, setOrdered(question, "criteria", next));
                          }} className="h-8 min-w-0 bg-background text-xs shadow-none" />
                          <Button type="button" variant="ghost" size="icon-xs" aria-label={`Move score level ${levelIndex} up`} disabled={levelIndex === 0} onClick={() => moveScoreLevel(id, question, levelIndex, -1)}><ChevronUp className="size-3.5" /></Button>
                          <Button type="button" variant="ghost" size="icon-xs" aria-label={`Move score level ${levelIndex} down`} disabled={levelIndex === levels.length - 1} onClick={() => moveScoreLevel(id, question, levelIndex, 1)}><ChevronDown className="size-3.5" /></Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </section>
            );
          })}
          <Button type="button" variant="outline" className="h-10 border-dashed bg-transparent" onClick={addQuestion}><Plus /> Add question</Button>
        </div>
      )}

      {editorError && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{editorError}</p>}
    </div>
  );
}
