import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig, JobRecord } from "./types.ts";
import { runProcess } from "./process-runner.ts";

const DIAGNOSTIC_FILE_NAMES = [
  "report.json",
  "report.html",
  "preflight.json",
  "postflight.json",
] as const;

const DIAGNOSTIC_ARTIFACT_NAMES = [
  "photoshop.log",
  "cleanup_plan.tsv",
  "source_cleanup_plan.tsv",
  "photoshop_job.tsv",
  "disk-space.json",
] as const;

function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function safeRelativeJobId(jobId: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(jobId)) {
    throw new Error(`任务编号包含不安全字符：${jobId}`);
  }
  return jobId;
}

async function sha256File(target: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const handle = await fs.open(target, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        position,
      );
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function writeJson(target: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export interface DiagnosticExportResult {
  path: string;
  selectedJobCount: number;
  includedFileCount: number;
  includedBytes: number;
  missingFiles: string[];
}

export async function exportDiagnosticBundle(input: {
  config: AppConfig;
  jobs: JobRecord[];
  diagnostics: Record<string, unknown>;
  queue: Record<string, unknown>;
  database: { path: string; integrity: string };
  target: string;
}): Promise<DiagnosticExportResult> {
  if (process.platform !== "win32") {
    throw new Error("诊断日志 ZIP 当前只支持 Windows。");
  }
  const target = path.resolve(input.target);
  if (path.extname(target).toLowerCase() !== ".zip") {
    throw new Error("诊断日志文件名必须以 .zip 结尾。");
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs
    .access(target)
    .then(() => {
      throw new Error(`目标文件已存在，拒绝覆盖：${target}`);
    })
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });

  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "psmetac-diagnostic-export-"),
  );
  const bundleRoot = path.join(temporaryRoot, "PSMetaC_Diagnostics");
  const manifestFiles: Array<{
    path: string;
    bytes: number;
    sha256: string;
  }> = [];
  const missingFiles: string[] = [];

  const includeFile = async (
    source: string,
    relativeTarget: string,
  ): Promise<void> => {
    let stat;
    try {
      stat = await fs.stat(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        missingFiles.push(relativeTarget.replace(/\\/g, "/"));
        return;
      }
      throw error;
    }
    if (!stat.isFile()) return;
    const destination = path.join(bundleRoot, relativeTarget);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
    manifestFiles.push({
      path: relativeTarget.replace(/\\/g, "/"),
      bytes: stat.size,
      sha256: await sha256File(destination),
    });
  };

  try {
    const { pipeToken: _pipeToken, ...redactedConfig } = input.config;
    await writeJson(path.join(bundleRoot, "environment.json"), {
      exportedAt: new Date().toISOString(),
      appVersion: input.diagnostics.appVersion,
      machineId: input.config.machineId,
      diagnostics: input.diagnostics,
    });
    await writeJson(path.join(bundleRoot, "configuration.redacted.json"), {
      ...redactedConfig,
      pipeToken: "[REDACTED]",
      privacyNotice:
        "本文件不包含本地通信令牌，但仍可能包含文件夹路径、电脑名和版本信息。",
    });
    await writeJson(path.join(bundleRoot, "database-summary.json"), {
      ...input.database,
      queue: input.queue,
      jobs: input.jobs,
    });

    await includeFile(
      path.join(input.config.dataRoot, "logs", "audit.jsonl"),
      path.join("logs", "audit.jsonl"),
    );
    for (const job of input.jobs) {
      const jobId = safeRelativeJobId(job.id);
      await includeFile(
        path.join(
          input.config.dataRoot,
          "logs",
          "jobs",
          `${jobId}.events.jsonl`,
        ),
        path.join("jobs", jobId, "events.jsonl"),
      );
      const reportDirectory = path.join(
        input.config.dataRoot,
        "reports",
        jobId,
      );
      for (const name of DIAGNOSTIC_FILE_NAMES) {
        await includeFile(
          path.join(reportDirectory, name),
          path.join("jobs", jobId, name),
        );
      }
      for (const name of DIAGNOSTIC_ARTIFACT_NAMES) {
        await includeFile(
          path.join(reportDirectory, "artifacts", name),
          path.join("jobs", jobId, "artifacts", name),
        );
      }
    }

    for (const relative of [
      "environment.json",
      "configuration.redacted.json",
      "database-summary.json",
    ]) {
      const targetFile = path.join(bundleRoot, relative);
      const stat = await fs.stat(targetFile);
      manifestFiles.push({
        path: relative,
        bytes: stat.size,
        sha256: await sha256File(targetFile),
      });
    }
    manifestFiles.sort((left, right) => left.path.localeCompare(right.path));
    await writeJson(path.join(bundleRoot, "manifest.json"), {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      selectedJobCount: input.jobs.length,
      files: manifestFiles,
      missingFiles,
      excluded:
        "PSD/PSB、成品、隔离副本、工作副本、备份、PNG 预览和本地通信令牌。",
    });

    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$source = '${bundleRoot.replace(/'/g, "''")}'`,
      `$destination = '${target.replace(/'/g, "''")}'`,
      "Add-Type -AssemblyName System.IO.Compression.FileSystem",
      "[System.IO.Compression.ZipFile]::CreateFromDirectory($source, $destination, [System.IO.Compression.CompressionLevel]::Optimal, $true)",
    ].join("\r\n");
    const compressed = await runProcess(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        encodePowerShell(script),
      ],
      { timeoutMs: 10 * 60 * 1000 },
    );
    if (compressed.code !== 0) {
      throw new Error(
        `诊断日志压缩失败：${compressed.stderr || compressed.stdout || compressed.code}`,
      );
    }
    const archive = await fs.stat(target);
    if (!archive.isFile() || archive.size === 0) {
      throw new Error("诊断日志 ZIP 没有正确生成。");
    }
    return {
      path: target,
      selectedJobCount: input.jobs.length,
      includedFileCount: manifestFiles.length,
      includedBytes: manifestFiles.reduce(
        (total, item) => total + item.bytes,
        0,
      ),
      missingFiles,
    };
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}
