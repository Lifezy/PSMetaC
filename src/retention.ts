import fs from "node:fs/promises";
import path from "node:path";
import { assertPathWithinDataRoot } from "./paths.ts";
import { runProcess } from "./process-runner.ts";
import type { AppConfig } from "./types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface QuarantineCleanupCandidate {
  directory: string;
  jobId: string;
  bytes: number;
  modifiedAt: string;
  ageDays: number;
  reasons: Array<"age" | "capacity">;
}

export interface QuarantineCleanupPlan {
  generatedAt: string;
  enabled: boolean;
  trigger: AppConfig["quarantineCleanupTrigger"];
  retentionDays: number;
  maxBytes: number;
  totalDirectories: number;
  totalBytes: number;
  lockedDirectories: number;
  lockedBytes: number;
  candidates: QuarantineCleanupCandidate[];
  candidateBytes: number;
  projectedBytes: number;
  scanErrors: Array<{ path: string; error: string }>;
}

export interface QuarantineCleanupResult extends QuarantineCleanupPlan {
  recycled: QuarantineCleanupCandidate[];
  recycledBytes: number;
  failures: Array<{ directory: string; error: string }>;
}

export interface ManagedQuarantineDirectory {
  jobId: string;
  directory: string;
}

function normalizeReviewJobId(jobId: string): string {
  const normalized = String(jobId || "").trim();
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    path.basename(normalized) !== normalized
  ) {
    throw new Error("隔离任务编号无效，已停止清理。");
  }
  return normalized;
}

export function assertManagedReviewDirectory(
  config: AppConfig,
  jobId: string,
  directory: string,
): string {
  const normalized = normalizeReviewJobId(jobId);
  const resolved = path.resolve(directory);
  const legacyDirectory = path.resolve(
    config.dataRoot,
    "quarantine",
    normalized,
  );
  if (resolved === legacyDirectory) return resolved;
  if (
    path.basename(resolved) === normalized &&
    [".psmetac-review", ".psmetac-work"].includes(
      path.basename(path.dirname(resolved)).toLowerCase(),
    )
  ) {
    return resolved;
  }
  throw new Error("复核目录与任务编号或受控目录不完全对应，已停止清理。");
}

function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

async function sendDirectoryToRecycleBin(target: string): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("隔离文件只能在 Windows 上移入回收站。");
  }
  const escaped = target.replace(/'/g, "''");
  const script = [
    "Add-Type -AssemblyName Microsoft.VisualBasic",
    `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${escaped}',`,
    "[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,",
    "[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,",
    "[Microsoft.VisualBasic.FileIO.UICancelOption]::DoNothing)",
  ].join(" ");
  const result = await runProcess(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encodePowerShell(script),
    ],
    { timeoutMs: 120_000 },
  );
  if (result.code !== 0) {
    throw new Error(
      `移入回收站失败：${result.stderr || result.stdout || `exit=${result.code}`}`,
    );
  }
}

export interface ExactQuarantineRecycleResult {
  directory: string;
  jobId: string;
  bytes: number;
}

export interface RecycledReviewArtifacts {
  jobId: string;
  directories: Array<{
    kind: "work" | "preview" | "quarantine";
    directory: string;
    bytes: number;
  }>;
  recycledBytes: number;
}

export async function recycleExactQuarantineDirectory(
  config: AppConfig,
  jobId: string,
  options: {
    recycleDirectory?: (target: string) => Promise<void>;
  } = {},
): Promise<ExactQuarantineRecycleResult> {
  const normalizedJobId = String(jobId || "").trim();
  if (
    !normalizedJobId ||
    normalizedJobId === "." ||
    normalizedJobId === ".." ||
    path.basename(normalizedJobId) !== normalizedJobId
  ) {
    throw new Error("隔离任务编号无效，已停止清理。");
  }
  const quarantineRoot = path.resolve(config.dataRoot, "quarantine");
  const directory = path.resolve(quarantineRoot, normalizedJobId);
  assertPathWithinDataRoot(directory, quarantineRoot);
  if (path.dirname(directory) !== quarantineRoot) {
    throw new Error("隔离目录与任务编号不完全对应，已停止清理。");
  }
  const stat = await fs.lstat(directory).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("没有找到这个任务的隔离目录，未清理任何文件。");
    }
    throw error;
  });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("隔离目标不是受控的普通目录，已停止清理。");
  }
  const bytes = await directoryBytes(directory);
  await (options.recycleDirectory || sendDirectoryToRecycleBin)(directory);
  return { directory, jobId: normalizedJobId, bytes };
}

