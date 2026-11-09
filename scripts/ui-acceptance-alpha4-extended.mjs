import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const playwrightRoot =
  process.env.PSMETAC_PLAYWRIGHT_ROOT ||
  "playwright";
const { chromium } = require(playwrightRoot);
const endpoint = process.env.PSMETAC_CDP || "http://127.0.0.1:9223";
const outputDirectory = path.resolve(
  process.argv[2] || ".test-artifacts/ui-alpha4-extended",
);
await fs.mkdir(outputDirectory, { recursive: true });

const browser = await chromium.connectOverCDP(endpoint);
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((candidate) => candidate.url().startsWith("file:"));
if (!page) throw new Error("没有找到 PSMetaC Electron 页面。");
await page.waitForLoadState("domcontentloaded");
await page.waitForFunction(
  () => !document.querySelector("#onboarding:not(.hidden)"),
);

const screenshots = [];
const capture = async (order, name) => {
  await page.waitForTimeout(180);
  const target = path.join(
    outputDirectory,
    `${String(order).padStart(2, "0")}-${name}.png`,
  );
  await page.screenshot({ path: target });
  screenshots.push(target);
};
const view = async (name) => {
  await page.click(`[data-view="${name}"]`);
  await page.waitForTimeout(160);
};
const theme = async (name) => {
  await page.click(`[data-theme-choice="${name}"]`);
  await page.waitForTimeout(120);
};

await page.evaluate(() => window.resizeTo(1220, 780));
await theme("light");
await view("watchers");
await capture(1, "watchers-light");
await view("reports");
await capture(2, "reports-light");
await view("quarantine");
await capture(3, "review-light");
await view("help");
await capture(4, "help-light");
await view("about");
await capture(5, "about-light");

await view("settings");
for (const [index, category] of [
  "general",
  "photoshop",
  "validation",
  "storage",
  "mcp",
  "experimental",
].entries()) {
  await page.click(`[data-settings-category="${category}"]`);
  await capture(index + 6, `settings-${category}-light`);
}

const switchChecks = await page.evaluate(() =>
  Array.from(
    document.querySelectorAll(
      '[data-settings-pane="experimental"] input[type="checkbox"]',
    ),
  ).map((input) => {
    const label = input.closest("label");
    const rect = label?.getBoundingClientRect();
    const style = label ? getComputedStyle(label) : null;
    return {
      id: input.id,
      checked: input.checked,
      disabled: input.disabled,
      labelWidth: rect?.width || 0,
      labelHeight: rect?.height || 0,
      pointerEvents: style?.pointerEvents || null,
    };
  }),
);

await theme("dark");
await capture(12, "settings-experimental-dark");
await page.click('[data-settings-category="validation"]');
await capture(13, "settings-validation-dark");
await view("new-task");
await page.click("#open-task-options");
await capture(14, "task-options-dark");

const themeContrast = await page.evaluate(() => {
  const read = (selector) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      color: style.color,
      border: style.borderColor,
    };
  };
  return {
    drawer: read("#task-options-drawer"),
    select: read("#profile"),
    validationRow: read(".validation-grid label"),
    navigation: read(".nav.active"),
  };
});

const result = {
  endpoint,
  outputDirectory,
  screenshots,
  checks: {
    switchChecks,
    switchesOperable: switchChecks.every(
      (item) =>
        !item.disabled &&
        item.labelWidth >= 40 &&
        item.labelHeight >= 24 &&
        item.pointerEvents !== "none",
    ),
    themeContrast,
  },
};
await fs.writeFile(
  path.join(outputDirectory, "acceptance.json"),
  `${JSON.stringify(result, null, 2)}\n`,
  "utf8",
);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
await page.evaluate(() => window.psbCleaner.windowControl("quit")).catch(() => {});
await browser.close();
