import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { WorkbenchSnapshot } from "../../src/lib/workbench/service";
import { chinese, type Copy } from "../../src/lib/workbench/translations";
import type { Locale } from "../../src/lib/workbench/locale";

const data = process.env.KEV_WORKBENCH_DATA_ROOT!;
const evidence = process.env.KEV_WORKBENCH_EVIDENCE_ROOT!;
if (!data || !evidence) throw new Error("Use the isolated deterministic workbench runner.");

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

async function ensureReady(page: Page) {
  const summary = page.locator("details[aria-label='Model controls'] > summary");
  if (!(await summary.evaluate((element) => element.parentElement!.hasAttribute("open")))) await summary.click();
  const load = page.getByRole("button", { name: "Load model", exact: true });
  if (await load.isVisible()) await load.click();
  await expect(page.getByRole("button", { name: "Switch model", exact: true })).toBeVisible();
}

async function switchLanguage(page: Page, locale: Locale) {
  await page.getByRole("button", { name: locale === "en" ? "English" : "简体中文", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", locale);
  await expect(page.getByRole("button", { name: locale === "en" ? "English" : "简体中文", exact: true })).toBeEnabled();
}

async function geometry(page: Page) {
  return page.evaluate(() => {
    const header = document.querySelector("header")!.getBoundingClientRect();
    const content = document.querySelector("header + div")!.getBoundingClientRect();
    const panel = document.querySelector("[data-pw='model-panel']")?.getBoundingClientRect() ?? null;
    return {
      headerHeight: header.height,
      headerBottom: header.bottom,
      contentTop: content.top,
      panel: panel ? { top: panel.top, left: panel.left, right: panel.right, bottom: panel.bottom, width: panel.width, height: panel.height } : null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
}

function builtInApp(locale: Locale) {
  return {
    schema: "kev-workbench/1",
    settings: {
      selectedModel: "kev-4b",
      exportModel: "kev-4b",
      theme: "light",
      locale,
      sessionPath: null,
      pendingModel: null,
      recoverySessionPath: null,
    },
    templates: [
      {
        id: "template-support-review",
        taskId: "support-review",
        name: "支持请求",
        description: "合成示例，包含 Choice、Noul 和 Score。",
        questions: {
          category: {
            type: "choice",
            instructions: "Which category best matches this synthetic request?",
            criteria: { billing: "A charge question", delivery: "A shipment question" },
          },
          needs_review: {
            type: "noul",
            instructions: "Does this synthetic request need a person to review it?",
            criteria: { true: "Needs a person", false: "Standard process is enough" },
          },
          urgency: {
            type: "score",
            instructions: "How soon should this synthetic request be reviewed?",
            criteria: ["Later", "Today"],
          },
        },
      },
    ],
  };
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  expect((await post(page, { action: "configure", delayMs: 0, failure: "none", loadFailure: "none", closeFailure: false, historyWriteFailure: false, settingsWriteFailure: false }, "/api/workbench/test")).status).toBe(200);
  const current = await snapshot(page);
  if (current.runtime.state !== "unloaded") expect((await post(page, { action: "stop", confirmRelease: true })).status).toBe(200);
  writeFileSync(path.join(data, "workbench.json"), JSON.stringify(builtInApp("en")));
  await page.reload();
  await expect(page.getByRole("heading", { name: "Local model workbench" })).toBeVisible();
});

test("OVERLAY: anchored model controls do not move the header or content", async ({ page }) => {
  const measurements: unknown[] = [];
  for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 812 }]) {
    await page.setViewportSize(viewport);
    for (const theme of ["light", "dark"] as const) {
      const themeName = label("en", theme === "dark" ? "Use dark theme" : "Use light theme");
      if (await page.getByRole("button", { name: themeName, exact: true }).count()) {
        await page.getByRole("button", { name: themeName, exact: true }).click();
      }
      await expect(page.locator("html")).toHaveClass(new RegExp(theme));
      const summary = page.locator("details[aria-label='Model controls'] > summary");
      if (await summary.evaluate((element) => element.parentElement!.hasAttribute("open"))) await summary.click();
      const closed = await geometry(page);
      await summary.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("button", { name: "Load model", exact: true })).toBeVisible();
      await expect.poll(async () => {
        const panel = await page.locator("[data-pw='model-panel']").boundingBox();
        const anchor = await summary.boundingBox();
        if (!panel || !anchor) return false;
        return panel.y >= anchor.y + anchor.height - 2 && panel.x >= -1 && panel.x + panel.width <= viewport.width + 1;
      }).toBe(true);
      const opened = await geometry(page);
      expect(Math.abs(opened.headerHeight - closed.headerHeight)).toBeLessThanOrEqual(1);
      expect(Math.abs(opened.contentTop - closed.contentTop)).toBeLessThanOrEqual(1);
      expect(opened.panel).not.toBeNull();
      expect(opened.panel!.left).toBeGreaterThanOrEqual(-1);
      expect(opened.panel!.right).toBeLessThanOrEqual(viewport.width + 1);
      const load = await page.getByRole("button", { name: "Load model", exact: true }).boundingBox();
      expect(load && load.y >= 0 && load.y + load.height <= viewport.height + 1).toBe(true);
      await page.keyboard.press("Escape");
      await expect(summary).toBeFocused();
      await expect(page.getByRole("button", { name: "Load model", exact: true })).toBeHidden();
      await summary.click();
      await page.getByRole("heading", { name: "Run a saved task" }).click({ force: true });
      await expect(page.getByRole("button", { name: "Load model", exact: true })).toBeHidden();
      measurements.push({ viewport, theme, closed, opened });
      await page.screenshot({ path: path.join(evidence, `qa-overlay-${viewport.width}x${viewport.height}-${theme}.png`) });
    }
  }
  writeFileSync(path.join(evidence, "qa-overlay-geometry.json"), JSON.stringify(measurements, null, 2));
});

