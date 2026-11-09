import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  createDefaultConfig,
  defaultBootstrapDirectory,
  loadBootstrap,
  loadConfig,
  saveBootstrap,
  saveConfig,
  validateConfig,
} from "../config.ts";
import { CleanerService } from "../service.ts";
import {
  LocalPipeServer,
  localPipeIsListening,
} from "../pipe-server.ts";
import { availableBytes } from "../files.ts";
import { diagnosePhotoshop, systemInformation } from "../environment.ts";
import { resolvePhotoshopBridge } from "../photoshop.ts";
import { assertNotDenied, isPathInside } from "../paths.ts";
import { APP_VERSION } from "../version.ts";
import { scanDroppedDesignFiles } from "../dropped-files.ts";
import { createChineseApplicationMenuTemplate } from "./menu-template.ts";
import {
  addCompletedJob,
  completionNotificationBody,
  emptyCompletionCounts,
} from "../notifications.ts";
import type { JobRecord } from "../types.ts";

const electron = await import("electron");
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  dialog,
  shell,
  nativeImage,
  Notification,
} = electron;

const directory = path.dirname(fileURLToPath(import.meta.url));
if (process.env.PSMETAC_UI_TEST_PROFILE) {
  app.setPath(
    "userData",
    path.resolve(process.env.PSMETAC_UI_TEST_PROFILE),
  );
}
const hasSingleInstanceLock = app.requestSingleInstanceLock();
let window: InstanceType<typeof BrowserWindow> | null = null;
let tray: InstanceType<typeof Tray> | null = null;
let service: CleanerService | null = null;
let pipe: LocalPipeServer | null = null;
let quitting = false;
let cleanupStarted = false;
let cleanupFinished = false;
let completionCounts = emptyCompletionCounts();
let successNotificationTimer: NodeJS.Timeout | null = null;
const notifiedTerminalJobs = new Set<string>();
const explicitlySelectedFiles = new Set<string>();
const explicitlySelectedDirectories = new Set<string>();
const explicitlySelectedExports = new Set<string>();

