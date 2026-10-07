import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const DATA_ROOT = process.env.KEV_WORKBENCH_DATA_ROOT;
const EVIDENCE_ROOT = process.env.KEV_WORKBENCH_EVIDENCE_ROOT;

if (!DATA_ROOT || !EVIDENCE_ROOT) throw new Error("Playwright must allocate project-local workbench data and evidence roots.");

const DEFAULT_TASKS = {
  schema: "kev-project-tasks/1",
  model: "kev-4b",
  tasks: {
    "support-review": {
      description: "支持请求",
      questions: {
        category: {
          type: "choice",
          instructions: "Which category best matches this synthetic request?",
          criteria: {
            billing: "A charge, invoice, or payment question",
            delivery: "A shipment, delay, or missing package",
            returns: "A refund, exchange, or damaged item",
          },
        },
        needs_review: {
          type: "noul",
          instructions: "Does this synthetic request need a person to review it?",
          criteria: {
            true: "The request needs individual attention",
            false: "The standard process is enough",
          },
        },
        urgency: {
          type: "score",
          instructions: "How soon should this synthetic request be reviewed?",
          criteria: ["When convenient", "Within a few days", "Today"],
        },
      },
    },
  },
};

type ApiReply = { status: number; body: unknown; cacheControl: string | null };

async function requestFromPage(page: Page, pathname: string, method: "GET" | "POST", body?: unknown): Promise<ApiReply> {
  return page.evaluate(async ({ pathname: pathValue, method: methodValue, body: bodyValue }) => {
    const response = await fetch(pathValue, {
      method: methodValue,
      cache: "no-store",
      ...(bodyValue === undefined ? {} : {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bodyValue),
      }),
    });
    const text = await response.text();
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      decoded = text;
    }
    return { status: response.status, body: decoded, cacheControl: response.headers.get("cache-control") };
  }, { pathname, method, body });
}

async function apiGet(page: Page): Promise<Record<string, unknown>> {
  const reply = await requestFromPage(page, "/api/workbench", "GET");
  expect(reply.status).toBe(200);
  expect(reply.body).toEqual(expect.objectContaining({ settings: expect.any(Object), templates: expect.any(Array), history: expect.any(Array), runtime: expect.any(Object) }));
  return reply.body as Record<string, unknown>;
}

async function apiPost(page: Page, body: unknown, pathname = "/api/workbench"): Promise<ApiReply> {
  return requestFromPage(page, pathname, "POST", body);
}

async function configureRuntime(page: Page, controls: Record<string, unknown>): Promise<void> {
  const reply = await apiPost(page, { action: "configure", ...controls }, "/api/workbench/test");
  expect(reply.status).toBe(200);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await configureRuntime(page, {
    delayMs: 0,
    failure: "none",
    loadFailure: "none",
    closeFailure: false,
    historyWriteFailure: false,
  });

  const previous = await apiGet(page);
  const previousRuntime = previous.runtime as Record<string, unknown>;
  if (previousRuntime.state !== "unloaded") {
    const stopped = await apiPost(page, { action: "stop", confirmRelease: true });
    expect(stopped.status).toBe(200);
  }
  const refreshed = await apiGet(page);
  for (const record of refreshed.history as { id: string }[]) {
    const deleted = await apiPost(page, { action: "delete-history", id: record.id });
    expect(deleted.status).toBe(200);
  }
  const imported = await apiPost(page, { action: "import", content: JSON.stringify(DEFAULT_TASKS) });
  expect(imported.status).toBe(200);
  const settings = await apiPost(page, {
    action: "settings",
    settings: { selectedModel: "kev-4b", exportModel: "kev-4b", theme: "light", projectDescription: null },
  });
  expect(settings.status).toBe(200);
  await page.reload();
  await expect(page.getByRole("heading", { name: "本地模型工作台" })).toBeVisible();
  await page.locator("details[aria-label='Model controls'] > summary").click();
});

test("hydrates responsively with accessible empty, light, and dark states", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await expect(page.getByRole("button", { name: "加载模型" })).toBeVisible();
  await page.getByText("More tools", { exact: true }).click();
  await expect(page.getByRole("link", { name: "Classic Playground" })).toHaveAttribute("href", "/classic");
  await expect(page.getByRole("link", { name: "Chess", exact: true })).toHaveAttribute("href", "/chess");
  await expect(page.getByText("No run selected")).toBeVisible();
  await expect(page.locator("html")).toHaveClass(/light/);
  await expect(page.locator("html")).not.toHaveClass(/dark/);

  const getLayoutMetrics = () => page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    panels: [...document.querySelectorAll("aside[aria-label='Workspace navigation'], section[aria-labelledby='input-heading'], section[aria-label='Run results']")]
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: rect.width, height: rect.height };
      }),
  }));

  await page.setViewportSize({ width: 1440, height: 900 });
  const wide = await getLayoutMetrics();
  expect(wide.document).toBeLessThanOrEqual(wide.viewport);
  expect(wide.panels).toHaveLength(3);
  expect(wide.panels.every((panel) => panel.width > 0 && panel.height > 0 && panel.left >= 0 && panel.right <= wide.viewport)).toBe(true);
  await page.screenshot({ path: path.join(EVIDENCE_ROOT, "deterministic-empty-1440x900-light.png") });

  await page.getByRole("button", { name: "Use dark theme" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.screenshot({ path: path.join(EVIDENCE_ROOT, "deterministic-empty-1440x900-dark.png") });

  await page.setViewportSize({ width: 1024, height: 768 });
  const compact = await getLayoutMetrics();
  expect(compact.document).toBeLessThanOrEqual(compact.viewport);
  expect(compact.panels.every((panel) => panel.width > 0 && panel.height > 0 && panel.left >= 0 && panel.right <= compact.viewport)).toBe(true);
  await page.screenshot({ path: path.join(EVIDENCE_ROOT, "deterministic-empty-1024x768-dark.png") });

  await page.getByRole("button", { name: "Use light theme" }).click();
  await expect(page.locator("html")).toHaveClass(/light/);
  await page.screenshot({ path: path.join(EVIDENCE_ROOT, "deterministic-empty-1024x768-light.png") });

  const getButton = page.getByRole("button", { name: "加载模型" });
  await getButton.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Switch model" })).toBeVisible();
  const runtime = (await apiGet(page)).runtime as Record<string, unknown>;
  expect(runtime.state).toBe("ready");
  expect(runtime.identity).toEqual(expect.objectContaining({ modelId: "kev-4b", backend: "deterministic-test-double" }));
  expect(pageErrors).toEqual([]);
});