test("EDITOR: question, option and score fields keep focus, caret and saved order", async ({ page }) => {
  await page.getByRole("button", { name: "Task library", exact: true }).click();
  const question = page.getByLabel("Question category ID");
  await question.click();
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  const before = await page.evaluate(() => (document.activeElement as HTMLInputElement).selectionStart);
  await page.keyboard.type("X");
  await page.keyboard.insertText("粘贴");
  const typed = await page.evaluate(() => {
    const input = document.activeElement as HTMLInputElement;
    return { value: input.value, start: input.selectionStart, active: input.tagName === "INPUT" };
  });
  expect(typed.active).toBe(true);
  expect(typed.value).toBe("categorX粘贴y");
  expect(typed.start).toBe((before ?? 0) + "X粘贴".length);

  await page.getByLabel("Question categorX粘贴y option billing ID").click();
  await page.keyboard.press("End");
  await page.keyboard.type("-id");
  const optionState = await page.evaluate(() => {
    const input = document.activeElement as HTMLInputElement;
    return { value: input.value, active: input.tagName === "INPUT" };
  });
  expect(optionState).toEqual({ value: "billing-id", active: true });
  await page.getByLabel("Question categorX粘贴y option billing-id description").click();
  await page.keyboard.press("End");
  await page.keyboard.type("说明");
  const descriptionState = await page.evaluate(() => {
    const input = document.activeElement as HTMLInputElement;
    return { value: input.value, active: input.tagName === "INPUT" };
  });
  expect(descriptionState).toEqual({ value: "A charge question说明", active: true });

  await page.getByLabel("Question urgency score level 0").click();
  await page.keyboard.press("End");
  await page.keyboard.type("稍后");
  const levelState = await page.evaluate(() => {
    const input = document.activeElement as HTMLInputElement;
    return { value: input.value, active: input.tagName === "INPUT" };
  });
  expect(levelState).toEqual({ value: "Later稍后", active: true });

  await page.getByRole("button", { name: "Update template", exact: true }).click();
  await expect(page.getByRole("status").first()).toContainText("Template saved");
  const saved = (await snapshot(page)).templates[0];
  expect(Object.keys(saved.questions)).toEqual(["categorX粘贴y", "needs_review", "urgency"]);
  const choice = saved.questions.categorX粘贴y as { criteria: Record<string, string> };
  expect(Object.keys(choice.criteria)).toEqual(["billing-id", "delivery"]);
  expect(choice.criteria["billing-id"]).toBe("A charge question说明");
  const score = saved.questions.urgency as { criteria: string[] };
  expect(score.criteria).toEqual(["Later稍后", "Today"]);
  writeFileSync(path.join(evidence, "qa-editor.json"), JSON.stringify({ typed, savedQuestions: saved.questions }, null, 2));
  await page.screenshot({ path: path.join(evidence, "qa-editor-caret.png"), fullPage: true });
});

