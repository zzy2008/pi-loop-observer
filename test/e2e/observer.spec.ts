import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startService } from "../../dist/server/main.js";
import { openViewer } from "../../dist/lifecycle/index.js";
import { twoTurnFixture } from "../fixtures/two-turn.js";
import { multiQuestionFixture } from "../fixtures/multi-question.js";
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
  await expect(
    page.getByRole("heading", { name: "Pi Loop Observer" }),
  ).toBeVisible();
  await expect(
    page.locator('.react-flow__node[data-id="fixture-llm2"]'),
  ).toBeVisible();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect(page).not.toHaveURL(/ticket/);
  await page
    .getByLabel("Select call", { exact: true })
    .selectOption("fixture-llm2");
  await expect(page.locator("aside")).toContainText("第二轮模型已处理错误");
  await page
    .getByRole("button", { name: "Previous stage", exact: true })
    .click();
  await page.getByRole("slider", { name: "Replay position" }).focus();
  await page.keyboard.press("Home");
  await expect(page.locator("aside")).not.toContainText("第二轮模型已处理错误");
  await page.getByRole("button", { name: "Back to live", exact: true }).click();
  if (testInfo.project.name !== "desktop")
    await page.getByRole("button", { name: "Timeline", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  if (testInfo.project.name !== "desktop") {
    await page
      .getByLabel("Select call", { exact: true })
      .selectOption("fixture-tool-a");
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

test("many questions stay vertical, use local timing, search and persist language", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { url } = await openViewer(service.handle, {
    sessionKey: multi.sessionKey,
  });
  await page.goto(url);
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
        return { x: matrix.e, y: matrix.f };
      }),
    );
  expect(Math.max(...positions.map((p) => p.x))).toBeLessThanOrEqual(72);
  const rows = positions.map((p) => p.y).sort((a, b) => a - b);
  for (let i = 1; i < rows.length; i++)
    expect(rows[i]! - rows[i - 1]!).toBeGreaterThanOrEqual(149);
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
  if (testInfo.project.name !== "desktop")
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
  await page
    .getByLabel("Navigate to turn", { exact: true })
    .selectOption("multi-q1-turn1");
  await expect(
    firstAxis.locator('[data-turn-id="multi-q1-turn1"]'),
  ).toContainText("Collapsed");
  await expect(firstAxis).toHaveAttribute("data-range-min", "1");
  await expect(firstAxis).toHaveAttribute("data-range-ms", "72000");
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
  if (testInfo.project.name !== "desktop")
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
