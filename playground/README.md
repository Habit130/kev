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

## Templates, runs, and local data

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

The native browser harness still uses the pre-redesign combined-view selectors. Its navigation adaptation and authorized native rerun are deferred; the redesign's verification uses only the deterministic entry point above, not a native quality or performance claim.

## Attribution and licenses

The workbench shell adapts the sidebar/inset layout pattern from the official [shadcn Dashboard block](https://ui.shadcn.com/examples/dashboard); shadcn/ui is MIT-licensed ([license](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md)). [Kiranism's dashboard](https://github.com/Kiranism/next-shadcn-dashboard-starter) was consulted as a visual reference only; no Kiranism application source or assets are copied. Its project is MIT-licensed ([license](https://github.com/Kiranism/next-shadcn-dashboard-starter/blob/main/LICENSE)). The workbench-specific controls, persistence, and interactions are Kev code.
