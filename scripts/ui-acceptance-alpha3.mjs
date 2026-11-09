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
  process.argv[2] || "../ui_acceptance/alpha3/screenshots",
);
await fs.mkdir(outputDirectory, { recursive: true });

const browser = await chromium.connectOverCDP(endpoint);
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((candidate) => candidate.url().startsWith("file:"));
if (!page) throw new Error("没有找到 PSMetaC Electron 页面。");
await page.waitForLoadState("domcontentloaded");
await page.waitForFunction(() => !document.querySelector("#onboarding:not(.hidden)"));

const resize = async (width, height) => {
  await page.evaluate(
    ([nextWidth, nextHeight]) => window.resizeTo(nextWidth, nextHeight),
    [width, height],
  );
  await page.waitForTimeout(250);
};
const capture = async (name) => {
  const target = path.join(outputDirectory, `${name}.png`);
  await page.screenshot({ path: target });
  return target;
};

const results = {
  endpoint,
  outputDirectory,
  checks: {},
  screenshots: [],
};

await resize(1220, 780);
results.screenshots.push(await capture("01-dashboard-light-1220x780"));

await page.click('[data-view="jobs"]');
await page.click("#toggle-job-filters");
const filterPanelState = await page.evaluate(() => ({
  expanded:
    document.querySelector("#toggle-job-filters")?.getAttribute("aria-expanded") ===
    "true",
  visible:
    !document.querySelector("#job-filter-panel")?.classList.contains("hidden"),
  summary: document.querySelector("#job-filter-summary")?.textContent?.trim(),
}));
results.checks.jobFilterPanel = filterPanelState;
results.screenshots.push(await capture("01b-jobs-filter-light-1220x780"));

await page.click('[data-view="settings"]');
await page.click('[data-settings-category="experimental"]');
const toggle = page.locator("#experimental-psd");
const toggleBefore = await toggle.isChecked();
await toggle.click();
const toggleAfter = await toggle.isChecked();
results.checks.experimentalToggle = {
  before: toggleBefore,
  after: toggleAfter,
  changed: toggleBefore !== toggleAfter,
};
await toggle.click();
await page.click('[data-theme-choice="dark"]');
results.screenshots.push(await capture("02-settings-experimental-dark-1220x780"));
results.checks.darkControlStyles = await page.evaluate(() => {
  const read = (selector) => {
    const element = document.querySelector(selector);
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      color: style.color,
      border: style.borderColor,
      opacity: style.opacity,
      disabled: element.disabled || false,
    };
  };
  return {
    importButton: read("#import-settings"),
    saveButton: read('[form="settings-form"]'),
    activeCategory: read(".settings-category.active"),
    firstToggle: read("#experimental-psd"),
  };
});
await page.click('[data-settings-category="files"]');
results.screenshots.push(await capture("02b-settings-files-dark-1220x780"));
results.checks.darkInputStyles = await page.evaluate(() => {
  const element = document.querySelector("#allowed-input-roots");
  const style = getComputedStyle(element);
  return {
    background: style.backgroundColor,
    color: style.color,
    border: style.borderColor,
    placeholder: getComputedStyle(element, "::placeholder").color,
  };
});
await page.click('[data-settings-category="experimental"]');

await resize(1600, 900);
results.screenshots.push(await capture("03-settings-experimental-dark-1600x900"));
const settingsGeometry = await page.evaluate(() => {
  const view = document.querySelector("#view-settings").getBoundingClientRect();
  const nav = document.querySelector(".settings-category-nav").getBoundingClientRect();
  const active = document
    .querySelector(".settings-category.active")
    .getBoundingClientRect();
  return {
    viewport: { width: innerWidth, height: innerHeight },
    view: { left: view.left, right: view.right, width: view.width },
    navigation: { left: nav.left, right: nav.right, width: nav.width },
    active: { left: active.left, right: active.right, width: active.width },
    activeInsideNavigation:
      active.left >= nav.left && active.right <= nav.right,
  };
});
results.checks.settingsWideGeometry = settingsGeometry;

await resize(980, 640);
await page.click('[data-theme-choice="light"]');
results.screenshots.push(await capture("04-settings-experimental-light-980x640"));

await page.click('[data-view="diagnostics"]');
await page.waitForTimeout(500);
const diagnosticState = await page.evaluate(() => ({
  result: document.querySelector("#diagnostics-result")?.textContent?.trim(),
  button: document.querySelector("#run-diagnostics")?.textContent?.trim(),
  technical: document.querySelector("#diagnostics-technical")?.textContent?.trim(),
}));
results.checks.diagnosticsOnEntry = {
  ...diagnosticState,
  passive:
    diagnosticState.result?.includes("尚未开始检测") &&
    diagnosticState.button === "开始检测" &&
    diagnosticState.technical === "尚未检查",
};
results.screenshots.push(await capture("05-diagnostics-passive-light-980x640"));

await resize(1220, 780);
await page.click('[data-window-action="toggle-maximize"]');
await page.waitForTimeout(250);
results.checks.customWindowMaximize =
  (await page.locator("#window-maximize").getAttribute("aria-label")) ===
  "还原";
await page.click('[data-window-action="toggle-maximize"]');

await fs.writeFile(
  path.join(outputDirectory, "acceptance.json"),
  `${JSON.stringify(results, null, 2)}\n`,
  "utf8",
);
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
await page
  .evaluate(() => window.psbCleaner.windowControl("quit"))
  .catch(() => {});
await browser.close();
