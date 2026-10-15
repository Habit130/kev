import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { Chess } from "chess.js";
import type { WorkbenchSnapshot } from "../../src/lib/workbench/service";
import { chinese, type Copy } from "../../src/lib/workbench/translations";
import type { Locale } from "../../src/lib/workbench/locale";
import { EVAL_LEVELS, formatResult, parseResult, RESULT_REASONS, resultText, type ResultReason } from "../../src/lib/chess";

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

// chess.js-validated legal lines used by the live terminal-state tests below.
const MATE_WHITE_LINE = ["e4", "f6", "d4", "g5", "Qh5#"];
const MATE_BLACK_LINE = ["f3", "e5", "g4", "Qh4#"];
const STALEMATE_LINE = ["e3", "a5", "Qh5", "Ra6", "Qxa5", "h5", "Qxc7", "Rah6", "h4", "f6", "Qxd7+", "Kf7", "Qxb7", "Qd3", "Qxb8", "Qh7", "Qxc8", "Kg6", "Qe6"];
const REPETITION_LINE = ["Nf3", "Nf6", "Ng1", "Ng8", "Nf3", "Nf6", "Ng1", "Ng8"];

type ChessRequestBody = {
  state: { fen: string; in_check: boolean };
  questions: { move: { criteria: Record<string, string> }; evaluation: { criteria: string[] } };
};
type ChessFixture = { calls: string[]; bodies: ChessRequestBody[] };

function playLine(sans: string[]): Chess {
  const chess = new Chess();
  for (const san of sans) chess.move(san);
  return chess;
}

// Answers the page's own /kev/v1 model path with the next scripted legal SAN (labeled synthetic,
// no live inference). A request outside the scripted line fails the route so drift is visible.
async function routeChessModel(page: Page, lines: string[][], log: ChessFixture) {
  let game = 0;
  let ply = 0;
  await page.route("**/kev/v1/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    log.calls.push(`${request.method()} ${pathname}`);
    if (pathname.endsWith("/v1/models")) {
      await route.fulfill({ json: { models: [{ name: "synthetic-chess", run: "synthetic-chess-fixture", base: "synthetic-chess-base" }] } });
      return;
    }
    const body = request.postDataJSON() as ChessRequestBody;
    const expected = lines[game]?.[ply];
    const criteria = body.questions?.move?.criteria ?? {};
    if (!expected || !(expected in criteria)) {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: `unexpected chess request for ply ${ply}` }) });
      return;
    }
    log.bodies.push(body);
    const keys = Object.keys(criteria);
    const levels = body.questions.evaluation.criteria;
    await route.fulfill({
      json: {
        model: "synthetic-chess-fixture",
        answers: {
          move: { type: "choice", choice: expected, confidence: 0.5, probabilities: Object.fromEntries(keys.map((key) => [key, key === expected ? 0.5 : 0.5 / Math.max(keys.length - 1, 1)])) },
          evaluation: { type: "score", score: 2, confidence: 0.5, legend: Object.fromEntries(levels.map((level, index) => [String(index), level])), probabilities: Object.fromEntries(levels.map((_, index) => [String(index), 1 / levels.length])) },
        },
        usage: { input_tokens: 9, output_tokens: 3 },
        latency_ms: 4,
      },
    });
    ply += 1;
    if (ply >= (lines[game]?.length ?? 0)) { game += 1; ply = 0; }
  });
}

// One Step click with its synthetic model reply completed.
async function stepChess(page: Page, name: string) {
  const response = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith("/v1/systemone"));
  await page.getByRole("button", { name, exact: true }).click();
  expect((await response).status()).toBe(200);
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
          mix_noul: { type: "noul", instructions: "Is this synthetic?", criteria: { true: { note: "structured yes" } } },
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
  await expect(page.getByText('Yes refers to: {"note":"structured yes"}')).toBeVisible();
  await expect(page.getByText("not a percentage").first()).toBeVisible();
  await expect(page.getByText("Only the questions configured for this submitted task are shown.")).toBeVisible();
  const articles = await page.getByRole("article", { name: /result$/ }).count();
  expect(articles).toBe(3);
  await page.screenshot({ path: path.join(evidence, "qa-guidance-mixed-en.png"), fullPage: true });
  await switchLanguage(page, "zh-CN");
  await expect(page.getByText('“是”指的是：{"note":"structured yes"}')).toBeVisible();
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