function approvalKey(value: string): string {
  const resolved = path.resolve(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

type RecentDirectoryKind =
  | "source"
  | "output"
  | "watcher"
  | "settingsImport"
  | "settingsExport";

async function existingDirectory(candidate: string): Promise<string> {
  let current = path.resolve(candidate);
  while (true) {
    try {
      if ((await fs.stat(current)).isDirectory()) return current;
    } catch {
      // Walk up to a directory that still exists.
    }
    const parent = path.dirname(current);
    if (parent === current) return app.getPath("desktop");
    current = parent;
  }
}

async function rememberDirectory(
  kind: RecentDirectoryKind,
  directoryPath: string,
): Promise<void> {
  if (!service) return;
  await service.updateSettings({
    recentDirectories: {
      ...service.config.recentDirectories,
      [kind]: path.resolve(directoryPath),
    },
  });
}

function queueSuccessNotification(job: JobRecord): void {
  addCompletedJob(completionCounts, job);
  if (successNotificationTimer) return;
  successNotificationTimer = setTimeout(() => {
    const body = completionNotificationBody(completionCounts);
    completionCounts = emptyCompletionCounts();
    successNotificationTimer = null;
    new Notification({
      title: "PSMetaC",
      body,
    }).show();
  }, 5_000);
}

type TrayState = "idle" | "running" | "paused" | "attention";

function trayImage(state: TrayState = "idle") {
  const stateImage = nativeImage.createFromPath(
    path.join(
      directory,
      "renderer",
      "assets",
      `psmetac-tray-${state}.png`,
    ),
  );
  if (!stateImage.isEmpty()) return stateImage;
  return nativeImage
    .createFromPath(
      path.join(directory, "renderer", "assets", "psmetac-icon-256.png"),
    )
    .resize({ width: 32, height: 32 });
}

function currentTrayState(): {
  state: TrayState;
  tooltip: string;
} {
  if (!service) {
    return { state: "idle", tooltip: "PSMetaC · 尚未完成首次设置" };
  }
  const queue = service.queueStatus() as {
    paused?: boolean;
    runnable?: number;
  };
  const recent = service.listJobs({ limit: 100 });
  const recentFailureCutoff = Date.now() - 60 * 60 * 1000;
  const attention = recent.filter(
    (job) =>
      (job.status === "quarantined" &&
        job.reviewStatus !== "kept_quarantined") ||
      job.status === "critical_paused" ||
      (["failed", "interrupted"].includes(job.status) &&
        Date.parse(job.updatedAt) >= recentFailureCutoff),
  ).length;
  if (attention) {
    return {
      state: "attention",
      tooltip: `PSMetaC · ${attention} 项需要查看`,
    };
  }
  const running = recent.find((job) =>
    [
      "preflighting",
      "waiting_photoshop",
      "copying",
      "running",
      "validating",
    ].includes(job.status),
  );
  if (running) {
    return {
      state: "running",
      tooltip: `PSMetaC · 正在处理 ${path.basename(running.sourcePath)}`,
    };
  }
  if (queue.paused) {
    return { state: "paused", tooltip: "PSMetaC · 队列已暂停" };
  }
  return {
    state: "idle",
    tooltip: `PSMetaC · ${queue.runnable || 0} 项等待处理`,
  };
}

async function startService(dataRoot: string): Promise<void> {
  if (service) return;
  const config = await loadConfig(dataRoot);
  if (await localPipeIsListening(config)) {
    throw new Error(
      "检测到另一个版本的 PSMetaC 仍在后台运行。请在旧程序中选择“文件 → 退出”，然后重新打开新版。",
    );
  }
  const nextService = await CleanerService.open(config);
  const nextPipe = new LocalPipeServer(config, nextService);
  try {
    await nextPipe.start();
  } catch (error) {
    await nextService.close().catch(() => {});
    throw error;
  }
  service = nextService;
  pipe = nextPipe;
  service.on("job-changed", (job) => {
    window?.webContents.send("job-changed", job);
    rebuildTray();
    if (
      ["succeeded", "partial"].includes(job.status) &&
      !notifiedTerminalJobs.has(job.id)
    ) {
      notifiedTerminalJobs.add(job.id);
      queueSuccessNotification(job);
    }
    if (
      ["quarantined", "failed", "critical_paused"].includes(job.status) &&
      !notifiedTerminalJobs.has(job.id)
    ) {
      notifiedTerminalJobs.add(job.id);
      new Notification({
        title: "PSMetaC",
        body:
          job.status === "quarantined"
            ? "处理副本没有通过你选择的验收标准，已进入“人工复核”。"
            : `任务需要处理：${job.status}`,
      }).show();
    }
  });
  service.on("service-error", (error) => {
    new Notification({
      title: "PSMetaC 后台出现问题",
      body: error.message,
    }).show();
  });
  service.on("queue-changed", () => {
    rebuildTray();
    rebuildApplicationMenu();
  });
  service.start();
  rebuildTray();
  rebuildApplicationMenu();
}

function rebuildTray(): void {
  if (!tray) return;
  const queue = service?.queueStatus() || { paused: true };
  const visual = currentTrayState();
  tray.setImage(trayImage(visual.state));
  tray.setToolTip(visual.tooltip);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开 PSMetaC", click: () => showWindow() },
      {
        label: queue.paused ? "继续处理任务" : "暂停处理新任务",
        enabled: Boolean(service) && !queue.criticalReason,
        click: () => {
          if (!service) return;
          queue.paused ? service.resumeQueue() : service.pauseQueue();
          rebuildTray();
        },
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function showWindow(): void {
  window?.show();
  window?.focus();
}

function navigateTo(view: string): void {
  showWindow();
  window?.webContents.send("navigate", view);
}

function rebuildApplicationMenu(): void {
  const queue = service?.queueStatus() as
    | { paused?: boolean; criticalReason?: string | null }
    | undefined;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      createChineseApplicationMenuTemplate(
        {
          paused: queue?.paused,
          criticalReason: queue?.criticalReason,
          available: Boolean(service),
        },
        {
          navigate: navigateTo,
          hide: () => window?.hide(),
          quit: () => {
            quitting = true;
            app.quit();
          },
          toggleQueue: () => {
            if (!service) return;
            queue?.paused ? service.resumeQueue() : service.pauseQueue();
          },
          showAbout: () => {
            void dialog.showMessageBox(window!, {
              type: "info",
          title: "关于 PaceSpace Metadata Cleaner",
          message: "PaceSpace Metadata Cleaner（PSMetaC）",
          detail:
            `版本 ${APP_VERSION}\nPSD / PSB 元数据检查与清理工具\n\n专业清理 Photoshop 文件中冗余的 XMP 与 DocumentAncestors 信息。默认生成并严格验证安全新副本；也可明确选择直接保存原文件（可选备份、跳过保存后校对）。\n\nPSB 正式支持；PSD 当前为实验功能。\n\nCopyright © PaceSpace. All Rights Reserved.`,
              buttons: ["确定"],
            });
          },
        },
      ) as any,
    ),
  );
}

async function createWindow(): Promise<void> {
  window = new BrowserWindow({
    width: 1220,
    height: 780,
    minWidth: 980,
    minHeight: 640,
    show: false,
    frame: false,
    autoHideMenuBar: true,
    title: "PaceSpace Metadata Cleaner (PSMetaC)",
    icon: path.join(
      directory,
      "renderer",
      "assets",
      "psmetac-icon-256.png",
    ),
    backgroundColor: "#15171a",
    webPreferences: {
      preload: path.join(directory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.setMenuBarVisibility(false);
  await window.loadFile(path.join(directory, "renderer", "index.html"));
  window.once("ready-to-show", () => window?.show());
  const publishWindowState = () =>
    window?.webContents.send("window-state", {
      maximized: window?.isMaximized() || false,
      fullScreen: window?.isFullScreen() || false,
    });
  window.on("maximize", publishWindowState);
  window.on("unmaximize", publishWindowState);
  window.on("enter-full-screen", publishWindowState);
  window.on("leave-full-screen", publishWindowState);
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window?.hide();
    }
  });
}

ipcMain.handle("window:control", async (_event, requestedAction) => {
  if (!window) return { maximized: false, fullScreen: false };
  const action = String(requestedAction || "");
  if (action === "minimize") window.minimize();
  else if (action === "toggle-maximize") {
    window.isMaximized() ? window.unmaximize() : window.maximize();
  } else if (action === "close") window.close();
  else if (action === "hide") window.hide();
  else if (action === "quit") {
    quitting = true;
    app.quit();
  } else if (action !== "state") {
    throw new Error(`不允许的窗口操作：${action}`);
  }
  return {
    maximized: window.isMaximized(),
    fullScreen: window.isFullScreen(),
  };
});

ipcMain.handle("bootstrap:status", async () => {
  const bootstrap = await loadBootstrap(defaultBootstrapDirectory());
  return {
    initialized: Boolean(bootstrap && service),
    dataRoot: bootstrap?.dataRoot || null,
  };
});

ipcMain.handle("bootstrap:inspect", async (_event, input) => {
  if (
    !input?.dataRoot ||
    !Array.isArray(input.allowedInputRoots) ||
    !Array.isArray(input.allowedOutputRoots)
  ) {
    throw new Error("请先选择软件数据目录。允许输入/输出目录可以暂时留空。");
  }
  const candidate = validateConfig(
    createDefaultConfig(input.dataRoot, {
      allowedInputRoots: input.allowedInputRoots,
      allowedOutputRoots: input.allowedOutputRoots,
      photoshopExecutable: input.photoshopExecutable || undefined,
      photoshopProgId: input.photoshopProgId || undefined,
    }),
  );
  const [dataFreeBytes, outputFreeBytes, photoshop] = await Promise.all([
    availableBytes(candidate.dataRoot),
    candidate.allowedOutputRoots[0]
      ? availableBytes(candidate.allowedOutputRoots[0])
      : Promise.resolve(null),
    diagnosePhotoshop({
      configuredExecutable: candidate.photoshopExecutable,
      verifiedVersions: candidate.verifiedPhotoshopVersions,
    }),
  ]);
  const warnings: string[] = [];
  const bridgeResolution = photoshop.selected
    ? await resolvePhotoshopBridge(
        photoshop.selected,
        candidate.photoshopProgId,
      )
    : null;
  const automationBridge = bridgeResolution?.selected
    ? {
        ...bridgeResolution.selected,
        mode: bridgeResolution.mode,
        attempts: bridgeResolution.attempts,
      }
    : null;
  if (!photoshop.selected) {
    warnings.push("未检测到 Photoshop；只能使用只读预检。");
  } else if (!photoshop.selected.verified) {
    warnings.push(
      `Photoshop ${photoshop.selected.productVersion || "未知版本"} 尚未完成 PSMetaC 实机验证；允许执行，报告会保留版本提示。`,
    );
  }
  if (dataFreeBytes < candidate.minimumSpaceReserveBytes) {
    warnings.push("数据目录可用空间低于默认 10 GB 安全保留量。");
  }
  return {
    system: systemInformation(),
    photoshop,
    automationBridge,
    storage: {
      dataRoot: candidate.dataRoot,
      dataFreeBytes,
      minimumReserveBytes: candidate.minimumSpaceReserveBytes,
      firstOutputRoot: candidate.allowedOutputRoots[0] || null,
      outputFreeBytes,
    },
    deniedRoots: candidate.deniedRoots,
    warnings,
  };
});

ipcMain.handle("bootstrap:initialize", async (_event, input) => {
  if (
    !input?.dataRoot ||
    !Array.isArray(input.allowedInputRoots) ||
    !Array.isArray(input.allowedOutputRoots)
  ) {
    throw new Error("软件数据目录为必填项；允许输入/输出目录必须使用列表格式。");
  }
  const config = createDefaultConfig(input.dataRoot, {
    allowedInputRoots: input.allowedInputRoots,
    allowedOutputRoots: input.allowedOutputRoots,
    photoshopExecutable: input.photoshopExecutable || undefined,
    photoshopProgId: input.photoshopProgId || undefined,
  });
  await saveConfig(config);
  await saveBootstrap(defaultBootstrapDirectory(), config.dataRoot);
  await startService(config.dataRoot);
  return { initialized: true, settings: service!.publicSettings() };
});

ipcMain.handle("dialog:directory", async (_event, requestedKind) => {
  const kind = ["source", "output", "watcher"].includes(
    String(requestedKind),
  )
    ? (String(requestedKind) as "source" | "output" | "watcher")
    : "output";
  const recent = service?.config.recentDirectories[kind];
  const fallback =
    kind === "source" || kind === "watcher"
      ? service?.config.allowedInputRoots[0]
      : service?.config.allowedOutputRoots[0];
  const defaultPath = await existingDirectory(
    recent || fallback || app.getPath("desktop"),
  );
  const result = await dialog.showOpenDialog(window!, {
    properties: ["openDirectory", "createDirectory"],
    defaultPath,
  });
  if (result.canceled) return null;
  const selected = result.filePaths[0];
  explicitlySelectedDirectories.add(approvalKey(selected));
  await rememberDirectory(kind, selected);
  return selected;
});

ipcMain.handle("dialog:files", async () => {
  const defaultPath = await existingDirectory(
    service?.config.recentDirectories.source ||
      service?.config.allowedInputRoots[0] ||
      app.getPath("desktop"),
  );
  const result = await dialog.showOpenDialog(window!, {
    properties: ["openFile", "multiSelections"],
    defaultPath,
    filters: [
      { name: "Photoshop 文件", extensions: ["psb", "psd"] },
      { name: "Photoshop Large Document", extensions: ["psb"] },
      { name: "Experimental Photoshop Document", extensions: ["psd"] },
    ],
  });
  if (result.canceled) return [];
  for (const selected of result.filePaths) {
    explicitlySelectedFiles.add(approvalKey(selected));
  }
  if (result.filePaths[0]) {
    await rememberDirectory("source", path.dirname(result.filePaths[0]));
  }
  return result.filePaths;
});

ipcMain.handle("selection:remove-file", async (_event, selectedPath) => {
  if (!selectedPath) return false;
  return explicitlySelectedFiles.delete(approvalKey(String(selectedPath)));
});

ipcMain.handle("selection:remove-files", async (_event, selectedPaths) => {
  if (!Array.isArray(selectedPaths)) return 0;
  let removed = 0;
  for (const selectedPath of selectedPaths) {
    if (
      selectedPath &&
      explicitlySelectedFiles.delete(approvalKey(String(selectedPath)))
    ) {
      removed += 1;
    }
  }
  return removed;
});

ipcMain.handle("selection:add-dropped-paths", async (_event, droppedPaths) => {
  if (!Array.isArray(droppedPaths) || droppedPaths.length === 0) {
    return {
      files: [],
      summary: {
        droppedEntries: 0,
        scannedDirectories: 0,
        acceptedFiles: 0,
        duplicateFiles: 0,
        unsupportedFiles: 0,
        inaccessibleEntries: 0,
        skippedLinks: 0,
        skippedDeniedEntries: 0,
        newlyAuthorizedFiles: 0,
      },
    };
  }
  const normalizedPaths = droppedPaths
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => path.resolve(value));
  const result = await scanDroppedDesignFiles(normalizedPaths, {
    deniedRoots: service?.config.deniedRoots ?? [],
  });
  let newlyAuthorizedFiles = 0;
  for (const selected of result.files) {
    const key = approvalKey(selected);
    if (!explicitlySelectedFiles.has(key)) newlyAuthorizedFiles += 1;
    explicitlySelectedFiles.add(key);
  }
  if (result.files[0]) {
    await rememberDirectory("source", path.dirname(result.files[0]));
  }
  return {
    files: result.files,
    summary: { ...result.summary, newlyAuthorizedFiles },
  };
});

ipcMain.handle("dialog:settings-import", async () => {
  const defaultPath = await existingDirectory(
    service?.config.recentDirectories.settingsImport ||
      app.getPath("desktop"),
  );
  const result = await dialog.showOpenDialog(window!, {
    properties: ["openFile"],
    defaultPath,
    filters: [{ name: "PSB Cleaner Settings", extensions: ["json"] }],
  });
  if (result.canceled) return null;
  await rememberDirectory(
    "settingsImport",
    path.dirname(result.filePaths[0]),
  );
  return result.filePaths[0];
});

ipcMain.handle("dialog:settings-export", async () => {
  const directory = await existingDirectory(
    service?.config.recentDirectories.settingsExport ||
      app.getPath("desktop"),
  );
  const result = await dialog.showSaveDialog(window!, {
    defaultPath: path.join(directory, "psmetac_config.json"),
    filters: [{ name: "PSMetaC 设置", extensions: ["json"] }],
  });
  if (result.canceled || !result.filePath) return null;
  await rememberDirectory(
    "settingsExport",
    path.dirname(result.filePath),
  );
  explicitlySelectedExports.add(approvalKey(result.filePath));
  return result.filePath;
});

ipcMain.handle("dialog:diagnostic-export", async () => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const machineId = service?.config.machineId || "machine";
  const result = await dialog.showSaveDialog(window!, {
    defaultPath: path.join(
      app.getPath("desktop"),
      `PSMetaC_Logs_v${APP_VERSION}_${machineId}_${timestamp}.zip`,
    ),
    filters: [{ name: "PSMetaC 诊断日志包", extensions: ["zip"] }],
  });
  if (result.canceled || !result.filePath) return null;
  explicitlySelectedExports.add(approvalKey(result.filePath));
  return result.filePath;
});

ipcMain.handle("shell:reveal-export", async (_event, target) => {
  if (!target) throw new Error("没有可显示的导出文件。");
  const resolved = path.resolve(String(target));
  if (!explicitlySelectedExports.has(approvalKey(resolved))) {
    throw new Error("只能显示本次由你明确选择位置的导出文件。");
  }
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error("没有找到刚刚导出的文件；它可能已被移动或删除。");
  }
  shell.showItemInFolder(resolved);
  return "";
});

