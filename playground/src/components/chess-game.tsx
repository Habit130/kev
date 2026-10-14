"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chess, type Square } from "chess.js";
import Link from "next/link";
import { useWorkbenchLocale } from "@/components/workbench-locale";
import type { Copy } from "@/lib/workbench/translations";
import { askModel, legalMove, loadGames, replay, saveGames, resultText, type Mode, type ModelMove, type SavedGame } from "@/lib/chess";
import { api } from "@/lib/kev";
import { ChessBoard } from "@/components/chess-board";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

const MODES: { value: Mode; label: Copy }[] = [
  { value: "self", label: "Model vs model" },
  { value: "white", label: "You play White" },
  { value: "black", label: "You play Black" },
];
const EVAL_LABELS = ["Black is clearly winning", "Black is better", "Roughly equal", "White is better", "White is clearly winning"] as const;

const TOP_N = 8;
type Row = { key: string; p: number; top: boolean };

function topRows(probs: Record<string, number>, chosen: string, n: number): Row[] {
  const sorted = Object.entries(probs).sort((a, b) => b[1] - a[1]);
  const rows = sorted.slice(0, n).map(([key, p]) => ({ key, p, top: key === chosen }));
  if (!rows.some((r) => r.top) && probs[chosen] !== undefined) rows[n - 1] = { key: chosen, p: probs[chosen], top: true }; // sampled move outside the top N
  return rows;
}
function topMass(probs: Record<string, number>, n: number) {
  return Object.values(probs).sort((a, b) => b - a).slice(0, n).reduce((s, p) => s + p, 0);
}

// Always renders `nRows` lanes so an empty distribution keeps its place. Labels wrap instead of truncating.
function DistributionPanel({ id, title, headline, detail, rows, nRows, mono, footer, dim }: {
  id: string; title: string; headline?: string; detail?: string; rows: Row[]; nRows: number; mono?: boolean; footer?: string; dim?: boolean;
}) {
  const { t } = useWorkbenchLocale();
  return (
    <section aria-labelledby={`p-${id}`} className={`grid gap-3 rounded-lg border border-border bg-card px-4 py-3 transition-opacity md:grid-cols-[14rem_minmax(0,1fr)] md:gap-6 ${dim ? "opacity-60" : ""}`}>
      <div className="flex min-w-0 flex-col">
        <h3 id={`p-${id}`} className="font-mono text-xs text-muted-foreground">{id}</h3>
        <p className="mt-1 min-h-10 text-sm leading-5 text-foreground">{title}</p>
        <p className={`mt-1.5 min-h-6 break-words text-base font-medium tracking-tight ${mono ? "font-mono" : ""}`}>{headline ?? "\u00a0"}</p>
        <p className="min-h-5 text-xs tabular-nums text-muted-foreground">{detail ?? "\u00a0"}</p>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        {Array.from({ length: nRows }, (_, i) => {
          const r = rows[i];
          return (
            <div key={i} className="grid min-h-5 grid-cols-[minmax(0,1fr)_4.5rem] items-center gap-x-3 text-xs">
              <span className={`min-w-0 break-words ${mono ? "font-mono" : ""} ${r?.top ? "font-medium text-foreground" : "text-muted-foreground"}`}>{r ? `${r.key}${r.top ? ` · ${t("shown")}` : ""}` : "\u00a0"}</span>
              <span className="text-right tabular-nums text-muted-foreground">{r ? r.p.toFixed(2) : "\u00a0"}</span>
              <span className="relative col-span-2 block h-2 min-w-0 rounded-full bg-distribution-track" aria-hidden>
                {r && <span className="absolute inset-y-0 left-0 rounded-full bg-distribution" style={{ width: `${Math.round(r.p * 100)}%` }} />}
              </span>
            </div>
          );
        })}
        {footer !== undefined && <p className="mt-1 min-h-4 break-words text-xs text-muted-foreground">{footer}</p>}
      </div>
    </section>
  );
}

function newGame(mode: Mode): SavedGame {
  return { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, startedAt: Date.now(), mode, pgn: "", moves: [] };
}

function rebuild(g: SavedGame) {
  return replay(g.moves).chess;
}