test("LANGUAGE defaults: generated choice descriptions and score levels follow the selected language", async ({ page }) => {
  const appFile = path.join(data, "workbench.json");
  await switchLanguage(page, "zh-CN");
  await page.getByRole("button", { name: "任务库", exact: true }).click();
  const draftBytesZh = readFileSync(appFile, "utf8");

  // Add question in Chinese mode generates Choice descriptions in the selected language.
  const addQuestion = page.getByRole("button", { name: "添加问题", exact: true });
  await addQuestion.focus();
  await page.keyboard.press("Enter");
  await expect(addQuestion).toBeFocused();
  await expect(page.getByLabel("问题 question_4 ID")).toHaveValue("question_4");
  await expect(page.getByLabel("问题 question_4 类型")).toHaveValue("choice");
  await expect(page.getByLabel("问题 question_4 选项 option_a 描述")).toHaveValue("选项 A");
  await expect(page.getByLabel("问题 question_4 选项 option_b 描述")).toHaveValue("选项 B");

  // Type change to Score regenerates ordered levels in Chinese and keeps the saved instruction.
  const instructions = page.getByLabel("问题 question_4 指令");
  await instructions.fill("保留的中文指令");
  const typeSelect = page.getByLabel("问题 question_4 类型");
  await typeSelect.focus();
  await typeSelect.selectOption("score");
  await expect(typeSelect).toBeFocused();
  await expect(typeSelect).toHaveValue("score");
  await expect(instructions).toHaveValue("保留的中文指令");
  await expect(page.getByLabel("问题 question_4 评分等级 0")).toHaveValue("等级 1");
  await expect(page.getByLabel("问题 question_4 评分等级 1")).toHaveValue("等级 2");

  // Add level appends the next ordered level in Chinese.
  const addLevel = page.getByRole("region", { name: "问题 question_4" }).getByRole("button", { name: "添加等级", exact: true });
  await addLevel.focus();
  await page.keyboard.press("Enter");
  await expect(addLevel).toBeFocused();
  await expect(page.getByLabel("问题 question_4 评分等级 2")).toHaveValue("等级 3");

  // Unsaved draft edits do not rewrite the stored template bytes.
  expect(readFileSync(appFile, "utf8")).toBe(draftBytesZh);

  // Switching language must not retroactively translate the existing draft.
  await switchLanguage(page, "en");
  await expect(page.getByLabel("Question question_4 instructions")).toHaveValue("保留的中文指令");
  await expect(page.getByLabel("Question question_4 score level 0")).toHaveValue("等级 1");
  await expect(page.getByLabel("Question question_4 score level 2")).toHaveValue("等级 3");
  expect(JSON.parse(readFileSync(appFile, "utf8")).templates).toEqual(JSON.parse(draftBytesZh).templates);

  // Add question and type change in English mode generate English descriptions.
  await page.getByRole("button", { name: "Add question", exact: true }).click();
  await expect(page.getByLabel("Question question_5 option option_a description")).toHaveValue("Option A");
  await expect(page.getByLabel("Question question_5 option option_b description")).toHaveValue("Option B");
  await page.getByLabel("Question question_5 type").selectOption("score");
  await expect(page.getByLabel("Question question_5 score level 0")).toHaveValue("Level 1");
  await expect(page.getByLabel("Question question_5 score level 1")).toHaveValue("Level 2");
  await page.getByRole("region", { name: "Question question_5" }).getByRole("button", { name: "Add level", exact: true }).click();
  await expect(page.getByLabel("Question question_5 score level 2")).toHaveValue("Level 3");

  // Saving keeps the generated bytes and ordering exactly; existing questions are untouched.
  await page.getByRole("button", { name: "Update template", exact: true }).click();
  await expect(page.getByRole("status").first()).toContainText("Template saved");
  const savedBytes = readFileSync(appFile, "utf8");
  const saved = (await snapshot(page)).templates[0];
  const originalQuestions = JSON.parse(draftBytesZh).templates[0].questions;
  expect(Object.keys(saved.questions)).toEqual(["category", "needs_review", "urgency", "question_4", "question_5"]);
  expect(saved.questions.category).toEqual(originalQuestions.category);
  expect(saved.questions.needs_review).toEqual(originalQuestions.needs_review);
  expect(saved.questions.urgency).toEqual(originalQuestions.urgency);
  const score4 = saved.questions.question_4 as { type: string; instructions: string; criteria: string[] };
  expect(score4.type).toBe("score");
  expect(score4.instructions).toBe("保留的中文指令");
  expect(score4.criteria).toEqual(["等级 1", "等级 2", "等级 3"]);
  const score5 = saved.questions.question_5 as { type: string; instructions: string; criteria: string[] };
  expect(score5.type).toBe("score");
  expect(score5.instructions).toBe("");
  expect(score5.criteria).toEqual(["Level 1", "Level 2", "Level 3"]);

  // Saved bytes keep their original language after switching back to Chinese.
  await switchLanguage(page, "zh-CN");
  await expect(page.getByLabel("问题 question_5 评分等级 0")).toHaveValue("Level 1");
  expect(JSON.parse(readFileSync(appFile, "utf8")).templates).toEqual(JSON.parse(savedBytes).templates);

  await page.screenshot({ path: path.join(evidence, "qa-language-defaults-zh.png"), fullPage: true });
  writeFileSync(path.join(evidence, "qa-language-defaults.json"), JSON.stringify({
    generated: { zh: { choice: ["选项 A", "选项 B"], score: ["等级 1", "等级 2", "等级 3"] }, en: { choice: ["Option A", "Option B"], score: ["Level 1", "Level 2", "Level 3"] } },
    savedQuestions: { question_4: score4, question_5: score5 },
    draftUnchangedWhileEditing: true,
    templatesStableAcrossSwitches: true,
  }, null, 2));
});

