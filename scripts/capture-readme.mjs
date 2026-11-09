// Render the real desktop UI with explicitly synthetic, in-memory demo data.
// No service, user profile, design file, database or Photoshop is opened.
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDefaultConfig } from "../src/config.ts";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PSMETAC_PLAYWRIGHT_ROOT || "playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "docs", "images");
await fs.mkdir(output, { recursive: true });
const gib = 1024 ** 3;
const settings = createDefaultConfig("D:\\PSMetaC-Demo\\data", {
  machineId: "readme-demo",
  allowedInputRoots: ["D:\\PSMetaC-Demo\\input"],
  allowedOutputRoots: ["D:\\PSMetaC-Demo\\output"],
  photoshopExecutable: "C:\\Program Files\\Adobe\\Adobe Photoshop 2025\\Photoshop.exe",
});
delete settings.pipeToken;
const stamp = new Date().toISOString();
const started = new Date(Date.now() - 90000).toISOString();
const job = (id, name, status, more = {}) => ({
  id, sourcePath: `D:\\PSMetaC-Demo\\input\\${name}`, sourceBytes: 2.4 * gib,
  status, reasonCode: "STRICT_VALIDATION_PASSED", profile: "standard",
  runMode: "auto_if_eligible", executionMode: "safe_copy", backupSource: true,
  coveragePolicy: "strict", coverageThresholdPercent: 5,
  requiredValidationChecks: [], outputMode: "specified_directory",
  progress: 1, progressStage: "complete", userTags: [],
  createdAt: started, updatedAt: stamp, finishedAt: stamp,
  executionStartedAt: started, photoshopVersion: "26.11", submissionSource: "ui",
  reportHtmlPath: `D:\\PSMetaC-Demo\\reports\\${id}\\report.html`,
  ...more,
});
const jobs = [
  job("demo-processing", "宣传册-嵌套智能对象.psb", "running", {
    reasonCode: "PHOTOSHOP_EXECUTING", progress: 0.63, progressStage: "photoshop_objects",
    progressCurrent: 18, progressTotal: 30, finishedAt: null,
    progressDetail: "正在清理嵌入智能对象，已完成 18 / 30 个目标", reportHtmlPath: null,
  }),
  job("demo-inspect", "包装设计-待确认.psb", "awaiting_approval", {
    reasonCode: "WAITING_FOR_USER_APPROVAL", runMode: "await_approval",
    executionStartedAt: null, finishedAt: null, progress: 0.3,
    preflightStartedAt: started, preflightFinishedAt: stamp,
  }),
  job("demo-success", "产品海报-安全副本.psb", "succeeded", {
    outputPath: "D:\\PSMetaC-Demo\\output\\产品海报.cleaned.psb",
    progressDetail: "全部自动检查通过，源文件保持不变",
  }),
  job("demo-review", "展架设计-画面待复核.psb", "quarantined", {
    reasonCode: "PIXEL_NOT_EXACT", quarantinePath: "D:\\PSMetaC-Demo\\output\\.psmetac-review\\result.psb",
  }),
];
const fixtures = {
  settings,
  list_jobs: jobs,
  list_user_tags: [],
  capabilities: { version: "0.2.0-alpha.6", verifiedPhotoshopVersions: ["26.11"] },
  queue_status: { paused: false, runnable: 2, criticalReason: null },
  preflight_summaries: {
    "demo-inspect": { eligible: true, explanation: "发现可清理的编辑溯源记录，达到标准清理条件。",
      documentAncestors: 16480, containersInspected: 32, parserWarnings: [],
      estimate: { affectedXmpBytes: 0.8 * gib, affectedContainers: 13, plannedObjects: 12,
        estimatedPhotoshopRangeMs: { low: 45000, high: 120000 } } },
  },
  history_statistics: {
    tasks: { uniqueSources: 24, total: 28, byFormat: { psb: 20, psd: 8 } },
    storage: { actualFreedBytes: 3.2 * gib, outputReductionBytes: 8.6 * gib,
      currentAddedBytes: 5.4 * gib, currentSafeCopyBytes: 4.2 * gib,
      currentBackupBytes: 1.2 * gib, currentQuarantineBytes: 0.6 * gib },
    reliability: { executedOutcomes: 26, partialExecutions: 1, failedExecutions: 0,
      failureRatePercent: 0, blocked: 1, cancelled: 1 },
    contentCleanup: { tasks: 3, hiddenLayersDeleted: 18, emptyLayersDeleted: 7 },
  },
  list_watchers: [{ id: "demo-folder", path: "D:\\PSMetaC-Demo\\自动处理", enabled: true,
    executionMode: "safe_copy", backupSource: true, profile: "standard", runMode: "auto_if_eligible",
    recursive: true, supportedFiles: 12, waitingStableFiles: 2, submittedJobs: 8,
    skippedFiles: 2, lastScanAt: stamp }],
  preview_quarantine_cleanup: { totalDirectories: 1, totalBytes: 0.6 * gib,
    candidates: [], lockedDirectories: 0 },
};
const browser = await chromium.launch({ headless: true,
  ...(process.env.PSMETAC_BROWSER_EXECUTABLE
    ? { executablePath: process.env.PSMETAC_BROWSER_EXECUTABLE }
    : process.platform === "win32" ? { channel: "msedge" } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript((data) => {
    localStorage.setItem("psmetac.theme", "dark");
    window.psbCleaner = {
      bootstrapStatus: async () => ({ initialized: true }),
      invoke: async method => {
        if (!(method in data)) throw new Error(`Unsupported demo method: ${method}`);
        return structuredClone(data[method]);
      },
      chooseFiles: async () => ["D:\\PSMetaC-Demo\\input\\产品海报.psb", "D:\\PSMetaC-Demo\\input\\包装设计.psb"],
      onJobChanged: () => {}, onNavigate: () => {}, onWindowState: () => {},
      windowControl: async () => {},
    };
  }, fixtures);
  await page.goto(pathToFileURL(path.join(root, "src/desktop/renderer/index.html")).href);
  await page.waitForFunction(() => document.querySelector("#history-unique-sources").textContent === "24");
  await page.evaluate(() => {
    const marker = document.createElement("span");
    marker.textContent = "演示数据 · 功能界面展示";
    marker.style.cssText = "position:fixed;top:19px;left:420px;z-index:2000;font:12px 'Microsoft YaHei UI',sans-serif;color:#aab4d1;pointer-events:none";
    document.body.append(marker);
  });
  const capture = async (name, selector) => {
    await page.waitForTimeout(350);
    if (errors.length) throw new Error(errors.join("\n"));
    const surface = selector ? page.locator(selector) : page;
    await surface.screenshot({ path: path.join(output, name), animations: "disabled" });
  };
  await page.click('[data-view="new-task"]');
  await page.click("#pick-files");
  await page.selectOption("#task-preset", "inspect-first");
  await capture("create-task.png");
  await page.click("#open-task-options");
  await page.locator("#content-cleanup-options").scrollIntoViewIfNeeded();
  await capture("cleanup-options.png");
  await page.click("#apply-task-options");
  await page.click('[data-view="jobs"]');
  await capture("batch-queue.png");
  await page.click('[data-view="watchers"]');
  await capture("automatic-folders.png");
  await page.click('[data-view="dashboard"]');
  await page.evaluate(() => {
    document.querySelector(".dashboard-stats-head p").textContent += "（演示数据，非实测成绩）";
  });
  await page.locator(".dashboard-stats").scrollIntoViewIfNeeded();
  await capture("history-statistics.png", ".dashboard-stats");
  console.log(JSON.stringify({ output, screenshots: 5, synthetic: true, pageErrors: errors }));
} finally {
  await browser.close();
}
