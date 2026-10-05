import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";

const DATA_ROOT = process.env.KEV_WORKBENCH_DATA_ROOT;
const EVIDENCE_ROOT = process.env.KEV_WORKBENCH_EVIDENCE_ROOT;
const PROJECT_ROOT = path.resolve(process.cwd(), "..");
const REGISTRY_PATH = path.join(PROJECT_ROOT, ".local", "local-inference.json");
const REGISTRY_SHA256 = "171c8b0c44f7b4be1ed1502c7e700912ff4924706d273af6a876bdc42321e4d8";
const APP_ORIGIN = "http://127.0.0.1:3001";
const execFile = promisify(execFileCallback);

if (!DATA_ROOT || !EVIDENCE_ROOT) throw new Error("Playwright must allocate project-local workbench data and evidence roots.");

type ModelId = "kev-0.8b" | "kev-4b";
type ArtifactIdentity = { source: string; revision: string };
type ModelIdentity = {
  modelId: ModelId;
  checkpoint: ArtifactIdentity;
  base: ArtifactIdentity;
  backend: string;
  dtype: string;
  device: string;
};
type ProcessIdentity = { pid: number; startedAt: string; executable: string };
type NativeRun = {
  id: string;
  submittedAt: string;
  status: string;
  stateMode: string;
  state: unknown;
  taskId: string;
  taskName: string;
  questions: Record<string, unknown>;
  modelIdentity: ModelIdentity;
  response: {
    model: string;
    answers: Record<string, Record<string, unknown>>;
    usage: { input_tokens: number; output_tokens: number };
    latency_ms: number;
  };
};
type BrowserSnapshot = {
  settings: { selectedModel: ModelId };
  templates: unknown[];
  history: NativeRun[];
  runtime: { state: string; identity: ModelIdentity | null };
};
type NativeEvidence = {
  registrySha256: string;
  workbenchActions: Array<{ action: string; body: Record<string, unknown>; status: number | null }>;
  models: Array<{
    modelId: ModelId;
    endpoint: string;
    identity: ModelIdentity | null;
    process: ProcessIdentity | null;
    modelCardIdentity: unknown;
    runs: Array<{ request: Record<string, unknown>; record: NativeRun; trace: string }>;
    apiSuite: { command: string[]; exitCode: number; stdout: string; stderr: string } | null;
    screenshots: string[];
    release: { snapshotState: string; endpointAfterClose: null; oldEndpointReachable: false; listenerReleased: boolean; processGone: boolean } | null;
  }>;
  consumerHandover: Record<string, unknown> | null;
  cleanupErrors: string[];
};

function readRegisteredIdentity(modelId: ModelId): Pick<ModelIdentity, "modelId" | "checkpoint" | "base"> {
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as {
    models?: Record<string, {
      checkpoint?: ArtifactIdentity & { path?: string };
      base?: ArtifactIdentity & { path?: string };
    }>;
  };
  const model = registry.models?.[modelId];
  if (!model?.checkpoint || !model.base) throw new Error(`The local registry has no complete pin for ${modelId}.`);
  return {
    modelId,
    checkpoint: { source: model.checkpoint.source, revision: model.checkpoint.revision },
    base: { source: model.base.source, revision: model.base.revision },
  };
}

async function getSnapshot(page: Page): Promise<BrowserSnapshot> {
  const reply = await page.evaluate(async () => {
    const response = await fetch("/api/workbench", { cache: "no-store" });
    return { status: response.status, body: await response.json() as unknown };
  });
  expect(reply.status).toBe(200);
  return reply.body as BrowserSnapshot;
}

async function postWorkbench(page: Page, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  return page.evaluate(async (requestBody) => {
    const response = await fetch("/api/workbench", {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(requestBody),
    });
    return { status: response.status, body: await response.json() as unknown };
  }, body);
}

async function nativeEndpoint(page: Page): Promise<string | null> {
  const reply = await page.evaluate(async () => {
    const response = await fetch("/api/workbench/test", { cache: "no-store" });
    return { status: response.status, body: await response.json() as unknown };
  });
  expect(reply.status).toBe(200);
  const body = reply.body as { endpoint?: unknown };
  if (body.endpoint === null) return null;
  expect(typeof body.endpoint).toBe("string");
  const url = new URL(body.endpoint as string);
  expect(url.protocol).toBe("http:");
  expect(url.hostname).toBe("127.0.0.1");
  expect(url.port).not.toBe("");
  expect(url.pathname).toBe("/");
  return url.origin;
}

