---
name: kev-knowledge
description: Search an explicitly authorized Kev knowledge graph for earlier research decisions, measurements, or session history. Use when repository evidence is insufficient and habit has confirmed the external graph and access scope, or asks to refresh that authorized graph.
---

# Kev knowledge graph (qmd)

The upstream author maintained a graph of Devin sessions since 17 Sep 2026: topic notes,
session notes, a timeline, PR/issue indexes, and extracted transcripts. This fork does not
assume the graph exists locally or grant access to the author's home-directory resources.

Read repository evidence first: `PLAN.md`, model cards, committed reports, and the relevant
archive tag. Use an external graph only after habit explicitly authorizes its path and
read scope. Record the actual path and qmd collection mapping in ignored
`.local/agent-context.md`. `KNOWLEDGE_ROOT` below denotes that confirmed location, not a
default to discover. Verify each collection maps to the approved scope before querying.

If no graph is authorized or qmd is unavailable, continue from repository evidence and
state the history gap. Do not access external paths, install global tooling, or guess
private history. Never copy `raw/` or `digest/` text into this public repo.

## When to look

- For earlier trials, rules, rounds, PRs, or upstream decisions, prefer available primary
  repository records, then search the authorized graph and cite its note when needed.
- Before a research, serving, data, release, or benchmark task, an authorized topic note
  may supply earlier incidents not recorded in the repository's summary.
- A graph note is context, not current authorization or a replacement for claim provenance.

## How to search

Two collections: `kev` (the distilled notes: index, timeline, topics, sessions, prs, issues; searched by default) and
`kev-transcripts` (`digest/` + `raw/`; excluded from default queries, name it with `-c`).

```sh
qmd search "<keywords>" -c kev -n 8            # BM25, instant; best for identifiers (PR numbers, flags, suite names)
qmd vsearch "<question>" -c kev -n 8           # semantic, ~3 s
qmd query "<question>" -c kev -n 8             # hybrid + LLM rerank; timing depends on the approved environment
qmd query "<question>" -c kev --files --min-score 0.3   # paths only
qmd get "kev/topics/<slug>.md"                 # read a note (line-numbered)
qmd multi-get "kev/sessions/*.md" -l 30        # skim the first 30 lines of every session note
qmd search "<exact phrase>" -c kev-transcripts -n 5     # quotes from the transcripts
```

Read order: `topics/` (distilled, trustworthy) -> `sessions/<id>.md` (what happened, with the exact asks and
outcomes) -> `digest/<id>.md` (prose transcript, for quotes) -> `raw/<id>.md` (tool calls, truncated outputs; last
resort). Transcript hits are long; read them with `qmd get "kev-transcripts/digest/<id>.md:<line>:<count>"` rather
than whole.

Without qmd, use `rg -n "<term>" "$KNOWLEDGE_ROOT/topics" "$KNOWLEDGE_ROOT/sessions"`,
then open the approved graph's `index.md`. This fallback needs the same access authorization.

## Map

| file | use |
|---|---|
| `index.md` | hub: topics with session counts, sessions by date |
| `timeline.md` | the story 17 Sep - 1 Oct 2026, with open threads |
| `topics/architecture.md`, `training-recipe.md`, `full-weight-sft.md`, `calibration.md` | the model and how it is trained; what moved the needle |
| `topics/evaluation-suites.md`, `research-rounds.md`, `autoresearch-program.md` | suites, gates, the audit that removed scienthoon/wanli/typesafe; every round's verdict; the standing rules |
| `topics/serving-performance.md`, `deployment-paths.md`, `long-context.md`, `modal-infrastructure.md` | CUDA graphs, batching, fused kernels, MLX, vLLM decision, 64k states, GPUs and spend |
| `topics/releases.md`, `docs-and-writing.md`, `data-and-synthetic.md`, `competitors.md`, `base-models.md` | what shipped when; README/card rules; data policy and teachers; Jev/AutoJev/Clef; Qwen -> Gemma/Inkling |
| `topics/skills-and-workflow.md`, `code-quality.md` | worktrees, subagents, Devin CLI tips, the thermonuclear standard |
| `sessions/warm-lute.md` | the nine-day marathon that ran rounds 4-29 and every 27B release |
| `prs.md`, `issues.md` | every PR/issue -> sessions that discussed it (`prs.md#pr-<n>`) |

## Citing

Quote a graph-relative note path, such as `topics/calibration.md`, or a session ID.
Put the actual machine path only in local context. Resuming an external Devin session is
not implied by a read-only history request and needs a separate authorization.
Numbers in the notes were written by hand from the transcripts; for a published number, prefer `docs/claims.json`,
PLAN.md or the model card, and say which you used.

## Refreshing after new sessions

Refresh only when habit authorizes writes to the graph and the source session store.
The extraction tools may read another location outside the graph; inspect their inputs
and confirm that scope before running them. Never expose credential-bearing transcripts.

```sh
cd "$KNOWLEDGE_ROOT"
python3 tools/extract_sessions.py        # reads the separately approved source session store
python3 tools/build_graph.py             # exits non-zero naming any session that lacks a note
qmd update && qmd embed -c kev && qmd embed -c kev-transcripts   # the second is slow (tens of minutes); optional
```

If qmd is missing, report the optional capability gap rather than install it globally.
Any approved provisioning/index setup is separate from this skill's read workflow.
The graph's README owns its actual collection setup; do not mutate global collections
or index an unapproved transcript store as part of an ordinary lookup.

For each new session: read `digest/<id>.md`, add an entry to `tools/session_notes.py` (title, summary, asks,
outcomes, lessons, topics), extend the topic notes it taught something new, add the day to `timeline.md`, rebuild.
`tools/fetch_github.sh` refreshes `data/prs.tsv` / `data/issues.tsv` (needs `gh`). Do not edit `sessions/*.md`,
`index.md`, `prs.md` or `issues.md` by hand; they are regenerated. `README.md` there documents the layout.