ipcMain.handle("shell:open-path", async (_event, target) => {
  if (!target) return "";
  if (!service) throw new Error("软件尚未完成首次设置。");
  const resolved = path.resolve(String(target));
  assertNotDenied(resolved, service.config.deniedRoots);
  const allowed =
    isPathInside(resolved, service.config.dataRoot) ||
    service.config.allowedOutputRoots.some((root) =>
      isPathInside(resolved, root),
    );
  if (!allowed) {
    throw new Error("桌面界面只允许打开软件报告、隔离文件和允许目录内的成品。");
  }
  return await shell.openPath(resolved);
});

ipcMain.handle("shell:open-job-target", async (_event, request) => {
  if (!service) throw new Error("软件尚未完成首次设置。");
  const job = service.getJob(String(request?.jobId || ""));
  const kind = String(request?.kind || "");
  if (!["source", "result", "result_folder", "report"].includes(kind)) {
    throw new Error("不支持的任务文件类型。");
  }
  const resultPath = job.quarantinePath || job.outputPath;
  let target: string | null = null;
  if (kind === "source") target = job.sourcePath;
  if (kind === "result" || kind === "result_folder") target = resultPath;
  if (kind === "report") target = job.reportHtmlPath;
  if (!target) {
    throw new Error(
      kind === "result" || kind === "result_folder"
        ? "这个任务没有产生可打开的处理文件；可以查看报告了解原因。"
        : "这个任务没有可打开的对应文件。",
    );
  }
  const resolved = path.resolve(target);
  assertNotDenied(resolved, service.config.deniedRoots);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error(
      "没有找到这个文件；任务可能未生成对应结果，或文件已被移动。",
    );
  }
  if (kind === "result_folder") {
    shell.showItemInFolder(resolved);
    return "";
  }
  const openError = await shell.openPath(resolved);
  if (openError) throw new Error(openError);
  return "";
});