test("LANGUAGE chess terminal inventory: display maps every known reason and preserves unknown strings", () => {
  const played = {
    "1-0 (checkmate)": playLine(MATE_WHITE_LINE),
    "0-1 (checkmate)": playLine(MATE_BLACK_LINE),
    "½-½ (stalemate)": playLine(STALEMATE_LINE),
    "½-½ (repetition)": playLine(REPETITION_LINE),
  };
  expect([...Object.values(played)].map((chess) => [chess.isGameOver(), chess.isCheckmate(), chess.isStalemate(), chess.isThreefoldRepetition()])).toEqual([
    [true, true, false, false],
    [true, true, false, false],
    [true, false, true, false],
    [true, false, false, true],
  ]);
  const inventory = [
    { provenance: "live play to checkmate, white mates", result: resultText(played["1-0 (checkmate)"])!, zh: "1-0 (将死)" },
    { provenance: "live play to checkmate, black mates", result: resultText(played["0-1 (checkmate)"])!, zh: "0-1 (将死)" },
    { provenance: "live play to stalemate", result: resultText(played["½-½ (stalemate)"])!, zh: "½-½ (逼和)" },
    { provenance: "live play to threefold repetition", result: resultText(played["½-½ (repetition)"])!, zh: "½-½ (三次重复局面)" },
    { provenance: "kings-only position (chess.js FEN)", result: resultText(new Chess("8/8/8/4k3/8/8/4K3/8 w - - 0 1"))!, zh: "½-½ (子力不足)" },
    { provenance: "halfmove clock at 100 (chess.js FEN)", result: resultText(new Chess("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 100 50"))!, zh: "½-½ (五十回合规则)" },
    { provenance: "defensive fallback kept for stored/imported strings; not reachable through chess.js 1.4.0 predicates", result: "½-½ (draw)", zh: "½-½ (和棋)" },
  ];
  expect(inventory.map((row) => row.result)).toEqual([
    "1-0 (checkmate)", "0-1 (checkmate)", "½-½ (stalemate)", "½-½ (repetition)", "½-½ (insufficient material)", "½-½ (fifty-move rule)", "½-½ (draw)",
  ]);
  expect(RESULT_REASONS).toHaveLength(6);
  const zhReason = (reason: ResultReason) => chinese[reason];
  for (const reason of RESULT_REASONS) expect(typeof chinese[reason]).toBe("string");
  for (const row of inventory) {
    expect(parseResult(row.result)).not.toBeNull();
    expect(formatResult(row.result, zhReason)).toBe(row.zh);
    expect(formatResult(row.result, (reason) => reason)).toBe(row.result); // English mode stays English
  }
  const unknown = ["1/2-1/2 (imported result)", "½-½", "1-0 (checkmate", "½-½ (stalemate) extra", ""];
  for (const result of unknown) {
    expect(parseResult(result)).toBeNull();
    expect(formatResult(result, zhReason)).toBe(result);
  }
  writeFileSync(path.join(evidence, "qa-chess-terminal-inventory.json"), JSON.stringify({ inventory, unknownFallbacks: unknown }, null, 2));
});