test("keeps the selected model distinct and switches the resident model only after confirmation", async ({ page }) => {
  await page.getByLabel("Selected model").selectOption("kev-0.8b");
  await expect.poll(async () => ((await apiGet(page)).settings as Record<string, unknown>).selectedModel).toBe("kev-0.8b");
  await page.getByRole("button", { name: "加载模型" }).click();
  await expect(page.getByRole("button", { name: "Switch model" })).toBeVisible();
  expect((await apiGet(page)).runtime).toEqual(expect.objectContaining({
    state: "ready",
    identity: expect.objectContaining({ modelId: "kev-0.8b", backend: "deterministic-test-double" }),
  }));

  await page.getByLabel("Selected model").selectOption("kev-4b");
  let snapshot = await apiGet(page);
  expect(snapshot.settings).toEqual(expect.objectContaining({ selectedModel: "kev-4b" }));
  expect(snapshot.runtime).toEqual(expect.objectContaining({ state: "ready", identity: expect.objectContaining({ modelId: "kev-0.8b" }) }));
  await expect(page.getByText(/Kev 0\.8B is resident, while Kev 4B is selected/)).toBeVisible();

  await page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Switch model" }).click();
  await expect(page.getByRole("button", { name: "Switch model" })).toBeVisible();
  snapshot = await apiGet(page);
  expect(snapshot.settings).toEqual(expect.objectContaining({ selectedModel: "kev-4b" }));
  expect(snapshot.runtime).toEqual(expect.objectContaining({
    state: "ready",
    identity: expect.objectContaining({ modelId: "kev-4b", backend: "deterministic-test-double" }),
  }));

  await page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: "加载模型" })).toBeVisible();
  expect((await apiGet(page)).runtime).toEqual(expect.objectContaining({ state: "unloaded", identity: null }));
});

