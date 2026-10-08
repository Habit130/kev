import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { WorkbenchSnapshot } from "../../src/lib/workbench/service";
import type { HistoryRecord } from "../../src/lib/workbench/storage";
import { chinese, type Copy } from "../../src/lib/workbench/translations";
import { formatNumber, formatTime, type Locale } from "../../src/lib/workbench/locale";

const data = process.env.KEV_WORKBENCH_DATA_ROOT!;
const evidence = process.env.KEV_WORKBENCH_EVIDENCE_ROOT!;
if (!data || !evidence) throw new Error("Use the isolated deterministic workbench runner.");
const appFile = path.join(data, "workbench.json");
const fixture = (name: string) => readFileSync(path.join(process.cwd(), "tests/workbench/fixtures", name), "utf8");
const label = (locale: Locale, copy: Copy) => locale === "en" ? copy : chinese[copy];

async function post(page: Page, body: unknown, route = "/api/workbench") {
  return page.evaluate(async ({ body, route }) => {
    const response = await fetch(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }, { body, route });
}
async function snapshot(page: Page): Promise<WorkbenchSnapshot> {
  return page.evaluate(async () => (await fetch("/api/workbench", { cache: "no-store" })).json());
}
async function controls(page: Page, values: Record<string, unknown>) {
  expect((await post(page, { action: "configure", ...values }, "/api/workbench/test")).status).toBe(200);
}
async function switchLanguage(page: Page, locale: Locale) {
  await page.getByRole("button", { name: locale === "en" ? "English" : "简体中文", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", locale);
  await expect(page.getByRole("button", { name: locale === "en" ? "English" : "简体中文", exact: true })).toBeEnabled();
}
async function modelControls(page: Page, locale: Locale) {
  const summary = page.locator(`details[aria-label='${label(locale, "Model controls")}'] > summary`);
  if (!(await summary.evaluate((element) => element.parentElement!.hasAttribute("open")))) await summary.click();
}
async function load(page: Page, locale: Locale) {
  await modelControls(page, locale);
  await page.getByRole("button", { name: label(locale, "Load model"), exact: true }).click();
  await expect(page.getByRole("button", { name: label(locale, "Switch model"), exact: true })).toBeVisible();
}
async function capture(page: Page, name: string) {
  await page.screenshot({ path: path.join(evidence, `synthetic-lang-${name}.png`), fullPage: true });
  writeFileSync(path.join(evidence, `lang-${name}.json`), JSON.stringify({ aria: await page.locator("body").ariaSnapshot(), snapshot: await snapshot(page) }, null, 2));
}
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await controls(page, { delayMs: 0, failure: "none", loadFailure: "none", closeFailure: false, historyWriteFailure: false, settingsWriteFailure: false });
  expect((await post(page, { action: "stop", confirmRelease: true })).status).toBe(200);
  const old = await snapshot(page);
  for (const record of old.history) expect((await post(page, { action: "delete-history", id: record.id })).status).toBe(200);
  // Copy immutable historical fixture bytes into this invocation's synthetic store only.
  writeFileSync(appFile, fixture("pre-redesign-workbench.json"));
  await page.reload();
  await expect(page.getByRole("heading", { name: "本地模型工作台", exact: true })).toBeVisible();
});

test("LANG-DEFAULT: Chinese defaults, legacy/unsupported locale, persistence and failed-save retry", async ({ page, browser }) => {
  const original = await snapshot(page);
  expect(original.settings.locale).toBe("zh-CN");
  expect(await page.evaluate(() => navigator.language)).not.toBe("zh-CN");
  await expect(page.getByRole("button", { name: "简体中文", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("界面语言").getByRole("button")).toHaveText(["简体中文", "English"]);
  for (const view of ["运行", "任务库", "历史记录"]) {
    await page.getByRole("button", { name: view, exact: true }).click();
    await expect(page.getByLabel("界面语言")).toBeVisible();
  }
  await switchLanguage(page, "en");
  await page.reload();
  await expect(page.getByRole("button", { name: "English", exact: true })).toHaveAttribute("aria-pressed", "true");
  const context = await browser.newContext({ locale: "fr-FR" });
  const fresh = await context.newPage();
  await fresh.goto("http://127.0.0.1:3001/");
  await expect(fresh.getByRole("button", { name: "English", exact: true })).toHaveAttribute("aria-pressed", "true");
  await context.close();
  const after = await snapshot(page);
  expect(after.templates).toEqual(original.templates);
  expect({ ...after.settings, locale: "zh-CN" }).toEqual(original.settings);
  await controls(page, { settingsWriteFailure: true });
  await page.getByRole("button", { name: "简体中文", exact: true }).click();
  await expect(page.locator("main [role='alert']")).toContainText("Could not save or read local data");
  await expect(page.getByRole("button", { name: "English", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect((await snapshot(page)).settings.locale).toBe("en");
  await capture(page, "failed-language-save-en");
  await controls(page, { settingsWriteFailure: false });
  await switchLanguage(page, "zh-CN");
  await controls(page, { settingsWriteFailure: true });
  await page.getByRole("button", { name: "English", exact: true }).click();
  await expect(page.locator("main [role='alert']")).toContainText("无法保存或读取本地数据");
  expect((await snapshot(page)).settings.locale).toBe("zh-CN");
  await capture(page, "failed-language-save-zh-CN");
  await controls(page, { settingsWriteFailure: false });
  const saved = JSON.parse(readFileSync(appFile, "utf8"));
  saved.settings.locale = "fr";
  writeFileSync(appFile, JSON.stringify(saved));
  await page.reload();
  await expect(page.getByRole("button", { name: "简体中文", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect((await snapshot(page)).templates).toEqual(original.templates);
  saved.settings.selectedModel = "invalid-model";
  writeFileSync(appFile, JSON.stringify(saved));
  expect((await page.request.get("/api/workbench")).status()).toBe(500);
  writeFileSync(appFile, fixture("pre-redesign-workbench.json"));
  // A genuinely new store also ignores the English browser language.
  unlinkSync(appFile);
  await page.reload();
  await expect(page.getByRole("button", { name: "简体中文", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect((await snapshot(page)).settings.locale).toBe("zh-CN");
  await capture(page, "default-zh-CN");
});

test("LANG-STATE: preserve unsaved visual/JSON/input/history drafts and run exclusion with stale replies", async ({ page }) => {
  await load(page, "zh-CN");
  await page.getByRole("button", { name: "任务库", exact: true }).click();
  await page.getByLabel("模板名称").fill("未保存 mixed draft");
  await page.getByLabel("问题 category 指令").fill("未保存 instructions");
  await switchLanguage(page, "en");
  await expect(page.getByLabel("Template name")).toHaveValue("未保存 mixed draft");
  await expect(page.getByLabel("Question category instructions")).toHaveValue("未保存 instructions");
  await page.getByRole("button", { name: "Advanced JSON", exact: true }).click();
  const unfinished = '{"unfinished": "中文 / English",';
  await page.locator("#advanced-questions").fill(unfinished);
  await switchLanguage(page, "zh-CN");
  await expect(page.locator("#advanced-questions")).toHaveValue(unfinished);
  await page.getByRole("button", { name: "运行", exact: true }).click();
  const input = "  中文 / English <|question_1|> literal\n ";
  await page.getByLabel("状态输入", { exact: true }).fill(input);
  await controls(page, { delayMs: 4_000 });
  const requests: unknown[] = [];
  page.on("request", (request) => { if (request.url().endsWith("/api/workbench") && request.method() === "POST") requests.push(request.postDataJSON()); });
  // Let the actual server finish, then hold only its old run reply. Never replace the response.
  let releaseReply: () => void = () => {};
  const gate = new Promise<void>((resolve) => { releaseReply = resolve; });
  await page.route("**/api/workbench", async (route) => {
    if (route.request().method() === "POST" && route.request().postDataJSON().action === "run") {
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response });
    } else await route.continue();
  });
  await page.getByRole("button", { name: "运行任务", exact: true }).click();
  await expect(page.getByRole("button", { name: "运行中…", exact: true })).toBeDisabled();
  await switchLanguage(page, "en");
  await expect(page.getByRole("button", { name: "Running…", exact: true })).toBeDisabled();
  await expect(page.getByLabel("Selected model", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeDisabled();
  await expect.poll(async () => (await snapshot(page)).history[0]?.status).toBe("succeeded");
  // The held run snapshot still contains English. A newer successful choice wins.
  await switchLanguage(page, "zh-CN");
  await expect(page.getByRole("button", { name: "运行中…", exact: true })).toBeDisabled();
  releaseReply();
  await expect(page.getByRole("article", { name: "category 选择题结果", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "简体中文", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("状态输入", { exact: true })).toHaveValue(input);
  const finished = await snapshot(page);
  expect(finished.history[0].state).toBe(input);
  expect(finished.history[0].modelIdentity.modelId).toBe("kev-4b");
  expect(requests.filter((body) => (body as { action: string }).action === "run")).toHaveLength(1);
  expect(requests.filter((body) => ["load", "switch", "stop"].includes((body as { action: string }).action))).toEqual([]);
  await page.getByRole("button", { name: "任务库", exact: true }).click();
  await expect(page.locator("#advanced-questions")).toHaveValue(unfinished);
  await expect(page.getByLabel("模板名称")).toHaveValue("未保存 mixed draft");
  await page.getByRole("button", { name: "历史记录", exact: true }).click();
  await switchLanguage(page, "en");
  await expect(page.getByLabel("Result provenance")).toContainText(finished.history[0].id);
  await page.getByRole("button", { name: "Restore to draft", exact: true }).click();
  await switchLanguage(page, "zh-CN");
  await expect(page.getByLabel("状态输入", { exact: true })).toHaveValue(input);
  await expect(page.getByLabel("已保存任务", { exact: true })).toHaveValue("restored");
  await expect(page.getByLabel("结果来源")).toContainText(finished.history[0].id);
  writeFileSync(path.join(evidence, "lang-state-requests.json"), JSON.stringify(requests, null, 2));
  await capture(page, "preserved-state-zh-CN");
});

test("LANG-INTEGRITY: mixed data, historical bytes, portable exports and canonical values stay unchanged", async ({ page }) => {
  const runBytes = fixture("pre-redesign-run.json");
  const run: HistoryRecord = JSON.parse(runBytes);
  const runFile = path.join(data, "history", `${run.id}.json`);
  writeFileSync(runFile, runBytes);
  await page.reload();
  const before = await snapshot(page);
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  const first = await post(page, { action: "export", model: "kev-4b" });
  const firstExport = JSON.parse(readFileSync(path.join(data, first.body.file), "utf8"));
  await page.getByRole("button", { name: "历史记录", exact: true }).click();
  await page.getByRole("button", { name: /支持请求/ }).click();
  await page.getByRole("button", { name: "查看原始数据", exact: true }).click();
  const raw = await page.getByLabel("原始请求与响应").locator("pre").textContent();
  await switchLanguage(page, "en");
  await expect(page.getByLabel("Raw request and response").locator("pre")).toHaveText(raw!);
  const after = await snapshot(page);
  expect(after.templates).toEqual(before.templates);
  expect(after.history).toEqual(before.history);
  expect(readFileSync(runFile, "utf8")).toBe(runBytes);
  const second = await post(page, { action: "export", model: "kev-4b" });
  const secondExport = JSON.parse(readFileSync(path.join(data, second.body.file), "utf8"));
  expect(secondExport).toEqual(firstExport);
  expect((await post(page, { action: "import", content: JSON.stringify(secondExport) })).status).toBe(200);
  const imported = await snapshot(page);
  const portableTemplates = (value: WorkbenchSnapshot) => value.templates.map((template) => ({ taskId: template.taskId, name: template.name, description: template.description, questions: template.questions }));
  expect(portableTemplates(imported)).toEqual(portableTemplates(before));
  expect(readFileSync(runFile, "utf8")).toBe(runBytes);
  expect(requests.every((url) => url.startsWith("http://127.0.0.1:3001/") || url.startsWith("ws://127.0.0.1:3001/"))).toBe(true);
  writeFileSync(path.join(evidence, "lang-integrity.json"), JSON.stringify({ before, after, firstExport, secondExport, raw, requests }, null, 2));
});

test("LANG-ERRORS: actual-server validation, lifecycle, length, inference and persistence failures in both languages", async ({ page }) => {
  test.setTimeout(120_000);
  const outcomes: unknown[] = [];
  for (const locale of ["zh-CN", "en"] as const) {
    await switchLanguage(page, locale);
    await controls(page, { failure: "none", loadFailure: "none", closeFailure: false, historyWriteFailure: false });
    await post(page, { action: "stop", confirmRelease: true });
    await page.reload();
    await expect(page.getByLabel(label(locale, "Interface language"))).toBeVisible();
    const unready = await post(page, { action: "run", stateMode: "text", stateText: "synthetic", taskId: "test", taskName: "test", questions: { ready: { type: "noul" } } });
    expect(unready.status).toBe(409);
    outcomes.push({ locale, case: "unready", reply: unready });
    await page.getByRole("button", { name: "JSON", exact: true }).click();
    await page.getByLabel(label(locale, "State input"), { exact: true }).fill("{broken");
    await expect(page.locator("main [role='alert']")).toContainText(label(locale, "Invalid input. Check the JSON, questions or configuration and try again."));
    await capture(page, `invalid-state-${locale}`);
    await page.getByRole("button", { name: label(locale, "Task library"), exact: true }).click();
    await page.getByRole("button", { name: label(locale, "Advanced JSON"), exact: true }).click();
    await page.locator("#advanced-questions").fill('{"bad":{"type":"unknown"}}');
    await page.getByRole("button", { name: label(locale, "Apply JSON"), exact: true }).click();
    await expect(page.locator("main [role='alert']").last()).toContainText(label(locale, "Invalid input. Check the JSON, questions or configuration and try again."));
    await page.getByLabel(label(locale, "Import task configuration")).setInputFiles({ name: "invalid.json", mimeType: "application/json", buffer: Buffer.from('{"schema":"bad"}') });
    await expect(page.locator("main [role='alert']").first()).toContainText(label(locale, "Invalid input. Check the JSON, questions or configuration and try again."));
    await capture(page, `invalid-import-questions-${locale}`);
    await page.getByRole("button", { name: label(locale, "Run"), exact: true }).click();
    await page.getByRole("button", { name: label(locale, "Text"), exact: true }).click();
    await page.getByLabel(label(locale, "State input"), { exact: true }).fill("Synthetic error state 中文");
    await modelControls(page, locale);
    for (const [failure, category, summary] of [
      ["busy", "busy", "The model slot is busy. Wait for the current run or close it in its owning project, then retry."],
      ["startup", "failed_startup", "Model startup failed. Check status and recover the owned session before retrying."],
      ["unavailable", "unavailable_environment", "Local model prerequisites are unavailable. Check the local inference setup guide."],
    ] as const) {
      await controls(page, { loadFailure: failure });
      const reply = page.waitForResponse((response) => response.url().endsWith("/api/workbench") && response.request().method() === "POST");
      await page.getByRole("button", { name: label(locale, "Load model"), exact: true }).click();
      const result = await reply;
      expect((await result.json()).error.category).toBe(category);
      await expect(page.locator("main [role='alert']").first()).toContainText(label(locale, summary));
      outcomes.push({ locale, case: failure, status: result.status(), body: await result.json() });
      await capture(page, `${failure}-${locale}`);
    }
    await controls(page, { loadFailure: "none" });
    await load(page, locale);
    for (const [failure, category, summary] of [
      ["length", "rejected_length", "Input exceeds the admitted length. Shorten it explicitly and retry; nothing was silently truncated."],
      ["run", "model_error", "Inference failed. Check model status and retry; no successful result was saved."],
      ["stale", "stale_runtime", "The saved model session is stale. Recover the owned session; unrelated processes were left untouched."],
    ] as const) {
      await controls(page, { failure });
      const reply = page.waitForResponse((response) => response.url().endsWith("/api/workbench") && response.request().method() === "POST");
      await page.getByRole("button", { name: label(locale, "Run task"), exact: true }).click();
      const result = await reply;
      expect((await result.json()).error.category).toBe(category);
      await expect(page.locator("main [role='alert']").last()).toContainText(label(locale, summary));
      outcomes.push({ locale, case: failure, status: result.status(), body: await result.json() });
      await capture(page, `${failure}-${locale}`);
    }
    await controls(page, { failure: "none", historyWriteFailure: true });
    await page.getByRole("button", { name: label(locale, "Run task"), exact: true }).click();
    await expect(page.locator("main [role='alert']").last()).toContainText(label(locale, "Could not save or read local data. Check project storage and retry; success has not been recorded."));
    expect((await snapshot(page)).history[0].status).toBe("interrupted");
    await capture(page, `persistence-${locale}`);
    await controls(page, { historyWriteFailure: false, closeFailure: true });
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: label(locale, "Stop"), exact: true }).click();
    await expect(page.locator("main [role='alert']").first()).toContainText(label(locale, "Model shutdown is not confirmed. Retry Stop; the slot is not considered free."));
    expect((await snapshot(page)).runtime.state).toBe("ready");
    await capture(page, `stop-failure-${locale}`);
    await controls(page, { closeFailure: false });
    expect((await post(page, { action: "stop", confirmRelease: true })).status).toBe(200);
  }
  for (const name of ["unready", "busy", "startup", "unavailable", "length", "run", "stale"]) {
    const matches = outcomes.filter((value) => (value as { case: string }).case === name) as { reply?: unknown; body?: unknown; status?: number }[];
    expect(matches).toHaveLength(2);
    expect(matches[0].reply ?? { body: matches[0].body, status: matches[0].status }).toEqual(matches[1].reply ?? { body: matches[1].body, status: matches[1].status });
  }
  writeFileSync(path.join(evidence, "lang-error-outcomes.json"), JSON.stringify(outcomes, null, 2));
});

test("LANG-COVERAGE: bilingual navigation, editor, results, history outcomes, dialogs and accessibility inventory", async ({ page }) => {
  await load(page, "zh-CN");
  await page.getByLabel("状态输入", { exact: true }).fill("Synthetic 中文 / English coverage");
  await page.getByRole("button", { name: "运行任务", exact: true }).click();
  await expect(page.getByRole("article", { name: "category 选择题结果", exact: true })).toBeVisible();
  const record = (await snapshot(page)).history[0];
  const dialogs: unknown[] = [];
  for (const locale of ["zh-CN", "en"] as const) {
    await switchLanguage(page, locale);
    let releaseSnapshot: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    await page.route("**/api/workbench", async (route) => {
      if (route.request().method() === "GET") {
        const response = await route.fetch();
        await gate;
        await route.fulfill({ response });
      } else await route.continue();
    });
    await page.reload();
    await expect(page.getByText(label(locale, "Loading project-owned templates and history…"), { exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(evidence, `synthetic-lang-initial-loading-${locale}.png`), fullPage: true });
    writeFileSync(path.join(evidence, `lang-initial-loading-${locale}.json`), JSON.stringify({ aria: await page.locator("body").ariaSnapshot() }, null, 2));
    releaseSnapshot();
    await expect(page.getByRole("button", { name: label(locale, "History"), exact: true })).toBeVisible();
    await page.unroute("**/api/workbench");
    await page.getByRole("button", { name: label(locale, "History"), exact: true }).click();
    await page.getByRole("button", { name: /支持请求/ }).click();
    await expect(page.getByRole("article", { name: label(locale, "{id} Choice result").replace("{id}", "category"), exact: true })).toBeVisible();
    await expect(page.getByRole("article", { name: label(locale, "{id} Noul result").replace("{id}", "needs_review"), exact: true })).toBeVisible();
    await expect(page.getByRole("article", { name: label(locale, "{id} Score result").replace("{id}", "urgency"), exact: true })).toBeVisible();
    const details = page.getByText(label(locale, "Actual model details"), { exact: true });
    if (!(await details.evaluate((element) => element.parentElement!.hasAttribute("open")))) await details.click();
    await expect(page.getByText(label(locale, "Checkpoint"), { exact: true })).toBeVisible();
    await capture(page, `results-details-${locale}`);
    await page.getByText(label(locale, "More tools"), { exact: true }).click();
    await expect(page.getByRole("link", { name: label(locale, "Classic Playground"), exact: true })).toHaveAttribute("href", "/classic");
    await expect(page.getByRole("link", { name: label(locale, "Chess"), exact: true })).toHaveAttribute("href", "/chess");
    await page.getByRole("button", { name: label(locale, "Task library"), exact: true }).click();
    await expect(page.getByLabel(label(locale, "Question {id} instructions").replace("{id}", "category"))).toBeVisible();
    await capture(page, `library-${locale}`);
    await page.getByRole("button", { name: label(locale, "Export"), exact: true }).click();
    await expect(page.getByRole("status").first()).toContainText(locale === "en" ? "Task configuration exported" : "任务配置已导出");
    const exported = await post(page, { action: "export", model: "kev-4b" });
    await page.getByLabel(label(locale, "Import task configuration")).setInputFiles({ name: "roundtrip.json", mimeType: "application/json", buffer: readFileSync(path.join(data, exported.body.file)) });
    await expect(page.getByRole("status").first()).toContainText(locale === "en" ? "Imported 1 task templates" : "已导入 1 个任务模板");
    await capture(page, `import-success-${locale}`);
    await page.getByLabel(label(locale, "Template description")).fill(`Synthetic description ${locale}`);
    await page.getByRole("button", { name: label(locale, "Update template"), exact: true }).click();
    await expect(page.getByRole("status").first()).toContainText(label(locale, "Template saved in project-local workbench storage."));
    await capture(page, `save-success-${locale}`);
    page.once("dialog", async (dialog) => { dialogs.push({ locale, kind: "template", message: dialog.message() }); await dialog.dismiss(); });
    await page.getByRole("button", { name: label(locale, "Delete template"), exact: true }).click();
    await page.getByRole("button", { name: label(locale, "History"), exact: true }).click();
    await expect(page.getByLabel(label(locale, "Result provenance"))).toContainText(record.id);
    page.once("dialog", async (dialog) => { dialogs.push({ locale, kind: "history", message: dialog.message() }); await dialog.dismiss(); });
    await page.getByRole("button", { name: label(locale, "Delete run"), exact: true }).click();
    await capture(page, `history-${locale}`);
    await page.getByRole("button", { name: label(locale, "Run"), exact: true }).click();
    await page.getByText(label(locale, "More tools"), { exact: true }).click();
  }
  expect(dialogs).toHaveLength(4);
  expect((dialogs[0] as { message: string }).message).toContain("删除已保存模板");
  expect((dialogs[2] as { message: string }).message).toContain("Delete the saved template");
  writeFileSync(path.join(evidence, "lang-dialogs.json"), JSON.stringify(dialogs, null, 2));
});

test("LANG-FORMAT: fixed precision/time fixtures, both sizes/themes/languages, keyboard and hydration", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && /hydrat/i.test(message.text())) errors.push(message.text()); });
  const record: HistoryRecord = JSON.parse(fixture("pre-redesign-run.json"));
  record.submittedAt = "2026-01-02T03:04:05.000Z";
  record.response!.latency_ms = 1234.56;
  record.response!.usage = { input_tokens: 12345, output_tokens: 6 };
  writeFileSync(path.join(data, "history", `${record.id}.json`), JSON.stringify(record));
  await page.reload();
  await page.getByRole("button", { name: "历史记录", exact: true }).click();
  await page.getByRole("button", { name: /支持请求/ }).click();
  const fixtures: unknown[] = [];
  for (const locale of ["zh-CN", "en"] as const) {
    await switchLanguage(page, locale);
    await expect(page.getByLabel(label(locale, "Result provenance"))).toContainText(formatTime(record.submittedAt, locale));
    await expect(page.getByText(`${formatNumber(1234.56, locale, 1)} ${label(locale, "ms")}`, { exact: true })).toBeVisible();
    await expect(page.getByText(`${formatNumber(12345, locale)} ${label(locale, "input tokens")}`, { exact: true })).toBeVisible();
    const response = record.response!;
    const noul = response.answers as { needs_review: { noul: number } };
    await expect(page.getByText(`${label(locale, "p(yes)")} ${formatNumber(noul.needs_review.noul, locale, 3)}`, { exact: true })).toBeVisible();
    fixtures.push({ locale, time: formatTime(record.submittedAt, locale), latency: formatNumber(1234.56, locale, 1), tokens: formatNumber(12345, locale) });
    for (const theme of ["light", "dark"] as const) {
      if (!(await page.locator("html").getAttribute("class"))!.includes(theme)) await page.getByRole("button", { name: label(locale, theme === "dark" ? "Use dark theme" : "Use light theme"), exact: true }).click();
      await expect(page.locator("html")).toHaveClass(new RegExp(theme));
      for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
        await page.setViewportSize(size);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        await capture(page, `format-${locale}-${theme}-${size.width}x${size.height}`);
      }
    }
  }
  const selector = page.getByRole("button", { name: "简体中文", exact: true });
  await selector.focus();
  await expect(selector).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "English", exact: true })).toBeFocused();
  await page.keyboard.press("Space");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await selector.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await page.getByRole("button", { name: "运行", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("状态输入", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  writeFileSync(path.join(evidence, "lang-format-fixtures.json"), JSON.stringify({ fixtures, canonical: record, errors }, null, 2));
});