export async function recycleManualReviewArtifacts(
  config: AppConfig,
  jobId: string,
  options: {
    recycleDirectory?: (target: string) => Promise<void>;
    quarantineDirectory?: string;
  } = {},
): Promise<RecycledReviewArtifacts> {
  const normalizedJobId = normalizeReviewJobId(jobId);

  const roots = {
    quarantine: options.quarantineDirectory
      ? path.dirname(
          assertManagedReviewDirectory(
            config,
            normalizedJobId,
            options.quarantineDirectory,
          ),
        )
      : path.resolve(config.dataRoot, "quarantine"),
    work: path.resolve(config.dataRoot, "work"),
    reports: path.resolve(config.dataRoot, "reports"),
  };
  const reportDirectory = path.resolve(roots.reports, normalizedJobId);
  assertPathWithinDataRoot(reportDirectory, roots.reports);
  if (path.dirname(reportDirectory) !== roots.reports) {
    throw new Error("报告目录与任务编号不完全对应，已停止清理。");
  }
  const reportStat = await fs.lstat(reportDirectory).catch(() => null);
  if (reportStat && (reportStat.isSymbolicLink() || !reportStat.isDirectory())) {
    throw new Error("任务报告目录不是受控的普通目录，已停止清理。");
  }

  const candidates = [
    {
      kind: "work" as const,
      parent: roots.work,
      directory: path.resolve(roots.work, normalizedJobId),
      required: false,
    },
    {
      kind: "preview" as const,
      parent: reportDirectory,
      directory: path.resolve(reportDirectory, "artifacts"),
      required: false,
    },
    {
      kind: "quarantine" as const,
      parent: roots.quarantine,
      directory: options.quarantineDirectory
        ? assertManagedReviewDirectory(
            config,
            normalizedJobId,
            options.quarantineDirectory,
          )
        : path.resolve(roots.quarantine, normalizedJobId),
      required: true,
    },
  ];
  const inspected: RecycledReviewArtifacts["directories"] = [];
  for (const candidate of candidates) {
    assertPathWithinDataRoot(candidate.directory, candidate.parent);
    if (path.dirname(candidate.directory) !== candidate.parent) {
      throw new Error("派生目录与任务编号不完全对应，已停止清理。");
    }
    const stat = await fs.lstat(candidate.directory).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!stat) {
      if (candidate.required) {
        throw new Error("没有找到这个任务的隔离目录，未清理任何文件。");
      }
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("派生文件目标不是受控的普通目录，已停止清理。");
    }
    inspected.push({
      kind: candidate.kind,
      directory: candidate.directory,
      bytes: await directoryBytes(candidate.directory),
    });
  }

  const recycleDirectory = options.recycleDirectory || sendDirectoryToRecycleBin;
  for (const candidate of inspected) {
    await recycleDirectory(candidate.directory);
  }
  return {
    jobId: normalizedJobId,
    directories: inspected,
    recycledBytes: inspected.reduce((sum, item) => sum + item.bytes, 0),
  };
}

async function directoryBytes(directory: string): Promise<number> {
  let total = 0;
  const visit = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(target);
      } else if (entry.isFile()) {
        total += (await fs.stat(target)).size;
      }
    }
  };
  await visit(directory);
  return total;
}