async function endpointResponds(page: Page, endpoint: string): Promise<boolean> {
  try {
    const response = await page.request.get(`${endpoint}/v1/models`, { timeout: 2_000 });
    return response.status() === 200;
  } catch {
    return false;
  }
}

function checkedIdentity(snapshot: BrowserSnapshot, modelId: ModelId): ModelIdentity {
  expect(snapshot.runtime).toEqual(expect.objectContaining({ state: "ready", identity: expect.any(Object) }));
  const identity = snapshot.runtime.identity;
  if (!identity) throw new Error("The workbench did not report its ready model identity.");
  expect(identity).toMatchObject(readRegisteredIdentity(modelId));
  expect(identity.backend).toBe("mlx");
  expect(identity.device).toBe("mps");
  expect(identity.dtype).toEqual(expect.any(String));
  expect(identity.dtype.length).toBeGreaterThan(0);
  return identity;
}

function processCommandEnvironment() {
  return { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8", NODE_ENV: "test" as const };
}

async function processIdentity(pid: number): Promise<ProcessIdentity | null> {
  const options = { encoding: "utf8" as const, env: processCommandEnvironment(), timeout: 5_000 };
  try {
    const [start, executable] = await Promise.all([
      execFile("/bin/ps", ["-p", String(pid), "-o", "lstart="], options),
      execFile("/bin/ps", ["-p", String(pid), "-o", "comm="], options),
    ]);
    if (!start.stdout.trim() || !executable.stdout.trim()) return null;
    return { pid, startedAt: start.stdout.trim(), executable: executable.stdout.trim() };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { code?: number | string };
    if (String(failure.code) === "1") return null;
    throw error;
  }
}

async function listeningProcessIdentities(endpoint: string): Promise<ProcessIdentity[]> {
  const port = new URL(endpoint).port;
  let stdout: string;
  try {
    const result = await execFile("/usr/sbin/lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
      env: processCommandEnvironment(),
      timeout: 5_000,
    });
    stdout = result.stdout;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { code?: number | string; stdout?: string };
    if (String(failure.code) === "1") return [];
    throw error;
  }
  const pids = [...new Set(stdout.split(/\s+/).filter((value) => /^\d+$/.test(value)).map(Number))];
  const identities = await Promise.all(pids.map(processIdentity));
  return identities.filter((identity): identity is ProcessIdentity => identity !== null);
}

async function assertProcessReleased(page: Page, endpoint: string, process: ProcessIdentity): Promise<void> {
  await expect.poll(async () => {
    const [responds, listeners, oldProcess] = await Promise.all([
      endpointResponds(page, endpoint),
      listeningProcessIdentities(endpoint),
      processIdentity(process.pid),
    ]);
    return !responds && listeners.length === 0 && oldProcess?.startedAt !== process.startedAt;
  }, { timeout: 30_000, intervals: [250, 1_000] }).toBe(true);
}

function safeModelCardIdentity(value: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!value) return null;
  const artifact = (raw: unknown): ArtifactIdentity | null => {
    if (typeof raw !== "object" || raw === null) return null;
    const item = raw as Record<string, unknown>;
    const nestedPin = item.pin;
    const pin = typeof nestedPin === "object" && nestedPin !== null && !Array.isArray(nestedPin)
      ? nestedPin as Record<string, unknown>
      : item;
    if (typeof pin.source !== "string" || typeof pin.revision !== "string") return null;
    return { source: pin.source, revision: pin.revision };
  };
  return {
    model_id: value.model_id,
    checkpoint: artifact(value.checkpoint),
    base: artifact(value.base),
    backend: value.backend,
    dtype: value.dtype,
    device: value.device,
  };
}

function assertTypedResults(record: NativeRun, identity: ModelIdentity): void {
  expect(record.status).toBe("succeeded");
  expect(record.modelIdentity).toEqual(identity);
  expect(record.response.model).toBe(identity.modelId);
  expect(Object.keys(record.response.answers)).toEqual(["category", "needs_review", "urgency"]);
  expect(record.response.answers.category.type).toBe("choice");
  expect(record.response.answers.needs_review.type).toBe("noul");
  expect(record.response.answers.urgency.type).toBe("score");
  expect(record.response.usage.input_tokens).toBeGreaterThan(0);
  expect(record.response.usage.output_tokens).toBeGreaterThan(0);
  expect(record.response.latency_ms).toBeGreaterThanOrEqual(0);
}