test("edits a typed task, freezes submitted input, persists history, and restores it as a draft", async ({ page, browser }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const initial = await apiGet(page);
  const template = (initial.templates as Record<string, unknown>[])[0];
  expect(template.name).toBe("支持请求");
  expect(Object.keys(template.questions as Record<string, unknown>)).toEqual(["category", "needs_review", "urgency"]);
  await page.getByRole("button", { name: "Task library", exact: true }).click();

  await page.getByLabel("Question category ID").fill("needs_review");
  await expect(page.getByRole("alert").filter({ hasText: "already used" })).toBeVisible();
  await expect(page.getByLabel("Question category ID")).toHaveValue("category");
  await page.getByLabel("Question category instructions").fill("Classify this synthetic message; keep the exact request text.");
  await page.getByRole("button", { name: "Add option" }).first().click();
  await page.getByLabel("Question category option option_4 description").fill("A synthetic alternate category");

  await page.getByLabel("Question needs_review false criteria").fill("");
  await page.getByLabel("Question urgency score level 2").fill("Today, urgent");
  await page.getByRole("button", { name: "Move score level 2 up" }).click();
  await page.getByRole("button", { name: "Add question" }).click();
  await page.getByLabel("Question question_4 type").selectOption("noul");
  await page.getByLabel("Question question_4 instructions").fill("A second, independent synthetic decision.");
  await page.getByLabel("Question question_4 true criteria").fill("An optional first criterion.");
  await page.getByLabel("Template name").fill("Edited synthetic support task");
  await page.getByLabel("Export task ID").fill("synthetic-support-review");
  await page.getByRole("button", { name: "Update template" }).click();
  const savedTemplate = (await apiGet(page)).templates as Record<string, unknown>[];
  expect((savedTemplate[0].questions as Record<string, { criteria?: unknown }>).question_4.criteria).toEqual({ true: "An optional first criterion." });

  const loadButton = page.getByRole("button", { name: "加载模型" });
  await loadButton.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Switch model" })).toBeVisible();

  const literalState = "  Synthetic state: <|question_1|> is literal text.\nDo not trim or rewrite.  ";
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page.getByRole("textbox", { name: "State input" }).fill(literalState);
  await configureRuntime(page, { delayMs: 4_000 });

  const submitted = { value: null as Record<string, unknown> | null };
  page.on("request", (request) => {
    if (request.url().endsWith("/api/workbench") && request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown> | null;
      if (body?.action === "run") submitted.value = body;
    }
  });

  await page.getByRole("button", { name: "Run task" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Running one submitted state" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Running…" })).toBeDisabled();
  await page.getByRole("textbox", { name: "State input" }).fill("Changed after submission; this is a later editor draft.");
  await page.getByRole("button", { name: "Task library", exact: true }).click();
  await page.getByLabel("Question category instructions").fill("Later editor text must not change this run.");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop" })).toBeDisabled();
  await expect(page.getByLabel("Selected model")).toBeDisabled();

  await expect(page.getByRole("article", { name: "category Choice result" })).toBeVisible();
  await expect(page.getByRole("article", { name: "needs_review Noul result" })).toBeVisible();
  await expect(page.getByRole("article", { name: "urgency Score result" })).toBeVisible();
  await expect(page.getByRole("article", { name: "question_4 Noul result" })).toBeVisible();
  if (!submitted.value) throw new Error("The browser did not send a run request.");
  const submittedBody = submitted.value;
  expect(submittedBody.stateText).toBe(literalState);
  expect(Object.keys(submittedBody.questions as Record<string, unknown>)).toEqual(["category", "needs_review", "urgency", "question_4"]);
  expect(((submittedBody.questions as Record<string, { criteria?: unknown }>).category.criteria as Record<string, unknown>)).toEqual({
    billing: "A charge, invoice, or payment question",
    delivery: "A shipment, delay, or missing package",
    returns: "A refund, exchange, or damaged item",
    option_4: "A synthetic alternate category",
  });
  expect(((submittedBody.questions as Record<string, { criteria?: unknown }>).urgency.criteria)).toEqual(["When convenient", "Today, urgent", "Within a few days"]);
  expect(((submittedBody.questions as Record<string, { criteria?: unknown }>).needs_review.criteria)).toEqual({ true: "The request needs individual attention" });
  expect(((submittedBody.questions as Record<string, { criteria?: unknown }>).question_4.criteria)).toEqual({ true: "An optional first criterion." });

  await page.getByRole("button", { name: "Inspect raw" }).click();
  const raw = await page.getByRole("region", { name: "Raw request and response" }).innerText();
  expect(raw).toContain(JSON.stringify(literalState).slice(1, -1));
  expect(raw).toContain('"latency_ms": 42');

  const complete = await apiGet(page);
  const record = (complete.history as Record<string, unknown>[])[0];
  expect(record.status).toBe("succeeded");
  expect(record.state).toBe(literalState);
  expect(record.taskId).toBe("synthetic-support-review");
  expect(record.taskName).toBe("Edited synthetic support task");
  expect(record.modelIdentity).toEqual(expect.objectContaining({ modelId: "kev-4b", backend: "deterministic-test-double" }));
  expect(record.response).toEqual(expect.objectContaining({ model: "kev-4b", answers: expect.any(Object), usage: expect.any(Object), latency_ms: 42 }));

  const historyPath = path.join(DATA_ROOT, "history", `${record.id}.json`);
  expect(existsSync(historyPath)).toBe(true);
  expect(statSync(historyPath).mode & 0o777).toBe(0o600);
  const persisted = JSON.parse(readFileSync(historyPath, "utf8")) as Record<string, unknown>;
  expect(persisted.state).toBe(literalState);
  expect(persisted.questions).toEqual(record.questions);
  writeFileSync(path.join(EVIDENCE_ROOT, "submitted-request-snapshot.json"), JSON.stringify({ submittedBody, record, persisted }, null, 2));

  const reopened = await browser.newContext();
  const reopenedPage = await reopened.newPage();
  await reopenedPage.goto("/");
  const reopenedSnapshot = await apiGet(reopenedPage);
  expect((reopenedSnapshot.history as Record<string, unknown>[]).map((item) => item.id)).toContain(record.id);
  expect((reopenedSnapshot.runtime as Record<string, unknown>).state).toBe("ready");
  const browserStorage = await reopenedPage.evaluate(async () => ({
    localStorage: localStorage.length,
    cookie: document.cookie,
    databases: (await indexedDB.databases()).map((database) => database.name ?? ""),
  }));
  expect(browserStorage.localStorage).toBe(0);
  expect(browserStorage.cookie).toBe("");
  expect(browserStorage.databases.filter((name) => /kev|workbench|history|template/i.test(name))).toEqual([]);
  await reopened.close();

  const refreshedTemplate = page.getByLabel("Template name");
  await page.getByRole("button", { name: "Task library", exact: true }).click();
  await refreshedTemplate.fill("New version; old history stays frozen");
  await page.getByRole("button", { name: "Update template" }).click();
  const afterTemplateEdit = await apiGet(page);
  const unchangedRecord = (afterTemplateEdit.history as Record<string, unknown>[]).find((item) => item.id === record.id);
  expect(unchangedRecord).toEqual(record);

  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.getByRole("button", { name: /Edited synthetic support task/ }).click();
  await page.getByRole("button", { name: "Restore to draft" }).click();
  await expect(page.getByRole("textbox", { name: "State input" })).toHaveValue(literalState);
  await expect(page.getByRole("combobox", { name: "Saved task" })).toHaveValue("restored");
  expect(((await apiGet(page)).history as Record<string, unknown>[])).toHaveLength(1);

  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.getByRole("button", { name: "Rerun snapshot" }).click();
  await expect(page.getByText("Typed results")).toBeVisible();
  await expect.poll(async () => ((await apiGet(page)).history as Record<string, unknown>[]).length).toBe(2);

  const historyDeleteButton = page.getByRole("button", { name: "Delete run" });
  await page.once("dialog", (dialog) => dialog.accept());
  await historyDeleteButton.click();
  await expect.poll(async () => ((await apiGet(page)).history as Record<string, unknown>[]).length).toBe(1);
  expect(pageErrors).toEqual([]);
});

