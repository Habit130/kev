"use client";

import { useWorkbenchLocale } from "@/components/workbench-locale";
import type { Answer, Question } from "@/lib/kev";

// One shared lane layout for every bar on the page: label | track | value.
// Only the fill length varies between rows, so lengths are comparable across cards.
function Bar({ label, p, top, delta, mono }: { label: string; p: number; top: boolean; delta?: number; mono?: boolean }) {
  const { t } = useWorkbenchLocale();
  const showDelta = delta !== undefined && Math.abs(delta) >= 0.01;
  return (
    <div className="grid gap-1 text-sm leading-5">
      <div className="flex items-baseline justify-between gap-3">
        <span className={`min-w-0 break-words ${mono ? "font-mono" : ""} ${top ? "font-medium text-foreground" : "text-foreground"}`}>{label}{top ? ` · ${t("shown")}` : ""}</span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          <span>{p.toFixed(2)}</span>
          {showDelta && <span className="ml-1">{delta > 0 ? "+" : ""}{delta.toFixed(2)}</span>}
        </span>
      </div>
      <span className="relative block h-2 min-w-0 rounded-full bg-distribution-track" aria-hidden>
        <span className="absolute inset-y-0 left-0 rounded-full bg-distribution" style={{ width: `${Math.round(p * 100)}%` }} />
      </span>
    </div>
  );
}

function instructionText(q?: Question) {
  if (!q) return "";
  return typeof q.instructions === "string" ? q.instructions : JSON.stringify(q.instructions);
}

export function AnswerCard({ id, question, answer, compare }: { id: string; question?: Question; answer: Answer; compare?: Answer }) {
  const { t, number } = useWorkbenchLocale();
  const instr = instructionText(question);
  const confidence = "confidence" in answer ? answer.confidence : undefined;
  const headline =
    answer.type === "noul" ? (answer.noul >= 0.5 ? t("yes") : t("no"))
    : answer.type === "choice" ? answer.choice
    : `${number(answer.score, 2)} ${t("of {max}", { max: number(Object.keys(answer.legend).length - 1) })}`;
  const detail =
    answer.type === "noul" ? `${t("p(yes)")} ${number(answer.noul, 2)}`
    : t("confidence {value}", { value: number(confidence ?? 0, 2) });

  return (
    <section aria-labelledby={`q-${id}`} className="grid gap-3 border-t border-border py-3 md:grid-cols-[14rem_minmax(0,1fr)] md:gap-6">
      <div className="flex min-w-0 flex-col">
        <h3 id={`q-${id}`} className="flex items-baseline gap-1.5 text-xs text-muted-foreground">
          <span className="min-w-0 break-words font-mono">{id}</span>
          <span className="shrink-0">· {answer.type}</span>
        </h3>
        {instr && <p className="mt-1 break-words text-sm leading-6 text-foreground">{instr}</p>}
        <p className="mt-1.5 flex flex-wrap items-baseline gap-x-2">
          <span className={`break-words text-base font-medium tracking-tight ${answer.type === "choice" ? "font-mono" : ""}`}>{headline}</span>
          <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">{detail}</span>
        </p>
      </div>

      <div className="flex min-w-0 flex-col justify-center">
        {answer.type === "noul" && (
          <>
            <Bar label={t("yes")} p={answer.noul} top={answer.noul >= 0.5} delta={compare?.type === "noul" ? answer.noul - compare.noul : undefined} />
            <Bar label={t("no")} p={1 - answer.noul} top={answer.noul < 0.5} />
          </>
        )}
        {answer.type === "choice" &&
          Object.entries(answer.probabilities)
            .sort((a, b) => b[1] - a[1])
            .map(([k, p]) => (
              <Bar key={k} label={k} mono p={p} top={k === answer.choice} delta={compare?.type === "choice" ? p - (compare.probabilities[k] ?? 0) : undefined} />
            ))}
        {answer.type === "score" &&
          Object.entries(answer.probabilities).map(([k, p]) => (
            <Bar key={k} label={`${k}  ${answer.legend[k]}`} p={p} top={Number(k) === Math.round(answer.score)} delta={compare?.type === "score" ? p - (compare.probabilities[k] ?? 0) : undefined} />
          ))}
      </div>
    </section>
  );
}
