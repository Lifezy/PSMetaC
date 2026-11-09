import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig, WatcherConfig } from "./types.ts";
import { JobStore } from "./database.ts";

export interface WatcherPreview {
  path: string;
  recursive: boolean;
  scannedFiles: number;
  supportedFiles: number;
  psbFiles: number;
  psdFiles: number;
  skippedDirectories: number;
  errors: string[];
}

export function watcherFileSignature(
  watcherId: string,
  sourcePath: string,
  size: number,
  mtimeMs: number,
): string {
  return crypto
    .createHash("sha256")
    .update(
      `${watcherId}\0${path.resolve(sourcePath)}\0${size}\0${Math.round(mtimeMs)}`,
    )
    .digest("hex");
}

function pathKey(value: string): string {
  const resolved = path.resolve(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function pathInside(candidate: string, root: string): boolean {
  const child = pathKey(candidate);
  const parent = pathKey(root);
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

export class WatcherManager {
  readonly config: AppConfig;
  readonly store: JobStore;
  private scanning = false;
  private stopping = false;
  private scanPromise: Promise<void> | null = null;
  onStableFile?: (
    watcher: WatcherConfig,
    sourcePath: string,
    clientRequestId: string,
  ) => Promise<{ jobId: string }>;

  constructor(config: AppConfig, store: JobStore) {
    this.config = config;
    this.store = store;
  }

  async preview(
    watcherPath: string,
    recursive: boolean,
    outputDir?: string,
  ): Promise<WatcherPreview> {
    const { files: _files, ...preview } = await this.enumerate({
      watcherPath,
      recursive,
      outputDir,
    });
    return preview;
  }

  async scanOnce(): Promise<void> {
    if (this.scanning || this.stopping) return;
    this.scanning = true;
    const scan = (async () => {
      for (const watcher of this.store
        .listWatchers()
        .filter((item) => item.enabled)) {
        if (this.stopping) break;
        await this.scanWatcher(watcher);
      }
    })();
    this.scanPromise = scan;
    try {
      await scan;
    } finally {
      this.scanning = false;
      if (this.scanPromise === scan) this.scanPromise = null;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.scanPromise;
  }

  private watcherEnabled(watcherId: string): boolean {
    if (this.stopping) return false;
    return (
      this.store.listWatchers().find((item) => item.id === watcherId)?.enabled ===
      true
    );
  }

  private stopPausedWatcher(watcherId: string): void {
    this.store.updateWatcherRuntime(watcherId, {
      scanStatus: "idle",
      waitingStableFiles: 0,
    });
  }

  private excludedDirectory(
    directory: string,
    watcherPath: string,
    outputDir?: string,
  ): boolean {
    if (pathKey(directory) === pathKey(watcherPath)) return false;
    if (pathInside(directory, this.config.dataRoot)) return true;
    if (outputDir && pathInside(directory, outputDir)) return true;
    if (
      path.basename(directory).toLowerCase() ===
      this.config.sourceSubfolderName.toLowerCase()
    ) {
      return true;
    }
    return false;
  }

  private async enumerate(input: {
    watcherPath: string;
    recursive: boolean;
    outputDir?: string;
  }): Promise<WatcherPreview & { files: string[] }> {
    const result: WatcherPreview & { files: string[] } = {
      path: path.resolve(input.watcherPath),
      recursive: input.recursive,
      scannedFiles: 0,
      supportedFiles: 0,
      psbFiles: 0,
      psdFiles: 0,
      skippedDirectories: 0,
      errors: [],
      files: [],
    };
    const visit = async (directory: string): Promise<void> => {
      if (
        this.excludedDirectory(
          directory,
          result.path,
          input.outputDir,
        )
      ) {
        result.skippedDirectories++;
        return;
      }
      let entries: Awaited<ReturnType<typeof fs.readdir>>;
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch (error) {
        result.errors.push(
          `${directory}: ${(error as Error).message}`,
        );
        return;
      }
      for (const entry of entries) {
        const target = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          if (entry.isDirectory()) result.skippedDirectories++;
          continue;
        }
        if (entry.isDirectory()) {
          if (input.recursive) await visit(target);
          continue;
        }
        if (!entry.isFile()) continue;
        result.scannedFiles++;
        const extension = path.extname(entry.name).toLowerCase();
        if (extension !== ".psb" && extension !== ".psd") continue;
        if (extension === ".psb") {
          result.supportedFiles++;
          result.psbFiles++;
          result.files.push(target);
        } else {
          result.psdFiles++;
          if (
            this.config.experimentalPsd &&
            this.config.experimentalPsdUnattended
          ) {
            result.supportedFiles++;
            result.files.push(target);
          }
        }
      }
    };
    await visit(result.path);
    return result;
  }

  private async scanWatcher(watcher: WatcherConfig): Promise<void> {
    if (!this.watcherEnabled(watcher.id)) {
      this.stopPausedWatcher(watcher.id);
      return;
    }
    this.store.updateWatcherRuntime(watcher.id, {
      scanStatus: "scanning",
      lastError: null,
    });
    const preview = await this.enumerate({
      watcherPath: watcher.path,
      recursive: watcher.recursive,
      outputDir:
        watcher.executionMode === "safe_copy"
          ? watcher.outputDir
          : undefined,
    });
    if (!this.watcherEnabled(watcher.id)) {
      this.stopPausedWatcher(watcher.id);
      return;
    }
    let waitingStableFiles = 0;
    let submittedJobs = watcher.submittedJobs;
    let skippedFiles = preview.scannedFiles - preview.supportedFiles;
    const fileErrors = [...preview.errors];

    for (const sourcePath of preview.files) {
      if (!this.watcherEnabled(watcher.id)) break;
      try {
        const stat = await fs.stat(sourcePath);
        if (!this.watcherEnabled(watcher.id)) break;
        const previous = this.store.getWatcherFile(
          watcher.id,
          sourcePath,
        );
        const signature = watcherFileSignature(
          watcher.id,
          sourcePath,
          stat.size,
          stat.mtimeMs,
        );
        const changed =
          !previous ||
          previous.sizeBytes !== stat.size ||
          Math.abs(previous.mtimeMs - stat.mtimeMs) > 1;
        if (changed) {
          this.store.upsertWatcherFile({
            watcherId: watcher.id,
            sourcePath,
            sizeBytes: stat.size,
            mtimeMs: stat.mtimeMs,
            unchangedSince: Date.now(),
            lastSubmittedSignature:
              previous?.lastSubmittedSignature || null,
            lastJobId: null,
            state: "waiting_stable",
          });
          waitingStableFiles++;
          continue;
        }
        if (previous.lastSubmittedSignature === signature) {
          skippedFiles++;
          continue;
        }
        if (
          Date.now() - previous.unchangedSince <
          this.config.stabilitySeconds * 1000
        ) {
          waitingStableFiles++;
          continue;
        }
        if (!this.watcherEnabled(watcher.id)) break;
        const submitted = await this.onStableFile?.(
          watcher,
          sourcePath,
          `watcher:${signature}`,
        );
        this.store.upsertWatcherFile({
          watcherId: watcher.id,
          sourcePath,
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs,
          unchangedSince: previous.unchangedSince,
          lastSubmittedSignature: signature,
          lastJobId: submitted?.jobId || null,
          state: "submitted",
        });
        submittedJobs++;
      } catch (error) {
        fileErrors.push(`${sourcePath}: ${(error as Error).message}`);
      }
    }

    const lastError = fileErrors.length
      ? fileErrors.slice(0, 3).join("\n")
      : null;
    const enabled = this.watcherEnabled(watcher.id);
    this.store.updateWatcherRuntime(watcher.id, {
      lastScanAt: new Date().toISOString(),
      scanStatus: enabled ? (lastError ? "error" : "monitoring") : "idle",
      scannedFiles: preview.scannedFiles,
      supportedFiles: preview.supportedFiles,
      waitingStableFiles: enabled ? waitingStableFiles : 0,
      submittedJobs,
      skippedFiles,
      lastError,
    });
    if (enabled && lastError) {
      const event = this.store.addEvent({
        level: "error",
        stage: "watcher",
        eventType: "WATCHER_SCAN_FAILED",
        message: "自动处理文件夹扫描遇到问题。",
        data: { watcherId: watcher.id, path: watcher.path, lastError },
      });
      await this.store.appendEventFiles(event);
    }
  }
}