test("imports structured multi-task configs, exports them portably, and rejects invalid imports atomically", async ({ page, browser }) => {
  await page.getByRole("button", { name: "Task library", exact: true }).click();
  const fixture = {
    schema: "kev-project-tasks/1",
    model: "kev-0.8b",
    description: "Synthetic portable task set",
    tasks: {
      alpha: {
        description: "Alpha synthetic review",
        questions: {
          zeta: {
            type: "choice",
            instructions: { style: "structured", order: ["first", "second"] },
            criteria: {
              second: { label: "Second", metadata: { priority: 2 } },
              first: null,
            },
          },
          check: { type: "noul", criteria: { true: ["yes", { source: "fixture" }], false: null } },
        },
      },
      beta: {
        description: "Beta score task",
        questions: {
          quality: {
            type: "score",
            instructions: "Use these synthetic ordered levels.",
            criteria: [{ label: "low", rank: 0 }, "middle", { label: "high", rank: 2 }],
          },
        },
      },
    },
  };

  await page.getByLabel("Import task configuration").setInputFiles({
    name: "synthetic-tasks.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await expect(page.getByRole("status").filter({ hasText: "Imported 2 task templates" })).toBeVisible();
  let snapshot = await apiGet(page);
  expect((snapshot.templates as Record<string, unknown>[]).map((item) => item.taskId)).toEqual(["alpha", "beta"]);
  expect((snapshot.settings as Record<string, unknown>).selectedModel).toBe("kev-0.8b");
  const alpha = (snapshot.templates as Record<string, unknown>[])[0];
  const alphaQuestions = alpha.questions as Record<string, { instructions?: unknown; criteria?: unknown }>;
  expect(alphaQuestions.zeta.instructions).toEqual({ style: "structured", order: ["first", "second"] });
  expect(Object.keys(alphaQuestions.zeta.criteria as Record<string, unknown>)).toEqual(["second", "first"]);
  expect((alphaQuestions.check.criteria as Record<string, unknown>).false).toBeNull();

  const invalidBefore = readFileSync(path.join(DATA_ROOT, "workbench.json"), "utf8");
  await page.getByLabel("Import task configuration").setInputFiles({
    name: "invalid-tasks.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ ...fixture, schema: "kev-project-tasks/unknown" })),
  });
  await expect(page.getByRole("alert").filter({ hasText: "schema must be" })).toBeVisible();
  expect(readFileSync(path.join(DATA_ROOT, "workbench.json"), "utf8")).toBe(invalidBefore);

  await page.getByLabel("Export model").selectOption("kev-4b");
  const exportResponse = page.waitForResponse((response) => {
    const request = response.request();
    return response.url().endsWith("/api/workbench") && request.method() === "POST" && request.postData()?.includes('"action":"export"') === true;
  });
  await page.getByRole("button", { name: "Export" }).click();
  const response = await exportResponse;
  expect(response.status()).toBe(200);
  const exported = await response.json() as { file: string; snapshot: Record<string, unknown> };
  expect(exported.file).toMatch(/^exports\/kev-project-tasks-.*\.json$/);
  const exportedPath = path.join(DATA_ROOT, exported.file);
  const exportedText = readFileSync(exportedPath, "utf8");
  const exportedConfig = JSON.parse(exportedText) as Record<string, unknown>;
  expect(exportedConfig).toEqual({
    schema: "kev-project-tasks/1",
    description: "Synthetic portable task set",
    model: "kev-4b",
    tasks: fixture.tasks,
  });
  expect(exportedText).not.toContain(DATA_ROOT);
  expect(exportedText).not.toContain("checkpoint");
  expect(exportedText).not.toContain("revision");
  expect(exported.snapshot.settings).toEqual(expect.objectContaining({ exportModel: "kev-4b" }));

  const reopened = await browser.newContext();
  const reopenedPage = await reopened.newPage();
  await reopenedPage.goto("/");
  snapshot = await apiGet(reopenedPage);
  expect((snapshot.templates as Record<string, unknown>[]).map((item) => item.taskId)).toEqual(["alpha", "beta"]);
  expect((snapshot.settings as Record<string, unknown>).selectedModel).toBe("kev-0.8b");
  await reopened.close();
});

test("reports load, inference, persistence, and close failures without inventing a ready or saved result", async ({ page }) => {
  await configureRuntime(page, { loadFailure: "busy" });
  await page.getByRole("button", { name: "加载模型" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Another Kev project currently owns the model slot" })).toBeVisible();
  expect((await apiGet(page)).runtime).toEqual(expect.objectContaining({ state: "unloaded" }));

  await configureRuntime(page, { loadFailure: "unavailable" });
  await page.getByRole("button", { name: "加载模型" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "prerequisites are unavailable" })).toBeVisible();

  await configureRuntime(page, { loadFailure: "startup" });
  await page.getByRole("button", { name: "加载模型" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Model startup failed" })).toBeVisible();
  expect((await apiGet(page)).runtime).toEqual(expect.objectContaining({ state: "unloaded" }));

  await configureRuntime(page, { loadFailure: "none" });
  await page.getByRole("button", { name: "加载模型" }).click();
  await expect(page.getByRole("button", { name: "Switch model" })).toBeVisible();
  await page.getByRole("textbox", { name: "State input" }).fill("Synthetic controlled failure input");

  await configureRuntime(page, { failure: "run" });
  await page.getByRole("button", { name: "Run task" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "deterministic model returned a controlled failure" })).toBeVisible();
  let snapshot = await apiGet(page);
  expect((snapshot.history as Record<string, unknown>[])[0].status).toBe("failed");

  await configureRuntime(page, { failure: "length" });
  await page.getByRole("button", { name: "Run task" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Nothing was silently shortened" })).toBeVisible();
  snapshot = await apiGet(page);
  expect((snapshot.history as Record<string, unknown>[])[0].failure).toEqual(expect.objectContaining({ category: "rejected_length" }));

  await configureRuntime(page, { failure: "stale" });
  await page.getByRole("button", { name: "Run task" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "saved model session is stale" })).toBeVisible();
  snapshot = await apiGet(page);
  expect((snapshot.history as Record<string, unknown>[])[0].failure).toEqual(expect.objectContaining({ category: "stale_runtime" }));

  await configureRuntime(page, { failure: "none", historyWriteFailure: true });
  await page.getByRole("button", { name: "Run task" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "history could not be saved" })).toBeVisible();
  snapshot = await apiGet(page);
  const interruptedRecord = (snapshot.history as Record<string, unknown>[])[0];
  expect(interruptedRecord.status).toBe("interrupted");
  expect(interruptedRecord.response).toBeUndefined();
  expect(interruptedRecord.failure).toEqual(expect.objectContaining({ category: "interrupted" }));
  const interruptedFile = path.join(DATA_ROOT, "history", `${interruptedRecord.id}.json`);
  expect(JSON.parse(readFileSync(interruptedFile, "utf8"))).toEqual(expect.objectContaining({
    status: "interrupted",
    failure: expect.objectContaining({ category: "interrupted" }),
  }));
  expect((await apiGet(page)).history).toEqual(expect.any(Array));

  await configureRuntime(page, { historyWriteFailure: false });
  const interrupted = await apiPost(page, { action: "interrupt-run" }, "/api/workbench/test");
  expect(interrupted.status).toBe(200);
  snapshot = await apiGet(page);
  expect((snapshot.history as Record<string, unknown>[]).some((record) => record.status === "interrupted")).toBe(true);

  await configureRuntime(page, { closeFailure: true });
  await page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "could not confirm model shutdown" })).toBeVisible();
  expect((await apiGet(page)).runtime).toEqual(expect.objectContaining({ state: "ready" }));

  await configureRuntime(page, { closeFailure: false });
  await page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: "加载模型" })).toBeVisible();
  expect((await apiGet(page)).runtime).toEqual(expect.objectContaining({ state: "unloaded" }));
});