test("LANGUAGE chess: a live stalemate localizes status and saved row without rewriting stored bytes", async ({ page }) => {
  const expected = "½-½ (stalemate)";
  expect(resultText(playLine(STALEMATE_LINE))).toBe(expected);
  const log: ChessFixture = { calls: [], bodies: [] };
  await routeChessModel(page, [STALEMATE_LINE], log);
  await page.goto("/chess");
  await page.getByRole("button", { name: "简体中文", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  const status = page.locator("p[role='status']");
  const savedRow = page.locator("ul li").filter({ hasText: "½-½" }).first();
  for (let ply = 0; ply < STALEMATE_LINE.length; ply += 1) await stepChess(page, "单步");
  await expect(status).toHaveText("½-½ (逼和)");

  // The request bytes are unchanged: canonical English criteria, the real position, no localization.
  expect(log.bodies).toHaveLength(STALEMATE_LINE.length);
  const position = new Chess();
  log.bodies.forEach((body, index) => {
    expect(body.state.fen).toBe(position.fen());
    expect(body.questions.evaluation.criteria).toEqual(EVAL_LEVELS);
    expect(Object.keys(body.questions.move.criteria).sort()).toEqual(position.moves().sort());
    position.move(STALEMATE_LINE[index]);
  });

  // Stored bytes keep the canonical English result, the moves and the PGN.
  const storedBytes = await page.evaluate(() => localStorage.getItem("kev.chess.v1"));
  const stored = JSON.parse(storedBytes!) as { result: string; moves: unknown[]; pgn: string }[];
  expect(stored).toHaveLength(1);
  expect(stored[0].result).toBe(expected);
  expect(stored[0].moves).toHaveLength(STALEMATE_LINE.length);
  expect(stored[0].pgn).toBe(playLine(STALEMATE_LINE).pgn());
  await page.screenshot({ path: path.join(evidence, "qa-chess-live-stalemate-zh.png"), fullPage: true });

  // Switching language re-renders both edges; it makes no inference request and rewrites nothing.
  const systemOneRequests = () => log.calls.filter((call) => call.endsWith("/v1/systemone")).length;
  const before = systemOneRequests();
  await switchLanguage(page, "en");
  await expect(status).toHaveText(expected);
  await expect(savedRow).toContainText(`19 plies · ${expected}`);
  await page.screenshot({ path: path.join(evidence, "qa-chess-live-stalemate-en.png"), fullPage: true });
  await switchLanguage(page, "zh-CN");
  await expect(status).toHaveText("½-½ (逼和)");
  await expect(savedRow).toContainText("19 步 · ½-½ (逼和)");
  expect(systemOneRequests()).toBe(before);
  expect(await page.evaluate(() => localStorage.getItem("kev.chess.v1"))).toBe(storedBytes);
});

test("LANGUAGE chess: live checkmate winner forms and threefold repetition localize both score strings", async ({ page }) => {
  const lines = [MATE_WHITE_LINE, MATE_BLACK_LINE, REPETITION_LINE];
  const expected = ["1-0 (checkmate)", "0-1 (checkmate)", "½-½ (repetition)"];
  const localized = ["1-0 (将死)", "0-1 (将死)", "½-½ (三次重复局面)"];
  expect(lines.map((line) => resultText(playLine(line)))).toEqual(expected);
  const log: ChessFixture = { calls: [], bodies: [] };
  await routeChessModel(page, lines, log);
  await page.goto("/chess");
  await page.getByRole("button", { name: "简体中文", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  const status = page.locator("p[role='status']");
  for (let game = 0; game < lines.length; game += 1) {
    if (game > 0) await page.getByRole("button", { name: "新对局", exact: true }).click();
    for (let ply = 0; ply < lines[game].length; ply += 1) await stepChess(page, "单步");
    await expect(status).toHaveText(localized[game]);
  }
  const stored = JSON.parse((await page.evaluate(() => localStorage.getItem("kev.chess.v1")))!) as { result: string }[];
  expect(stored.map((game) => game.result)).toEqual(expected);
  await page.screenshot({ path: path.join(evidence, "qa-chess-live-outcomes-zh.png"), fullPage: true });
});

test("LANGUAGE chess: saved historical rows localize known reasons and keep imported strings verbatim", async ({ page }) => {
  const finished = playLine(STALEMATE_LINE);
  const known = resultText(finished)!;
  const historical = { id: "historical-1", startedAt: 1750000000000, mode: "self", pgn: finished.pgn(), moves: STALEMATE_LINE.map((san) => ({ san, by: "model" })), result: known };
  const imported = { ...historical, id: "imported-1", result: "1/2-1/2 (imported summary)" };
  const calls: string[] = [];
  await page.route("**/kev/v1/**", async (route) => {
    calls.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    await route.fulfill({ json: { models: [{ name: "synthetic-chess", run: "synthetic-chess-fixture", base: "synthetic-chess-base" }] } });
  });

  await page.goto("/");
  await page.evaluate((games) => localStorage.setItem("kev.chess.v1", JSON.stringify(games)), [historical, imported]);
  const storedBytes = await page.evaluate(() => localStorage.getItem("kev.chess.v1"));
  await page.goto("/chess");
  await page.getByRole("button", { name: "简体中文", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  const knownRow = page.locator("ul li").filter({ hasText: "½-½" });
  const importedRow = page.locator("ul li").filter({ hasText: "imported summary" });
  await expect(knownRow).toHaveCount(1);
  await expect(importedRow).toHaveCount(1);
  await expect(knownRow).toContainText("19 步 · ½-½ (逼和)");
  await expect(importedRow).toContainText("1/2-1/2 (imported summary)");
  await page.screenshot({ path: path.join(evidence, "qa-chess-stored-history-zh.png"), fullPage: true });

  await switchLanguage(page, "en");
  await expect(knownRow).toContainText(`19 plies · ${known}`);
  await expect(importedRow).toContainText("1/2-1/2 (imported summary)");
  await switchLanguage(page, "zh-CN");
  await expect(knownRow).toContainText("½-½ (逼和)");
  expect(await page.evaluate(() => localStorage.getItem("kev.chess.v1"))).toBe(storedBytes);
  expect(calls.some((call) => call.endsWith("/v1/systemone"))).toBe(false);
  await page.screenshot({ path: path.join(evidence, "qa-chess-stored-history-zh-after-switch.png"), fullPage: true });
});