test("GUIDANCE: explains configured questions, example fill, and result meanings", async ({ page }) => {
  const before = readFileSync(path.join(data, "workbench.json"), "utf8");
  const run = page.locator("section[aria-labelledby='input-heading']");
  await expect(run.getByText("One shared input is sent with every independent question.")).toBeVisible();
  await expect(run.getByRole("article", { name: "Question category" })).toContainText("Which category best matches this synthetic request?");
  await expect(run.getByText("Needs a person")).toBeVisible();
  await expect(run.getByText("Ordered levels, from 0")).toBeVisible();
  await expect(page.getByText("JSON must parse as one JSON value")).toBeVisible();
  await page.getByRole("button", { name: "JSON", exact: true }).click();
  await page.getByLabel("State input", { exact: true }).fill("{broken");
  await expect(page.locator("main [role='alert']").filter({ hasText: "Invalid input" })).toBeVisible();
  await page.screenshot({ path: path.join(evidence, "qa-guidance-invalid-json.png") });
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.getByLabel("State input", { exact: true }).fill("");

  await page.getByRole("button", { name: "Fill supplied example input", exact: true }).click();
  const example = "The shoes arrived late and the card shows two charges. This is a synthetic example, not a real request.";
  await expect(page.getByLabel("State input", { exact: true })).toHaveValue(example);
  expect(readFileSync(path.join(data, "workbench.json"), "utf8")).toBe(before);
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Fill supplied example input", exact: true }).click();
  await expect(page.getByLabel("State input", { exact: true })).toHaveValue(example);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByLabel("State input", { exact: true }).fill("keep this draft");
  await page.getByRole("button", { name: "Fill supplied example input", exact: true }).click();
  await expect(page.getByLabel("State input", { exact: true })).toHaveValue(example);
  expect(readFileSync(path.join(data, "workbench.json"), "utf8")).toBe(before);

  const choiceOnly = {
    schema: "kev-project-tasks/1",
    model: "kev-4b",
    tasks: { only: { description: "Choice only", questions: { only_choice: { type: "choice", instructions: "Pick one synthetic option.", criteria: { a: "Alpha", b: "Beta" } } } } },
  };
  expect((await post(page, { action: "import", content: JSON.stringify(choiceOnly) })).status).toBe(200);
  await page.reload();
  await expect(page.locator("section[aria-labelledby='input-heading']").getByText("Pick one synthetic option.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Fill supplied example input" })).toHaveCount(0);
  await ensureReady(page);
  await page.getByLabel("State input", { exact: true }).fill("synthetic choice only");
  await page.getByRole("button", { name: "Run task", exact: true }).click();
  await expect(page.getByRole("article", { name: "only_choice Choice result" })).toBeVisible();
  await expect(page.getByRole("article", { name: /Noul result|Score result/ })).toHaveCount(0);
  await expect(page.getByText("This choice is only among the options configured for this question.")).toBeVisible();
  await expect(page.getByText("not guaranteed accuracy").first()).toBeVisible();

  const mixed = {
    schema: "kev-project-tasks/1",
    model: "kev-4b",
    tasks: {
      mixed: {
        description: "Mixed synthetic",
        questions: {
          mix_choice: { type: "choice", instructions: "Choose a synthetic bucket.", criteria: { one: "First" } },
          mix_noul: { type: "noul", instructions: "Is this synthetic?", criteria: { true: "It is synthetic" } },
          mix_score: { type: "score", instructions: "How synthetic?", criteria: ["Low", "High"] },
        },
      },
    },
  };
  expect((await post(page, { action: "import", content: JSON.stringify(mixed) })).status).toBe(200);
  await page.reload();
  await page.getByLabel("State input", { exact: true }).fill("synthetic mixed");
  await ensureReady(page);
  await page.getByRole("button", { name: "Run task", exact: true }).click();
  await expect(page.getByRole("article", { name: "mix_choice Choice result" })).toBeVisible();
  await expect(page.getByRole("article", { name: "mix_noul Noul result" })).toBeVisible();
  await expect(page.getByRole("article", { name: "mix_score Score result" })).toBeVisible();
  await expect(page.getByText("Yes refers to: It is synthetic")).toBeVisible();
  await expect(page.getByText("not a percentage").first()).toBeVisible();
  await expect(page.getByText("Only the questions configured for this submitted task are shown.")).toBeVisible();
  const articles = await page.getByRole("article", { name: /result$/ }).count();
  expect(articles).toBe(3);
  await page.screenshot({ path: path.join(evidence, "qa-guidance-mixed-en.png"), fullPage: true });
  await switchLanguage(page, "zh-CN");
  await expect(page.getByText("“是”指的是：It is synthetic")).toBeVisible();
  await expect(page.locator("#state-input")).toHaveValue("synthetic mixed");
  await page.screenshot({ path: path.join(evidence, "qa-guidance-mixed-zh.png"), fullPage: true });
  writeFileSync(path.join(evidence, "qa-guidance.json"), JSON.stringify({ articles, templateBytesUnchanged: true }, null, 2));
});