async function runSyntheticTask(
  page: Page,
  modelId: ModelId,
  taskName: string,
  stateText: string,
  editQuestions: boolean,
): Promise<{ request: Record<string, unknown>; record: NativeRun }> {
  await page.getByLabel("Template name").fill(taskName);
  await page.getByRole("textbox", { name: "State input" }).fill(stateText);
  if (editQuestions) {
    await page.getByLabel("Question category instructions").fill(`Use the changed synthetic instructions for the ${modelId} second native run.`);
    await page.getByLabel("Question urgency score level 2").fill(`Within one synthetic day for ${modelId}.`);
  }

  const responsePromise = page.waitForResponse((response) => {
    const request = response.request();
    if (!response.url().endsWith("/api/workbench") || request.method() !== "POST") return false;
    try {
      return (request.postDataJSON() as Record<string, unknown>).action === "run";
    } catch {
      return false;
    }
  });
  await page.getByRole("button", { name: "Run task" }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const payload = await response.json() as { record: NativeRun };
  const request = response.request().postDataJSON() as Record<string, unknown>;
  const record = payload.record;
  expect(request).toMatchObject({ action: "run", stateMode: "text", stateText, taskName });
  expect(request.questions).toEqual(record.questions);
  expect(record.state).toBe(stateText);
  expect(record.taskName).toBe(taskName);
  expect(record.modelIdentity.modelId).toBe(modelId);
  assertTypedResults(record, record.modelIdentity);

  const choice = record.response.answers.category;
  const choiceCard = page.getByRole("article", { name: "category Choice result" });
  await expect(choiceCard).toContainText(String(choice.choice));
  await expect(choiceCard).toContainText(`confidence ${Number(choice.confidence).toFixed(3)}`);
  const choiceProbabilities = choice.probabilities as Record<string, number>;
  for (const [option, probability] of Object.entries(choiceProbabilities)) {
    await expect(choiceCard).toContainText(option);
    await expect(choiceCard).toContainText(probability.toFixed(3));
  }

  const noul = record.response.answers.needs_review;
  const noulCard = page.getByRole("article", { name: "needs_review Noul result" });
  await expect(noulCard).toContainText(`p(yes) ${Number(noul.noul).toFixed(3)}`);
  await expect(noulCard).toContainText(`Yes`);
  await expect(noulCard).toContainText(`No`);

  const score = record.response.answers.urgency;
  const scoreCard = page.getByRole("article", { name: "urgency Score result" });
  await expect(scoreCard).toContainText(`Expected level ${Number(score.score).toFixed(3)}`);
  const scoreProbabilities = score.probabilities as Record<string, number>;
  const legend = score.legend as Record<string, string>;
  for (const [level, probability] of Object.entries(scoreProbabilities)) {
    await expect(scoreCard).toContainText(legend[level]);
    await expect(scoreCard).toContainText(probability.toFixed(3));
  }
  await expect(page.getByText(`${record.response.latency_ms.toFixed(1)} ms`)).toBeVisible();
  await expect(page.getByText(`${record.response.usage.input_tokens} input tokens`)).toBeVisible();
  await expect(page.getByText(`${record.response.usage.output_tokens} output tokens`)).toBeVisible();

  const inspectButton = page.getByRole("button", { name: "Inspect raw" });
  if (await inspectButton.isVisible()) await inspectButton.click();
  const rawText = await page.getByRole("region", { name: "Raw request and response" }).locator("pre").innerText();
  const raw = JSON.parse(rawText) as { request: Record<string, unknown>; response: unknown };
  expect(raw.request).toEqual({ state: record.state, model: modelId, questions: record.questions });
  expect(raw.response).toEqual(record.response);
  const hideButton = page.getByRole("button", { name: "Hide raw" });
  if (await hideButton.isVisible()) await hideButton.click();

  return { request, record };
}

async function captureResultScreenshots(page: Page, modelId: ModelId, paths: string[]): Promise<void> {
  const captures = [
    { width: 1440, height: 900, theme: "light" as const },
    { width: 1440, height: 900, theme: "dark" as const },
    { width: 1024, height: 768, theme: "light" as const },
    { width: 1024, height: 768, theme: "dark" as const },
  ];
  for (const capture of captures) {
    await page.setViewportSize({ width: capture.width, height: capture.height });
    const isDark = await page.locator("html").evaluate((element) => element.classList.contains("dark"));
    if ((capture.theme === "dark") !== isDark) {
      await page.getByRole("button", { name: isDark ? "Use light theme" : "Use dark theme" }).click();
      await expect(page.locator("html")).toHaveClass(capture.theme === "dark" ? /dark/ : /light/);
    }
    const layout = await page.evaluate(() => ({
      viewportWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
    }));
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    const name = `native-${modelId}-${capture.width}x${capture.height}-${capture.theme}-results.png`;
    const screenshot = path.join(EVIDENCE_ROOT!, name);
    await page.screenshot({ path: screenshot, fullPage: true });
    paths.push(name);
  }
}

async function runApiCompatibilitySuite(modelId: ModelId, endpoint: string, evidenceFile: string) {
  const uv = path.join(PROJECT_ROOT, ".local", "bin", "uv");
  const command = ["run", "--frozen", "--extra", "serve", "python", "-m", "pytest", "tests/test_api.py", "-q"];
  const home = path.join(DATA_ROOT!, "python-home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const env = {
    PATH: [
      path.join(PROJECT_ROOT, ".local", "bin"),
      path.join(PROJECT_ROOT, ".local", "python", "bin"),
      path.join(PROJECT_ROOT, ".local", "node", "bin"),
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].join(path.delimiter),
    HOME: home,
    NODE_ENV: "test" as const,
    LANG: "en_US.UTF-8",
    TMPDIR: path.join(DATA_ROOT!, "tmp"),
    XDG_CACHE_HOME: path.join(DATA_ROOT!, "xdg"),
    UV_CACHE_DIR: path.join(PROJECT_ROOT, ".local", "cache", "uv"),
    UV_OFFLINE: "1",
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    PYTHONNOUSERSITE: "1",
    KEV_BASE_URL: endpoint,
  };
  let exitCode = 0;
  let stdout = "";
  let stderr = "";
  try {
    const result = await execFile(uv, command, {
      cwd: PROJECT_ROOT,
      env,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      timeout: 15 * 60_000,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string };
    exitCode = typeof failure.code === "number" ? failure.code : 1;
    stdout = failure.stdout ?? "";
    stderr = failure.stderr ?? failure.message;
  }
  writeFileSync(evidenceFile, JSON.stringify({ modelId, endpoint, command: [uv, ...command], cwd: PROJECT_ROOT, exitCode, stdout, stderr }, null, 2) + "\n", { mode: 0o600 });
  expect(exitCode, `${modelId} API compatibility suite failed; see ${evidenceFile}`).toBe(0);
  return { command: [uv, ...command], exitCode, stdout, stderr };
}

async function runKevCommand(args: string[], dataRoot: string, timeout = 30_000): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const env = {
    PATH: [
      path.join(PROJECT_ROOT, ".local", "bin"),
      path.join(PROJECT_ROOT, ".local", "python", "bin"),
      path.join(PROJECT_ROOT, ".local", "node", "bin"),
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].join(path.delimiter),
    HOME: path.join(dataRoot, "home"),
    NODE_ENV: "test" as const,
    LANG: "en_US.UTF-8",
    TMPDIR: path.join(dataRoot, "tmp"),
    XDG_CACHE_HOME: path.join(dataRoot, "xdg"),
    KEV_LOCAL_INFERENCE_CONFIG: REGISTRY_PATH,
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    UV_OFFLINE: "1",
    PYTHONNOUSERSITE: "1",
  };
  mkdirSync(env.HOME, { recursive: true, mode: 0o700 });
  mkdirSync(env.TMPDIR, { recursive: true, mode: 0o700 });
  mkdirSync(env.XDG_CACHE_HOME, { recursive: true, mode: 0o700 });
  try {
    const result = await execFile(path.join(PROJECT_ROOT, "bin", "kev"), args, {
      cwd: PROJECT_ROOT,
      env,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      timeout,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message,
    };
  }
}

async function writeEvidence(evidence: NativeEvidence): Promise<void> {
  writeFileSync(path.join(EVIDENCE_ROOT!, "native-evidence.json"), JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
}

test("runs both provisioned models through native MLX, the real browser, and the existing API suite", async ({ page, browser }) => {
  test.setTimeout(20 * 60_000);
  const registryHash = createHash("sha256").update(readFileSync(REGISTRY_PATH)).digest("hex");
  expect(registryHash).toBe(REGISTRY_SHA256);
  const evidence: NativeEvidence = {
    registrySha256: registryHash,
    workbenchActions: [],
    models: [],
    consumerHandover: null,
    cleanupErrors: [],
  };
  const actionRequests: Array<{ action: string; body: Record<string, unknown> }> = [];
  const actionResponses: Array<{ action: string; status: number }> = [];
  const externalOrigins = new Set<string>();
  let activePage = page;
  let externalSessionPath: string | null = null;
  let externalConsumerRoot: string | null = null;
  let originalFailure: unknown;

  const observe = (target: Page) => {
    target.on("request", (request) => {
      if (request.url().startsWith(`${APP_ORIGIN}/api/workbench`) && request.method() === "POST") {
        try {
          const body = request.postDataJSON() as Record<string, unknown>;
          if (typeof body.action === "string") actionRequests.push({ action: body.action, body });
        } catch {
          // Only structured workbench actions are relevant to the lifecycle trace.
        }
      }
      if (new URL(request.url()).origin !== APP_ORIGIN) externalOrigins.add(new URL(request.url()).origin);
    });
    target.on("response", (response) => {
      const request = response.request();
      if (!request.url().startsWith(`${APP_ORIGIN}/api/workbench`) || request.method() !== "POST") return;
      try {
        const body = request.postDataJSON() as Record<string, unknown>;
        if (typeof body.action === "string") actionResponses.push({ action: body.action, status: response.status() });
      } catch {
        // Non-JSON responses are not part of the recorded workbench action trace.
      }
    });
  };

  try {
    observe(page);
    await page.goto("/");
    expect((await getSnapshot(page)).runtime.state).toBe("unloaded");
    expect(await nativeEndpoint(page)).toBeNull();

    const consumerRoot = path.join(DATA_ROOT, "consumer-handover");
    externalConsumerRoot = consumerRoot;
    mkdirSync(consumerRoot, { recursive: true, mode: 0o700 });
    const consumerConfig = path.join(consumerRoot, "native-consumer.json");
    writeFileSync(consumerConfig, JSON.stringify({
      schema: "kev-project-tasks/1",
      model: "kev-0.8b",
      tasks: {
        slot_check: {
          description: "Synthetic native slot handover",
          questions: {
            ready: { type: "noul", instructions: "Is this synthetic handover input ready for review?" },
          },
        },
      },
    }, null, 2) + "\n", { mode: 0o600 });

    const opened = await runKevCommand(["open", "--config", consumerConfig], consumerRoot, 6 * 60_000);
    writeFileSync(path.join(EVIDENCE_ROOT, "native-consumer-open.json"), JSON.stringify({ command: ["bin/kev", "open", "--config", consumerConfig], cwd: PROJECT_ROOT, ...opened }, null, 2) + "\n", { mode: 0o600 });
    expect(opened.exitCode).toBe(0);
    const consumerSession = JSON.parse(opened.stdout) as { session: string; state: string; endpoint: string; identity: Record<string, unknown> };
    externalSessionPath = consumerSession.session;
    expect(consumerSession.state).toBe("ready");
    expect(consumerSession.identity).toMatchObject({ model_id: "kev-0.8b", backend: "mlx" });
    const consumerProcesses = await listeningProcessIdentities(consumerSession.endpoint);
    expect(consumerProcesses).toHaveLength(1);
    expect(consumerProcesses[0].executable).toMatch(/python/i);

    await page.getByRole("button", { name: "加载模型" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Another Kev project currently owns the model slot" })).toBeVisible({ timeout: 60_000 });
    expect((await getSnapshot(page)).runtime.state).toBe("unloaded");
    expect(await nativeEndpoint(page)).toBeNull();
    expect(actionResponses.filter(({ action }) => action === "load").at(-1)?.status).toBe(409);

    const closed = await runKevCommand(["close", "--session", externalSessionPath], consumerRoot);
    writeFileSync(path.join(EVIDENCE_ROOT, "native-consumer-close.json"), JSON.stringify({ command: ["bin/kev", "close", "--session", "<owned-session-returned-by-open>"], cwd: PROJECT_ROOT, ...closed }, null, 2) + "\n", { mode: 0o600 });
    expect(closed.exitCode).toBe(0);
    const closeReply = JSON.parse(closed.stdout) as { state: string };
    expect(closeReply.state).toBe("closed");
    await assertProcessReleased(page, consumerSession.endpoint, consumerProcesses[0]);
    externalSessionPath = null;
    externalConsumerRoot = null;
    evidence.consumerHandover = {
      modelId: "kev-0.8b",
      consumerIdentity: safeModelCardIdentity(consumerSession.identity),
      process: consumerProcesses[0],
      consumerEndpointReleased: true,
      workbenchLoadWhileConsumerOwned: 409,
      workbenchAdoptedConsumer: false,
      consumerCloseState: closeReply.state,
    };

    for (const modelId of ["kev-0.8b", "kev-4b"] as const) {
      const modelEvidence: NativeEvidence["models"][number] = {
        modelId,
        endpoint: "",
        identity: null,
        process: null,
        modelCardIdentity: null,
        runs: [],
        apiSuite: null,
        screenshots: [],
        release: null,
      };
      evidence.models.push(modelEvidence);

      const beforeSelection = await getSnapshot(activePage);
      if (beforeSelection.settings.selectedModel !== modelId) {
        await activePage.getByLabel("Selected model").selectOption(modelId);
        await expect.poll(async () => (await getSnapshot(activePage)).settings.selectedModel).toBe(modelId);
      }
      const beforeOperation = await getSnapshot(activePage);
      const previousModel = beforeOperation.runtime.identity?.modelId;
      const willSwitch = beforeOperation.runtime.state === "ready" && previousModel !== modelId;
      const successfulStartsBefore = actionResponses.filter(({ action, status }) => (action === "load" || action === "switch") && status === 200).length;
      if (willSwitch) {
        if (!previousModel) throw new Error("A ready workbench runtime has no actual model identity to switch from.");
        const previousEvidence = evidence.models.find((item) => item.modelId === previousModel);
        if (!previousEvidence?.endpoint || !previousEvidence.process) throw new Error(`Missing owned-process evidence for ${previousModel}.`);
        const switchResponsePromise = activePage.waitForResponse((response) => {
          const request = response.request();
          if (!response.url().endsWith("/api/workbench") || request.method() !== "POST") return false;
          try {
            return (request.postDataJSON() as Record<string, unknown>).action === "switch";
          } catch {
            return false;
          }
        }, { timeout: 10 * 60_000 });
        await activePage.once("dialog", (dialog) => dialog.accept());
        await activePage.getByRole("button", { name: "Switch model" }).click();
        const switchResponse = await switchResponsePromise;
        expect(switchResponse.status()).toBe(200);
        const switched = await switchResponse.json() as BrowserSnapshot;
        expect(switched.runtime).toEqual(expect.objectContaining({ state: "ready", identity: expect.objectContaining({ modelId }) }));
        await expect.poll(async () => {
          const runtime = (await getSnapshot(activePage)).runtime;
          return runtime.state === "ready" ? runtime.identity?.modelId : null;
        }, { timeout: 10 * 60_000, intervals: [1_000, 5_000] }).toBe(modelId);
        await assertProcessReleased(activePage, previousEvidence.endpoint, previousEvidence.process);
        previousEvidence.release = {
          snapshotState: "released-before-new-model-ready",
          endpointAfterClose: null,
          oldEndpointReachable: false,
          listenerReleased: true,
          processGone: true,
        };
        expect(actionResponses.filter(({ action, status }) => action === "switch" && status === 200)).toHaveLength(1);
      } else {
        const loadResponsesBefore = actionResponses.filter(({ action }) => action === "load").length;
        const loadResponsePromise = activePage.waitForResponse((response) => {
          const request = response.request();
          if (!response.url().endsWith("/api/workbench") || request.method() !== "POST") return false;
          try {
            return (request.postDataJSON() as Record<string, unknown>).action === "load";
          } catch {
            return false;
          }
        }, { timeout: 10 * 60_000 });
        await activePage.getByRole("button", { name: "加载模型" }).click();
        const loadResponse = await loadResponsePromise;
        expect(loadResponse.status()).toBe(200);
        await expect(activePage.getByRole("button", { name: "Switch model" })).toBeVisible({ timeout: 60_000 });
        await expect.poll(() => actionResponses.filter(({ action }) => action === "load").length).toBe(loadResponsesBefore + 1);
        expect(actionResponses.filter(({ action }) => action === "load").at(-1)?.status).toBe(200);
      }
      await expect.poll(async () => (await getSnapshot(activePage)).runtime.state, { timeout: 10 * 60_000, intervals: [1_000, 5_000] }).toBe("ready");
      expect(actionResponses.filter(({ action, status }) => (action === "load" || action === "switch") && status === 200)).toHaveLength(successfulStartsBefore + 1);

      const loaded = await getSnapshot(activePage);
      const identity = checkedIdentity(loaded, modelId);
      const endpoint = await nativeEndpoint(activePage);
      expect(endpoint).not.toBeNull();
      if (!endpoint) throw new Error(`No owned native endpoint was reported for ${modelId}.`);
      expect(await endpointResponds(activePage, endpoint)).toBe(true);
      const processIdentities = await listeningProcessIdentities(endpoint);
      expect(processIdentities).toHaveLength(1);
      expect(processIdentities[0].executable).toMatch(/python/i);
      modelEvidence.endpoint = endpoint;
      modelEvidence.identity = identity;
      modelEvidence.process = processIdentities[0];

      const modelCards = await activePage.request.get(`${endpoint}/v1/models`);
      expect(modelCards.status()).toBe(200);
      const cardPayload = await modelCards.json() as { models?: Array<Record<string, unknown>> };
      const card = cardPayload.models?.[0];
      expect(card).toBeDefined();
      const local = card?.local as Record<string, unknown> | undefined;
      expect(local).toBeDefined();
      const cardIdentity = safeModelCardIdentity(local);
      expect(cardIdentity).toEqual({
        model_id: modelId,
        checkpoint: identity.checkpoint,
        base: identity.base,
        backend: identity.backend,
        dtype: identity.dtype,
        device: identity.device,
      });
      modelEvidence.modelCardIdentity = cardIdentity;

      const first = await runSyntheticTask(
        activePage,
        modelId,
        `Native ${modelId} first synthetic run`,
        `Synthetic first state for ${modelId}: one shipment status question and one billing note.`,
        false,
      );
      modelEvidence.runs.push({ request: first.request, record: first.record, trace: `native-${modelId}-run-1.json` });
      const firstHistoryFile = path.join(DATA_ROOT, "history", `${first.record.id}.json`);
      const firstHistoryBytes = readFileSync(firstHistoryFile, "utf8");
      expect(JSON.parse(firstHistoryBytes)).toEqual(expect.objectContaining({ status: "succeeded", state: first.record.state, questions: first.record.questions, modelIdentity: identity }));
      writeFileSync(path.join(EVIDENCE_ROOT, `native-${modelId}-run-1.json`), JSON.stringify({ endpoint, identity, request: first.request, record: first.record }, null, 2) + "\n", { mode: 0o600 });

      const second = await runSyntheticTask(
        activePage,
        modelId,
        `Native ${modelId} second synthetic run`,
        `Synthetic second state for ${modelId}: the return label changed after the first request.`,
        true,
      );
      expect(second.request.questions).not.toEqual(first.request.questions);
      expect(actionResponses.filter(({ action, status }) => (action === "load" || action === "switch") && status === 200)).toHaveLength(successfulStartsBefore + 1);
      modelEvidence.runs.push({ request: second.request, record: second.record, trace: `native-${modelId}-run-2.json` });
      expect(readFileSync(firstHistoryFile, "utf8")).toBe(firstHistoryBytes);
      const secondHistoryFile = path.join(DATA_ROOT, "history", `${second.record.id}.json`);
      expect(JSON.parse(readFileSync(secondHistoryFile, "utf8"))).toEqual(expect.objectContaining({ status: "succeeded", state: second.record.state, questions: second.record.questions, modelIdentity: identity }));
      writeFileSync(path.join(EVIDENCE_ROOT, `native-${modelId}-run-2.json`), JSON.stringify({ endpoint, identity, request: second.request, record: second.record }, null, 2) + "\n", { mode: 0o600 });

      await captureResultScreenshots(activePage, modelId, modelEvidence.screenshots);
      modelEvidence.apiSuite = await runApiCompatibilitySuite(
        modelId,
        endpoint,
        path.join(EVIDENCE_ROOT, `native-${modelId}-api-suite.json`),
      );

      if (modelId === "kev-0.8b") {
        const loadRequestsBeforeClose = actionRequests.filter(({ action }) => action === "load").length;
        await activePage.close();
        activePage = await browser.newPage();
        observe(activePage);
        await activePage.goto("/");
        const reopened = await getSnapshot(activePage);
        expect(reopened.runtime.state).toBe("ready");
        expect(checkedIdentity(reopened, modelId)).toEqual(identity);
        expect(await nativeEndpoint(activePage)).toBe(endpoint);
        expect(reopened.history.map((record) => record.id)).toEqual(expect.arrayContaining([first.record.id, second.record.id]));
        expect(await endpointResponds(activePage, endpoint)).toBe(true);

        const historyButton = activePage.getByRole("button", { name: new RegExp(`Native ${modelId} second synthetic run`) });
        await historyButton.click();
        await activePage.getByRole("button", { name: "Restore to editor" }).click();
        await expect(activePage.getByRole("textbox", { name: "State input" })).toHaveValue(String(second.record.state));
        await expect(activePage.getByLabel("Template name")).toHaveValue(second.record.taskName);
        await expect(activePage.getByLabel("Question category instructions")).toHaveValue(`Use the changed synthetic instructions for the ${modelId} second native run.`);
        expect(actionRequests.filter(({ action }) => action === "run")).toHaveLength(2);
        expect(actionRequests.filter(({ action }) => action === "load")).toHaveLength(loadRequestsBeforeClose);
      } else {
        await activePage.once("dialog", (dialog) => dialog.accept());
        await activePage.getByRole("button", { name: "Stop" }).click();
        await expect(activePage.getByRole("button", { name: "加载模型" })).toBeVisible({ timeout: 60_000 });
        expect((await getSnapshot(activePage)).runtime.state).toBe("unloaded");
        expect(await nativeEndpoint(activePage)).toBeNull();
        await assertProcessReleased(activePage, endpoint, processIdentities[0]!);
        modelEvidence.release = { snapshotState: "unloaded", endpointAfterClose: null, oldEndpointReachable: false, listenerReleased: true, processGone: true };
      }
    }

    expect(externalOrigins).toEqual(new Set());
    const finalHash = createHash("sha256").update(readFileSync(REGISTRY_PATH)).digest("hex");
    expect(finalHash).toBe(REGISTRY_SHA256);
  } catch (error) {
    originalFailure = error;
  } finally {
    if (externalSessionPath) {
      const closed = await runKevCommand(["close", "--session", externalSessionPath], externalConsumerRoot ?? DATA_ROOT!);
      if (closed.exitCode !== 0) evidence.cleanupErrors.push(`Canonical consumer close failed: ${closed.stderr}`);
      else {
        externalSessionPath = null;
        externalConsumerRoot = null;
      }
    }
    try {
      if (activePage.isClosed()) activePage = await browser.newPage();
      if (!activePage.url().startsWith(APP_ORIGIN)) await activePage.goto("/");
      const current = await getSnapshot(activePage);
      if (current.runtime.state === "ready" || current.runtime.state === "recovery") {
        const stopped = await postWorkbench(activePage, { action: "stop", confirmRelease: true });
        if (stopped.status !== 200) evidence.cleanupErrors.push(`Workbench stop returned HTTP ${stopped.status}.`);
        else if ((stopped.body as { runtime?: { state?: string } }).runtime?.state !== "unloaded") {
          evidence.cleanupErrors.push("Workbench did not confirm an unloaded runtime during cleanup.");
        }
      }
    } catch (error) {
      evidence.cleanupErrors.push(error instanceof Error ? error.message : "Workbench cleanup failed.");
    }
    evidence.workbenchActions = actionRequests.map((entry, index) => ({ ...entry, status: actionResponses[index]?.status ?? null }));
    await writeEvidence(evidence);
  }

  if (originalFailure) {
    const message = originalFailure instanceof Error ? originalFailure.message : String(originalFailure);
    throw new Error(evidence.cleanupErrors.length ? `${message}\nCleanup errors: ${evidence.cleanupErrors.join("; ")}` : message);
  }
  expect(evidence.cleanupErrors).toEqual([]);
});
