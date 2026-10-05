import { mkdirSync } from "node:fs";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const projectRoot = path.resolve(process.cwd(), "..");
const mode = process.env.KEV_WORKBENCH_TEST_MODE;

if (mode !== "deterministic" && mode !== "native") {
  throw new Error("Set KEV_WORKBENCH_TEST_MODE through the workbench test script.");
}

const dataRoot = process.env.KEV_WORKBENCH_DATA_ROOT;
const evidenceRoot = process.env.KEV_WORKBENCH_EVIDENCE_ROOT;
if (!dataRoot || !evidenceRoot) throw new Error("Use scripts/run-workbench-tests.sh to allocate isolated local data and evidence roots.");
const resolvedDataRoot = path.resolve(dataRoot);
const resolvedEvidenceRoot = path.resolve(evidenceRoot);
const permittedDataRoot = path.join(projectRoot, ".local", "playground");
const permittedEvidenceRoot = path.join(projectRoot, ".local", "verification", "local-model-workbench", "a1", "playwright");
for (const [root, permitted] of [[resolvedDataRoot, permittedDataRoot], [resolvedEvidenceRoot, permittedEvidenceRoot]]) {
  const relative = path.relative(permitted, root);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("Workbench test data and evidence must stay inside the allocated project-local roots.");
  }
}

process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(projectRoot, ".local", "tools", "playwright");

mkdirSync(path.join(resolvedDataRoot, "tmp"), { recursive: true, mode: 0o700 });
mkdirSync(path.join(resolvedDataRoot, "xdg"), { recursive: true, mode: 0o700 });
mkdirSync(resolvedEvidenceRoot, { recursive: true, mode: 0o700 });

const localNode = path.join(projectRoot, ".local", "node", "bin");

export default defineConfig({
  testDir: "./tests/workbench",
  testMatch: mode === "native" ? "**/*.native.spec.ts" : "**/*.spec.ts",
  testIgnore: mode === "native" ? [] : "**/*.native.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: mode === "native" ? 20 * 60_000 : 60_000,
  expect: { timeout: 20_000 },
  outputDir: path.join(resolvedEvidenceRoot, "results"),
  reporter: [
    ["list"],
    ["json", { outputFile: path.join(resolvedEvidenceRoot, "report.json") }],
  ],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:3001",
    browserName: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "sh scripts/workbench-test-server.sh",
    cwd: process.cwd(),
    url: "http://127.0.0.1:3001/",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      PATH: `${localNode}${path.delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
      KEV_WORKBENCH_TEST_MODE: mode,
      KEV_WORKBENCH_DATA_ROOT: resolvedDataRoot,
      KEV_LOCAL_INFERENCE_CONFIG: path.join(projectRoot, ".local", "local-inference.json"),
      HF_HUB_OFFLINE: "1",
      TRANSFORMERS_OFFLINE: "1",
      TMPDIR: path.join(dataRoot, "tmp"),
      XDG_CACHE_HOME: path.join(dataRoot, "xdg"),
      NEXT_TELEMETRY_DISABLED: "1",
      KEV_API: "",
    },
  },
});