test("LANGUAGE and TOOLS: bilingual chrome, preserved data, synthetic Classic and Chess", async ({ page }) => {
  const calls: string[] = [];
  await page.route("**/kev/v1/**", async (route) => {
    const url = route.request().url();
    calls.push(`${route.request().method()} ${new URL(url).pathname}`);
    const fail = url.includes("fail=1");
    if (fail) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "synthetic backend down" }) });
      return;
    }
    if (url.includes("/v1/models")) {
      await route.fulfill({ json: { models: [{ name: "synthetic-fixture", run: "synthetic-kev-fixture", base: "synthetic-base-fixture" }] } });
      return;
    }
    const body = route.request().postDataJSON() ?? {};
    const questions = body.questions ?? {};
    const answers: Record<string, unknown> = {};
    for (const [id, question] of Object.entries(questions) as [string, { type?: string; criteria?: unknown }][]) {
      if (question.type === "noul") answers[id] = { type: "noul", noul: 0.25, confidence: 0.2 };
      else if (question.type === "score") {
        const levels = Array.isArray(question.criteria) ? question.criteria : ["a"];
        answers[id] = { type: "score", score: 1, confidence: 0.2, legend: Object.fromEntries(levels.map((level, index) => [String(index), String(level)])), probabilities: Object.fromEntries(levels.map((_, index) => [String(index), 1 / levels.length])) };
      } else {
        const keys = Object.keys((question.criteria ?? { e4: "pawn" }) as Record<string, unknown>);
        const choice = keys.includes("e4") ? "e4" : keys[0];
        answers[id] = { type: "choice", choice, confidence: 0.2, probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? 0.5 : 0.5 / Math.max(keys.length - 1, 1)])) };
      }
    }
    await route.fulfill({ json: { model: "synthetic-fixture", answers, usage: { input_tokens: 8, output_tokens: 2 }, latency_ms: 7 } });
  });

  await expect(page.locator("p.font-medium.text-foreground").filter({ hasText: /^支持请求$/ })).toBeVisible();
  await expect(page.locator("section[aria-labelledby='input-heading']").getByText("合成示例，包含 Choice、Noul 和 Score。")).toBeVisible();
  await expect(page.getByRole("button", { name: "Task library", exact: true })).toBeVisible();
  await page.getByText("More tools", { exact: true }).click();
  await expect(page.getByText("does not claim tested Jev compatibility")).toBeVisible();
  await expect(page.getByText("not cloud-only")).toBeVisible();
  const draft = "unsaved english draft";
  await page.getByLabel("State input", { exact: true }).fill(draft);
  await switchLanguage(page, "zh-CN");
  await expect(page.getByRole("button", { name: "任务库", exact: true })).toBeVisible();
  await expect(page.getByLabel("状态输入", { exact: true })).toHaveValue(draft);
  await expect(page.locator("p.font-medium.text-foreground").filter({ hasText: /^支持请求$/ })).toBeVisible();
  await page.screenshot({ path: path.join(evidence, "qa-language-zh-run.png"), fullPage: true });

  await page.goto("/classic");
  await expect(page.getByText("独立的兼容本地 Kev 后端")).toBeVisible();
  await expect(page.getByRole("heading", { name: "输入类型化问题，输出概率，一次前向计算。" })).toBeVisible();
  const classicDraft = await page.locator("#state").inputValue();
  await page.getByRole("button", { name: "English", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("#state")).toHaveValue(classicDraft);
  await expect(page.getByRole("heading", { name: "Typed questions in, probabilities out, one forward pass." })).toBeVisible();
  await page.getByRole("button", { name: /^Run/ }).click();
  await expect(page.getByRole("heading", { name: /department/ })).toBeVisible();
  await page.screenshot({ path: path.join(evidence, "qa-classic-success-en.png"), fullPage: true });
  await page.route("**/kev/v1/systemone**", (route) => route.fulfill({ status: 503, contentType: "text/plain", body: "synthetic backend down" }));
  await page.getByRole("button", { name: /^Run/ }).click();
  await expect(page.getByText("Request failed")).toBeVisible();
  await expect(page.getByText("synthetic backend down")).toBeVisible();
  await page.screenshot({ path: path.join(evidence, "qa-classic-failure-en.png") });

  await page.unroute("**/kev/v1/systemone**");
  await page.goto("/chess");
  await expect(page.getByText("Jev compatibility is not claimed or tested here.")).toBeVisible();
  await page.getByRole("button", { name: "简体中文", exact: true }).click();
  await expect(page.getByRole("heading", { name: "每一步都是一道选择题。" })).toBeVisible();
  await page.getByRole("button", { name: "English", exact: true }).click();
  await page.getByRole("button", { name: "Model vs model", exact: true }).click();
  await page.getByRole("button", { name: "Step", exact: true }).click();
  await expect(page.getByText("confidence").first()).toBeVisible();
  await page.screenshot({ path: path.join(evidence, "qa-chess-success-en.png"), fullPage: true });
  await page.route("**/kev/v1/systemone**", (route) => route.fulfill({ status: 503, contentType: "text/plain", body: "synthetic chess down" }));
  await page.getByRole("button", { name: "Step", exact: true }).click();
  await expect(page.getByText("Chess request failed")).toBeVisible();
  await expect(page.getByText("synthetic chess down")).toBeVisible();
  await page.screenshot({ path: path.join(evidence, "qa-chess-failure-en.png") });
  expect(calls.some((call) => call.includes("/v1/systemone"))).toBe(true);
  expect(calls.some((call) => call.includes("/api/workbench"))).toBe(false);
  writeFileSync(path.join(evidence, "qa-tools-calls.json"), JSON.stringify(calls, null, 2));
});