test("serializes duplicate loads and stop requests, rejects cross-origin calls and confines symlinks", async ({ page }) => {
  const nativeTestRoute = await page.request.get("http://127.0.0.1:3001/api/workbench/test");
  expect(nativeTestRoute.status()).toBe(404);

  const simultaneousLoads = await page.evaluate(async () => {
    const responses = await Promise.all([
    fetch("/api/workbench", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "load", model: "kev-4b" }) }),
    fetch("/api/workbench", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "load", model: "kev-4b" }) }),
    ]);
    return Promise.all(responses.map(async (response) => ({ status: response.status, body: await response.json() })));
  });
  expect(simultaneousLoads.map((item) => item.status)).toEqual([200, 200]);
  const testSession = JSON.parse(readFileSync(path.join(DATA_ROOT, "runtime", "test-session.json"), "utf8")) as Record<string, unknown>;
  expect(testSession).toEqual(expect.objectContaining({ model: "kev-4b", state: "ready" }));
  await page.reload();
  expect((await apiGet(page)).runtime).toEqual(expect.objectContaining({ state: "ready", identity: expect.objectContaining({ modelId: "kev-4b" }) }));

  await page.getByRole("textbox", { name: "State input" }).fill("One synthetic request; switch waits for the frozen run.");
  await expect(page.getByRole("button", { name: "Run task" })).toBeEnabled();
  await configureRuntime(page, { delayMs: 2_500 });
  const capturedRun = { value: null as Record<string, unknown> | null };
  page.on("request", (request) => {
    if (request.url().endsWith("/api/workbench") && request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown> | null;
      if (body?.action === "run") capturedRun.value = body;
    }
  });
  await page.getByRole("button", { name: "Run task" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Running one submitted state" })).toBeVisible();

  const stop = apiPost(page, { action: "stop", confirmRelease: true });
  await expect(page.getByRole("article", { name: "category Choice result" })).toBeVisible();
  const stopped = await stop;
  expect(stopped.status).toBe(200);
  expect(capturedRun.value?.stateText).toBe("One synthetic request; switch waits for the frozen run.");
  const afterRun = await apiGet(page);
  expect((afterRun.history as Record<string, unknown>[])[0]).toEqual(expect.objectContaining({
    status: "succeeded",
    state: "One synthetic request; switch waits for the frozen run.",
    modelIdentity: expect.objectContaining({ modelId: "kev-4b" }),
  }));
  expect((stopped.body as Record<string, unknown>).runtime).toEqual(expect.objectContaining({ state: "unloaded" }));

  const noStore = await page.request.get("http://127.0.0.1:3001/api/workbench");
  expect(noStore.headers()["cache-control"]).toContain("no-store");
  const forbidden = await page.request.post("http://127.0.0.1:3001/api/workbench", {
    headers: { origin: "http://evil.invalid", "content-type": "application/json" },
    data: { action: "settings", settings: { theme: "dark" } },
  });
  expect(forbidden.status()).toBe(403);
  const traversal = await apiPost(page, { action: "delete-history", id: "../../etc/passwd" });
  expect(traversal.status).toBe(400);

  const publicSnapshot = await apiGet(page);
  expect(JSON.stringify(publicSnapshot)).not.toMatch(/owner_token|sessionPath|recoverySessionPath|runtime\.log/);

  const sentinel = path.join(path.dirname(DATA_ROOT), `sentinel-${randomUUID()}.json`);
  const linkId = "11111111-1111-4111-8111-111111111111";
  const historyLink = path.join(DATA_ROOT, "history", `${linkId}.json`);
  mkdirSync(path.dirname(historyLink), { recursive: true });
  writeFileSync(sentinel, '{"private":"sentinel remains intact"}\n', { mode: 0o600, flag: "wx" });
  try {
    symlinkSync(sentinel, historyLink);
    const withLink = await apiGet(page);
    expect((withLink.history as Record<string, unknown>[]).some((record) => record.id === linkId)).toBe(false);
    const deleteLink = await apiPost(page, { action: "delete-history", id: linkId });
    expect(deleteLink.status).toBe(500);
    expect(readFileSync(sentinel, "utf8")).toBe('{"private":"sentinel remains intact"}\n');
  } finally {
    if (existsSync(historyLink)) unlinkSync(historyLink);
    if (existsSync(sentinel)) unlinkSync(sentinel);
  }
});

