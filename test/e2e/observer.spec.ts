import type { EventDraft, Fact } from "../../src/model/index.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startService } from "../../dist/server/main.js";
import { openViewer } from "../../dist/lifecycle/index.js";
import { twoTurnFixture } from "../fixtures/two-turn.js";
import { multiQuestionFixture } from "../fixtures/multi-question.js";
async function showFilters(page: Page) {
  const filters = page.locator(".observer-filters");
  const summary = filters.locator("summary");
  if (
    (await summary.isVisible()) &&
    (await filters.getAttribute("open")) === null
  ) {
    await summary.click();
  }
}
async function showGraph(page: Page) {
  await page.locator(".observer-tools > label select").selectOption("");
  await page
    .locator(".mobile-tabs button")
    .filter({ hasText: /^(Call graph|调用图)$/ })
    .click();
}
async function chooseCall(page: Page, id: string) {
  await showFilters(page);
  await page.getByLabel("Select call", { exact: true }).selectOption(id);
}
let directory: string;
let service: Awaited<ReturnType<typeof startService>>;
const fixture = twoTurnFixture();
const multi = multiQuestionFixture();
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-obs-browser-"));
  service = await startService({ dataDir: directory });
  service.recorder.appendBatch({
    protocolVersion: 1,
    storeId: service.handle.storeId,
    ...fixture,
  });
  for (let i = 0; i < multi.events.length; i += 100) {
    service.recorder.appendBatch({
      protocolVersion: 1,
      storeId: service.handle.storeId,
      ...multi,
      events: multi.events.slice(i, i + 100),
    });
  }
});
test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
});
test.afterAll(async () => {
  await service?.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
});
test("history recorded with no browser renders graph, timeline, details, replay and refresh", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { url } = await openViewer(service.handle, {
    sessionKey: fixture.sessionKey,
  });
  await page.goto(url);
  await showGraph(page);
  await expect(
    page.getByRole("heading", { name: "Pi Loop Observer" }),
  ).toBeVisible();
  await expect(
    page.locator('.react-flow__node[data-id="fixture-llm2"]'),
  ).toBeVisible();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect(
    page.locator(
      '.react-flow__edge[data-id="fixture-tool-a:fixture-llm2:result-consumed"] .react-flow__edge-path',
    ),
  ).toHaveAttribute("marker-end", /url/);

  await expect(page).not.toHaveURL(/ticket/);
  await chooseCall(page, "fixture-llm2");
  await expect(page.locator("aside")).toContainText("第二轮模型已处理错误");
  await page
    .getByRole("button", { name: "Previous stage", exact: true })
    .click();
  await page.getByRole("slider", { name: "Replay position" }).focus();
  await page.keyboard.press("Home");
  await expect(page.locator("aside")).not.toContainText("第二轮模型已处理错误");
  await page.getByRole("button", { name: "Back to live", exact: true }).click();
  await page.getByRole("button", { name: "Timeline", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  if (testInfo.project.name !== "desktop") {
    await chooseCall(page, "fixture-tool-a");
    await expect(page.locator("aside")).toContainText("bash");
    await expect(page.locator("aside")).toContainText("Failed");
    await page.getByRole("button", { name: "Call graph", exact: true }).click();
    await page
      .getByRole("button", {
        name: "Focus selected / active call",
        exact: true,
      })
      .click();
    await expect(
      page.locator('.react-flow__node[data-id="fixture-tool-a"]'),
    ).toBeInViewport();
    expect(
      await page
        .locator(".react-flow__viewport")
        .evaluate(
          (element) =>
            new DOMMatrixReadOnly(getComputedStyle(element).transform).a,
        ),
    ).toBeCloseTo(1);
  }
  await page.screenshot({
    path: testInfo.outputPath("observer.png"),
    fullPage: true,
  });
  await page.reload();
  await showGraph(page);
  await expect(
    page.locator('.react-flow__node[data-id="fixture-llm2"]'),
  ).toBeVisible();
  expect(
    await page.locator('.react-flow__node[data-id="fixture-llm2"]').count(),
  ).toBe(1);
  if (testInfo.project.name === "desktop") {
    // Exercise the 250ms live projection updates after several fresh graph mounts.
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.reload();
      await showGraph(page);
      await expect(
        page.locator('.react-flow__node[data-id="fixture-llm2"]'),
      ).toBeVisible();
      const hiddenFrames = await page.evaluate(
        () =>
          new Promise<number>((resolve) => {
            const started = performance.now();
            let hidden = 0;
            const sample = () => {
              const node = document.querySelector(
                '.react-flow__node[data-id="fixture-llm2"]',
              );
              if (
                !node ||
                getComputedStyle(node).visibility === "hidden" ||
                node.getBoundingClientRect().height === 0
              )
                hidden++;
              if (performance.now() - started >= 800) resolve(hidden);
              else requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
          }),
      );
      expect(hiddenFrames).toBe(0);
    }
  }
  expect(errors).toEqual([]);
});

test("paused replay keeps its prefix while disconnected live records are recovered", async ({
  page,
  context,
}) => {
  const live = twoTurnFixture("fixture/live", "live-producer");
  service.recorder.appendBatch({
    protocolVersion: 1,
    storeId: service.handle.storeId,
    ...live,
    events: live.events.slice(0, 8),
  });
  const { url } = await openViewer(service.handle, {
    sessionKey: live.sessionKey,
  });
  await page.goto(url);
  await showGraph(page);
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect(
    page.locator('.react-flow__node[data-id="fixture-llm1"]'),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Previous stage", exact: true })
    .click();
  await expect(page.locator("footer")).toContainText("Replay");
  await context.setOffline(true);
  service.recorder.appendBatch({
    protocolVersion: 1,
    storeId: service.handle.storeId,
    ...live,
    events: live.events.slice(8),
  });
  await context.setOffline(false);
  await expect(page.getByText("Connected", { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await expect(
    page.locator('.react-flow__node[data-id="fixture-llm2"]'),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Back to live", exact: true }).click();
  await expect(
    page.locator('.react-flow__node[data-id="fixture-llm2"]'),
  ).toBeVisible({ timeout: 15000 });
  await expect(
    page.locator('.react-flow__node[data-id="fixture-llm2"]'),
  ).toHaveCount(1);
});

test("questions contain turn lanes, local timing, search and persistent language", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { url } = await openViewer(service.handle, {
    sessionKey: multi.sessionKey,
  });
  await page.goto(url);
  await showGraph(page);
  await expect(page.getByLabel("Language", { exact: true })).toHaveValue("en");
  await expect(
    page.getByRole("link", { name: "GitHub", exact: true }),
  ).toHaveAttribute("href", "https://github.com/zzy2008/pi-loop-observer");
  await expect(
    page.getByRole("link", { name: "Documentation", exact: true }),
  ).toHaveAttribute(
    "href",
    "https://github.com/zzy2008/pi-loop-observer#readme",
  );
  const question = page.getByLabel("Select question", { exact: true });
  await expect(question).toContainText("Q1 · Investigate search configuration");
  await expect(question).toContainText("Q2 · Review API retries");
  await expect(page.locator(".react-flow__node")).toHaveCount(98);
  const positions = await page
    .locator(".react-flow__node")
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const matrix = new DOMMatrixReadOnly(getComputedStyle(node).transform);
        return {
          id: node.getAttribute("data-id"),
          x: matrix.e,
          y: matrix.f,
          height: (node as HTMLElement).offsetHeight,
          width: (node as HTMLElement).offsetWidth,
        };
      }),
    );
  const q1 = positions.find((p) => p.id === "prompt:multi-question-1")!;
  const q2 = positions.find((p) => p.id === "prompt:multi-question-2")!;
  expect(q2.y - q1.y - q1.height).toBe(24);
  const firstTurn = positions.find((p) => p.id === "turn:multi-q1-turn1")!;
  const secondTurn = positions.find((p) => p.id === "turn:multi-q1-turn2")!;
  expect(firstTurn.x).toBeGreaterThan(q1.x);
  expect(secondTurn.y - firstTurn.y - firstTurn.height).toBe(12);
  const firstCall = positions.find((p) => p.id === "multi-q1-t1-llm")!;
  const nextCall = positions.find((p) => p.id === "multi-q1-t1-read1")!;
  expect(firstCall.y).toBe(nextCall.y);
  expect(firstCall.x).toBeGreaterThan(firstTurn.x);
  expect(nextCall.x - firstCall.x - firstCall.width).toBe(56);
  expect(firstCall.y + firstCall.height).toBeLessThan(
    firstTurn.y + firstTurn.height,
  );
  const questionNode = page.locator(
    '.react-flow__node[data-id="prompt:multi-question-1"]',
  );
  await questionNode
    .getByRole("button", { name: "Collapse", exact: true })
    .click();
  await expect(page.locator(".react-flow__node")).toHaveCount(50);
  await questionNode
    .getByRole("button", { name: "Expand", exact: true })
    .click();
  await expect(page.locator(".react-flow__node")).toHaveCount(98);
  const picker = page.getByLabel("Select call", { exact: true });
  await expect(picker).toContainText(
    "Q1.T1.C2 · read · path: src/q1/turn-1-0.ts",
  );
  await expect(picker).toContainText(
    "Q1.T1.C3 · read · path: src/q1/turn-1-1.ts",
  );
  await page.getByRole("button", { name: "Timeline", exact: true }).click();
  const groups = page.getByTestId("question-timeline");
  await expect(groups).toHaveCount(2);
  for (const id of ["multi-question-1", "multi-question-2"]) {
    const group = page.locator(
      `[data-testid="question-timeline"][data-trace-id="${id}"]`,
    );
    await expect(group).toHaveAttribute("data-duration-ms", "72000");
    await expect(group.getByRole("heading", { level: 3 })).toContainText(
      "1.2 min",
    );
  }
  const firstAxis = page.locator('[data-trace-id="multi-question-1"] svg');
  await expect(firstAxis).toHaveAttribute("data-range-min", "1");
  await expect(firstAxis).toHaveAttribute("data-range-ms", "72000");
  await expect(
    firstAxis.locator('[data-turn-id="multi-q1-turn1"] text'),
  ).toContainText("Turn 1");
  await expect(
    firstAxis.locator('[data-span-id="multi-q1-t1-llm"] text').first(),
  ).toContainText("Call 1 · fixture-model");
  await showFilters(page);
  await page
    .getByLabel("Navigate to turn", { exact: true })
    .selectOption("multi-q1-turn1");
  await expect(
    firstAxis.locator('[data-turn-id="multi-q1-turn1"]'),
  ).toContainText("Collapsed");
  await expect(firstAxis).toHaveAttribute("data-range-min", "1");
  await expect(firstAxis).toHaveAttribute("data-range-ms", "72000");
  await showFilters(page);
  await page
    .getByLabel("Navigate to turn", { exact: true })
    .selectOption("multi-q1-turn1");
  await page
    .getByRole("button", { name: "Session overview", exact: true })
    .click();
  await expect(groups).toHaveCount(1);
  await expect(groups).toHaveAttribute("data-trace-id", "overview");
  await expect(groups.getByRole("heading", { level: 3 })).toContainText(
    "1.02 h",
  );
  await expect(groups).toContainText("includes idle gaps");
  await page.getByRole("button", { name: "Per question", exact: true }).click();
  await showFilters(page);
  await question.selectOption("multi-question-1");
  const search = page.getByLabel("Search current session", { exact: true });
  await search.fill("src/q2/turn-12-1.ts");
  await expect(page.getByTestId("search-count")).toContainText(
    "1 matching calls",
  );
  await page.getByTestId("search-results").getByRole("button").click();
  await expect(page.locator("aside h2")).toContainText("Q2.T12.C3");
  await expect(page.locator("aside")).toContainText("2026");
  await expect(page.locator("aside")).toContainText("1.6 s");
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await page.getByRole("button", { name: "Call graph", exact: true }).click();
  await page
    .getByRole("button", { name: "Focus selected / active call", exact: true })
    .click();
  await expect(
    page.locator('.react-flow__node[data-id="multi-q2-t12-read2"]'),
  ).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("observer-v2.png"),
    fullPage: true,
  });
  await page.getByLabel("Language", { exact: true }).selectOption("zh");
  await expect(page.getByLabel("搜索当前会话", { exact: true })).toBeVisible();
  await page.reload();
  await showGraph(page);
  await expect(page.getByLabel("语言", { exact: true })).toHaveValue("zh");
  await expect(page.getByText("已连接", { exact: true })).toBeVisible();
  await page.getByLabel("语言", { exact: true }).selectOption("en");
  await search.fill("Review API retries");
  await expect(page.getByTestId("search-count")).toContainText(
    "36 matching calls",
  );
  await page.getByRole("slider", { name: "Replay position" }).focus();
  await page.keyboard.press("Home");
  await expect(page.getByTestId("search-count")).toContainText(
    "0 matching calls",
  );
  await expect(page.getByTestId("search-results")).not.toContainText(
    "Q2.T12.C3",
  );
  await expect(question).not.toContainText("Review API retries");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("compact layout keeps visuals prominent with sticky header, themes and favicon", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ colorScheme: "light" });
  const { url } = await openViewer(service.handle, {
    sessionKey: fixture.sessionKey,
  });
  await page.goto(url);
  await showGraph(page);
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Color theme", { exact: true })).toHaveValue(
    "system",
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const header = page.locator(".product-header");
  const graph = page.locator("main.graph");
  for (const name of ["GitHub", "Documentation"]) {
    const link = await page
      .getByRole("link", { name, exact: true })
      .boundingBox();
    expect(link!.x).toBeGreaterThanOrEqual(0);
    expect(link!.x + link!.width).toBeLessThanOrEqual(
      testInfo.project.use.viewport!.width,
    );
  }
  const metrics = await page.evaluate(() => {
    const graph = document.querySelector("main.graph")!.getBoundingClientRect();
    const header = document
      .querySelector(".product-header")!
      .getBoundingClientRect();
    return {
      headerHeight: header.height,
      graphTop: graph.top,
      graphHeight: graph.height,
      viewportWidth: innerWidth,
      pageWidth: document.documentElement.scrollWidth,
    };
  });
  expect(metrics.graphTop).toBeLessThanOrEqual(
    testInfo.project.name === "desktop" ? 230 : 360,
  );
  expect(metrics.graphHeight).toBeGreaterThanOrEqual(360);
  expect(metrics.pageWidth).toBeLessThanOrEqual(metrics.viewportWidth);
  await writeFile(
    testInfo.outputPath("layout-metrics.json"),
    JSON.stringify(metrics, null, 2),
  );
  await testInfo.attach("layout-metrics", {
    body: JSON.stringify(metrics),
    contentType: "application/json",
  });
  await expect(page.locator(".timeline-wrap")).toBeHidden();
  await expect(page.locator(".detail-wrap")).toBeHidden();
  const zoom = () =>
    page
      .locator(".react-flow__viewport")
      .evaluate(
        (el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).a,
      );
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect.poll(zoom).toBeGreaterThan(1);
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  await expect.poll(zoom).toBeCloseTo(1);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath("compact-dark.png"),
    fullPage: true,
  });
  await page.evaluate(() => scrollTo(0, 500));
  await expect
    .poll(async () => (await header.boundingBox())!.y)
    .toBeCloseTo(0, 0);
  await expect(
    page.getByLabel("Color theme", { exact: true }),
  ).toBeInViewport();
  const colors = () =>
    page.evaluate(() => ({
      node: getComputedStyle(document.querySelector(".react-flow__node")!)
        .backgroundColor,
      text: getComputedStyle(document.querySelector(".react-flow__node")!)
        .color,
      axis: getComputedStyle(document.querySelector(".timeline svg text")!)
        .fill,
      page: getComputedStyle(document.documentElement).backgroundColor,
      toolbar: getComputedStyle(document.querySelector(".graph-tools")!)
        .backgroundColor,
    }));
  const dark = await colors();
  await page.getByLabel("Color theme", { exact: true }).selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const light = await colors();
  expect(light.node).not.toBe(dark.node);
  expect(light.text).not.toBe(dark.text);
  expect(light.axis).not.toBe(dark.axis);
  expect(light.page).not.toBe(dark.page);
  expect(light.toolbar).not.toBe(dark.toolbar);
  await page.reload();
  await showGraph(page);
  await expect(page.getByLabel("Color theme", { exact: true })).toHaveValue(
    "light",
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("compact-light.png"),
    fullPage: true,
  });
  if (testInfo.project.name !== "desktop") {
    await page.getByRole("button", { name: "Timeline", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Timeline", exact: true }),
    ).toBeVisible();
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({
      path: testInfo.outputPath("compact-light-timeline.png"),
      fullPage: true,
    });
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.getByLabel("Color theme", { exact: true }).selectOption("system");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const icon = await page.locator('link[rel="icon"]').getAttribute("href");
  const response = await page.request.get(new URL(icon!, page.url()).href);
  expect(icon).toContain("favicon-light.svg");
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toContain("image/svg+xml");
  expect(await response.text()).toContain("Pi Loop Observer");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("typography and controls remain consistent across panels and languages", async ({
  page,
}, testInfo) => {
  const { url } = await openViewer(service.handle, {
    sessionKey: fixture.sessionKey,
  });
  await page.goto(url);
  await showGraph(page);
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  const inspect = () =>
    page.evaluate(() => {
      const read = (selector: string) => {
        const el = document.querySelector(selector)!;
        const style = getComputedStyle(el);
        return {
          family: style.fontFamily,
          size: parseFloat(style.fontSize),
          weight: style.fontWeight,
          height: el.getBoundingClientRect().height,
          radius: style.borderRadius,
        };
      };
      return {
        body: read("body"),
        header: read(".product-header select"),
        session: read(".session-picker select"),
        search: read(".search-controls input"),
        picker: read(".call-picker select"),
        focus: read(".graph-actions > button"),
        replay: read(".replay button"),
        node: read(".observer-tree-node strong"),
        caption: read(".observer-tree-node small"),
        details: read(".details h2"),
        timeline: read(".timeline h2"),
      };
    });
  await showFilters(page);
  let fonts = await inspect();
  for (const control of [
    fonts.header,
    fonts.session,
    fonts.search,
    fonts.picker,
    fonts.focus,
    fonts.replay,
  ]) {
    expect(control.family).toBe(fonts.body.family);
    expect(control.size).toBe(fonts.body.size);
    expect(control.height).toBe(testInfo.project.name === "desktop" ? 32 : 36);
    expect(control.radius).toBe(fonts.header.radius);
  }
  expect(fonts.details.size).toBe(fonts.timeline.size);
  expect(fonts.details.weight).toBe(fonts.timeline.weight);
  expect(fonts.node.family).toBe(fonts.body.family);
  expect(fonts.node.size).toBe(fonts.body.size);
  expect(fonts.caption.size).toBeGreaterThanOrEqual(12);
  await page.locator(".observer-filters > summary").click();
  await page.getByRole("button", { name: "Timeline", exact: true }).click();
  await expect
    .poll(() =>
      page
        .locator(".timeline svg")
        .first()
        .evaluate((el) => (el as SVGSVGElement).getScreenCTM()!.a),
    )
    .toBeCloseTo(1, 2);
  const chart = await page
    .locator(".timeline svg")
    .first()
    .evaluate((el) => {
      const axis = el.querySelector("text")!;
      return {
        family: getComputedStyle(axis).fontFamily,
        size: parseFloat(getComputedStyle(axis).fontSize),
        actualSize:
          parseFloat(getComputedStyle(axis).fontSize) *
          (el as SVGSVGElement).getScreenCTM()!.a,
      };
    });
  expect(chart.family).toBe(fonts.body.family);
  expect(chart.actualSize).toBeGreaterThanOrEqual(12);
  await chooseCall(page, "fixture-llm2");
  await expect(page.locator("aside")).toContainText("第二轮模型已处理错误");
  await expect(page.locator("aside h2")).toHaveCSS(
    "font-size",
    `${fonts.timeline.size}px`,
  );
  await page.getByRole("button", { name: "Timeline", exact: true }).click();
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath("consistent-en-dark.png"),
    fullPage: true,
  });
  await page.getByLabel("Color theme", { exact: true }).selectOption("light");
  await page.getByLabel("Language", { exact: true }).selectOption("zh");
  await expect(page.getByText("已连接", { exact: true })).toBeVisible();
  fonts = await inspect();
  expect(fonts.details.size).toBe(fonts.timeline.size);
  expect(fonts.search.size).toBe(fonts.picker.size);
  expect(fonts.header.family).toBe(fonts.node.family);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath("consistent-zh-light.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await writeFile(
    testInfo.outputPath("typography-metrics.json"),
    JSON.stringify({ fonts, chart }, null, 2),
  );
});

