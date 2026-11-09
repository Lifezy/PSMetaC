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
  process.argv[2] || ".test-artifacts/ui-alpha4",
);
await fs.mkdir(outputDirectory, { recursive: true });

const browser = await chromium.connectOverCDP(endpoint);
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((candidate) => candidate.url().startsWith("file:"));
if (!page) throw new Error("没有找到 PSMetaC Electron 页面。");
const cdp = await page.context().newCDPSession(page);
await page.waitForLoadState("domcontentloaded");
await page.waitForFunction(() => !document.querySelector("#onboarding:not(.hidden)"));

const screenshots = [];
const resize = async (width, height) => {
  await page.evaluate(
    ([nextWidth, nextHeight]) => window.resizeTo(nextWidth, nextHeight),
    [width, height],
  );
  await page.waitForTimeout(240);
};
const capture = async (name) => {
  const target = path.join(outputDirectory, `${name}.png`);
  const screenshot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  await fs.writeFile(target, Buffer.from(screenshot.data, "base64"));
  screenshots.push(target);
};

await resize(1220, 780);
await page.click('[data-theme-choice="light"]');
await page.click('[data-view="dashboard"]');
await capture("01-dashboard-light-1220x780");
await page.locator(".dashboard-stats").scrollIntoViewIfNeeded();
await capture("01b-dashboard-history-light-1220x780");

await page.click('[data-view="new-task"]');
await capture("02-create-task-light-1220x780");
await page.click("#open-task-options");
await capture("03-task-options-light-1220x780");
await page.locator("#content-cleanup-options").scrollIntoViewIfNeeded();
await capture("03b-task-content-cleanup-light-1220x780");
await page.check("#delete-hidden-layers");
await capture("03c-task-content-cleanup-warning-light-1220x780");
const contentCleanup = await page.evaluate(() => ({
  warningVisible: !document.querySelector("#content-cleanup-warning").classList.contains("hidden"),
  executionMode: document.querySelector("#execution-mode").value,
  topologyRequired: document.querySelector('[data-validation="task"][value="structure_topology"]').checked,
  topologyDisabled: document.querySelector('[data-validation="task"][value="structure_topology"]').disabled,
}));
await page.uncheck("#delete-hidden-layers");
const taskDrawer = await page.evaluate(() => {
  const drawer = document.querySelector("#task-options-drawer");
  const backdrop = document.querySelector("#task-options-backdrop");
  const rect = drawer.getBoundingClientRect();
  return {
    visible: !drawer.classList.contains("hidden"),
    backdropVisible: !backdrop.classList.contains("hidden"),
    rightAligned: Math.abs(innerWidth - rect.right - 12) <= 1,
    withinViewport: rect.top >= 0 && rect.bottom <= innerHeight,
  };
});
await page.click("#apply-task-options");

await page.click('[data-view="jobs"]');
await page.click('[data-job-pool="completed"]');
await capture("04-jobs-completed-light-1220x780");
await page.click("#toggle-job-filters");
await capture("05-jobs-filter-light-1220x780");

await page.click('[data-view="settings"]');
await page.click('[data-settings-category="files"]');
await page.click('[data-theme-choice="dark"]');
await capture("06-settings-files-dark-1220x780");
const darkControls = await page.evaluate(() => {
  const read = (selector) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      color: style.color,
      border: style.borderColor,
      opacity: style.opacity,
      disabled: element.disabled === true,
    };
  };
  return {
    textarea: read("#allowed-input-roots"),
    saveButton: read('[form="settings-form"]'),
    activeNavigation: read(".settings-category.active"),
    importButton: read("#import-settings"),
    appendDirectoryButton: read('[data-append-root="allowed-input-roots"]'),
    pauseQueueButton: read("#pause-new-jobs"),
  };
});

await resize(1600, 900);
await capture("07-settings-files-dark-1600x900");
const wideGeometry = await page.evaluate(() => {
  const view = document.querySelector("#view-settings").getBoundingClientRect();
  const workspace = document.querySelector(".workspace").getBoundingClientRect();
  return {
    viewportWidth: innerWidth,
    workspaceWidth: workspace.width,
    contentWidth: view.width,
    contentCentered:
      Math.abs(view.left - workspace.left - (workspace.width - view.width) / 2) < 24,
  };
});

await resize(980, 640);
await page.click('[data-theme-choice="light"]');
await page.click('[data-view="diagnostics"]');
await page.waitForTimeout(300);
await capture("08-diagnostics-passive-light-980x640");
const diagnostics = await page.evaluate(() => ({
  result: document.querySelector("#diagnostics-result")?.textContent?.trim(),
  button: document.querySelector("#run-diagnostics")?.textContent?.trim(),
  technical: document.querySelector("#diagnostics-technical")?.textContent?.trim(),
}));

const result = {
  endpoint,
  outputDirectory,
  checks: {
    taskDrawer,
    contentCleanup,
    darkControls,
    wideGeometry,
    diagnostics,
    diagnosticsPassive:
      diagnostics.button === "开始检测" && diagnostics.technical === "尚未检查",
  },
  screenshots,
};
const failures = [];
if (!Object.values(taskDrawer).every(Boolean)) {
  failures.push("任务选项抽屉没有完整显示在窗口内");
}
if (
  !contentCleanup.warningVisible ||
  contentCleanup.executionMode !== "safe_copy" ||
  contentCleanup.topologyRequired ||
  !contentCleanup.topologyDisabled
) {
  failures.push("内容整理安全联锁没有按预期生效");
}
if (
  darkControls.textarea.background === "rgb(255, 255, 255)" ||
  darkControls.textarea.color === darkControls.textarea.background ||
  darkControls.textarea.border === darkControls.textarea.background
) {
  failures.push("暗色输入框的文字、底色或边界仍不可辨认");
}
if (
  wideGeometry.contentWidth > 1441 ||
  wideGeometry.contentWidth < 1100 ||
  !wideGeometry.contentCentered
) {
  failures.push("宽窗口内容没有保持可读宽度并居中");
}
if (!result.checks.diagnosticsPassive) {
  failures.push("进入运行检测页面时发生了自动检测");
}
result.failures = failures;
result.passed = failures.length === 0;
await fs.writeFile(
  path.join(outputDirectory, "acceptance.json"),
  `${JSON.stringify(result, null, 2)}\n`,
  "utf8",
);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
await page.evaluate(() => window.psbCleaner.windowControl("quit")).catch(() => {});
await browser.close();
if (failures.length > 0) {
  throw new Error(`界面验收失败：${failures.join("；")}`);
}
