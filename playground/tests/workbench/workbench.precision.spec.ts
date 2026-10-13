import { expect, test, type Locator, type Page } from "@playwright/test";

const TASKS = {
  schema: "kev-project-tasks/1",
  model: "kev-4b",
  tasks: {
    "support-review": {
      description: "支持请求",
      questions: {
        category: {
          type: "choice",
          instructions: "Classify this synthetic request.",
          criteria: {
            "billing-账单与付款BillingQuestion": "A long mixed billing label",
            delivery: "A shipment question",
          },
        },
        needs_review: { type: "noul", instructions: "Needs review?" },
        urgency: { type: "score", instructions: "How soon?", criteria: ["Later · 稍后", "Today · 今天处理，概率不是准确率"] },
      },
    },
  },
};

function channel(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

function luminance(color: string): number {
  const match = color.match(/rgba?\(([^)]+)\)/);
  if (!match) throw new Error(`unparsed color ${color}`);
  const [red, green, blue, alpha = 1] = match[1].split(",").map((part) => Number(part.trim()));
  if (alpha === 0) return Number.NaN;
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

function contrast(foreground: string, background: string): number {
  const left = luminance(foreground);
  const right = luminance(background);
  const lighter = Math.max(left, right);
  const darker = Math.min(left, right);
  return (lighter + 0.05) / (darker + 0.05);
}

async function paint(locator: Locator): Promise<{ color: string; background: string }> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    let node: Element | null = element;
    let background = "rgba(0, 0, 0, 0)";
    while (node) {
      const next = getComputedStyle(node).backgroundColor;
      if (next && next !== "rgba(0, 0, 0, 0)" && next !== "transparent") {
        background = next;
        break;
      }
      node = node.parentElement;
    }
    return { color: style.color, background };
  });
}

async function post(page: Page, pathname: string, body: unknown): Promise<void> {
  const status = await page.evaluate(async ({ pathname: pathValue, body: bodyValue }) => {
    const response = await fetch(pathValue, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bodyValue),
    });
    return response.status;
  }, { pathname, body });
  expect(status).toBe(200);
}

