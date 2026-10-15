"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useWorkbenchLocale } from "@/components/workbench-locale";
import type { Copy } from "@/lib/workbench/translations";
import { api, PRESETS, type PermuteResponse, type Question, type SystemOneRequest, type SystemOneResponse } from "@/lib/kev";
import { AnswerCard } from "@/components/answer-card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

const pretty = (v: unknown) => JSON.stringify(v, null, 2);

function parseState(s: string) {
  const t = s.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try { return JSON.parse(t); } catch { /* treat as plain text */ }
  }
  return s;
}

type ModelInfo = { run: string; base: string } | { error: string } | null;

export function Playground() {
  const { t, number } = useWorkbenchLocale();
  const [presetIdx, setPresetIdx] = useState(0);
  const [stateText, setStateText] = useState(() => typeof PRESETS[0].state === "string" ? PRESETS[0].state : pretty(PRESETS[0].state));
  const [questionsText, setQuestionsText] = useState(() => pretty(PRESETS[0].questions));
  const [result, setResult] = useState<SystemOneResponse | null>(null);
  const [separate, setSeparate] = useState<SystemOneResponse | null>(null);
  const [permute, setPermute] = useState<{ question: string; data: PermuteResponse } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<ModelInfo>(null);
  const [tab, setTab] = useState("answers");

  useEffect(() => {
    api.models().then((m) => setModel(m.models[0])).catch((e: Error) => setModel({ error: e.message }));
  }, []);

  const parsed = useMemo<{ req?: SystemOneRequest; err?: string }>(() => {
    try {
      const questions = JSON.parse(questionsText) as Record<string, Question>;
      return { req: { state: parseState(stateText), model: "kev-latest", questions } };
    } catch (e) { return { err: (e as Error).message }; }
  }, [stateText, questionsText]);

  const choiceIds = useMemo(
    () => (parsed.req ? Object.entries(parsed.req.questions).filter(([, q]) => q.type === "choice" && Object.keys(q.criteria).length >= 2).map(([id]) => id) : []),
    [parsed.req],
  );

  function loadPreset(i: number) {
    const p = PRESETS[i];
    setPresetIdx(i);
    setStateText(typeof p.state === "string" ? p.state : pretty(p.state));
    setQuestionsText(pretty(p.questions));
    setResult(null); setSeparate(null); setPermute(null); setError(null); setTab("answers");
  }

  async function run<T>(label: string, fn: () => Promise<T>, done: (t: T) => void) {
    if (!parsed.req) return;
    setBusy(label); setError(null);
    try { done(await fn()); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }

  const onRun = () => run("run", () => api.systemOne(parsed.req!), (r) => { setResult(r); setSeparate(null); setPermute(null); setTab("answers"); });
  const onSeparate = () => run("separate", async () => ({ packed: await api.systemOne(parsed.req!), sep: await api.separate(parsed.req!) }), ({ packed, sep }) => { setResult(packed); setSeparate(sep); setTab("answers"); });
  const onPermute = (qid: string) => run("permute", () => api.permute(parsed.req!, qid, 6), (d) => { setPermute({ question: qid, data: d }); setTab("permute"); });

  const onRunRef = useRef(onRun);
  useEffect(() => { onRunRef.current = onRun; });   // latest handler for the global shortcut, without re-subscribing
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onRunRef.current(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const maxDiff = useMemo(() => {
    if (!result || !separate) return null;
    let m = 0;
    for (const [id, a] of Object.entries(result.answers)) {
      const b = separate.answers[id];
      if (!b) continue;
      if (a.type === "noul" && b.type === "noul") m = Math.max(m, Math.abs(a.noul - b.noul));
      else if ("probabilities" in a && "probabilities" in b) for (const k of Object.keys(a.probabilities)) m = Math.max(m, Math.abs(a.probabilities[k] - (b.probabilities[k] ?? 0)));
    }
    return m;
  }, [result, separate]);

  const nQ = result ? Object.keys(result.answers).length : 0;

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-6xl flex-col px-6 pt-8 md:px-10">
      <header className="flex w-full min-w-0 flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <nav className="flex items-baseline gap-4 text-sm">
          <h1 className="font-medium tracking-tight">kev</h1>
          <Link href="/chess" className="text-muted-foreground hover:text-foreground">{t("chess")}</Link>
        </nav>
        <p className="min-w-0 max-w-full break-all text-sm text-muted-foreground">
          {model === null ? t("connecting") : "error" in model ? t("backend unavailable: {detail}", { detail: model.error }) : <><span className="font-mono">{model.base}</span> · <span className="font-mono">{model.run}</span></>}
        </p>
      </header>

      <div className="mt-10 max-w-2xl">
        <h2 className="text-2xl font-medium tracking-tight">{t("Typed questions in, probabilities out, one forward pass.")}</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {t("The state is read once. Every question is answered in parallel and cannot see the others. Each answer is a distribution over the options you supplied.")}
        </p>
      </div>

      <nav aria-label={t("Presets")} className="mt-8 flex flex-wrap gap-x-5 gap-y-1 text-sm">
        {PRESETS.map((p, i) => (
          <button key={p.name} type="button" onClick={() => loadPreset(i)} aria-current={i === presetIdx ? "true" : undefined}
            className={`border-b pb-0.5 transition-colors ${i === presetIdx ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
            {t(p.name as Copy)}
          </button>
        ))}
      </nav>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{t(PRESETS[presetIdx].blurb as Copy)}</p>

      <div className="mt-8 grid gap-10 pb-28 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          <div className="flex flex-col gap-2">
            <Label htmlFor="state">{t("State")} <span className="font-normal text-muted-foreground">{t("(text, or a JSON object or array)")}</span></Label>
            <Textarea id="state" value={stateText} onChange={(e) => setStateText(e.target.value)} className="min-h-28 font-mono text-sm leading-6 shadow-none" />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="questions">{t("Questions")} <span className="font-normal text-muted-foreground">{t("(noul, choice, score)")}</span></Label>
            <Textarea id="questions" value={questionsText} onChange={(e) => setQuestionsText(e.target.value)} className="min-h-72 font-mono text-sm leading-6 shadow-none" aria-invalid={!!parsed.err} />
            {parsed.err && <p role="alert" className="text-sm text-destructive">{parsed.err}</p>}
          </div>
        </div>

        <div className="flex min-w-0 flex-col">
          <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <TabsList variant="line" className="h-auto p-0">
                <TabsTrigger value="answers" className="px-0 text-sm">{t("Answers")}</TabsTrigger>
                <TabsTrigger value="permute" disabled={!permute} className="px-0 text-sm">{t("Permutation")}</TabsTrigger>
                <TabsTrigger value="raw" disabled={!result} className="px-0 text-sm">JSON</TabsTrigger>
              </TabsList>
              {result && (
                <p className="text-xs tabular-nums text-muted-foreground">
                  {t("{latency} ms · {tokens} input tokens · {count} {unit}", { latency: number(result.latency_ms, 0), tokens: number(result.usage.input_tokens), count: number(nQ), unit: t(nQ === 1 ? "question" : "questions") })}
                </p>
              )}
            </div>

            <TabsContent value="answers" className="mt-5">
              {!result && (
                <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">{t("Run the request to see one distribution per question.")}</p>
              )}
              {result && separate && (
                <p className="mb-3 rounded-lg border border-border bg-muted px-4 py-2.5 text-sm leading-6">
                  {t("One request with {count} questions: {latency} ms, {tokens} tokens.", { count: number(nQ), latency: number(result.latency_ms, 0), tokens: number(result.usage.input_tokens) })}{" "}
                  {t("{count} separate requests: {latency} ms, {tokens} tokens.", { count: number(nQ), latency: number(separate.latency_ms, 0), tokens: number(separate.usage.input_tokens) })}{" "}
                  {t("Largest probability difference between the two: {diff}.", { diff: maxDiff?.toFixed(4) ?? "" })}{" "}
                  {maxDiff !== null && maxDiff < 0.011 ? t("Sibling questions did not change any answer.") : t("This exceeds rounding; check the request.")}
                </p>
              )}
              <div className="flex flex-col gap-2">
                {result && Object.entries(result.answers).map(([id, a]) => (
                  <AnswerCard key={id} id={id} question={parsed.req?.questions[id]} answer={a} compare={separate?.answers[id]} />
                ))}
              </div>
            </TabsContent>

            <TabsContent value="permute" className="mt-5">
              {permute && (
                <div className="rounded-lg border border-border bg-card p-5">
                  <p className="text-sm leading-6">
                    {t("{id} under {count} option orders.", { id: permute.question, count: number(permute.data.runs.length) })}{" "}
                    {permute.data.argmax_stable ? t("The top option is the same in every order.") : t("The top option changes between orders.")}
                  </p>
                  <div className="mt-4 overflow-x-auto">
                    <table className="w-full text-sm">
                      <caption className="sr-only">{t("Probability of each option under different option orders")}</caption>
                      <thead>
                        <tr className="border-b border-border text-left text-muted-foreground">
                          <th scope="col" className="py-2 pr-4 font-normal">{t("Order")}</th>
                          {Object.keys(permute.data.spread).map((k) => <th key={k} scope="col" className="py-2 pl-4 text-right font-mono font-normal">{k}</th>)}
                        </tr>
                      </thead>
                      <tbody className="tabular-nums">
                        {permute.data.runs.map((r, i) => (
                          <tr key={i} className="border-b border-border">
                            <th scope="row" className="py-2 pr-4 text-left font-normal text-muted-foreground" title={r.order.join(" → ")}>{r.order.map((o) => o.slice(0, 3)).join(" · ")}</th>
                            {Object.keys(permute.data.spread).map((k) => (
                              <td key={k} className={`py-2 pl-4 text-right ${r.choice === k ? "font-medium" : "text-muted-foreground"}`}>{r.probabilities[k].toFixed(2)}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr>
                          <th scope="row" className="py-2 pr-4 text-left font-normal text-muted-foreground">{t("Spread (max − min)")}</th>
                          {Object.entries(permute.data.spread).map(([k, s]) => <td key={k} className={`py-2 pl-4 text-right tabular-nums ${s > 0.1 ? "font-medium" : "text-muted-foreground"}`}>{s.toFixed(2)}</td>)}
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                  <p className="mt-3 text-sm leading-6 text-muted-foreground">{t("Each row is the same question with its options in a different order. A spread above 0.10 is shown in bold. The table scrolls inside this labelled region when it is wider than the page.")}</p>
                </div>
              )}
            </TabsContent>

            <TabsContent value="raw" className="mt-5">
              {result && (
                <div className="grid gap-4 xl:grid-cols-2">
                  <div className="rounded-lg border border-border bg-card p-5">
                    <p className="text-sm text-muted-foreground">{t("Request")}</p>
                    <pre className="mt-2 max-h-[36rem] overflow-auto font-mono text-xs leading-5">{pretty(parsed.req)}</pre>
                  </div>
                  <div className="rounded-lg border border-border bg-card p-5">
                    <p className="text-sm text-muted-foreground">{t("Response")}</p>
                    <pre className="mt-2 max-h-[36rem] overflow-auto font-mono text-xs leading-5">{pretty(result)}</pre>
                  </div>
                </div>
              )}
            </TabsContent>
          </Tabs>
        </div>
      </div>

      <div className="sticky bottom-0 z-10 mt-10 -mx-6 border-t border-border bg-background px-6 py-3 md:-mx-10 md:px-10">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={onRun} disabled={!parsed.req || !!busy} className="rounded-md">
              {busy === "run" ? t("Running") : t("Run")}
              <kbd className="ml-1 font-mono text-xs font-normal opacity-80">⌘↵</kbd>
            </Button>
            <Button variant="outline" onClick={onSeparate} disabled={!parsed.req || !!busy} className="rounded-md shadow-none" title={t("Answer every question in its own request, then compare with the packed answer")}>
              {busy === "separate" ? t("Comparing") : t("Packed vs separate")}
            </Button>
            {choiceIds.map((id) => (
              <Button key={id} variant="ghost" onClick={() => onPermute(id)} disabled={!!busy} className="rounded-md text-muted-foreground" title={t("Re-ask {id} under 6 option orders", { id })}>
                {busy === "permute" && permute?.question === id ? t("Permuting") : t("Permute")} <span className="font-mono">{id}</span>
              </Button>
            ))}
          </div>
          {error && <div role="alert" className="text-sm text-destructive"><p className="font-medium">{t("Request failed")}</p><pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-all" lang="en">{error}</pre></div>}
        </div>
      </div>
    </div>
  );
}