ipcMain.handle("service:invoke", async (_event, request) => {
  if (!service) throw new Error("软件尚未完成首次设置。");
  const params = request.params || {};
  switch (request.method) {
    case "capabilities":
      return service.capabilities();
    case "profiles":
      return service.listProfiles();
    case "settings":
      return service.publicSettings();
    case "test_photoshop_connection":
      return await service.testPhotoshopConnection({
        executable: params.executable
          ? String(params.executable)
          : undefined,
        progId: params.progId ? String(params.progId) : undefined,
      });
    case "list_photoshop_installations":
      return await service.photoshopInstallations();
    case "update_settings":
      return await service.updateSettings(params);
    case "export_settings":
      return await service.exportSettings(params.target);
    case "import_settings":
      return await service.importSettings(params.source);
    case "export_diagnostic_logs":
      return await service.exportDiagnosticLogs(
        params.target,
        Array.isArray(params.jobIds) ? params.jobIds : [],
      );
    case "preview_quarantine_cleanup":
      return await service.previewQuarantineCleanup();
    case "clean_quarantine_now":
      return await service.cleanQuarantineNow({
        confirmedDirectories: Array.isArray(params.confirmedDirectories)
          ? params.confirmedDirectories.map(String)
          : [],
      });
    case "submit_jobs":
      if (!Array.isArray(params.jobs)) {
        throw new Error("任务列表格式无效。");
      }
      for (const job of params.jobs) {
        if (job.source !== "ui") continue;
        if (!explicitlySelectedFiles.has(approvalKey(job.sourcePath))) {
          throw new Error(
            `请使用“选择 PSB / PSD 文件”按钮明确选择此文件：${job.sourcePath}`,
          );
        }
        if (
          job.runMode !== "inspect_only" &&
          (job.executionMode || "safe_copy") === "safe_copy" &&
          (job.outputMode || "specified_directory") ===
            "specified_directory" &&
          (!job.outputDir ||
            !explicitlySelectedDirectories.has(approvalKey(job.outputDir)))
        ) {
          throw new Error("请使用“选择”按钮明确选择成品目录。");
        }
      }
      {
        const result = await service.submitJobs(params.jobs, {
          explicitlySelectedSources: params.jobs
            .filter((job: Record<string, unknown>) => job.source === "ui")
            .map((job: Record<string, unknown>) => String(job.sourcePath)),
          explicitlySelectedOutputDirectories: params.jobs
            .filter(
              (job: Record<string, unknown>) =>
                job.source === "ui" && job.outputDir,
            )
            .map((job: Record<string, unknown>) => String(job.outputDir)),
        });
        for (const job of params.jobs) {
          if (job.source === "ui") {
            explicitlySelectedFiles.delete(approvalKey(job.sourcePath));
          }
        }
        return result;
      }
    case "preview_batch_capacity":
      if (!Array.isArray(params.jobs)) {
        throw new Error("任务列表格式无效。");
      }
      for (const job of params.jobs) {
        if (job.source !== "ui") continue;
        if (!explicitlySelectedFiles.has(approvalKey(job.sourcePath))) {
          throw new Error(
            `请使用“选择 PSD / PSB 文件”按钮明确选择此文件：${job.sourcePath}`,
          );
        }
        if (
          job.runMode !== "inspect_only" &&
          (job.executionMode || "safe_copy") === "safe_copy" &&
          (job.outputMode || "specified_directory") === "specified_directory" &&
          (!job.outputDir ||
            !explicitlySelectedDirectories.has(approvalKey(job.outputDir)))
        ) {
          throw new Error("请使用“选择”按钮明确选择成品目录。");
        }
      }
      return await service.previewBatchCapacity(params.jobs, {
        explicitlySelectedSources: params.jobs
          .filter((job: Record<string, unknown>) => job.source === "ui")
          .map((job: Record<string, unknown>) => String(job.sourcePath)),
        explicitlySelectedOutputDirectories: params.jobs
          .filter(
            (job: Record<string, unknown>) => job.source === "ui" && job.outputDir,
          )
          .map((job: Record<string, unknown>) => String(job.outputDir)),
      });
    case "list_jobs":
      return service.listJobs(params);
    case "history_statistics":
      return await service.historyStatistics(params);
    case "list_user_tags":
      return service.listUserTags();
    case "create_user_tag":
      return service.createUserTag(params);
    case "update_user_tag":
      return service.updateUserTag(params);
    case "delete_user_tag":
      return service.deleteUserTag(params.tagId);
    case "set_job_user_tags":
      return service.setJobUserTags(params);
    case "get_job":
      return service.getJob(params.jobId);
    case "cancel_job":
      return await service.cancelJob(params.jobId);
    case "approve_job":
      return await service.approveJob(params.jobId);
    case "keep_inspection_result":
      return await service.keepInspectionResult(params.jobId);
    case "preflight_summaries":
      return await service.preflightSummaries(params);
    case "archive_job":
      return await service.archiveJob(params.jobId);
    case "delete_job_data":
      return await service.deleteJobData(params.jobId);
    case "get_report":
      return await service.getReport(params.jobId);
    case "get_review_context":
      return await service.getReviewContext(params.jobId);
    case "record_manual_review":
      return await service.recordManualReview(params);
    case "queue_status":
      return service.queueStatus();
    case "pause_queue":
      return service.pauseQueue();
    case "stop_queue_after_current":
      return await service.stopQueueAfterCurrent();
    case "resume_queue":
      return service.resumeQueue();
    case "acknowledge_critical":
      return service.acknowledgeCriticalPause();
    case "list_watchers":
      return service.listWatchers();
    case "preview_watcher":
      return await service.previewWatcher(params);
    case "scan_watchers":
      return await service.scanWatchersNow();
    case "add_watcher":
      return await service.addWatcher(params);
    case "set_watcher_enabled":
      return await service.setWatcherEnabled({
        watcherId: String(params.watcherId || ""),
        enabled: params.enabled,
      });
    case "diagnostics":
      return await service.diagnostics();
    default:
      throw new Error(`不允许的桌面调用：${request.method}`);
  }
});

app.on("before-quit", () => {
  quitting = true;
});

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showWindow();
  });
  app.whenReady().then(async () => {
    tray = new Tray(trayImage());
    tray.on("click", showWindow);
    tray.on("double-click", showWindow);
    rebuildTray();
    rebuildApplicationMenu();
    const bootstrap = await loadBootstrap(defaultBootstrapDirectory());
    if (bootstrap) {
      await startService(bootstrap.dataRoot).catch((error) => {
        new Notification({
          title: "PSMetaC 启动失败",
          body: error.message,
        }).show();
      });
    }
    await createWindow();
  });
}

app.on("window-all-closed", () => {
  // The tray keeps the per-user process alive.
});

app.on("will-quit", (event) => {
  if (successNotificationTimer) {
    clearTimeout(successNotificationTimer);
    successNotificationTimer = null;
  }
  if (cleanupFinished) return;
  if (service || pipe) {
    event.preventDefault();
    if (cleanupStarted) return;
    cleanupStarted = true;
    const close = async () => {
      await pipe?.close().catch(() => {});
      await service?.close().catch(() => {});
      pipe = null;
      service = null;
      cleanupFinished = true;
      app.exit(0);
    };
    void close();
  }
});
