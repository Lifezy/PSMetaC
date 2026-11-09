import fs from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "./paths.ts";

export interface DroppedFileScanSummary {
  droppedEntries: number;
  scannedDirectories: number;
  acceptedFiles: number;
  duplicateFiles: number;
  unsupportedFiles: number;
  inaccessibleEntries: number;
  skippedLinks: number;
  skippedDeniedEntries: number;
}

export interface DroppedFileScanResult {
  files: string[];
  summary: DroppedFileScanSummary;
}

export class DroppedFileScanError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DroppedFileScanError";
    this.code = code;
  }
}

function comparisonKey(value: string): string {
  const resolved = path.resolve(value).replace(/[\\/]+$/u, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isSupportedDesignFile(value: string): boolean {
  const extension = path.extname(value).toLowerCase();
  return extension === ".psb" || extension === ".psd";
}

function isDenied(value: string, deniedRoots: string[]): boolean {
  return deniedRoots.some((root) => isPathInside(value, root));
}

export async function scanDroppedDesignFiles(
  droppedPaths: string[],
  options: {
    deniedRoots?: string[];
    maxAcceptedFiles?: number;
    maxScannedEntries?: number;
  } = {},
): Promise<DroppedFileScanResult> {
  const deniedRoots = options.deniedRoots ?? [];
  const maxAcceptedFiles = options.maxAcceptedFiles ?? 10_000;
  const maxScannedEntries = options.maxScannedEntries ?? 100_000;
  const summary: DroppedFileScanSummary = {
    droppedEntries: droppedPaths.length,
    scannedDirectories: 0,
    acceptedFiles: 0,
    duplicateFiles: 0,
    unsupportedFiles: 0,
    inaccessibleEntries: 0,
    skippedLinks: 0,
    skippedDeniedEntries: 0,
  };
  const files: string[] = [];
  const knownFiles = new Set<string>();
  const knownDirectories = new Set<string>();
  let scannedEntries = 0;

  const assertWithinLimits = (): void => {
    if (scannedEntries > maxScannedEntries) {
      throw new DroppedFileScanError(
        "DROPPED_SCAN_ENTRY_LIMIT",
        `文件夹内容超过安全扫描上限（${maxScannedEntries.toLocaleString()} 项）。请缩小文件夹范围后重试。`,
      );
    }
    if (files.length > maxAcceptedFiles) {
      throw new DroppedFileScanError(
        "DROPPED_SCAN_FILE_LIMIT",
        `找到的 PSD/PSB 超过单次添加上限（${maxAcceptedFiles.toLocaleString()} 个）。请分批添加。`,
      );
    }
  };

  const addFile = async (filePath: string): Promise<void> => {
    if (!isSupportedDesignFile(filePath)) {
      summary.unsupportedFiles += 1;
      return;
    }
    const realPath = await fs.realpath(filePath);
    const key = comparisonKey(realPath);
    if (knownFiles.has(key)) {
      summary.duplicateFiles += 1;
      return;
    }
    knownFiles.add(key);
    files.push(realPath);
    assertWithinLimits();
  };

  const scanDirectory = async (directoryPath: string): Promise<void> => {
    const realDirectory = await fs.realpath(directoryPath);
    const directoryKey = comparisonKey(realDirectory);
    if (knownDirectories.has(directoryKey)) return;
    knownDirectories.add(directoryKey);
    if (isDenied(realDirectory, deniedRoots)) {
      summary.skippedDeniedEntries += 1;
      return;
    }
    summary.scannedDirectories += 1;
    const entries = await fs.readdir(realDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      scannedEntries += 1;
      assertWithinLimits();
      const child = path.join(realDirectory, entry.name);
      if (isDenied(child, deniedRoots)) {
        summary.skippedDeniedEntries += 1;
        continue;
      }
      if (entry.isSymbolicLink()) {
        summary.skippedLinks += 1;
        continue;
      }
      try {
        if (entry.isDirectory()) {
          await scanDirectory(child);
        } else if (entry.isFile()) {
          await addFile(child);
        }
      } catch (error) {
        if (error instanceof DroppedFileScanError) throw error;
        summary.inaccessibleEntries += 1;
      }
    }
  };

  for (const droppedPath of droppedPaths) {
    if (!path.isAbsolute(droppedPath)) {
      summary.inaccessibleEntries += 1;
      continue;
    }
    const absolute = path.resolve(droppedPath);
    if (isDenied(absolute, deniedRoots)) {
      summary.skippedDeniedEntries += 1;
      continue;
    }
    try {
      const stat = await fs.lstat(absolute);
      scannedEntries += 1;
      assertWithinLimits();
      if (stat.isSymbolicLink()) {
        summary.skippedLinks += 1;
      } else if (stat.isDirectory()) {
        await scanDirectory(absolute);
      } else if (stat.isFile()) {
        await addFile(absolute);
      } else {
        summary.unsupportedFiles += 1;
      }
    } catch (error) {
      if (error instanceof DroppedFileScanError) throw error;
      summary.inaccessibleEntries += 1;
    }
  }

  files.sort((left, right) => left.localeCompare(right));
  summary.acceptedFiles = files.length;
  return { files, summary };
}