export function ChessGame() {
  const { t, number, locale } = useWorkbenchLocale();
  const [games, setGames] = useState<SavedGame[]>([]);
  const [game, setGame] = useState<SavedGame | null>(null);
  const [mode, setMode] = useState<Mode>("self");
  const [sample, setSample] = useState(false);
  const [auto, setAuto] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Square | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const autoRef = useRef(false);
  const gameRef = useRef<SavedGame | null>(null); // latest persisted game, so async replies validate against the live position

  // load from localStorage (an external store) after mount; deferred so SSR and first client render match
  useEffect(() => {
    const t = setTimeout(() => {
      const saved = loadGames();
      setGames(saved);
      const last = saved.at(-1);
      const g = last && !last.result ? last : newGame("self");
      if (last && !last.result) setMode(last.mode);
      gameRef.current = g; setGame(g);
    }, 0);
    api.models().then((m) => setModel(m.models[0].run)).catch(() => setModel(null));
    return () => clearTimeout(t);
  }, []);

  const chess = useMemo(() => (game ? rebuild(game) : new Chess()), [game]);
  const lastMove = useMemo(() => { const h = chess.history({ verbose: true }); const m = h.at(-1); return m ? { from: m.from, to: m.to } : null; }, [chess]);
  const humanSide = mode === "white" ? "w" : mode === "black" ? "b" : null;
  const humanToMove = !!game && !game.result && humanSide === chess.turn();
  const modelToMove = !!game && !game.result && humanSide !== chess.turn();
  const lastModel = useMemo(() => [...(game?.moves ?? [])].reverse().find((m) => m.model)?.model, [game]);

  const persist = useCallback((g: SavedGame) => {
    gameRef.current = g;
    setGame(g);
    setGames((prev) => { const next = [...prev.filter((x) => x.id !== g.id), g]; saveGames(next); return next; });
  }, []);

  // The only way a move enters a game. `base` is the game the move was chosen for; it is applied only if that is still
  // the live game (id and ply count) and `san` is legal in that position. Returns the resulting position, or null if rejected.
  const applyMove = useCallback((base: SavedGame, san: string, by: "human" | "model", info?: ModelMove): Chess | null => {
    const cur = gameRef.current;
    if (!cur || cur.id !== base.id || cur.moves.length !== base.moves.length || cur.result) return null; // position changed while the move was being chosen
    const mv = legalMove(cur, san);
    if (!mv) { setError(`Rejected illegal move ${san} for ${by}`); return null; }
    const c = rebuild(cur);
    c.move(mv.san);
    persist({ ...cur, moves: [...cur.moves, { san: mv.san, by, model: info }], pgn: c.pgn(), result: resultText(c) });
    return c;
  }, [persist]);

  const modelMove = useCallback(async () => {
    if (!game || game.result || thinking) return;
    setThinking(true); setError(null);
    try {
      const info = await askModel(rebuild(game), sample);
      const c = applyMove(game, info.san, "model", info);
      if (!c || c.isGameOver()) { setAuto(false); autoRef.current = false; }
    } catch (e) { setError((e as Error).message); setAuto(false); autoRef.current = false; }
    finally { setThinking(false); }
  }, [game, sample, thinking, applyMove]);

  // autoplay loop: after each state change, if it's the model's turn and auto is on, move again
  useEffect(() => { autoRef.current = auto; }, [auto]);
  useEffect(() => {
    if (!auto || !game || game.result || thinking) return;
    if (humanSide !== null && humanSide === chess.turn()) return;
    const t = setTimeout(() => { if (autoRef.current) modelMove(); }, 250);
    return () => clearTimeout(t);
  }, [auto, game, thinking, chess, humanSide, modelMove]);

  // in human-vs-model modes, the model replies automatically (and opens when you play Black)
  useEffect(() => {
    if (humanSide === null || !game || game.result || thinking || chess.turn() === humanSide) return;
    const last = game.moves.at(-1);
    if (game.moves.length === 0 || last?.by === "human") {
      const t = setTimeout(modelMove, 150);
      return () => clearTimeout(t);
    }
  }, [game, chess, humanSide, thinking, modelMove]);

  const targets = useMemo(() => new Set(selected ? chess.moves({ square: selected, verbose: true }).map((m) => m.to) : []), [chess, selected]);

  function onSquare(sq: Square) {
    if (!humanToMove || thinking) return;
    const piece = chess.get(sq);
    if (selected && targets.has(sq)) {
      // several legal moves share from/to only for promotions; promote to a queen
      const candidates = chess.moves({ square: selected, verbose: true }).filter((m) => m.to === sq);
      const mv = candidates.find((m) => !m.promotion || m.promotion === "q") ?? candidates[0];
      if (mv) applyMove(game!, mv.san, "human");
      setSelected(null); return;
    }
    if (piece && piece.color === chess.turn()) setSelected(sq); else setSelected(null);
  }

  function start(m: Mode) {
    setAuto(false); autoRef.current = false; setMode(m); setSelected(null); setError(null);
    persist(newGame(m));
  }

  function undo() {
    if (!game || game.moves.length === 0) return;
    setAuto(false); autoRef.current = false;
    // in human modes undo the model reply too, so it is the human's turn again
    const n = humanSide && game.moves.at(-1)?.by === "model" ? 2 : 1;
    const moves = game.moves.slice(0, -n);
    const c = replay(moves).chess;
    persist({ ...game, moves, pgn: c.pgn(), result: undefined });
  }

  const finished = games.filter((g) => g.result);
  const movesRef = useRef<HTMLOListElement>(null);
  useEffect(() => { movesRef.current?.scrollTo({ top: movesRef.current.scrollHeight }); }, [game?.moves.length]);

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-6xl flex-col px-6 pt-8 pb-16 md:px-10">
      <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <nav className="flex items-baseline gap-4 text-sm">
          <Link href="/" className="text-muted-foreground hover:text-foreground">kev</Link>
          <span className="font-medium tracking-tight">{t("chess")}</span>
        </nav>
        <p className="min-w-0 max-w-full break-all text-sm text-muted-foreground">{model ? <span className="font-mono">{model}</span> : t("connecting")}</p>
      </header>

      <div className="mt-10 max-w-2xl">
        <h1 className="text-2xl font-medium tracking-tight">{t("Every move is a Choice question.")}</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {t("The legal moves are the options, the board is the state. The model returns a probability for each move and a Score for who is better, in one request. The model has never seen a chess game, so expect the distributions to be more interesting than the play.")}
        </p>
      </div>

      <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,34rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            {MODES.map((m) => (
              <button key={m.value} type="button" onClick={() => start(m.value)} aria-current={mode === m.value ? "true" : undefined}
                className={`border-b pb-0.5 ${mode === m.value ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
                {t(m.label)}
              </button>
            ))}
          </div>

          <ChessBoard chess={chess} selected={selected} targets={targets} lastMove={lastMove} flipped={mode === "black"} onSquare={onSquare} disabled={!humanToMove || thinking} />

          <div className="flex flex-wrap items-center gap-2">
            {mode === "self" ? (
              <>
                <Button onClick={() => setAuto((a) => !a)} disabled={!!game?.result} className="rounded-md">{auto ? t("Pause") : t("Play")}</Button>
                <Button variant="outline" onClick={modelMove} disabled={auto || thinking || !!game?.result} className="rounded-md shadow-none">{t("Step")}</Button>
              </>
            ) : (
              <Button variant="outline" onClick={modelMove} disabled={!modelToMove || thinking} className="rounded-md shadow-none">{t("Model moves")}</Button>
            )}
            <Button variant="ghost" onClick={undo} disabled={!game || game.moves.length === 0 || thinking} className="rounded-md text-muted-foreground">{t("Undo")}</Button>
            <Button variant="ghost" onClick={() => start(mode)} className="rounded-md text-muted-foreground">{t("New game")}</Button>
            <div className="ml-auto flex items-center gap-2">
              <Switch id="sample" checked={sample} onCheckedChange={(v) => setSample(!!v)} size="sm" />
              <Label htmlFor="sample" className="text-sm text-muted-foreground">{t("Sample from distribution")}</Label>
            </div>
          </div>

          <p className="min-h-5 text-sm text-muted-foreground" role="status">
            {game?.result ? <span className="text-foreground">{game.result}</span>
              : thinking ? t("Model is choosing")
              : humanToMove ? t("Your move ({side}). Click a piece, then a square.", { side: t(humanSide === "w" ? "White" : "Black") })
              : t("{side} to move", { side: t(chess.turn() === "w" ? "White" : "Black") })}
            {chess.inCheck() && !game?.result ? t(" · check") : ""}
          </p>
          {error && <div role="alert" className="text-sm text-destructive"><p className="font-medium">{t("Chess request failed")}</p><pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-all" lang="en">{error}</pre></div>}
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <DistributionPanel id="move" title={lastModel ? t("Best move among {count} legal moves", { count: number(lastModel.n_legal) }) : t("Best move among the legal moves")}
            headline={lastModel?.san} detail={lastModel ? t("confidence {value}", { value: number(lastModel.confidence, 2) }) : undefined}
            rows={lastModel ? topRows(lastModel.probabilities, lastModel.san, TOP_N) : []} nRows={TOP_N} mono
            footer={lastModel && lastModel.n_legal > TOP_N ? t("{count} more moves share the remaining {mass}", { count: number(lastModel.n_legal - TOP_N), mass: number(1 - topMass(lastModel.probabilities, TOP_N), 2) }) : " "}
            dim={thinking} />
          <DistributionPanel id="evaluation" title={t("Who is better in this position?")}
            headline={lastModel ? t("{score} of 4", { score: number(lastModel.evaluation, 2) }) : undefined} detail={lastModel?.evalConfidence !== undefined ? t("confidence {value}", { value: number(lastModel.evalConfidence, 2) }) : undefined}
            rows={EVAL_LABELS.map((label, i) => ({ key: `${i}  ${t(label)}`, p: lastModel?.evalProbabilities[String(i)] ?? 0, top: !!lastModel && i === Math.round(lastModel.evaluation) }))} nRows={EVAL_LABELS.length}
            dim={thinking} />
          <p className="min-h-5 text-xs tabular-nums text-muted-foreground">
            {lastModel ? t("{latency} ms · {tokens} input tokens · {count} options", { latency: number(lastModel.latency_ms, 0), tokens: number(lastModel.input_tokens), count: number(lastModel.n_legal) }) : t("The model's distribution appears here after its first move.")}
          </p>

          <div className="rounded-md border border-border bg-card px-4 py-3">
            <p className="text-xs text-muted-foreground">{t("Moves")}</p>
            <ol ref={movesRef} className="mt-1 grid h-40 grid-cols-[2.5rem_1fr_1fr] content-start gap-y-0.5 overflow-y-auto font-mono text-[13px] tabular-nums">
              {Array.from({ length: Math.ceil((game?.moves.length ?? 0) / 2) }, (_, i) => (
                <li key={i} className="contents">
                  <span className="text-muted-foreground">{i + 1}.</span>
                  <span>{game!.moves[2 * i]?.san}</span>
                  <span>{game!.moves[2 * i + 1]?.san ?? ""}</span>
                </li>
              ))}
              {game && game.moves.length === 0 && <li className="col-span-3 font-sans text-muted-foreground">{t("No moves yet.")}</li>}
            </ol>
          </div>
        </div>
      </div>

      <div className="mt-8 rounded-md border border-border bg-card px-4 py-3">
        <p className="text-xs text-muted-foreground">{t("Previous games (stored in this browser)")}</p>
        {finished.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">{t("None yet. Finished games are listed here.")}</p>
        ) : (
          <ul className="mt-1 grid gap-x-8 text-sm md:grid-cols-2">
            {[...finished].reverse().slice(0, 8).map((g) => (
              <li key={g.id} className="flex items-baseline justify-between gap-3 py-0.5">
                <span className="text-muted-foreground">{new Date(g.startedAt).toLocaleString(locale)} · {t(MODES.find((m) => m.value === g.mode)?.label ?? "Model vs model")}</span>
                <span className="tabular-nums">{t("{count} plies", { count: number(g.moves.length) })} · {g.result}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