async function overflow(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await post(page, "/api/workbench/test", {
    action: "configure",
    delayMs: 0,
    failure: "none",
    loadFailure: "none",
    closeFailure: false,
    historyWriteFailure: false,
    settingsWriteFailure: false,
  });
  await post(page, "/api/workbench", { action: "import", content: JSON.stringify(TASKS) });
  await post(page, "/api/workbench", {
    action: "settings",
    settings: { selectedModel: "kev-4b", exportModel: "kev-4b", theme: "light", locale: "en", projectDescription: null },
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Local model workbench" })).toBeVisible();
});

test("keeps workbench views inside the viewport and readable", async ({ page }) => {
  const viewports = [
    { width: 375, height: 812 },
    { width: 768, height: 1024 },
    { width: 1024, height: 768 },
    { width: 1440, height: 900 },
    { width: 812, height: 375 },
  ];
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    for (const name of ["Run", "Task library", "History"] as const) {
      await page.getByRole("button", { name, exact: true }).click();
      expect(await overflow(page), `${name} ${viewport.width}x${viewport.height}`).toBe(false);
    }
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  const help = page.getByText("Text is submitted literally", { exact: false });
  await page.getByRole("button", { name: "Run", exact: true }).click();
  expect(await help.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(14);
  const meta = page.getByText("Kev · local inference, typed answers");
  expect(await meta.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(12);

  await page.setViewportSize({ width: 375, height: 812 });
  await page.locator("details[aria-label='Model controls'] > summary").click();
  const load = page.getByRole("button", { name: "Load model" });
  const loadBox = await load.boundingBox();
  expect(loadBox?.height).toBeGreaterThanOrEqual(44);
  expect(loadBox?.width).toBeGreaterThanOrEqual(44);
  const theme = page.getByRole("button", { name: "Use dark theme" });
  const themeBox = await theme.boundingBox();
  expect(themeBox?.width).toBeGreaterThanOrEqual(24);
  expect(themeBox?.height).toBeGreaterThanOrEqual(24);
});

test("measures rendered contrast and keeps keyboard focus visible", async ({ page }) => {
  await page.locator("details[aria-label='Model controls'] > summary").click();
  const loadPaint = await paint(page.getByRole("button", { name: "Load model" }));
  expect(contrast(loadPaint.color, loadPaint.background)).toBeGreaterThanOrEqual(4.5);
  await page.getByRole("button", { name: "Load model" }).click();
  await expect(page.getByRole("button", { name: "Switch model" })).toBeVisible();
  await page.getByLabel("Selected model").selectOption("kev-0.8b");
  const warning = page.getByRole("status").filter({ hasText: "is resident, while" });
  await expect(warning).toBeVisible();
  const warningPaint = await paint(warning);
  expect(contrast(warningPaint.color, warningPaint.background)).toBeGreaterThanOrEqual(4.5);

  const help = page.getByText("Probabilities and scores are model outputs", { exact: false });
  const helpPaint = await paint(help);
  expect(contrast(helpPaint.color, helpPaint.background)).toBeGreaterThanOrEqual(4.5);

  await page.getByRole("textbox", { name: "State input" }).fill("Synthetic contrast state");
  await page.getByLabel("Selected model").selectOption("kev-4b");
  const runPaint = await paint(page.getByRole("button", { name: "Run task" }));
  expect(contrast(runPaint.color, runPaint.background)).toBeGreaterThanOrEqual(4.5);

  await page.getByRole("button", { name: "Use dark theme" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  const darkHelp = await paint(page.getByText("Probabilities and scores are model outputs", { exact: false }));
  expect(contrast(darkHelp.color, darkHelp.background)).toBeGreaterThanOrEqual(4.5);
  await page.getByRole("button", { name: "Use light theme" }).click();

  await page.getByRole("button", { name: "Run", exact: true }).focus();
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => {
    const element = document.activeElement;
    if (!element) return null;
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return {
      name: element.getAttribute("aria-label") || element.textContent,
      outline: style.outlineStyle,
      width: style.outlineWidth,
      shadow: style.boxShadow,
      top: box.top,
      bottom: box.bottom,
      viewport: window.innerHeight,
    };
  });
  const focusVisible = focused?.outline !== "none" || (focused?.shadow && focused.shadow !== "none");
  expect(focusVisible).toBe(true);
  expect(focused!.bottom).toBeGreaterThan(0);
  expect(focused!.top).toBeLessThan(focused!.viewport);
});

test("keeps textual busy feedback when motion is reduced", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.locator("details[aria-label='Model controls'] > summary").click();
  const load = page.getByRole("button", { name: "Load model", exact: true });
  if (await load.isVisible()) await load.click();
  await expect(page.getByRole("button", { name: "Switch model" })).toBeVisible();
  await page.getByLabel("Selected model").selectOption("kev-4b");
  await page.getByRole("textbox", { name: "State input" }).fill("Synthetic reduced-motion state");
  await post(page, "/api/workbench/test", { action: "configure", delayMs: 2500, failure: "none" });
  await page.getByRole("button", { name: "Run task" }).click();
  const status = page.getByRole("status").filter({ hasText: "Running one submitted state" });
  await expect(status).toBeVisible();
  const duration = await page.locator(".animate-spin").evaluate((element) => getComputedStyle(element).animationDuration);
  expect(Number.parseFloat(duration)).toBeLessThan(0.05);
  await expect(page.getByRole("article", { name: "category Choice result" })).toBeVisible();
  await expect(page.getByText("billing-账单与付款BillingQuestion").first()).toBeVisible();
  await expect(page.getByText("0.620").first()).toBeVisible();
});

test("smokes Classic and Chess through synthetic v1 fixtures only", async ({ page }) => {
  const calls: string[] = [];
  await page.route("**/kev/v1/**", async (route) => {
    const url = route.request().url();
    calls.push(new URL(url).pathname);
    const headers = { "content-type": "application/json", "x-synthetic-fixture": "classic-chess-v1" };
    if (url.includes("/v1/models")) {
      await route.fulfill({ headers, json: { models: [{ name: "synthetic-fixture", run: "synthetic-kev-fixture", base: "synthetic-base-fixture" }] } });
      return;
    }
    const body = route.request().postDataJSON() ?? {};
    if (url.endsWith("/permute")) {
      const keys = Object.keys(body.request?.questions?.[body.question]?.criteria ?? { a: "one" });
      await route.fulfill({
        headers,
        json: {
          runs: [{ order: keys, probabilities: Object.fromEntries(keys.map((key) => [key, 1 / keys.length])), choice: keys[0], latency_ms: 9 }],
          argmax_stable: true,
          spread: Object.fromEntries(keys.map((key) => [key, 0])),
        },
      });
      return;
    }
    const questions = body.questions ?? body.request?.questions ?? {};
    const answers: Record<string, unknown> = {};
    for (const [id, question] of Object.entries(questions) as [string, { type?: string; criteria?: unknown }][]) {
      if (question.type === "noul") answers[id] = { type: "noul", noul: 0.5 };
      else if (question.type === "score") {
        const levels = Array.isArray(question.criteria) ? question.criteria : ["a"];
        answers[id] = {
          type: "score",
          score: 0,
          confidence: 0.2,
          legend: Object.fromEntries(levels.map((level, index) => [String(index), String(level)])),
          probabilities: Object.fromEntries(levels.map((_, index) => [String(index), 1 / levels.length])),
        };
      } else {
        const keys = Object.keys((question.criteria ?? { e4: "pawn" }) as Record<string, unknown>);
        const choice = keys.includes("e4") ? "e4" : keys[0];
        answers[id] = { type: "choice", choice, confidence: 0.2, probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? 0.5 : 0.5 / Math.max(keys.length - 1, 1)])) };
      }
    }
    await route.fulfill({
      headers,
      json: { model: "synthetic-fixture", answers, usage: { input_tokens: 8, output_tokens: 2 }, latency_ms: 7 },
    });
  });

  await page.goto("/classic");
  await expect(page.getByText("synthetic-base-fixture")).toBeVisible();
  await page.getByRole("button", { name: /^Run/ }).click();
  await expect(page.getByRole("heading", { name: /department/ })).toBeVisible();
  await page.getByRole("button", { name: "Packed vs separate" }).click();
  await expect(page.getByText("separate requests")).toBeVisible();
  await page.getByRole("button", { name: /Permute/ }).first().click();
  await expect(page.getByText("The top option is the same in every order.")).toBeVisible();
  expect(calls.some((path) => path.endsWith("/v1/systemone"))).toBe(true);
  expect(calls.some((path) => path.includes("/api/workbench"))).toBe(false);

  await page.addInitScript(() => {
    localStorage.setItem("kev.chess.v1", JSON.stringify([
      { id: "finished-synthetic", startedAt: 1700000000000, mode: "self", pgn: "", moves: [{ san: "e4", by: "model" }, { san: "e5", by: "model" }], result: "½-½ (stalemate)" },
      { id: "open-synthetic", startedAt: 1700000001000, mode: "white", pgn: "", moves: [] },
    ]));
  });
  await page.goto("/chess");
  await expect(page.getByText("½-½ (stalemate)")).toBeVisible();
  await expect(page.getByRole("button", { name: "You play White" })).toHaveAttribute("aria-current", "true");
  await page.getByRole("button", { name: "Model vs model", exact: true }).click();
  await page.getByRole("button", { name: "Step", exact: true }).click();
  await expect(page.getByText("confidence").first()).toBeVisible();
  for (const viewport of [{ width: 375, height: 812 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    expect(await overflow(page)).toBe(false);
    const board = await page.getByRole("grid", { name: "Chess board" }).boundingBox();
    expect(board && Math.abs(board.width - board.height)).toBeLessThan(2);
  }
});