export async function previewRetentionMaintenance(
  config: AppConfig,
  options: {
    lockedJobIds?: Iterable<string>;
    now?: number;
    quarantineDirectories?: Iterable<ManagedQuarantineDirectory>;
  } = {},
): Promise<QuarantineCleanupPlan> {
  const now = options.now ?? Date.now();
  const locked = new Set(options.lockedJobIds || []);
  const quarantineRoot = path.join(config.dataRoot, "quarantine");
  const entries = await fs
    .readdir(quarantineRoot, { withFileTypes: true })
    .catch(() => []);
  const scanErrors: QuarantineCleanupPlan["scanErrors"] = [];
  const directories: Array<{
    directory: string;
    jobId: string;
    bytes: number;
    mtimeMs: number;
    locked: boolean;
  }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = path.join(quarantineRoot, entry.name);
    assertPathWithinDataRoot(directory, quarantineRoot);
    try {
      const [stat, bytes] = await Promise.all([
        fs.stat(directory),
        directoryBytes(directory),
      ]);
      directories.push({
        directory,
        jobId: entry.name,
        bytes,
        mtimeMs: stat.mtimeMs,
        locked: locked.has(entry.name),
      });
    } catch (error) {
      scanErrors.push({ path: directory, error: (error as Error).message });
    }
  }
  const knownDirectories = new Set(
    directories.map((item) => path.resolve(item.directory).toLowerCase()),
  );
  for (const item of options.quarantineDirectories || []) {
    try {
      const directory = assertManagedReviewDirectory(
        config,
        item.jobId,
        item.directory,
      );
      const key = directory.toLowerCase();
      if (knownDirectories.has(key)) continue;
      const stat = await fs.lstat(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("复核目标不是受控的普通目录。");
      }
      directories.push({
        directory,
        jobId: item.jobId,
        bytes: await directoryBytes(directory),
        mtimeMs: stat.mtimeMs,
        locked: locked.has(item.jobId),
      });
      knownDirectories.add(key);
    } catch (error) {
      scanErrors.push({ path: item.directory, error: (error as Error).message });
    }
  }
  directories.sort(
    (left, right) => left.mtimeMs - right.mtimeMs || left.jobId.localeCompare(right.jobId),
  );
  const totalBytes = directories.reduce((sum, item) => sum + item.bytes, 0);
  const lockedDirectories = directories.filter((item) => item.locked);
  let projectedBytes = totalBytes;
  const candidates: QuarantineCleanupCandidate[] = [];
  for (const item of directories) {
    if (item.locked) continue;
    const ageReached =
      config.quarantineRetentionDays > 0 &&
      now - item.mtimeMs >= config.quarantineRetentionDays * DAY_MS;
    const capacityReached =
      config.quarantineMaxBytes > 0 &&
      projectedBytes > config.quarantineMaxBytes;
    const activeConditions = [
      ...(config.quarantineRetentionDays > 0 ? [ageReached] : []),
      ...(config.quarantineMaxBytes > 0 ? [capacityReached] : []),
    ];
    const eligible =
      activeConditions.length > 0 &&
      (config.quarantineCleanupTrigger === "all"
        ? activeConditions.every(Boolean)
        : activeConditions.some(Boolean));
    if (!eligible) continue;
    const reasons: QuarantineCleanupCandidate["reasons"] = [];
    if (ageReached) reasons.push("age");
    if (capacityReached) reasons.push("capacity");
    candidates.push({
      directory: item.directory,
      jobId: item.jobId,
      bytes: item.bytes,
      modifiedAt: new Date(item.mtimeMs).toISOString(),
      ageDays: Math.max(0, (now - item.mtimeMs) / DAY_MS),
      reasons,
    });
    projectedBytes = Math.max(0, projectedBytes - item.bytes);
  }
  return {
    generatedAt: new Date(now).toISOString(),
    enabled: config.quarantineCleanupEnabled,
    trigger: config.quarantineCleanupTrigger,
    retentionDays: config.quarantineRetentionDays,
    maxBytes: config.quarantineMaxBytes,
    totalDirectories: directories.length,
    totalBytes,
    lockedDirectories: lockedDirectories.length,
    lockedBytes: lockedDirectories.reduce((sum, item) => sum + item.bytes, 0),
    candidates,
    candidateBytes: candidates.reduce((sum, item) => sum + item.bytes, 0),
    projectedBytes,
    scanErrors,
  };
}

export async function runRetentionMaintenance(
  config: AppConfig,
  options: {
    lockedJobIds?: Iterable<string>;
    quarantineDirectories?: Iterable<ManagedQuarantineDirectory>;
    ignoreDisabled?: boolean;
    confirmedDirectories?: Iterable<string>;
    onRecycled?: (
      candidate: QuarantineCleanupCandidate,
    ) => void | Promise<void>;
  } = {},
): Promise<QuarantineCleanupResult> {
  const plan = await previewRetentionMaintenance(config, options);
  const recycled: QuarantineCleanupCandidate[] = [];
  const failures: QuarantineCleanupResult["failures"] = [];
  if (!plan.enabled && !options.ignoreDisabled) {
    return { ...plan, recycled, recycledBytes: 0, failures };
  }
  const confirmed = options.confirmedDirectories
    ? new Set(
        [...options.confirmedDirectories].map((item) =>
          path.resolve(item).toLowerCase(),
        ),
      )
    : null;
  for (const candidate of plan.candidates) {
    if (confirmed && !confirmed.has(path.resolve(candidate.directory).toLowerCase())) {
      continue;
    }
    try {
      await sendDirectoryToRecycleBin(candidate.directory);
      recycled.push(candidate);
      await options.onRecycled?.(candidate);
    } catch (error) {
      failures.push({
        directory: candidate.directory,
        error: (error as Error).message,
      });
    }
  }
  return {
    ...plan,
    recycled,
    recycledBytes: recycled.reduce((sum, item) => sum + item.bytes, 0),
    failures,
  };
}
