# Kev local workbench

The workbench is a local UI for editing portable task templates and running the existing Kev consumer against the provisioned local model registry. It uses the canonical System One request/response contract. It does not download models, train them, send input to a remote service, or claim that scores are business accuracy.

## One-time setup

1. Install a Node.js 22 distribution **inside this checkout only**. Download the appropriate macOS archive from [nodejs.org](https://nodejs.org/en/download), verify its SHA-256 against the official checksum file, and extract it so `.local/node/bin/node`, `npm`, and `npx` exist. Do not use a global installer or modify a shell profile. The verified setup for this delivery used Node `22.23.3`.
2. From the repository root, install the locked frontend dependencies:

   ```bash
   PATH="$PWD/.local/node/bin:$PATH" npm ci --prefix playground
   ```

3. For browser verification only, install Chromium under project-local storage:

   ```bash
   PATH="$PWD/.local/node/bin:$PATH" PLAYWRIGHT_BROWSERS_PATH="$PWD/.local/tools/playwright" .local/node/bin/npx playwright install chromium
   ```

The launcher itself opens the macOS default browser and does not require Playwright.

## Start and stop

After setup, double-click [`../bin/kev-playground.command`](../bin/kev-playground.command), or run it from a terminal from any working directory. The launcher resolves its own checkout, verifies Node 22 and the installed dependencies, starts Next on `127.0.0.1:3001`, waits for the page to respond, then opens the browser. Its isolated server environment sets `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, `UV_OFFLINE=1`, and disables Next telemetry. A model load uses the exact existing local registry pairing.

Keep the Terminal window opened by the launcher running. To stop the web app, click **Stop** in the workbench first if the model slot should be released, then press **Ctrl-C** in that Terminal. Closing a browser tab does not stop either the app or model. If the app is stopped while a model remains resident, start it again to recover the owned model status and stop controls. An occupied port, missing Node version, or missing dependencies produces an actionable error; the launcher never adopts or kills an unrelated listener.

The workbench is at `/`. **More tools** links to Classic at `/classic` and Chess at `/chess`. These independent tools require their own Kev API backend (`KEV_API`, default `http://127.0.0.1:8009`); loading a workbench model does not configure them.

## Interface language / 界面语言

The header's **简体中文 / English** selector is available in Run, Task library,
and History. Simplified Chinese is the default, regardless of browser language.
The successfully saved choice is a project-level preference in
`.local/playground/workbench/workbench.json`, shared by new tabs and browser
contexts and retained across app restarts. Missing or unsupported saved locales
fall back to Chinese; other saved-data validation remains unchanged. A failed
save keeps the previous language and shows an error; select the language again
to retry. No cookies or browser-profile locale store is used.

Switching translates application headings, controls, help, dialogs, notices,
accessible labels, lifecycle and failure summaries, results and display units.
Dates use the selected locale and the browser's existing time zone; probabilities,
confidence and expected levels keep three decimals, latency one decimal, token
counts integers. Raw JSON retains canonical formatting and values. Original
diagnostics remain inspectable under **诊断详情 / Diagnostic details**; errors
are classified by stable category, never by translated text.

Language changes preserve unfinished template and Advanced JSON text, input,
restored drafts, selected task/model/history and displayed results. Language saves
are separate from run/model exclusion: switching during a run neither resubmits
nor cancels it, and the eventual result uses the current interface language.

Task names/descriptions, generated examples, question/option IDs and contents,
inputs, model IDs, saved snapshots, score legends and canonical responses are
**data, not translations**. Classic and Chess remain independent pages; only
their workbench entries/help are translated. Browser/OS dialog chrome is outside
application copy. No translation service or extra network translation request,
model-quality change, inference prompt translation or new language is introduced.

## Templates and workflow

- **Run** opens first: select a saved task, read its summary, enter Text or JSON, and use **Run task**. Input and results sit side by side on wide screens, stacking on smaller screens. Results identify their submitted task/run and actual model independently of later selection or input changes. Full model identity and raw response are secondary details; long distribution labels wrap.
- **Task library** owns create/select/edit/save/update/delete and configuration import/export. Choice options and Score levels retain their order; optional Noul criteria can be added or omitted. **Advanced JSON** is available on demand for supported structured values. Unfinished edits and run input survive routine in-tab view changes; unsaved library edits do not replace Run's saved questions. Reloading a tab discards unfinished drafts.
- State has explicit text and JSON modes. Text is submitted literally. Invalid JSON is rejected before inference. Inputs are not silently trimmed, translated, rewritten, or shortened.
- Import/export uses `kev-project-tasks/1`; a valid import replaces the entire saved library (no merge) after full validation. Invalid imports leave it unchanged. History is kept. Export chooses one registered logical model and writes under `.local/playground/workbench/exports/`, not the OS Downloads folder.
- **History** lists task, timestamp, outcome and actual model. Inspect, restore to a draft without submitting, rerun with the currently selected ready model, or delete individually. Restored drafts are identified on Run and can run even after their original template is deleted; they never overwrite saved templates. Each submission freezes its state/questions and actual model identity. Persistence errors are not reported as saved success.
- Workbench settings, templates, history, consumer session data, runtime caches, logs, temporary data, and exports stay under the checkout's ignored `.local/playground/`. Generic exclusive model-slot ownership metadata stays under `.local/consumer-runtime/`. The workbench does not store history/templates in cookies, localStorage, or application IndexedDB.
- The compact global **Model** summary shows readiness and the actual resident model, including a different future selection. Expand it for selection, load/switch/stop and lifecycle guidance. Closing the tab or changing views does not release or duplicate a model. Use explicit Stop to release the workbench-owned slot; switching requires confirmed release first. A busy slot owned by another project is not adopted or stopped.
- The logical model selected for a run is not the model's identity. Result and history details report the actual resident checkpoint/base and runtime, not an echoed API alias.

Scores and probabilities retain System One meanings; they are not explanations, calibrated business-accuracy guarantees, or permission to automate high-impact decisions. This workbench is local-only and does not add document ingestion, batch processing, fine-tuning, or cloud deployment.

## Verification

Run from `playground/` with Node 22 on `PATH`:

```bash
npm run lint
npx --no-install next typegen
npx --no-install tsc --noEmit -p .
npm run build
npm run test:workbench
```

The deterministic browser suite uses isolated synthetic inputs and stores both test data and evidence below project-local `.local/` paths. The real MLX suite is `npm run test:workbench:native`; it requires the authorized existing model pairings, an available exclusive Metal workload, and a separate sequential resource check. Do not treat deterministic doubles as native model evidence.

The deterministic entry point also runs `tests/workbench/workbench.locale.spec.ts`:
default/legacy/unsupported settings and failed-save retry; bilingual coverage;
actual-server errors; unfinished drafts and held genuine run replies; historical
bytes/export integrity; fixed format fixtures, both sizes/themes and keyboard.
No frontend or inference response is substituted: delayed-response scenarios
hold and replay the actual local server response unchanged.

### Translation inventory

| Application surface | Observable verification |
| --- | --- |
| Shell, navigation, theme, language, More tools, initial loading/empty | LANG-DEFAULT, LANG-COVERAGE; bilingual initial-loading and library captures |
| Model readiness, selection, load/switch/stop, confirmation and recovery help | Core lifecycle regressions; LANG-ERRORS and model controls in both languages |
| Saved task, shared input, literal-text help, run/restored draft and notices | LANG-STATE; retained core saved-versus-unsaved and restore scenarios |
| Visual Choice/Noul/Score editor, dynamic accessible labels, Advanced JSON, validation | LANG-COVERAGE and LANG-ERRORS; bilingual library/import/questions captures |
| Import replacement help, export/save feedback and delete dialogs | LANG-COVERAGE; bilingual success captures and recorded dialog messages |
| History outcomes/actions, provenance, raw/details and all three result types | LANG-COVERAGE, LANG-ERRORS, LANG-INTEGRITY; core history/outcome assertions |
| Invalid input/import, unready/busy/startup/stop/length/inference/storage failures | LANG-ERRORS; identical categories/statuses and original diagnostics in both languages |
| Timestamps, precision/units, themes/sizes, keyboard and document language | LANG-FORMAT; fixed fixtures, accessibility snapshots and browser error observation |

`src/lib/workbench/translations.ts` is the finite application-copy dictionary;
`locale.ts` owns locale validation/defaults and display formatting. Raw IDs,
payloads, diagnostics and browser-owned file-picker chrome are intentionally
outside this inventory. Unexpected categories get a localized summary with
inspectable original detail instead of guessing from a translated sentence.

The native browser harness still uses the pre-redesign combined-view selectors. Its navigation adaptation and authorized native rerun are deferred; the redesign's verification uses only the deterministic entry point above, not a native quality or performance claim.

## Attribution and licenses

The workbench shell adapts the sidebar/inset layout pattern from the official [shadcn Dashboard block](https://ui.shadcn.com/examples/dashboard); shadcn/ui is MIT-licensed ([license](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md)). [Kiranism's dashboard](https://github.com/Kiranism/next-shadcn-dashboard-starter) was consulted as a visual reference only; no Kiranism application source or assets are copied. Its project is MIT-licensed ([license](https://github.com/Kiranism/next-shadcn-dashboard-starter/blob/main/LICENSE)). The workbench-specific controls, persistence, and interactions are Kev code.