test("separates saved execution, unfinished library edits, result provenance and deleted-template restores", async ({ page, browser }) => {
  const before = await apiGet(page);
  const saved = (before.templates as { id: string; questions: unknown }[])[0];
  await page.getByRole("button", { name: "加载模型" }).click();
  await expect(page.getByRole("button", { name: "Switch model" })).toBeVisible();
  await page.getByRole("textbox", { name: "State input" }).fill("Unfinished run input");
  await page.getByRole("button", { name: "Task library", exact: true }).click();
  await page.getByLabel("Question category instructions").fill("UNSAVED library questions must not leak to Run");
  await page.getByRole("button", { name: "Advanced JSON", exact: true }).click();
  await page.getByRole("textbox", { name: /Questions JSON/ }).fill("{ unfinished advanced draft");
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "State input" })).toHaveValue("Unfinished run input");
  await expect(page.getByLabel("Template name")).not.toBeVisible();
  await expect(page.getByLabel("Import task configuration")).not.toBeVisible();
  await page.getByRole("button", { name: "JSON", exact: true }).click();
  await page.getByRole("textbox", { name: "State input" }).fill("{ invalid");
  await expect(page.getByRole("alert").filter({ hasText: "Object keys must be strings" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run task" })).toBeDisabled();
  await page.getByRole("textbox", { name: "State input" }).fill('{"synthetic":"literal JSON"}');
  await page.getByRole("button", { name: "Run task" }).click();
  await expect(page.getByRole("article", { name: "category Choice result" })).toBeVisible();
  let current = await apiGet(page);
  const first = (current.history as Record<string, unknown>[])[0];
  expect(first.questions).toEqual(saved.questions);
  expect(first.state).toEqual({ synthetic: "literal JSON" });
  await page.getByRole("textbox", { name: "State input" }).fill('{"later":"input"}');
  await expect(page.getByLabel("Result provenance")).toContainText(String(first.id));
  await page.getByRole("button", { name: "Task library", exact: true }).click();
  await expect(page.getByRole("textbox", { name: /Questions JSON/ })).toHaveValue("{ unfinished advanced draft");
  await page.getByRole("button", { name: "Close JSON editor", exact: true }).click();
  await expect(page.getByLabel("Question category instructions")).toHaveValue("UNSAVED library questions must not leak to Run");
  await page.getByRole("button", { name: "Create new task template" }).click();
  await page.getByLabel("Template name").fill("Task B synthetic");
  await page.getByLabel("Export task ID").fill("task-b");
  await page.getByRole("button", { name: "Save template", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Template saved");
  current = await apiGet(page);
  const second = (current.templates as { id: string; name: string }[]).find((item) => item.name === "Task B synthetic")!;
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page.getByRole("combobox", { name: "Saved task", exact: true }).selectOption(second.id);
  await expect(page.getByLabel("Result provenance")).toContainText(String(first.taskName));
  await expect(page.getByLabel("Result provenance")).not.toContainText("Task B synthetic");
  await page.getByRole("button", { name: "Task library", exact: true }).click();
  await page.getByRole("button", { name: /支持请求/ }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete template" }).click();
  await expect.poll(async () => (await apiGet(page)).templates).toEqual([expect.objectContaining({ id: second.id })]);
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.getByRole("button", { name: /支持请求/ }).click();
  await page.getByRole("button", { name: "Restore to draft" }).click();
  await expect(page.getByRole("combobox", { name: "Saved task", exact: true })).toHaveValue("restored");
  expect((await apiGet(page)).history).toEqual([first]);
  await page.getByRole("button", { name: "Run task" }).click();
  await expect.poll(async () => ((await apiGet(page)).history as unknown[]).length).toBe(2);
  const after = await apiGet(page);
  expect((after.history as Record<string, unknown>[])[0].questions).toEqual(first.questions);
  expect((after.history as Record<string, unknown>[])[0].state).toEqual(first.state);
  expect(after.templates).toEqual([expect.objectContaining({ id: second.id })]);
  const reopened = await browser.newContext();
  const nextPage = await reopened.newPage();
  await nextPage.goto("/");
  await expect(nextPage.getByRole("combobox", { name: "Saved task", exact: true })).toHaveValue(second.id);
  expect((await apiGet(nextPage)).history).toEqual(after.history);
  await reopened.close();
  writeFileSync(path.join(EVIDENCE_ROOT, "state-boundaries.json"), JSON.stringify({ before, first, after }, null, 2));
});

test("captures synthetic visual states, canonical displayed values and keyboard navigation", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.locator("details[aria-label='Model controls'] > summary").click();
  await expect(page.getByRole("button", { name: "加载模型" })).not.toBeVisible();
  const capture = async (state: string) => {
    for (const [width, height] of [[1440, 900], [1024, 768], [600, 800]]) {
      await page.setViewportSize({ width, height });
      for (const theme of ["light", "dark"] as const) {
        if (!await page.locator("html").evaluate((node, value) => node.classList.contains(value), theme)) {
          await page.getByRole("button", { name: theme === "light" ? "Use light theme" : "Use dark theme" }).click();
        }
        await expect(page.locator("html")).toHaveClass(new RegExp(theme));
        await expect.poll(() => page.getByRole("button", { name: "Task library", exact: true }).evaluate((element) => getComputedStyle(element).color === getComputedStyle(document.querySelector("main")!).color)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        await page.screenshot({ path: path.join(EVIDENCE_ROOT, `synthetic-ux-${state}-${width}x${height}-${theme}.png`), fullPage: true });
      }
    }
  };
  await capture("empty");
  const libraryNav = page.getByRole("button", { name: "Task library", exact: true });
  await libraryNav.focus();
  await expect(libraryNav).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Task library", exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(EVIDENCE_ROOT, "synthetic-task-library.png"), fullPage: true });
  await page.getByRole("button", { name: "Run", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.locator("details[aria-label='Model controls'] > summary").focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "加载模型" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Switch model" })).toBeVisible();
  await page.locator("details[aria-label='Model controls'] > summary").click();
  await page.getByLabel("State input", { exact: true }).fill("Synthetic visual and canonical result verification");
  await configureRuntime(page, { failure: "run" });
  await page.getByRole("button", { name: "Run task" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Run not completed", { exact: true })).toBeVisible();
  await capture("error");
  await configureRuntime(page, { failure: "none", delayMs: 5000 });
  await page.getByRole("button", { name: "Run task" }).click();
  await expect(page.getByRole("button", { name: "Running…" })).toBeDisabled();
  // Theme persistence shares the mutation gate while running; capture each theme in a separate delayed run.
  for (const theme of ["dark", "light"] as const) {
    if (theme === "light") {
      await expect(page.getByRole("article", { name: "category Choice result" })).toBeVisible();
      await page.getByRole("button", { name: "Use light theme" }).click();
      await page.getByRole("button", { name: "Run task" }).click();
    }
    for (const [width, height] of [[1440, 900], [1024, 768]]) {
      await page.setViewportSize({ width, height });
      await page.screenshot({ path: path.join(EVIDENCE_ROOT, `synthetic-ux-loading-${width}x${height}-${theme}.png`), fullPage: true });
    }
  }
  await expect(page.getByRole("article", { name: "category Choice result" })).toBeVisible();
  const snapshot = await apiGet(page);
  const record = (snapshot.history as { response: { answers: Record<string, Record<string, unknown>>; usage: { input_tokens: number; output_tokens: number }; latency_ms: number } }[])[0];
  const answers = record.response.answers;
  await expect(page.getByRole("article", { name: "category Choice result" })).toContainText(String(answers.category.choice));
  await expect(page.getByRole("article", { name: "category Choice result" })).toContainText(`confidence ${Number(answers.category.confidence).toFixed(3)}`);
  await expect(page.getByRole("article", { name: "needs_review Noul result" })).toContainText(`p(yes) ${Number(answers.needs_review.noul).toFixed(3)}`);
  await expect(page.getByRole("article", { name: "urgency Score result" })).toContainText(`Expected level ${Number(answers.urgency.score).toFixed(3)}`);
  for (const [id, kind] of [["category", "Choice"], ["urgency", "Score"]]) {
    for (const probability of Object.values(answers[id].probabilities as Record<string, number>)) {
      await expect(page.getByRole("article", { name: `${id} ${kind} result` })).toContainText(probability.toFixed(3));
    }
  }
  await expect(page.getByRole("article", { name: "needs_review Noul result" })).toContainText((1 - Number(answers.needs_review.noul)).toFixed(3));
  await expect(page.getByText(`${record.response.usage.input_tokens} input tokens`, { exact: true })).toBeVisible();
  await expect(page.getByText(`${record.response.usage.output_tokens} output tokens`, { exact: true })).toBeVisible();
  await expect(page.getByText(`${record.response.latency_ms.toFixed(1)} ms`, { exact: true })).toBeVisible();
  await expect(page.getByText("Checkpoint", { exact: true })).not.toBeVisible();
  await expect(page.getByRole("region", { name: "Raw request and response" })).not.toBeVisible();
  await capture("success");
  await page.getByRole("button", { name: "Inspect raw" }).click();
  await expect(page.getByRole("region", { name: "Raw request and response" })).toContainText('"latency_ms": 42');
  await page.getByText("Actual model details", { exact: true }).click();
  await expect(page.getByText("Checkpoint", { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(EVIDENCE_ROOT, "synthetic-secondary-details.png"), fullPage: true });
  await page.getByRole("button", { name: "History", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.screenshot({ path: path.join(EVIDENCE_ROOT, "synthetic-history.png"), fullPage: true });
  await page.getByText("More tools", { exact: true }).click();
  await expect(page.getByRole("link", { name: "Classic Playground" })).toHaveAttribute("href", "/classic");
  await expect(page.getByRole("link", { name: "Chess", exact: true })).toHaveAttribute("href", "/chess");
  await page.screenshot({ path: path.join(EVIDENCE_ROOT, "synthetic-more-tools.png"), fullPage: true });
  expect(errors.filter((error) => error !== "Failed to load resource: the server responded with a status of 503 (Service Unavailable)")).toEqual([]);
  expect(errors.filter((error) => error === "Failed to load resource: the server responded with a status of 503 (Service Unavailable)")).toHaveLength(1);
  writeFileSync(path.join(EVIDENCE_ROOT, "visual-keyboard-canonical.json"), JSON.stringify({ errors, snapshot, keyboard: ["navigation", "model expansion/load", "run"] }, null, 2));
});

test("opens pre-redesign persisted synthetic records unchanged and keeps long distributions inspectable", async ({ page }) => {
  const appBytes = readFileSync(path.join(process.cwd(), "tests/workbench/fixtures/pre-redesign-workbench.json"), "utf8");
  const runBytes = readFileSync(path.join(process.cwd(), "tests/workbench/fixtures/pre-redesign-run.json"), "utf8");
  const app = JSON.parse(appBytes) as { templates: { id: string }[] };
  const run = JSON.parse(runBytes) as { id: string; state: string };
  writeFileSync(path.join(DATA_ROOT, "workbench.json"), appBytes, { mode: 0o600 });
  writeFileSync(path.join(DATA_ROOT, "history", `${run.id}.json`), runBytes, { mode: 0o600 });
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Saved task", exact: true })).toHaveValue(app.templates[0].id);
  const opened = await apiGet(page);
  expect(opened.templates).toEqual(app.templates);
  expect(opened.history).toEqual([run]);
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.getByRole("button", { name: /支持请求/ }).click();
  await expect(page.getByLabel("Result provenance")).toContainText(run.id);
  await page.getByRole("button", { name: "Restore to draft" }).click();
  await expect(page.getByLabel("State input", { exact: true })).toHaveValue(run.state);
  expect(readFileSync(path.join(DATA_ROOT, "history", `${run.id}.json`), "utf8")).toBe(runBytes);
  expect(readFileSync(path.join(DATA_ROOT, "workbench.json"), "utf8")).toBe(appBytes);
  writeFileSync(path.join(EVIDENCE_ROOT, "pre-redesign-readback.json"), JSON.stringify(opened, null, 2));

  const longLabel = "A long synthetic ordered level label that must remain readable without relying on a truncated legend or pointer hover";
  const imported = await apiPost(page, { action: "import", content: JSON.stringify({ schema: "kev-project-tasks/1", model: "kev-4b", tasks: { long: { questions: { long_score: { type: "score", criteria: [longLabel, "Other level"] } } } } }) });
  expect(imported.status).toBe(200);
  await page.reload();
  await page.locator("details[aria-label='Model controls'] > summary").click();
  await page.getByRole("button", { name: "加载模型" }).click();
  await expect(page.getByRole("button", { name: "Switch model" })).toBeVisible();
  await page.locator("details[aria-label='Model controls'] > summary").click();
  await page.getByLabel("State input", { exact: true }).fill("Synthetic long-label input");
  await page.getByRole("button", { name: "Run task" }).click();
  const label = page.getByRole("article", { name: "long_score Score result" }).getByText(`0 · ${longLabel}`, { exact: true });
  await expect(label).toBeVisible();
  expect(await label.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: path.join(EVIDENCE_ROOT, "synthetic-long-label.png"), fullPage: true });
});

test("keeps dark navigation and input colors in the workbench theme scope", async ({ page }) => {
  await page.getByRole("button", { name: "Use dark theme" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect.poll(() => page.getByRole("button", { name: "Task library", exact: true }).evaluate((element) => getComputedStyle(element).color === getComputedStyle(document.querySelector("main")!).color)).toBe(true);
  const styles = await page.evaluate(() => {
    const inspect = (element: Element) => {
      const style = getComputedStyle(element);
      return { tag: element.tagName, classes: element.className, color: style.color, background: style.backgroundColor, foreground: style.getPropertyValue("--foreground"), secondary: style.getPropertyValue("--secondary"), input: style.getPropertyValue("--input") };
    };
    return { html: inspect(document.documentElement), body: inspect(document.body), main: inspect(document.querySelector("main")!), nav: inspect(document.querySelector("nav button:nth-child(2)")!), input: inspect(document.querySelector("#state-input")!) };
  });
  writeFileSync(path.join(EVIDENCE_ROOT, "dark-theme-styles.json"), JSON.stringify(styles, null, 2));
  expect(styles.nav.color).toBe(styles.main.color);
  expect(styles.input.foreground).toBe(styles.main.foreground);
});