test("focused workspace switches views and opens details only on demand", async ({
  page,
}, testInfo) => {
  const { url } = await openViewer(service.handle, {
    sessionKey: multi.sessionKey,
  });
  await page.goto(url);
  await showGraph(page);
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect(page.locator("main.graph")).toBeVisible();
  await expect(page.locator(".timeline-wrap")).toBeHidden();
  await expect(page.locator(".detail-wrap")).toBeHidden();
  await expect(page.getByLabel("History branch", { exact: true })).toBeHidden();
  await expect(
    page.getByLabel("Select question", { exact: true }),
  ).toBeVisible();
  const mainWidth = await page
    .locator("main.graph")
    .evaluate((el) => el.getBoundingClientRect().width);
  expect(mainWidth).toBeGreaterThan(testInfo.project.use.viewport!.width * 0.9);
  await page.screenshot({
    path: testInfo.outputPath("focused-graph-dark.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Timeline", exact: true }).click();
  await expect(page.locator("main.graph")).toBeHidden();
  await expect(page.locator(".timeline-wrap")).toBeVisible();
  await page.locator('.timeline svg g[role="button"]').first().focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".detail-wrap")).toBeVisible();
  await expect(page.locator("aside h2")).toContainText("Q1.T1.C1");
  await page.screenshot({
    path: testInfo.outputPath("focused-details-dark.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Close details", exact: true })
    .click();
  await expect(page.locator(".detail-wrap")).toBeHidden();
  await expect(page.locator(".timeline-wrap")).toBeVisible();
  await page.getByLabel("Color theme", { exact: true }).selectOption("light");
  await page.screenshot({
    path: testInfo.outputPath("focused-timeline-light.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Call graph", exact: true }).click();
  await expect(page.locator("main.graph")).toBeVisible();
  await showFilters(page);
  await expect(
    page.getByLabel("History branch", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Navigate to turn", { exact: true })
    .selectOption("multi-q1-turn1");
  await page.locator(".observer-filters > summary").click();
  await expect(
    page.locator('.react-flow__node[data-id="multi-q1-t1-llm"]'),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("trace follows the latest question, keeps history selectable, and inspects compact rows", async ({
  page,
}, testInfo) => {
  const { url } = await openViewer(service.handle, {
    sessionKey: multi.sessionKey,
  });
  await page.goto(url);
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Color theme", { exact: true })).toHaveValue(
    "system",
  );
  await expect(
    page.getByRole("button", { name: "Trace", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  const trace = page.locator(".trace-wrap");
  await expect(trace).toBeVisible();
  await expect(page.locator("main.graph")).toBeHidden();
  await expect(page.locator(".detail-wrap")).toBeHidden();
  await expect(trace.locator(".trace-question-title")).toContainText(
    "Q2 · Review API retries",
  );
  await expect(trace.locator(".trace-row[data-span-id]")).toHaveCount(36);
  await page.screenshot({
    path: testInfo.outputPath("trace-dark.png"),
    fullPage: true,
  });
  const first = trace.locator(".trace-row[data-span-id]").first();
  await first.locator(".trace-select").click();
  await expect(page.locator(".details h2")).toContainText("Q2.T1.C1");
  await expect(trace).toBeVisible();
  await expect(first).toHaveClass(/is-selected/);
  await page.screenshot({
    path: testInfo.outputPath("trace-details-dark.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Close details", exact: true })
    .click();
  const domain = trace.locator(".trace-domain").first();
  const range = await domain.getAttribute("data-range-ms");
  await trace.locator(".trace-fold").first().click();
  await expect(trace.locator(".trace-row[data-span-id]")).toHaveCount(33);
  await expect(domain).toHaveAttribute("data-range-ms", range!);
  await trace.locator(".trace-fold").first().click();
  await page
    .getByLabel("Select question", { exact: true })
    .selectOption("multi-question-1");
  await expect(trace.locator(".trace-question-title")).toContainText("Q1");
  await page
    .getByLabel("Search current session", { exact: true })
    .fill("src/q2/turn-12-1.ts");
  await page.getByTestId("search-results").getByRole("button").click();
  await expect(page.locator(".details h2")).toContainText("Q2.T12.C3");
  await expect(
    trace.locator('.trace-row[data-span-id="multi-q2-t12-read2"]'),
  ).toBeInViewport();
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await page
    .getByRole("button", { name: "Close details", exact: true })
    .click();
  await page.getByLabel("Color theme", { exact: true }).selectOption("light");
  await page
    .getByLabel("Select question", { exact: true })
    .selectOption("__latest");
  await trace.evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.getByLabel("Language", { exact: true }).selectOption("zh");
  await page.screenshot({
    path: testInfo.outputPath("trace-light-zh.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("live trace follows new questions unless history is pinned, and records SDK duration and cancellation", async ({
  page,
}, testInfo) => {
  const sessionKey = `fixture/follow-${testInfo.project.name}`;
  const producerId = sessionKey + ":producer";
  let seq = 0;
  const addQuestion = (number: number) => {
    const traceId = `follow-q${number}`,
      turnId = `follow-t${number}`,
      runId = `follow-r${number}`;
    const facts: Fact[] = [
      { type: "run.started", runId },
      {
        type: "input.applied",
        traceId,
        kind: "normal",
        label: `Question ${number}`,
      },
      { type: "turn.started", turnId, runId, turnIndex: 0 },
      {
        type: "span.started",
        spanId: `follow-call${number}`,
        kind: "tool",
        name: "read",
        timingBasis: "observed",
      },
      {
        type: "span.ended",
        spanId: `follow-call${number}`,
        outcome: "completed",
        durationMs: 0,
      },
      { type: "turn.ended", turnId, runId, turnIndex: 0 },
      { type: "run.ended", runId },
      { type: "run.settled", runId, outcomeKnown: true, aborted: number === 2 },
    ];
    const events: EventDraft[] = facts.map((fact) => ({
      schemaVersion: 1,
      eventId: `${producerId}:${++seq}`,
      producerId,
      producerSeq: seq,
      sessionKey,
      source: "pi-live",
      observedAt: {
        wallMs: 1791072000000 + seq * 100,
        monoMs: seq * 100,
        clockId: "follow-clock",
      },
      refs: { traceId, turnId, runId },
      fact,
    }));
    service.recorder.appendBatch({
      protocolVersion: 1,
      storeId: service.handle.storeId,
      sessionKey,
      producerId,
      events,
      payloads: [],
    });
  };
  addQuestion(1);
  const { url } = await openViewer(service.handle, { sessionKey });
  await page.goto(url);
  const title = page.locator(".trace-question-title");
  await expect(title).toContainText("Q1");
  addQuestion(2);
  await expect(title).toContainText("Q2");
  await page.locator(".trace-select").last().click();
  await expect(page.locator(".details")).toContainText("0 ms");
  await expect(page.locator(".details")).toContainText("Pi tool execution");
  await page
    .getByRole("button", { name: "Close details", exact: true })
    .click();
  await title.click();
  await expect(page.locator(".details")).toContainText("Cancelled");
  await page
    .getByRole("button", { name: "Close details", exact: true })
    .click();
  await page
    .getByLabel("Select question", { exact: true })
    .selectOption("follow-q1");
  addQuestion(3);
  await expect(
    page.getByLabel("Select question", { exact: true }),
  ).toContainText("Q3");
  await expect(title).toContainText("Q1");
  await page
    .getByLabel("Select question", { exact: true })
    .selectOption("__latest");
  await expect(title).toContainText("Q3");
  await page.getByLabel("Select question", { exact: true }).selectOption("");
  await expect(title).toHaveCount(3);
});

test("time bars animate live and replay, freeze when paused, and respect reduced motion", async ({
  page,
}) => {
  const active = twoTurnFixture("fixture/motion", "motion-producer");
  const append = (events: EventDraft[]) =>
    service.recorder.appendBatch({
      protocolVersion: 1,
      storeId: service.handle.storeId,
      ...active,
      events,
    });
  append(active.events.slice(0, 7));
  const { url } = await openViewer(service.handle, {
    sessionKey: active.sessionKey,
  });
  await page.goto(url);
  const workspace = page.locator(".workspace");
  const bar = page.locator(
    '.trace-row[data-span-id="fixture-llm1"] .trace-bar',
  );
  await expect(workspace).toHaveAttribute("data-motion", "live");
  await expect(bar).toBeVisible();
  const motion = async () =>
    bar.evaluate((el) => ({
      transform: getComputedStyle(el, "::before").transform,
      state: getComputedStyle(el, "::before").animationPlayState,
      animation: getComputedStyle(el, "::before").animationName,
      transition: getComputedStyle(el).transitionProperty,
    }));
  const first = await motion();
  expect(first.transition).not.toMatch(/width|left|all/);
  await expect
    .poll(async () => (await motion()).transform)
    .not.toBe(first.transform);
  await page
    .getByRole("button", { name: "Previous stage", exact: true })
    .click();
  await expect(workspace).toHaveAttribute("data-motion", "paused");
  await expect.poll(async () => (await motion()).state).toBe("paused");
  // Allow the pause to be committed to the compositor before comparing frames.
  await bar.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const paused = await motion();
  const frozen = await bar.evaluate(async (el) => {
    const before = getComputedStyle(el, "::before").transform;
    await new Promise((resolve) => setTimeout(resolve, 180));
    return before === getComputedStyle(el, "::before").transform;
  });
  expect(frozen).toBe(true);
  expect(paused.transition).toBe("none");
  await page.getByLabel("Replay speed", { exact: true }).selectOption(".5");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(workspace).toHaveAttribute("data-motion", "replay");
  await expect
    .poll(async () => (await motion()).transform)
    .not.toBe(paused.transform);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByRole("button", { name: "Timeline", exact: true }).click();
  const stream = page.locator(
    '.timeline-call[data-span-id="fixture-llm1"] .timeline-running-stream',
  );
  await expect(stream).toBeVisible();
  await expect(stream).toHaveCSS("animation-play-state", "paused");
  await page.getByRole("button", { name: "Back to live", exact: true }).click();
  await expect(stream).toHaveCSS("animation-play-state", "running");
  const offset = await stream.evaluate(
    (el) => getComputedStyle(el).strokeDashoffset,
  );
  await expect
    .poll(() => stream.evaluate((el) => getComputedStyle(el).strokeDashoffset))
    .not.toBe(offset);
  await expect(
    page.locator(
      '.timeline-call[data-span-id="fixture-llm1"] .timeline-duration-bar',
    ),
  ).toHaveCSS("transition-property", "fill-opacity");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(stream).toHaveCSS("animation-name", "none");
  await expect(stream).toHaveCSS("transition-property", "none");
  await page.getByRole("button", { name: "Trace", exact: true }).click();
  expect((await motion()).animation).toBe("none");
  expect((await motion()).transition).toBe("none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  append(active.events.slice(7));
  await expect(page.locator(".trace-running")).toHaveCount(0);
  await page.getByRole("button", { name: "Timeline", exact: true }).click();
  await expect(page.locator(".timeline-running-stream")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

for (const panel of ["Trace", "Timeline"] as const) {
  test(`${panel} bar geometry stays aligned with the current time scale on new events`, async ({
    page,
  }) => {
    const recorded = twoTurnFixture(`fixture/scale-${panel}`, `scale-${panel}`);
    const append = (events: EventDraft[]) =>
      service.recorder.appendBatch({
        protocolVersion: 1,
        storeId: service.handle.storeId,
        ...recorded,
        events,
      });
    append(recorded.events.slice(0, 8));
    const { url } = await openViewer(service.handle, {
      sessionKey: recorded.sessionKey,
    });
    await page.goto(url);
    await page.getByRole("button", { name: panel, exact: true }).click();
    const selector =
      panel === "Trace"
        ? '.trace-row[data-span-id="fixture-llm1"] .trace-bar'
        : '.timeline-call[data-span-id="fixture-llm1"] .timeline-duration-bar';
    await expect(page.locator(selector)).toBeVisible();
    await page.evaluate(
      ({ panel, selector }) => {
        const el = document.querySelector(selector)!;
        const domain = el.closest(panel === "Trace" ? ".trace-domain" : "svg")!;
        const initial = domain.getAttribute("data-range-ms");
        const samples: number[] = [];
        (window as any).__scaleSamples = samples;
        const started = performance.now();
        const sample = () => {
          if (domain.getAttribute("data-range-ms") !== initial) {
            const range = Number(domain.getAttribute("data-range-ms"));
            const plotWidth =
              panel === "Trace"
                ? el.parentElement!.getBoundingClientRect().width
                : Number(domain.getAttribute("width")) - 260 - 88;
            const expected = (970 / range) * plotWidth;
            samples.push(Math.abs(el.getBoundingClientRect().width - expected));
          }
          if (performance.now() - started < 1200) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      },
      { panel, selector },
    );
    append(recorded.events.slice(8));
    await expect
      .poll(() => page.evaluate(() => (window as any).__scaleSamples.length))
      .toBeGreaterThan(20);
    const maxError = await page.evaluate(() =>
      Math.max(...(window as any).__scaleSamples),
    );
    expect(
      maxError,
      "bar must match its time axis on every rendered frame (pixels)",
    ).toBeLessThan(1.5);
  });
}

test("replay follows recorded milliseconds across pause and speed changes", async ({
  page,
}) => {
  const { url } = await openViewer(service.handle, {
    sessionKey: fixture.sessionKey,
  });
  await page.goto(url);
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.getByRole("slider", { name: "Replay position" }).focus();
  await page.keyboard.press("Home");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.clock.runFor(500);
  const elapsed = page.locator(
    '.trace-row[data-span-id="fixture-llm1"] .trace-duration',
  );
  const expectElapsed = async (expected: number, frameTolerance: number) => {
    const text = (await page
      .locator('.trace-row[data-span-id="fixture-llm1"] .trace-plot')
      .getAttribute("aria-label"))!
      .split(" · ")
      .at(-1);
    const shown = Number(text!.replace(/[^0-9.]/g, ""));
    expect(shown).toBeGreaterThanOrEqual(expected - frameTolerance);
    expect(shown).toBeLessThanOrEqual(expected);
  };
  await expectElapsed(480, 17);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.clock.runFor(2000);
  expect(await elapsed.allTextContents()).toEqual(["~ 480 ms"]);
  await page.getByLabel("Replay speed", { exact: true }).selectOption("2");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.clock.runFor(200);
  await expectElapsed(880, 34);
  // Changing speed during playback must preserve the already elapsed 900ms.
  await page.getByLabel("Replay speed", { exact: true }).selectOption(".5");
  await page.clock.runFor(100);
  await expectElapsed(930, 9);
  await page.clock.runFor(100);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  expect(await elapsed.allTextContents()).toEqual(["970 ms"]);
  await expect(
    page.locator('.trace-row[data-span-id="fixture-llm2"]'),
  ).toHaveCount(0);
  const slider = page.getByRole("slider", { name: "Replay position" });
  await slider.evaluate((el) => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(el, "1500");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const toolElapsed = page.locator(
    '.trace-row[data-span-id="fixture-tool-a"] .trace-duration',
  );
  expect(await toolElapsed.allTextContents()).toEqual(["~ 460 ms"]);
  await page.clock.runFor(500);
  expect(await toolElapsed.allTextContents()).toEqual(["~ 460 ms"]);
  await page.getByLabel("Replay speed", { exact: true }).selectOption("2");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.clock.runFor(500);
  expect(Number(await slider.inputValue())).toBeGreaterThanOrEqual(2466);
  expect(Number(await slider.inputValue())).toBeLessThanOrEqual(2500);
  await page.clock.runFor(2000);
  await expect(
    page.getByRole("button", { name: "Play", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".trace-running")).toHaveCount(0);
  const finalPosition = await slider.inputValue();
  await page.clock.runFor(1000);
  expect(await slider.inputValue()).toBe(finalPosition);
  expect(Number(finalPosition)).toBe(Number(await slider.getAttribute("max")));
  await page.getByRole("button", { name: "Back to live", exact: true }).click();
  await expect(page.locator("footer")).toContainText("LIVE");
  await slider.focus();
  await page.keyboard.press("Home");
  await page.getByLabel("Replay speed", { exact: true }).selectOption("1");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  // Resume rendering after a simulated browser scheduling delay.
  await page.clock.fastForward(900);
  await expectElapsed(880, 17);
});

for (const panel of ["Trace", "Timeline"] as const) {
  test(`${panel} replay renders bar geometry on animation frames with icon controls`, async ({
    page,
  }, testInfo) => {
    const { url } = await openViewer(service.handle, {
      sessionKey: fixture.sessionKey,
    });
    await page.goto(url);
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: panel, exact: true }).click();
    for (const name of ["Previous stage", "Play", "Next stage"]) {
      const button = page.getByRole("button", { name, exact: true });
      await expect(button.locator("svg")).toBeVisible();
      await expect(button).toHaveAttribute("title", name);
      expect(await button.textContent()).toBe("");
    }
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    await page.getByRole("slider", { name: "Replay position" }).focus();
    await page.keyboard.press("Home");
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(
      page
        .getByRole("button", { name: "Pause", exact: true })
        .locator(".icon-pause"),
    ).toBeVisible();
    const selector =
      panel === "Trace"
        ? '.trace-row[data-span-id="fixture-llm1"] .trace-bar'
        : '.timeline-call[data-span-id="fixture-llm1"] .timeline-duration-bar';
    await page.evaluate((selector) => {
      const positions: string[] = [],
        widths: number[] = [];
      const probe = window as typeof window & {
        replayFrames: { positions: string[]; widths: number[] };
      };
      probe.replayFrames = { positions, widths };
      const sample = () => {
        positions.push(
          (document.querySelector(".replay input") as HTMLInputElement).value,
        );
        const bar = document.querySelector(selector);
        if (bar) widths.push(bar.getBoundingClientRect().width);
        if (positions.length < 30) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, selector);
    await page.clock.runFor(480);
    const counts = await page.evaluate(() => {
      const probe = (
        window as typeof window & {
          replayFrames: { positions: string[]; widths: number[] };
        }
      ).replayFrames;
      return {
        positions: new Set(probe.positions).size,
        widths: new Set(probe.widths).size,
      };
    });
    expect(
      counts.positions,
      "playhead should advance every display frame",
    ).toBeGreaterThanOrEqual(25);
    expect(
      counts.widths,
      "visible bar geometry should advance every display frame",
    ).toBeGreaterThanOrEqual(24);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page
      .locator("footer.replay")
      .screenshot({ path: testInfo.outputPath(`replay-icons-${panel}.png`) });
  });
}

for (const panel of ["Trace", "Timeline"] as const) {
  test(`${panel} excludes capture idle time and calms labels while bars keep moving`, async ({
    page,
  }) => {
    const recorded = twoTurnFixture(`fixture/quiet-${panel}`, `quiet-${panel}`);
    const last = recorded.events.at(-1)!;
    last.observedAt.monoMs! += 9 * 86400000;
    last.observedAt.wallMs += 9 * 86400000;
    service.recorder.appendBatch({
      protocolVersion: 1,
      storeId: service.handle.storeId,
      ...recorded,
    });
    const { url } = await openViewer(service.handle, {
      sessionKey: recorded.sessionKey,
    });
    await page.goto(url);
    await page.getByRole("button", { name: panel, exact: true }).click();
    const slider = page.getByRole("slider", { name: "Replay position" });
    await expect(slider).toHaveAttribute("max", "3520");
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    await slider.focus();
    await page.keyboard.press("Home");
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.clock.runFor(32);
    const selectors =
      panel === "Trace"
        ? {
            label: '.trace-row[data-span-id="fixture-llm1"] .trace-duration',
            bar: '.trace-row[data-span-id="fixture-llm1"] .trace-bar',
            axis: ".trace-ticks",
          }
        : {
            label:
              '.timeline-call[data-span-id="fixture-llm1"] .timeline-duration-label',
            bar: '.timeline-call[data-span-id="fixture-llm1"] .timeline-duration-bar',
            axis: ".timeline-chart > g > text",
          };
    await page.evaluate((selectors) => {
      const data = {
        labels: [] as string[],
        widths: [] as number[],
        axes: [] as string[],
      };
      (window as typeof window & { quietSamples: typeof data }).quietSamples =
        data;
      let count = 0;
      const sample = () => {
        data.labels.push(
          document.querySelector(selectors.label)?.textContent ?? "",
        );
        data.widths.push(
          document.querySelector(selectors.bar)!.getBoundingClientRect().width,
        );
        data.axes.push(
          [...document.querySelectorAll(selectors.axis)]
            .slice(0, 5)
            .map((el) => el.textContent)
            .join("|"),
        );
        if (++count < 28) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, selectors);
    await page.clock.runFor(448);
    const result = await page.evaluate(() => {
      const data = (
        window as typeof window & {
          quietSamples: { labels: string[]; widths: number[]; axes: string[] };
        }
      ).quietSamples;
      return {
        labels: new Set(data.labels).size,
        widths: new Set(data.widths).size,
        axes: new Set(data.axes).size,
      };
    });
    expect(result.labels).toBeLessThanOrEqual(2);
    expect(result.widths).toBeGreaterThanOrEqual(24);
    expect(result.axes).toBe(1);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(page.locator(selectors.label)).toHaveText("~ 460 ms");
  });
}

test("question selection updates replay duration instead of including gaps", async ({
  page,
}) => {
  const { url } = await openViewer(service.handle, {
    sessionKey: multi.sessionKey,
  });
  await page.goto(url);
  const slider = page.getByRole("slider", { name: "Replay position" });
  await expect(slider).toBeEnabled();
  const latest = Number(await slider.getAttribute("max"));
  expect(latest).toBe(72000);
  await page.getByLabel("Select question", { exact: true }).selectOption("");
  const total = Number(await slider.getAttribute("max"));
  expect(total).toBeGreaterThan(latest);
  expect(total).toBe(144000);
  await page
    .getByLabel("Select question", { exact: true })
    .selectOption("multi-question-1");
  await expect(slider).toHaveAttribute("max", String(latest));
});

test("Call graph calms running duration labels without slowing replay", async ({
  page,
}) => {
  const { url } = await openViewer(service.handle, {
    sessionKey: "fixture/two-turn",
  });
  await page.goto(url);
  await page.getByRole("button", { name: "Call graph", exact: true }).click();
  const slider = page.getByRole("slider", { name: "Replay position" });
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await slider.focus();
  await page.keyboard.press("Home");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.clock.runFor(32);
  const selector =
    '.react-flow__node[data-id="fixture-llm1"] .observer-node-timing > span';
  await page.evaluate((selector) => {
    const samples = { labels: [] as string[], positions: [] as string[] };
    (
      window as typeof window & { graphTimeSamples: typeof samples }
    ).graphTimeSamples = samples;
    let count = 0;
    const sample = () => {
      samples.labels.push(document.querySelector(selector)?.textContent ?? "");
      samples.positions.push(
        document.querySelector<HTMLInputElement>(
          'input[aria-label="Replay position"]',
        )!.value,
      );
      if (++count < 28) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, selector);
  await page.clock.runFor(448);
  const samples = await page.evaluate(
    () =>
      (
        window as typeof window & {
          graphTimeSamples: { labels: string[]; positions: string[] };
        }
      ).graphTimeSamples,
  );
  expect(samples.labels.every(Boolean)).toBe(true);
  expect(new Set(samples.labels).size).toBeLessThanOrEqual(2);
  expect(new Set(samples.positions).size).toBeGreaterThanOrEqual(24);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.locator(selector)).toHaveText("≈ 460 ms");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.clock.runFor(544);
  await expect(page.locator(selector)).toHaveText("970 ms");
});
