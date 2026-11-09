import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig, FileReport, JobRecord } from "./types.ts";
import { JobStore } from "./database.ts";
import {
  atomicWriteJson,
  availableBytes,
  copyFileVerified,
  expectedPhotoshopDocumentFormat,
  moveWithoutOverwrite,
  readPhotoshopDocumentFormat,
  safeRemoveWorkDirectory,
  snapshotFile,
  snapshotsEqual,
  type FileSnapshot,
} from "./files.ts";
import { inspectPsb } from "./inspector.ts";
import {
  collectParserWarnings,
  evaluatePolicy,
  PROFILE_DEFINITIONS,
} from "./policies.ts";
import { buildOutputPath } from "./paths.ts";
import { planExecutionStorage } from "./storage-plan.ts";
import {
  createCancellationFlag,
  resolvePhotoshopBridge,
  probePhotoshopIdle,
  runPhotoshopCleanup,
} from "./photoshop.ts";
import {
  diagnosePhotoshop,
  photoshopVersionMatches,
  systemInformation,
  type PhotoshopInstallation,
} from "./environment.ts";
import { structureFingerprint, validateCleanup } from "./validation.ts";
import { writeReport } from "./reports.ts";
import { watcherFileSignature } from "./watchers.ts";
import { APP_VERSION } from "./version.ts";

function nowIso(): string {
  return new Date().toISOString();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function listTaskOutputCandidates(input: {
  workDirectory: string;
  expectedOutput: string;
}): Promise<string[]> {
  const expected = path.resolve(input.expectedOutput);
  const entries = await fs
    .readdir(input.workDirectory, { withFileTypes: true })
    .catch(() => []);
  const candidates: Array<{ target: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().startsWith("cleaned-output")) {
      continue;
    }
    const extension = path.extname(entry.name).toLowerCase();
    if (extension !== ".psd" && extension !== ".psb") continue;
    const target = path.resolve(input.workDirectory, entry.name);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat || stat.size <= 0) continue;
    candidates.push({ target, mtimeMs: stat.mtimeMs });
  }
  candidates.sort((left, right) => {
    if (left.target === expected) return -1;
    if (right.target === expected) return 1;
    return right.mtimeMs - left.mtimeMs;
  });
  return candidates.map((candidate) => candidate.target);
}

function isTerminal(status: JobRecord["status"]): boolean {
  return [
    "preflight_complete",
    "skipped",
    "blocked",
    "succeeded",
    "partial",
    "quarantined",
    "discarded",
    "cancelled",
    "failed",
    "critical_paused",
  ].includes(status);
}

function sizeChangeFields(
  sourceBytesBefore: number | null,
  resultBytesAfter: number | null,
): Record<string, number | null> {
  if (
    sourceBytesBefore === null ||
    resultBytesAfter === null ||
    sourceBytesBefore <= 0
  ) {
    return {
      sourceBytesBefore,
      resultBytesAfter,
      sizeChangeBytes: null,
      sizeChangePercent: null,
      reductionBytes: null,
      reductionPercent: null,
    };
  }
  const sizeChangeBytes = resultBytesAfter - sourceBytesBefore;
  const sizeChangePercent = (sizeChangeBytes / sourceBytesBefore) * 100;
  return {
    sourceBytesBefore,
    resultBytesAfter,
    sizeChangeBytes,
    sizeChangePercent,
    reductionBytes: -sizeChangeBytes,
    reductionPercent: -sizeChangePercent,
  };
}

function jobTiming(
  job: JobRecord,
  finishedAt = job.finishedAt || nowIso(),
): Record<string, number> {
  const duration = (start?: string | null, end?: string | null) => {
    const startMs = Date.parse(start || "");
    const endMs = Date.parse(end || "");
    return Number.isFinite(startMs) && Number.isFinite(endMs)
      ? Math.max(0, endMs - startMs)
      : 0;
  };
  return {
    queueWaitMs: duration(job.createdAt, job.preflightStartedAt),
    preflightMs: duration(
      job.preflightStartedAt,
      job.preflightFinishedAt,
    ),
    photoshopWaitMs: duration(
      job.preflightFinishedAt,
      job.executionStartedAt,
    ),
    executionMs: duration(job.executionStartedAt, finishedAt),
    totalJobMs: duration(job.createdAt, finishedAt),
  };
}

function parseSmartFailures(logText: string): string[] {
  return logText
    .split(/\r?\n/)
    .filter((line) => line.includes("\tSMART_OBJECT\tERROR\t"));
}

export interface LayerCleanupLogSummary {
  requested: { hidden: boolean; empty: boolean };
  deletedHidden: Array<Record<string, unknown>>;
  deletedEmpty: Array<Record<string, unknown>>;
  skippedHidden: Array<Record<string, unknown>>;
  skippedEmpty: Array<Record<string, unknown>>;
  deletedCount: number;
}

function decodeLogValue(value: string | undefined): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseLayerCleanup(logText: string): LayerCleanupLogSummary {
  const summary: LayerCleanupLogSummary = {
    requested: { hidden: false, empty: false },
    deletedHidden: [],
    deletedEmpty: [],
    skippedHidden: [],
    skippedEmpty: [],
    deletedCount: 0,
  };
  for (const line of logText.split(/\r?\n/u)) {
    if (!line.includes("\tLAYER_CLEANUP\t")) continue;
    const payload = line.split("\tLAYER_CLEANUP\t")[1] || "";
    const fields = payload.split("\t");
    const action = fields.shift() || "";
    const values: Record<string, string | number> = {};
    for (const field of fields) {
      const separator = field.indexOf("=");
      if (separator <= 0) continue;
      const key = field.slice(0, separator);
      const raw = field.slice(separator + 1);
      values[key] = ["path", "name", "reason", "type"].includes(key)
        ? decodeLogValue(raw)
        : /^-?\d+(?:\.\d+)?$/u.test(raw)
          ? Number(raw)
          : raw;
    }
    if (action === "START") {
      summary.requested.hidden = values.hidden === "true";
      summary.requested.empty = values.empty === "true";
    } else if (action === "DELETED") {
      if (values.kind === "hidden") summary.deletedHidden.push(values);
      if (values.kind === "empty") summary.deletedEmpty.push(values);
    } else if (action === "SKIPPED") {
      if (values.kind === "hidden") summary.skippedHidden.push(values);
      if (values.kind === "empty") summary.skippedEmpty.push(values);
    }
  }
  summary.deletedCount =
    summary.deletedHidden.length + summary.deletedEmpty.length;
  return summary;
}

function contentCleanupRequested(job: JobRecord): boolean {
  return job.deleteHiddenLayers || job.deleteEmptyLayers;
}

function contentCleanupPolicy(job: JobRecord): Record<string, unknown> {
  return {
    deleteHiddenLayers: job.deleteHiddenLayers,
    deleteEmptyLayers: job.deleteEmptyLayers,
    scope: "root_document_only",
    safeCopyOnly: true,
    requiresManualReviewWhenChanged: true,
  };
}

function evaluateJobPolicy(
  inspection: Parameters<typeof evaluatePolicy>[0],
  job: JobRecord,
): ReturnType<typeof evaluatePolicy> {
  const decision = evaluatePolicy(inspection, job.profile);
  if (!contentCleanupRequested(job) || decision.eligible) return decision;
  return {
    ...decision,
    eligible: true,
    reasonCode: "CONTENT_CLEANUP_REQUESTED",
    explanation:
      "未达到元数据清理阈值，但用户明确选择了图层内容整理；任务将只在安全副本上执行并进入人工复核。",
  };
}

export function parsePhotoshopTerminalStatus(logText: string): {
  status:
    | "done"
    | "partial"
    | "cancelled"
    | "cancelled_saved"
    | "error"
    | "missing";
  detail: string | null;
} {
  const terminal = logText
    .split(/\r?\n/u)
    .map((line) =>
      line.match(
        /(?:^|\t)STATUS=(DONE|PARTIAL|CANCELLED_SAVED|CANCELLED|ERROR)(?:\t(.*))?$/u,
      ),
    )
    .filter(Boolean)
    .at(-1);
  if (!terminal) return { status: "missing", detail: null };
  const kind = terminal[1];
  const rawDetail = (terminal[2] || "")
    .replace(/\t(?:line=\d+|elapsedMs=\d+).*$/u, "")
    .trim();
  if (kind === "DONE") {
    return { status: "done", detail: null };
  }
  if (kind === "PARTIAL") {
    return { status: "partial", detail: rawDetail || null };
  }
  if (kind === "CANCELLED_SAVED") {
    return { status: "cancelled_saved", detail: rawDetail || null };
  }
  if (kind === "CANCELLED") {
    return {
      status: "cancelled",
      detail: rawDetail || null,
    };
  }
  if (kind === "ERROR") {
    return {
      status: "error",
      detail: rawDetail || "Photoshop 执行失败。",
    };
  }
  return { status: "missing", detail: null };
}

export function parsePhotoshopRuntimeEnvironment(logText: string): {
  productVersion: string | null;
  executableDirectory: string | null;
} {
  const line = logText
    .split(/\r?\n/u)
    .filter((item) => item.includes("\tPHOTOSHOP_ENV\t"))
    .at(-1);
  if (!line) {
    return { productVersion: null, executableDirectory: null };
  }
  const fields: Record<string, string> = {};
  for (const field of (line.split("\tPHOTOSHOP_ENV\t")[1] || "").split("\t")) {
    const separator = field.indexOf("=");
    if (separator > 0) {
      fields[field.slice(0, separator)] = field.slice(separator + 1);
    }
  }
  let executableDirectory: string | null = null;
  if (fields.path) {
    try {
      executableDirectory = decodeURIComponent(fields.path);
    } catch {
      executableDirectory = fields.path;
    }
  }
  return {
    productVersion: fields.version?.trim() || null,
    executableDirectory,
  };
}

function photoshopReportDetails(
  selected: PhotoshopInstallation | null,
  runtime: ReturnType<typeof parsePhotoshopRuntimeEnvironment>,
  verifiedVersions: string[],
): Record<string, unknown> | null {
  const runtimeVersion = runtime.productVersion;
  const effectiveVersion = runtimeVersion || selected?.productVersion || null;
  if (!selected && !effectiveVersion) return null;
  const formallyAdapted =
    effectiveVersion !== null &&
    photoshopVersionMatches(effectiveVersion, verifiedVersions);
  return {
    ...(selected || {
      executable: null,
      productVersion: effectiveVersion || "",
      verified: false,
    }),
    selectedProductVersion: selected?.productVersion || null,
    runtimeProductVersion: runtimeVersion,
    runtimeExecutableDirectory: runtime.executableDirectory,
    formallyAdapted,
    compatibilityNotice: formallyAdapted
      ? null
      : "该 Photoshop 版本尚未完成 PSMetaC 的实机验证。允许执行，但报告会保留“尚未验证”标记。",
  };
}

export function parsePhotoshopProgress(
  logText: string,
  plannedObjects: number,
): {
  stage: string;
  current: number | null;
  total: number | null;
  detail: string;
  progress: number;
} {
  const lines = logText.split(/\r?\n/u);
  const planEvents = lines
    .filter((line) => line.includes("\tPLAN_PROGRESS\t"))
    .map((line) => {
      const values: Record<string, string> = {};
      const payload = line.split("\tPLAN_PROGRESS\t")[1] || "";
      for (const field of payload.split("\t")) {
        const separator = field.indexOf("=");
        if (separator > 0) {
          values[field.slice(0, separator)] = field.slice(separator + 1);
        }
      }
      return values;
    });
  const planProgress = planEvents.at(-1);
  const structuredTotal = Number(planProgress?.total);
  const total =
    Number.isFinite(structuredTotal) && structuredTotal > 0
      ? structuredTotal
      : plannedObjects > 0
        ? plannedObjects
        : null;
  const fallbackCompletedObjects = lines.filter((line) =>
    /\tSMART_OBJECT\t(?:SAVED|UNCHANGED|ERROR|SKIP_SHARED_ALREADY_PROCESSED)\t/u.test(
      line,
    ),
  ).length;
  const structuredCompleted = Number(planProgress?.completed);
  const completedObjects = Number.isFinite(structuredCompleted)
    ? structuredCompleted
    : fallbackCompletedObjects;
  const structuredFailed = Number(planProgress?.failed);
  const failedObjects = Number.isFinite(structuredFailed)
    ? structuredFailed
    : lines.filter((line) => line.includes("\tSMART_OBJECT\tERROR\t")).length;
  const structuredSkipped = Number(planProgress?.skipped);
  const skippedObjects = Number.isFinite(structuredSkipped)
    ? structuredSkipped
    : lines.filter((line) => /\tSMART_OBJECT\tSKIP_[A-Z_]+\t/u.test(line))
        .length;
  const structuredScanned = Number(planProgress?.scanned);
  const scannedObjects = Number.isFinite(structuredScanned)
    ? structuredScanned
    : lines.filter((line) => line.includes("\tSMART_OBJECT\tSTATE\t")).length;
  const current = total === null ? completedObjects : Math.min(completedObjects, total);
  const lastDocument = lines
    .filter((line) => line.includes("\tDOCUMENT\t"))
    .at(-1)
    ?.split("\t")
    .slice(2, 3)
    .join("") || "";
  const objectRatio =
    total && total > 0 ? Math.min(1, current / total) : completedObjects > 0 ? 0.5 : 0;

  if (lines.some((line) => line.includes("\tSTATUS=DONE"))) {
    return {
      stage: "photoshop_complete",
      current,
      total,
      detail: "Photoshop 已完成清理和保存，正在接收结果",
      progress: 0.79,
    };
  }
  if (
    lines.some((line) =>
      /\t(?:STATE_REOPEN|PREVIEW_AFTER_REOPEN)\b/u.test(
        line,
      ),
    )
  ) {
    return {
      stage: "photoshop_reopen",
      current,
      total,
      detail: "保存完成，正在重新打开并核对 Photoshop 文档",
      progress: 0.77,
    };
  }
  if (
    lines.some((line) =>
      /\t(?:IN_PLACE_SAVE\tSTART|OUTPUT_SAVE_ATTEMPT|OUTPUT_SAVE_COMMAND_STARTED|OUTPUT_SAVE_COMMAND_RETURNED|OUTPUT_FILE_CONFIRMED|OUTPUT_SAVE_COMPLETE|PREVIEW_AFTER_PROCESSING|PREVIEW_AFTER_SAVE)\b/u.test(
        line,
      ),
    )
  ) {
    return {
      stage: "photoshop_save",
      current,
      total,
      detail: "Photoshop 正在保存文件；此阶段耗时取决于文件大小，不能安全强制中断",
      progress: 0.72,
    };
  }
  const layerCleanupSummary = lines
    .filter((line) => line.includes("\tLAYER_CLEANUP\tSUMMARY\t"))
    .at(-1);
  if (
    layerCleanupSummary ||
    lines.some((line) => line.includes("\tLAYER_CLEANUP\tSTART\t"))
  ) {
    const deletedHidden = Number(
      layerCleanupSummary?.match(/\bdeletedHidden=(\d+)/u)?.[1] || 0,
    );
    const deletedEmpty = Number(
      layerCleanupSummary?.match(/\bdeletedEmpty=(\d+)/u)?.[1] || 0,
    );
    return {
      stage: "photoshop_layers",
      current,
      total,
      detail: layerCleanupSummary
        ? `已删除隐藏图层 ${deletedHidden} 个、空图层 ${deletedEmpty} 个；正在准备保存`
        : "正在按任务选项检查并删除根文档中的隐藏或空图层",
      progress: 0.715,
    };
  }
  if (
    total !== null &&
    current === total &&
    lines.some((line) => line.includes("\tROOT_XMP\t"))
  ) {
    return {
      stage: "photoshop_root_xmp",
      current,
      total,
      detail: `计划目标 ${current}/${total} 已结束；已扫描 ${scannedObjects}，跳过 ${skippedObjects}，失败 ${failedObjects}；正在清理根文档元数据`,
      progress: 0.71,
    };
  }
  if (completedObjects > 0 || lines.some((line) => line.includes("\tDOCUMENT\t"))) {
    return {
      stage: "photoshop_objects",
      current,
      total,
      detail: total
        ? `计划目标 ${current}/${total}；已扫描 ${scannedObjects}，跳过 ${skippedObjects}，失败 ${failedObjects}${lastDocument ? `；当前：${lastDocument}` : ""}`
        : `正在处理文档内容；已完成 ${current}，已扫描 ${scannedObjects}，跳过 ${skippedObjects}，失败 ${failedObjects}${lastDocument ? `；当前：${lastDocument}` : ""}`,
      progress: 0.52 + objectRatio * 0.18,
    };
  }
  if (lines.some((line) => line.includes("\tROOT_OPENED\t"))) {
    return {
      stage: "photoshop_prepare",
      current: 0,
      total,
      detail: "Photoshop 已打开工作文件，正在核对图层和清理计划",
      progress: 0.52,
    };
  }
  if (lines.some((line) => line.includes("\tSOURCE_OPEN\t"))) {
    return {
      stage: "photoshop_open",
      current: 0,
      total,
      detail: "Photoshop 正在打开工作文件",
      progress: 0.5,
    };
  }
  return {
    stage: "photoshop_start",
    current: 0,
    total,
    detail: "正在连接并启动指定的 Photoshop",
    progress: 0.48,
  };
}

export class JobWorker {
  readonly config: AppConfig;
  readonly store: JobStore;
  private preflightActive = false;
  private executionActive = false;
  private photoshopDiagnostic:
    | Awaited<ReturnType<typeof diagnosePhotoshop>>
    | null = null;
  onJobChanged?: (job: JobRecord) => void;

  constructor(config: AppConfig, store: JobStore) {
    this.config = config;
    this.store = store;
  }

  private reportDirectory(jobId: string): string {
    return path.join(this.config.dataRoot, "reports", jobId);
  }

  private artifactDirectory(jobId: string): string {
    return path.join(this.reportDirectory(jobId), "artifacts");
  }

  private workDirectory(jobId: string): string {
    return path.join(this.config.dataRoot, "work", jobId);
  }

  private async readDiskSpaceAssessment(
    jobId: string,
  ): Promise<Record<string, unknown> | null> {
    return await fs
      .readFile(
        path.join(this.artifactDirectory(jobId), "disk-space.json"),
        "utf8",
      )
      .then((text) => JSON.parse(text) as Record<string, unknown>)
      .catch(() => null);
  }

  private async emit(input: Parameters<JobStore["addEvent"]>[0]): Promise<void> {
    const event = this.store.addEvent(input);
    await this.store.appendEventFiles(event);
  }

  private changed(job: JobRecord): void {
    this.onJobChanged?.(job);
  }

  private updateProgress(
    jobId: string,
    values: Parameters<JobStore["updateJob"]>[1],
  ): JobRecord {
    const updated = this.store.updateJob(jobId, values);
    this.changed(updated);
    return updated;
  }

  async cancelJob(jobId: string): Promise<JobRecord> {
    let job = this.store.requestCancellation(jobId);
    await this.emit({
      jobId,
      level: "warning",
      stage: "control",
      eventType: "CANCEL_REQUESTED",
      message: "Cancellation was requested.",
    });
    if (["running", "validating"].includes(job.status)) {
      await fs.mkdir(this.artifactDirectory(jobId), { recursive: true });
      await createCancellationFlag(this.artifactDirectory(jobId));
    } else if (
      [
        "waiting_stable",
        "queued_preflight",
        "ready",
        "waiting_photoshop",
        "awaiting_approval",
      ].includes(job.status)
    ) {
      let sourceUnchanged: boolean | null = null;
      if (job.status === "queued_preflight") {
        try {
          const snapshot = await snapshotFile(job.sourcePath);
          job = this.store.updateJob(jobId, {
            sourceBytes: snapshot.bytes,
            sourceMtimeMs: snapshot.mtimeMs,
            sourceSha256: snapshot.sha256,
          });
          // No Photoshop or write-capable stage has run. The recorded hash is
          // the cancellation-time proof attached to the report.
          sourceUnchanged = true;
        } catch {
          sourceUnchanged = null;
        }
      } else if (job.sourceSha256) {
        try {
          const current = await snapshotFile(job.sourcePath);
          sourceUnchanged =
            current.bytes === job.sourceBytes &&
            Math.abs(current.mtimeMs - (job.sourceMtimeMs || 0)) <= 1 &&
            current.sha256 === job.sourceSha256;
        } catch {
          sourceUnchanged = false;
        }
      }
      job = this.store.updateJob(jobId, {
        status: "cancelled",
        reasonCode: "CANCELLED_BEFORE_PHOTOSHOP",
        progress: 1,
        progressDetail: "在 Photoshop 启动前已安全取消，源文件未交给 Photoshop",
        finishedAt: nowIso(),
      });
      await this.finishWithCurrentReport(
        job,
        undefined,
        null,
        sourceUnchanged,
      );
    }
    this.changed(job);
    return job;
  }

  async approveJob(jobId: string): Promise<JobRecord> {
    const current = this.store.getJob(jobId);
    if (!current) throw new Error(`Unknown job: ${jobId}`);
    if (current.status !== "awaiting_approval") {
      throw new Error(`Job is not awaiting approval: ${current.status}`);
    }
    const job = this.store.updateJob(jobId, {
      status: "ready",
      reasonCode: "USER_APPROVED",
      progressStage: "preflight_decision",
      progressDetail: "你已批准执行，等待安全检查",
    });
    await this.emit({
      jobId,
      level: "info",
      stage: "control",
      eventType: "JOB_APPROVED",
      message: "The user approved execution after preflight.",
    });
    this.changed(job);
    return job;
  }

  async keepInspectionResult(jobId: string): Promise<JobRecord> {
    const current = this.store.getJob(jobId);
    if (!current) throw new Error(`Unknown job: ${jobId}`);
    if (current.status !== "awaiting_approval") {
      throw new Error(`Job is not awaiting approval: ${current.status}`);
    }
    let job = this.store.updateJob(jobId, {
      status: "preflight_complete",
      reasonCode: "USER_KEPT_INSPECTION_RESULT",
      progress: 1,
      progressStage: "preflight_decision",
      progressDetail: "已保留检查结果，不启动 Photoshop",
      finishedAt: nowIso(),
    });
    await this.emit({
      jobId,
      level: "info",
      stage: "control",
      eventType: "INSPECTION_RESULT_KEPT",
      message: "The user kept the preflight result without starting Photoshop.",
    });
    const existingReport = current.reportJsonPath
      ? await fs
          .readFile(current.reportJsonPath, "utf8")
          .then((text) => JSON.parse(text) as FileReport)
          .catch(() => null)
      : null;
    if (existingReport) {
      const report: FileReport = {
        ...existingReport,
        status: job.status,
        reasonCode: job.reasonCode,
        finishedAt: job.finishedAt || nowIso(),
        execution: {
          ...(existingReport.execution || {}),
          started: false,
          lastProgressStage: job.progressStage,
          lastProgressDetail: job.progressDetail,
        },
      };
      const written = await writeReport({
        report,
        centralDirectory: this.reportDirectory(job.id),
      });
      job = this.store.updateJob(job.id, {
        reportJsonPath: written.centralJson,
        reportHtmlPath: written.centralHtml,
      });
    } else {
      await this.finishWithCurrentReport(job, undefined, null, true);
      job = this.store.getJob(job.id) || job;
    }
    this.changed(job);
    return job;
  }

  async tick(): Promise<void> {
    const queue = this.store.getQueueState();
    if (queue.paused) {
      if (!queue.finishCurrentJobId) return;
      const current = this.store.getJob(queue.finishCurrentJobId);
      if (
        !current ||
        isTerminal(current.status) ||
        current.status === "awaiting_approval"
      ) {
        this.store.setQueueState(true, queue.criticalReason, null);
        return;
      }
      if (current.status === "queued_preflight" && !this.preflightActive) {
        await this.processPreflight(current);
      } else if (
        ["ready", "waiting_photoshop"].includes(current.status) &&
        !this.executionActive
      ) {
        await this.processExecution(current);
      }
      return;
    }

    if (!this.config.pipelinePreflight) {
      if (this.preflightActive || this.executionActive) return;
      const job = this.store.nextRunnableJob();
      if (!job) return;
      if (job.status === "queued_preflight") {
        await this.processPreflight(job);
      } else {
        await this.processExecution(job);
      }
      return;
    }

    const pending: Promise<void>[] = [];
    if (!this.executionActive) {
      const execution = this.store.nextExecutionJob();
      if (execution) pending.push(this.processExecution(execution));
    }
    if (!this.preflightActive) {
      const preflight = this.store.nextPreflightJob();
      if (preflight) pending.push(this.processPreflight(preflight));
    }
    await Promise.all(pending);
  }

  private async processPreflight(job: JobRecord): Promise<void> {
    if (this.preflightActive) return;
    this.preflightActive = true;
    try {
      if (job.cancelRequested) {
        await this.cancelJob(job.id);
      } else {
        await this.runPreflight(job);
      }
    } finally {
      this.preflightActive = false;
      this.finishCurrentIfNeeded(job.id);
    }
  }

  private async processExecution(job: JobRecord): Promise<void> {
    if (this.executionActive) return;
    if (
      job.status === "waiting_photoshop" &&
      Date.now() - Date.parse(job.updatedAt) < 10_000
    ) {
      return;
    }
    this.executionActive = true;
    try {
      if (job.cancelRequested) await this.cancelJob(job.id);
      else await this.runExecution(job);
    } finally {
      this.executionActive = false;
      this.finishCurrentIfNeeded(job.id);
    }
  }

  private finishCurrentIfNeeded(jobId: string): void {
    const latestQueue = this.store.getQueueState();
    if (latestQueue.finishCurrentJobId !== jobId) return;
    const latest = this.store.getJob(jobId);
    if (
      !latest ||
      isTerminal(latest.status) ||
      latest.status === "awaiting_approval"
    ) {
      this.store.setQueueState(
        true,
        latestQueue.criticalReason,
        null,
      );
    }
  }

  private async environment(): Promise<
    Awaited<ReturnType<typeof diagnosePhotoshop>>
  > {
    if (!this.photoshopDiagnostic) {
      this.photoshopDiagnostic = await diagnosePhotoshop({
        configuredExecutable: this.config.photoshopExecutable,
        verifiedVersions: this.config.verifiedPhotoshopVersions,
      });
    }
    return this.photoshopDiagnostic;
  }

  invalidatePhotoshopDiagnostic(): void {
    this.photoshopDiagnostic = null;
  }

  private async runPreflight(initialJob: JobRecord): Promise<void> {
    const startedAt = nowIso();
    let job = this.store.updateJob(initialJob.id, {
      status: "preflighting",
      reasonCode: null,
      progress: 0.03,
      progressStage: "preflight_snapshot",
      progressCurrent: null,
      progressTotal: null,
      progressDetail: "正在读取源文件大小、修改时间和 SHA-256 指纹",
      preflightStartedAt: startedAt,
      preflightFinishedAt: null,
    });
    this.changed(job);
    await this.emit({
      jobId: job.id,
      level: "info",
      stage: "preflight",
      eventType: "PREFLIGHT_STARTED",
      message: "Read-only PSB preflight started.",
      data: { sourcePath: job.sourcePath, profile: job.profile },
    });
    const reportDirectory = this.reportDirectory(job.id);
    const artifactDirectory = this.artifactDirectory(job.id);
    const preflightPath = path.join(reportDirectory, "preflight.json");
    const cleanupPlanPath = path.join(
      artifactDirectory,
      "source_cleanup_plan.tsv",
    );
    const startedMs = Date.now();
    try {
      if (
        job.experimental &&
        job.runMode === "auto_if_eligible" &&
        !this.config.experimentalPsdUnattended
      ) {
        throw Object.assign(
          new Error("Experimental PSD cannot use automatic execution."),
          { reasonCode: "PSD_REQUIRES_MANUAL_APPROVAL" },
        );
      }
      const sourceBefore = await snapshotFile(job.sourcePath);
      job = this.store.updateJob(job.id, {
        sourceBytes: sourceBefore.bytes,
        sourceMtimeMs: sourceBefore.mtimeMs,
        sourceSha256: sourceBefore.sha256,
        progress: 0.1,
        progressStage: "preflight_scan",
        progressDetail: "正在只读扫描 PSB/PSD 结构、XMP 和智能对象",
      });
      this.changed(job);
      const inspection = await inspectPsb({
        sourcePath: job.sourcePath,
        cleanupPlanPath,
        artifactDirectory,
        isCancelled: () =>
          this.store.getJob(job.id)?.cancelRequested === true,
      });
      await atomicWriteJson(preflightPath, inspection);
      const sourceAfter = await snapshotFile(job.sourcePath);
      if (!snapshotsEqual(sourceBefore, sourceAfter)) {
        await this.criticalPause(
          job,
          "SOURCE_CHANGED_DURING_PREFLIGHT",
          "Source changed during read-only preflight.",
        );
        return;
      }
      const parserWarnings = collectParserWarnings(inspection);
      const decision = evaluateJobPolicy(inspection, job);
      const environment = await this.environment();
      job = this.store.updateJob(job.id, {
        progress: 0.27,
        progressStage: "preflight_decision",
        progressCurrent: Number(inspection.summary.containersInspected || 0),
        progressTotal: Number(inspection.summary.containersInspected || 0),
        progressDetail: "只读扫描完成，正在判断是否符合处理条件",
        photoshopVersion: environment.selected?.productVersion || null,
      });
      this.changed(job);
      let status: JobRecord["status"];
      let reasonCode: string;
      if (parserWarnings.length > 0) {
        status = "blocked";
        reasonCode = "PREFLIGHT_PARSER_WARNINGS";
      } else if (!decision.eligible) {
        status = "skipped";
        reasonCode = decision.reasonCode;
      } else if (job.runMode === "inspect_only") {
        status = "preflight_complete";
        reasonCode = "INSPECT_ONLY_COMPLETE";
      } else if (!environment.selected) {
        status = "blocked";
        reasonCode = "PHOTOSHOP_NOT_FOUND";
      } else if (
        job.runMode === "await_approval" ||
        (job.experimental && !this.config.experimentalPsdUnattended)
      ) {
        status = "awaiting_approval";
        reasonCode = job.experimental
          ? "PSD_REQUIRES_MANUAL_APPROVAL"
          : "WAITING_FOR_USER_APPROVAL";
      } else {
        status = "ready";
        reasonCode = "PREFLIGHT_ELIGIBLE";
      }

      job = this.store.updateJob(job.id, {
        status,
        reasonCode,
        progress: status === "ready" ? 0.3 : 1,
        progressStage: "preflight_decision",
        progressDetail:
          status === "ready"
            ? environment.selected?.verified
              ? "预检通过，等待执行安全检查"
              : `预检通过；Photoshop ${environment.selected?.productVersion || "未知版本"} 尚未完成实机验证，本次结果会保留版本提示`
            : status === "awaiting_approval"
              ? "预检完成，等待你确认是否执行"
              : "预检已经结束",
        finishedAt: isTerminal(status) ? nowIso() : null,
        preflightFinishedAt: nowIso(),
        preflightJsonPath: preflightPath,
        cleanupPlanPath,
      });
      await this.emit({
        jobId: job.id,
        level: parserWarnings.length ? "error" : "info",
        stage: "preflight",
        eventType: "PREFLIGHT_COMPLETED",
        message: decision.explanation,
        data: {
          status,
          reasonCode,
          estimate: decision.estimate,
          parserWarnings,
          photoshop: environment.selected,
        },
      });
      await this.writePreflightReport({
        job,
        startedAt,
        source: sourceBefore,
        inspection,
        decision,
        parserWarnings,
        photoshop: environment.selected,
        durationMs: Date.now() - startedMs,
      });
      this.changed(job);
    } catch (error) {
      const message = (error as Error).message;
      let sourceUnchanged: boolean | null = null;
      const currentJob = this.store.getJob(job.id);
      if (currentJob?.sourceSha256) {
        try {
          const current = await snapshotFile(job.sourcePath);
          sourceUnchanged =
            current.bytes === currentJob.sourceBytes &&
            Math.abs(current.mtimeMs - (currentJob.sourceMtimeMs || 0)) <= 1 &&
            current.sha256 === currentJob.sourceSha256;
        } catch {
          sourceUnchanged = false;
        }
      }
      if (sourceUnchanged === false) {
        await this.criticalPause(
          job,
          "SOURCE_CHANGED_DURING_PREFLIGHT_FAILURE",
          "Source changed while preflight was terminating.",
        );
        return;
      }
      if (
        message === "__JOB_CANCELLED__" ||
        this.store.getJob(job.id)?.cancelRequested
      ) {
        job = this.store.updateJob(job.id, {
          status: "cancelled",
          reasonCode: "CANCELLED_DURING_PREFLIGHT",
          progress: 1,
          progressDetail: "在只读预检阶段收到取消请求",
          preflightFinishedAt: nowIso(),
          finishedAt: nowIso(),
        });
      } else {
        const reasonCode =
          String(
            (error as Error & { reasonCode?: string }).reasonCode || "",
          ) || "PREFLIGHT_FAILED";
        job = this.store.updateJob(job.id, {
          status: "blocked",
          reasonCode,
          progress: 1,
          progressDetail: "只读预检未能完成，请查看报告中的阻止原因",
          preflightFinishedAt: nowIso(),
          finishedAt: nowIso(),
        });
      }
      await this.emit({
        jobId: job.id,
        level: job.status === "cancelled" ? "warning" : "error",
        stage: "preflight",
        eventType: "PREFLIGHT_TERMINATED",
        message,
      });
      await this.finishWithCurrentReport(
        job,
        message,
        null,
        sourceUnchanged,
      );
      this.changed(job);
    }
  }

  private async runExecution(initialJob: JobRecord): Promise<void> {
    let job = initialJob;
    const reportDirectory = this.reportDirectory(job.id);
    const artifactDirectory = this.artifactDirectory(job.id);
    let preflight: Record<string, any>;
    let decision: ReturnType<typeof evaluatePolicy>;
    let output: Awaited<ReturnType<typeof buildOutputPath>>;
    try {
      preflight = JSON.parse(
        await fs.readFile(job.preflightJsonPath!, "utf8"),
      );
      decision = evaluateJobPolicy(preflight as any, job);
      output =
        job.executionMode === "in_place"
          ? {
              outputPath: job.sourcePath,
              outputDir: path.dirname(job.sourcePath),
            }
          : await buildOutputPath({
              sourcePath: job.sourcePath,
              jobId: job.id,
              outputMode: job.outputMode,
              outputDir: job.outputDir,
              config: this.config,
              allowOutsideAllowedRoots: job.explicitOutputSelection,
            });
    } catch (error) {
      job = this.store.updateJob(job.id, {
        status: "blocked",
        reasonCode: "EXECUTION_CONFIGURATION_BLOCKED",
        progress: 1,
        progressStage: "safety_checks",
        progressDetail: "保存位置或执行配置没有通过安全检查",
        finishedAt: nowIso(),
      });
      await this.emit({
        jobId: job.id,
        level: "error",
        stage: "safety",
        eventType: "EXECUTION_CONFIGURATION_BLOCKED",
        message: (error as Error).message,
      });
      await this.finishWithCurrentReport(job, (error as Error).message);
      this.changed(job);
      return;
    }

    job = this.updateProgress(job.id, {
      progress: 0.31,
      progressStage: "safety_checks",
      progressCurrent: null,
      progressTotal: null,
      progressDetail: "正在确认源文件、磁盘空间和 Photoshop 状态",
    });
    const environment = await this.environment();
    if (!environment.selected) {
      job = this.store.updateJob(job.id, {
        status: "blocked",
        reasonCode: "PHOTOSHOP_NOT_FOUND",
        progress: 1,
        progressStage: "photoshop_bridge",
        progressDetail: "没有找到可供任务使用的 Photoshop",
        finishedAt: nowIso(),
      });
      await this.finishWithCurrentReport(job, "No Photoshop installation was selected.");
      this.changed(job);
      return;
    }
    const preferredProgId =
      this.config.photoshopProgId || environment.selected.progId;
    if (preferredProgId) {
      const initialIdle = await probePhotoshopIdle(
        job.sourcePath,
        preferredProgId,
      );
      if (initialIdle.state === "source_open") {
        job = this.store.updateJob(job.id, {
          status: "blocked",
          reasonCode: "SOURCE_OPEN_IN_PHOTOSHOP",
          progress: 1,
          progressStage: "photoshop_bridge",
          progressDetail: "源文件正在所选 Photoshop 中打开，未进行自动化握手",
          finishedAt: nowIso(),
        });
        await this.finishWithCurrentReport(
          job,
          initialIdle.detail,
          null,
          true,
        );
        this.changed(job);
        return;
      }
      if (initialIdle.state === "busy" || initialIdle.state === "unknown") {
        job = this.store.updateJob(job.id, {
          status: "waiting_photoshop",
          reasonCode:
            initialIdle.state === "busy"
              ? "PHOTOSHOP_BUSY"
              : "PHOTOSHOP_STATE_UNKNOWN",
          progressStage: "waiting_photoshop",
          progressDetail:
            initialIdle.state === "busy"
              ? "所选 Photoshop 正忙，空闲后才会测试连接和执行任务"
              : "暂时无法确认所选 Photoshop 是否空闲，稍后会重试",
        });
        await this.emit({
          jobId: job.id,
          level: initialIdle.state === "busy" ? "info" : "warning",
          stage: "photoshop",
          eventType: "PHOTOSHOP_WAIT_BEFORE_BRIDGE",
          message: initialIdle.detail,
        });
        this.changed(job);
        return;
      }
    }
    job = this.updateProgress(job.id, {
      progress: 0.315,
      progressStage: "photoshop_bridge",
      progressDetail: `正在验证任务专用 Photoshop ${environment.selected.productVersion || "未知版本"}`,
    });
    const bridgeResolution = await resolvePhotoshopBridge(
      environment.selected,
      this.config.photoshopProgId,
    );
    const bridgeProbe = bridgeResolution.selected!;
    await this.emit({
      jobId: job.id,
      level: bridgeProbe.ok ? "info" : "error",
      stage: "photoshop_bridge",
      eventType: bridgeProbe.ok
        ? "PHOTOSHOP_BRIDGE_VERIFIED"
        : "PHOTOSHOP_BRIDGE_BLOCKED",
      message: bridgeProbe.ok
        ? "The selected Photoshop COM/JSX bridge was verified before creating a work copy."
        : bridgeProbe.errorDescription || bridgeProbe.reasonCode,
      data: {
        ...bridgeProbe,
        mode: bridgeResolution.mode,
        attempts: bridgeResolution.attempts,
      },
    });
    if (!bridgeProbe.ok) {
      job = this.store.updateJob(job.id, {
        status: "blocked",
        reasonCode: bridgeProbe.reasonCode,
        progress: 1,
        progressStage: "photoshop_bridge",
        progressDetail:
          "任务专用 Photoshop 的自动化连接没有通过检查；尚未制作工作副本",
        finishedAt: nowIso(),
      });
      await this.finishWithCurrentReport(
        job,
        bridgeProbe.errorDescription || bridgeProbe.reasonCode,
        null,
        true,
      );
      this.changed(job);
      return;
    }
    const idle = await probePhotoshopIdle(
      job.sourcePath,
      bridgeProbe.progId!,
    );
    if (idle.state === "source_open") {
      job = this.store.updateJob(job.id, {
        status: "blocked",
        reasonCode: "SOURCE_OPEN_IN_PHOTOSHOP",
        progress: 1,
        progressDetail: "源文件正在 Photoshop 中打开，已在执行前停止",
        finishedAt: nowIso(),
      });
      await this.emit({
        jobId: job.id,
        level: "error",
        stage: "photoshop",
        eventType: "SOURCE_OPEN_BLOCKED",
        message:
          "The source file is open in Photoshop. Execution was blocked before a work copy was opened.",
      });
      await this.finishWithCurrentReport(job, idle.detail, null, true);
      this.changed(job);
      return;
    }
    if (idle.state === "busy" || idle.state === "unknown") {
      job = this.store.updateJob(job.id, {
        status: "waiting_photoshop",
        reasonCode: idle.state === "busy" ? "PHOTOSHOP_BUSY" : "PHOTOSHOP_STATE_UNKNOWN",
        progressStage: "waiting_photoshop",
        progressDetail:
          idle.state === "busy"
            ? "Photoshop 正忙，PSMetaC 会等待空闲后再继续"
            : "暂时无法确认 Photoshop 是否空闲，稍后会重试",
      });
      await this.emit({
        jobId: job.id,
        level: idle.state === "busy" ? "info" : "warning",
        stage: "photoshop",
        eventType: "PHOTOSHOP_WAIT",
        message: idle.detail,
      });
      this.changed(job);
      return;
    }

    const sourceBefore = await snapshotFile(job.sourcePath);
    const baseline: FileSnapshot = {
      path: job.sourcePath,
      bytes: job.sourceBytes!,
      mtimeMs: job.sourceMtimeMs!,
      mtimeIso: new Date(job.sourceMtimeMs!).toISOString(),
      sha256: job.sourceSha256!,
    };
    if (!snapshotsEqual(sourceBefore, baseline)) {
      job = this.store.updateJob(job.id, {
        status: "queued_preflight",
        reasonCode: "PREFLIGHT_PLAN_INVALIDATED",
        progress: 0,
        progressStage: "queued",
        progressCurrent: null,
        progressTotal: null,
        progressDetail: "源文件在预检后发生变化，旧计划已作废，将重新检查",
        sourceBytes: null,
        sourceMtimeMs: null,
        sourceSha256: null,
        preflightStartedAt: null,
        preflightFinishedAt: null,
        executionStartedAt: null,
        validationStartedAt: null,
        preflightJsonPath: null,
        cleanupPlanPath: null,
      });
      await this.emit({
        jobId: job.id,
        level: "warning",
        stage: "preflight",
        eventType: "PREFLIGHT_PLAN_INVALIDATED",
        message:
          "源文件在预检后发生变化；旧计划已废弃，任务返回只读预检。",
      });
      this.changed(job);
      return;
    }

    const [dataFree, outputFree] = await Promise.all([
      availableBytes(this.config.dataRoot),
      availableBytes(output.outputDir),
    ]);
    const storagePlan = planExecutionStorage({
      executionMode: job.executionMode,
      backupSource: job.backupSource,
      sourceBytes: sourceBefore.bytes,
      minimumSpaceMultiplier: this.config.minimumSpaceMultiplier,
      minimumSpaceReserveBytes: this.config.minimumSpaceReserveBytes,
      dataRoot: this.config.dataRoot,
      dataFree,
      outputRoot: output.outputDir,
      outputFree,
    });
    const workDirectory =
      job.executionMode === "safe_copy"
        ? path.join(storagePlan.workRoot, ".psmetac-work", job.id)
        : this.workDirectory(job.id);
    const insufficientSpace = !storagePlan.eligible;
    const diskSpaceAssessment = {
      checkedAt: nowIso(),
      executionMode: job.executionMode,
      backupSource: job.backupSource,
      sourceBytes: sourceBefore.bytes,
      dataRoot: this.config.dataRoot,
      dataFree,
      workDirectory,
      ...storagePlan,
      minimumSpaceMultiplier: this.config.minimumSpaceMultiplier,
      minimumSpaceReserveBytes: this.config.minimumSpaceReserveBytes,
    };
    await fs.mkdir(artifactDirectory, { recursive: true });
    await atomicWriteJson(
      path.join(artifactDirectory, "disk-space.json"),
      diskSpaceAssessment,
    );
    if (insufficientSpace) {
      job = this.store.updateJob(job.id, {
        status: "blocked",
        reasonCode: "INSUFFICIENT_DISK_SPACE",
        progress: 1,
        progressStage: "safety_checks",
        progressDetail: "可用磁盘空间不足，尚未复制或修改文件",
        finishedAt: nowIso(),
      });
      await this.emit({
        jobId: job.id,
        level: "error",
        stage: "safety",
        eventType: "DISK_SPACE_BLOCKED",
        message: "Disk-space safety gate blocked execution.",
        data: {
          ...diskSpaceAssessment,
        },
      });
      await this.finishWithCurrentReport(job);
      this.changed(job);
      return;
    }

    const workingSource = path.join(
      workDirectory,
      `working-source${path.extname(job.sourcePath).toLowerCase()}`,
    );
    const backupDirectory = path.join(this.config.dataRoot, "backups", job.id);
    const backupPath = path.join(
      backupDirectory,
      `${path.parse(job.sourcePath).name}.before-psmetac-${job.id.slice(0, 8)}${path.extname(job.sourcePath).toLowerCase()}`,
    );
    const executionPlan = path.join(artifactDirectory, "cleanup_plan.tsv");
    const stagingOutput =
      job.executionMode === "in_place"
        ? job.sourcePath
        : path.join(
            workDirectory,
            `cleaned-output${path.extname(job.sourcePath).toLowerCase()}`,
          );
    const executionStartedAt = nowIso();
    const executionStartedMs = Date.now();
    const timing: Record<string, number> = {};
    job = this.store.updateJob(job.id, {
      executionStartedAt,
    });
    try {
      await fs.mkdir(workDirectory, { recursive: true });
      await fs.mkdir(artifactDirectory, { recursive: true });
      let executionSource = job.sourcePath;
      if (job.executionMode === "safe_copy") {
        job = this.store.updateJob(job.id, {
          status: "copying",
          reasonCode: "CREATING_VERIFIED_WORK_COPY",
          progress: 0.33,
          progressStage: "work_copy",
          progressCurrent: 0,
          progressTotal: sourceBefore.bytes,
          progressDetail: "正在制作隔离工作副本；Photoshop 不会打开源文件",
        });
        this.changed(job);
        await this.emit({
          jobId: job.id,
          level: "info",
          stage: "copy",
          eventType: "WORK_COPY_STARTED",
          message:
            "Creating an isolated work copy; Photoshop will not open the source.",
        });
        const copyStartedMs = Date.now();
        let lastCopyProgressAt = 0;
        await copyFileVerified({
          source: job.sourcePath,
          destination: workingSource,
          expectedSha256: job.sourceSha256,
          isCancelled: () =>
            this.store.getJob(job.id)?.cancelRequested === true,
          onProgress: (copied, total) => {
            const now = Date.now();
            if (now - lastCopyProgressAt < 250 && copied < total) return;
            lastCopyProgressAt = now;
            const progress = 0.33 + (copied / total) * 0.11;
            this.updateProgress(job.id, {
              progress,
              progressStage: "work_copy",
              progressCurrent: copied,
              progressTotal: total,
              progressDetail: `正在复制工作副本：${Math.round((copied / total) * 100)}%`,
            });
          },
        });
        timing.copyMs = Date.now() - copyStartedMs;
        executionSource = workingSource;
        await this.emit({
          jobId: job.id,
          level: "info",
          stage: "copy",
          eventType: "WORK_COPY_VERIFIED",
          message: "The work-copy SHA-256 matches the source.",
        });
      } else if (job.backupSource) {
        job = this.store.updateJob(job.id, {
          status: "copying",
          reasonCode: "CREATING_VERIFIED_SOURCE_BACKUP",
          progress: 0.33,
          progressStage: "backup",
          progressCurrent: 0,
          progressTotal: sourceBefore.bytes,
          progressDetail: "正在制作并校验源文件恢复备份",
          backupPath,
        });
        this.changed(job);
        await this.emit({
          jobId: job.id,
          level: "warning",
          stage: "backup",
          eventType: "SOURCE_BACKUP_STARTED",
          message:
            "Creating and verifying a recovery backup before overwriting the source.",
          data: { backupPath },
        });
        const backupStartedMs = Date.now();
        let lastBackupProgressAt = 0;
        await copyFileVerified({
          source: job.sourcePath,
          destination: backupPath,
          expectedSha256: job.sourceSha256,
          isCancelled: () =>
            this.store.getJob(job.id)?.cancelRequested === true,
          onProgress: (copied, total) => {
            const now = Date.now();
            if (now - lastBackupProgressAt < 250 && copied < total) return;
            lastBackupProgressAt = now;
            const progress = 0.33 + (copied / total) * 0.11;
            this.updateProgress(job.id, {
              progress,
              progressStage: "backup",
              progressCurrent: copied,
              progressTotal: total,
              progressDetail: `正在备份源文件：${Math.round((copied / total) * 100)}%`,
            });
          },
        });
        timing.backupMs = Date.now() - backupStartedMs;
        await this.emit({
          jobId: job.id,
          level: "info",
          stage: "backup",
          eventType: "SOURCE_BACKUP_VERIFIED",
          message: "The recovery backup SHA-256 matches the source.",
          data: { backupPath },
        });
      } else {
        await this.emit({
          jobId: job.id,
          level: "critical",
          stage: "backup",
          eventType: "SOURCE_BACKUP_SKIPPED",
          message:
            "In-place execution will overwrite the source without a recovery backup.",
        });
      }

      job = this.updateProgress(job.id, {
        progress: 0.45,
        progressStage: "work_copy_scan",
        progressCurrent: null,
        progressTotal: null,
        progressDetail: "副本校验完成，正在复核副本结构和清理目标",
      });
      const workPreflightStartedMs = Date.now();
      const executionPreflight = await inspectPsb({
        sourcePath: executionSource,
        cleanupPlanPath: executionPlan,
        artifactDirectory,
        isCancelled: () =>
          this.store.getJob(job.id)?.cancelRequested === true,
      });
      timing.workCopyPreflightMs = Date.now() - workPreflightStartedMs;
      if (
        structureFingerprint(executionPreflight) !==
        structureFingerprint(preflight)
      ) {
        throw new Error("WORK_COPY_STRUCTURE_MISMATCH");
      }
      const sourceImmediatelyBeforePhotoshop = await snapshotFile(
        job.sourcePath,
      );
      if (!snapshotsEqual(sourceBefore, sourceImmediatelyBeforePhotoshop)) {
        job = this.store.updateJob(job.id, {
          status: "queued_preflight",
          reasonCode: "SOURCE_CHANGED_BEFORE_PHOTOSHOP",
          progress: 0,
          progressStage: "queued",
          progressCurrent: null,
          progressTotal: null,
          progressDetail:
            "源文件在准备期间被其他程序修改；旧计划已作废，将重新检查",
          sourceBytes: null,
          sourceMtimeMs: null,
          sourceSha256: null,
          preflightStartedAt: null,
          preflightFinishedAt: null,
          executionStartedAt: null,
          validationStartedAt: null,
          preflightJsonPath: null,
          cleanupPlanPath: null,
        });
        await this.emit({
          jobId: job.id,
          level: "warning",
          stage: "safety",
          eventType: "EXTERNAL_MODIFICATION_DETECTED",
          message:
            "The source changed after preparation and before Photoshop execution; the stale plan was discarded.",
          data: {
            expectedSha256: sourceBefore.sha256,
            observedSha256: sourceImmediatelyBeforePhotoshop.sha256,
          },
        });
        await this.cleanupWork(job);
        this.changed(job);
        return;
      }
      job = this.store.updateJob(job.id, {
        status: "running",
        reasonCode: "PHOTOSHOP_EXECUTING",
        progress: 0.48,
        progressStage: "photoshop_start",
        progressCurrent: 0,
        progressTotal: Number(decision.estimate.plannedObjects || 0),
        progressDetail: "正在连接并启动指定的 Photoshop",
        cleanupPlanPath: executionPlan,
        outputPath:
          job.executionMode === "safe_copy" ? output.outputPath : null,
      });
      this.changed(job);
      await this.emit({
        jobId: job.id,
        level: "info",
        stage: "photoshop",
        eventType: "PHOTOSHOP_STARTED",
        message:
          job.executionMode === "in_place"
            ? "Photoshop cleanup started directly on the source file."
            : "Photoshop cleanup started on the verified work copy.",
        data: {
          executionMode: job.executionMode,
          executionSource,
          stagingOutput,
          backupPath: job.backupPath,
        },
      });

      const photoshopStartedMs = Date.now();
      const plannedObjects = Number(decision.estimate.plannedObjects || 0);
      let lastPhotoshopProgress = "";
      const observePhotoshopProgress = async () => {
        const text = await fs
          .readFile(path.join(artifactDirectory, "photoshop.log"), "utf8")
          .catch(() => "");
        const observed = parsePhotoshopProgress(text, plannedObjects);
        const signature = JSON.stringify(observed);
        if (signature === lastPhotoshopProgress) return;
        lastPhotoshopProgress = signature;
        this.updateProgress(job.id, {
          progress: observed.progress,
          progressStage: observed.stage,
          progressCurrent: observed.current,
          progressTotal: observed.total,
          progressDetail: observed.detail,
        });
      };
      let bridge = await runPhotoshopCleanup({
        workingSource: executionSource,
        stagingOutput,
        artifactDirectory,
        progId: bridgeProbe.progId!,
        executionMode: job.executionMode,
        coveragePolicy: job.coveragePolicy,
        coverageThresholdPercent: job.coverageThresholdPercent,
        reopenRequired: job.requiredValidationChecks.some((check) =>
          ["reopen_success", "render_consistency"].includes(
            check,
          ),
        ),
        deleteHiddenLayers: job.deleteHiddenLayers,
        deleteEmptyLayers: job.deleteEmptyLayers,
        onPoll: observePhotoshopProgress,
      });
      await observePhotoshopProgress();
      let logText = await fs
        .readFile(path.join(artifactDirectory, "photoshop.log"), "utf8")
        .catch(() => "");
      if (
        bridge.code !== 0 &&
        !logText.includes("\tSOURCE_OPEN\t") &&
        job.attempt < 1 &&
        !this.store.getJob(job.id)?.cancelRequested
      ) {
        job = this.store.updateJob(job.id, { attempt: job.attempt + 1 });
        await this.emit({
          jobId: job.id,
          level: "warning",
          stage: "photoshop",
          eventType: "BRIDGE_RETRY",
          message: "The pre-open bridge failed; retrying once.",
          data: { code: bridge.code, stderr: bridge.stderr },
        });
        await delay(2_000);
        bridge = await runPhotoshopCleanup({
          workingSource: executionSource,
          stagingOutput,
          artifactDirectory,
          progId: bridgeProbe.progId!,
          executionMode: job.executionMode,
          coveragePolicy: job.coveragePolicy,
          coverageThresholdPercent: job.coverageThresholdPercent,
          reopenRequired: job.requiredValidationChecks.some((check) =>
            ["reopen_success", "render_consistency"].includes(
              check,
            ),
          ),
          deleteHiddenLayers: job.deleteHiddenLayers,
          deleteEmptyLayers: job.deleteEmptyLayers,
          onPoll: observePhotoshopProgress,
        });
        await observePhotoshopProgress();
        logText = await fs
          .readFile(path.join(artifactDirectory, "photoshop.log"), "utf8")
          .catch(() => "");
      }
      timing.photoshopMs = Date.now() - photoshopStartedMs;
      const runtimePhotoshop = parsePhotoshopRuntimeEnvironment(logText);
      if (runtimePhotoshop.productVersion) {
        job = this.store.updateJob(job.id, {
          photoshopVersion: runtimePhotoshop.productVersion,
        });
        const formallyAdapted = photoshopVersionMatches(
          runtimePhotoshop.productVersion,
          this.config.verifiedPhotoshopVersions,
        );
        await this.emit({
          jobId: job.id,
          level: formallyAdapted ? "info" : "warning",
          stage: "photoshop",
          eventType: "PHOTOSHOP_RUNTIME_IDENTIFIED",
          message: formallyAdapted
            ? `Photoshop ${runtimePhotoshop.productVersion} is formally supported.`
            : `Photoshop ${runtimePhotoshop.productVersion} has not completed PSMetaC validation; execution remains allowed.`,
          data: {
            ...runtimePhotoshop,
            formallyAdapted,
          },
        });
      }
      const photoshopTerminal = parsePhotoshopTerminalStatus(logText);
      const layerCleanup = parseLayerCleanup(logText);
      if (contentCleanupRequested(job)) {
        await this.emit({
          jobId: job.id,
          level: layerCleanup.deletedCount > 0 ? "warning" : "info",
          stage: "photoshop",
          eventType: "CONTENT_LAYER_CLEANUP_COMPLETED",
          message:
            layerCleanup.deletedCount > 0
              ? `已从安全副本删除 ${layerCleanup.deletedCount} 个图层项，结果必须人工复核。`
              : "已检查所选图层整理规则，没有删除任何图层。",
          data: layerCleanup,
        });
      }

      if (
        job.executionMode === "in_place" &&
        photoshopTerminal.status === "cancelled_saved"
      ) {
        const sourceAfter = await snapshotFile(job.sourcePath);
        job = this.store.updateJob(job.id, {
          status: "cancelled",
          reasonCode: "CANCELLED_AFTER_PARTIAL_IN_PLACE_SAVE",
          progress: 1,
          progressStage: "photoshop_save",
          progressDetail:
            "已停止后续对象；此前完成的清理已安全保存到原件，未处理项已写入报告",
          outputPath: job.sourcePath,
          finishedAt: nowIso(),
        });
        const report = await this.buildInPlaceExecutionReport({
          job,
          startedAt: executionStartedAt,
          sourceBefore,
          sourceAfter,
          preflight,
          decision,
          backupPath: job.backupPath,
          smartObjectFailures: parseSmartFailures(logText),
          timing: {
            ...timing,
            totalExecutionMs: Date.now() - executionStartedMs,
          },
        });
        const written = await writeReport({
          report,
          centralDirectory: reportDirectory,
          sidecarBasePath: null,
        });
        job = this.store.updateJob(job.id, {
          reportJsonPath: written.centralJson,
          reportHtmlPath: written.centralHtml,
        });
        await this.emit({
          jobId: job.id,
          level: "warning",
          stage: "control",
          eventType: "IN_PLACE_PARTIAL_SAVE_AFTER_CANCEL",
          message:
            "Cancellation stopped new work and preserved all cleanup completed before the safe checkpoint.",
        });
        await this.cleanupWork(job);
        this.changed(job);
        return;
      }

      if (
        photoshopTerminal.status === "cancelled" ||
        (this.store.getJob(job.id)?.cancelRequested &&
          !(
            job.executionMode === "in_place" &&
            ["done", "partial"].includes(photoshopTerminal.status)
          ))
      ) {
        if (job.executionMode === "safe_copy") {
          await fs.rm(stagingOutput, { force: true }).catch(() => {});
        }
        const sourceAfter = await snapshotFile(job.sourcePath);
        if (!snapshotsEqual(sourceBefore, sourceAfter)) {
          await this.criticalPause(
            job,
            "SOURCE_CHANGED_DURING_CANCEL",
            "Source changed while a cancellation was being completed.",
          );
          return;
        }
        job = this.store.updateJob(job.id, {
          status: "cancelled",
          reasonCode: "CANCELLED_AT_SAFE_CHECKPOINT",
          progress: 1,
          progressDetail: "Photoshop 已完成当前安全收尾，任务按你的要求停止",
          finishedAt: nowIso(),
        });
        await this.finishWithCurrentReport(job, undefined, null, true);
        return;
      }
      if (photoshopTerminal.status === "error") {
        throw new Error(
          `PHOTOSHOP_SAVE_OR_EXECUTION_ERROR: ${photoshopTerminal.detail}`,
        );
      }
      if (bridge.code !== 0) {
        throw new Error(
          `PHOTOSHOP_BRIDGE_FAILED (${bridge.code}): ${bridge.stderr || bridge.stdout}`,
        );
      }
      if (
        photoshopTerminal.status !== "done" &&
        photoshopTerminal.status !== "partial"
      ) {
        throw new Error("PHOTOSHOP_TERMINAL_STATUS_MISSING");
      }
      if (job.executionMode === "in_place") {
        const sourceAfter = await snapshotFile(job.sourcePath);
        if (this.store.getJob(job.id)?.cancelRequested) {
          await this.emit({
            jobId: job.id,
            level: "warning",
            stage: "control",
            eventType: "CANCEL_REQUESTED_DURING_IN_PLACE_SAVE",
            message:
              "Cancellation arrived after the irreversible source save started; the completed save was kept.",
          });
        }
        job = this.store.updateJob(job.id, {
          status:
            photoshopTerminal.status === "partial" ? "partial" : "succeeded",
          reasonCode:
            photoshopTerminal.status === "partial"
              ? "IN_PLACE_PARTIAL_SAVED_UNVALIDATED"
              : "IN_PLACE_SAVED_UNVALIDATED",
          progress: 1,
          progressStage: "photoshop_save",
          progressDetail:
            photoshopTerminal.status === "partial"
              ? "源文件已保存，但部分计划对象未完成；完成项不会因个别失败而丢失"
              : "源文件已直接保存；按直存模式设置未执行保存后校对",
          outputPath: job.sourcePath,
          finishedAt: nowIso(),
        });
        if (job.watcherId) {
          this.store.upsertWatcherFile({
            watcherId: job.watcherId,
            sourcePath: job.sourcePath,
            sizeBytes: sourceAfter.bytes,
            mtimeMs: sourceAfter.mtimeMs,
            unchangedSince: Date.now(),
            lastSubmittedSignature: watcherFileSignature(
              job.watcherId,
              job.sourcePath,
              sourceAfter.bytes,
              sourceAfter.mtimeMs,
            ),
            lastJobId: job.id,
            state: "submitted",
          });
        }
        const report = await this.buildInPlaceExecutionReport({
          job,
          startedAt: executionStartedAt,
          sourceBefore,
          sourceAfter,
          preflight,
          decision,
          backupPath: job.backupPath,
          smartObjectFailures: parseSmartFailures(logText),
          timing: {
            ...timing,
            totalExecutionMs: Date.now() - executionStartedMs,
          },
        });
        const written = await writeReport({
          report,
          centralDirectory: reportDirectory,
          sidecarBasePath: null,
        });
        job = this.store.updateJob(job.id, {
          reportJsonPath: written.centralJson,
          reportHtmlPath: written.centralHtml,
        });
        await this.emit({
          jobId: job.id,
          level: "warning",
          stage: "complete",
          eventType: "SOURCE_OVERWRITTEN_UNVALIDATED",
          message:
            "The source was overwritten by explicit in-place mode; post-save validation was skipped.",
          data: {
            backupPath: job.backupPath,
            backupCreated: Boolean(job.backupPath),
          },
        });
        await this.cleanupWork(job);
        this.changed(job);
        return;
      }
      try {
        await fs.access(stagingOutput);
      } catch {
        throw new Error("PHOTOSHOP_OUTPUT_MISSING");
      }
      const expectedOutputFormat =
        expectedPhotoshopDocumentFormat(stagingOutput);
      const actualOutputFormat =
        await readPhotoshopDocumentFormat(stagingOutput);
      if (actualOutputFormat !== expectedOutputFormat) {
        throw new Error(
          `PHOTOSHOP_OUTPUT_FORMAT_MISMATCH:expected=${expectedOutputFormat};actual=${actualOutputFormat}`,
        );
      }
      await this.emit({
        jobId: job.id,
        level: "info",
        stage: "photoshop",
        eventType: "OUTPUT_FILE_CONFIRMED",
        message: "The Photoshop output path and document format were confirmed.",
        data: {
          path: stagingOutput,
          format: actualOutputFormat,
        },
      });

      job = this.store.updateJob(job.id, {
        status: "validating",
        reasonCode: "STRICT_VALIDATION_RUNNING",
        progress: 0.8,
        progressStage: "validation_scan",
        progressCurrent: null,
        progressTotal: null,
        progressDetail: "正在重新扫描成品结构和剩余 XMP",
        validationStartedAt: nowIso(),
      });
      this.changed(job);
      const validationStartedMs = Date.now();
      const postflight = await inspectPsb({
        sourcePath: stagingOutput,
        cleanupPlanPath: path.join(artifactDirectory, "postflight_plan.tsv"),
        artifactDirectory,
        isCancelled: () => false,
      });
      await atomicWriteJson(
        path.join(reportDirectory, "postflight.json"),
        postflight,
      );
      job = this.updateProgress(job.id, {
        progress: 0.87,
        progressStage: "source_integrity",
        progressDetail: "成品结构扫描完成，正在确认源文件指纹没有变化",
      });
      const sourceAfter = await snapshotFile(job.sourcePath);
      const sourceUnchanged = snapshotsEqual(sourceBefore, sourceAfter);
      if (!sourceUnchanged) {
        await this.criticalPause(
          job,
          "SOURCE_CHANGED_DURING_EXECUTION",
          "The source digital fingerprint changed during execution.",
        );
        return;
      }
      job = this.updateProgress(job.id, {
        progress: 0.9,
        progressStage: "validation_compare",
        progressDetail: "正在比较结构、目标 XMP、智能对象结果和像素",
      });
      const validation = await validateCleanup({
        preflight: preflight as any,
        postflight,
        artifactDirectory,
        sourceUnchanged,
        requiredValidationChecks:
          job.requiredValidationChecks,
      });
      if (layerCleanup.deletedCount > 0) {
        const reviewReason = "CONTENT_LAYER_CHANGES_REQUIRE_REVIEW";
        if (!validation.warnings.includes(reviewReason)) {
          validation.warnings.push(reviewReason);
        }
        if (!validation.blockingErrors.includes(reviewReason)) {
          validation.blockingErrors.push(reviewReason);
        }
        validation.passed = false;
      }
      if (
        photoshopTerminal.status === "partial" &&
        job.coveragePolicy === "strict"
      ) {
        const coverageError = "CLEANUP_PLAN_COVERAGE_INCOMPLETE";
        if (!validation.errors.includes(coverageError)) {
          validation.errors.push(coverageError);
        }
        if (!validation.blockingErrors.includes(coverageError)) {
          validation.blockingErrors.push(coverageError);
        }
        validation.passed = false;
      }
      job = this.updateProgress(job.id, {
        progress: 0.93,
        progressStage: "validation_compare",
        progressDetail: "结构、XMP 和像素比较已经完成，正在决定发布或隔离",
      });
      timing.postflightAndValidationMs = Date.now() - validationStartedMs;
      const stagingStat = await fs.stat(stagingOutput);
      const xmpRemovedBytes =
        Number(preflight.summary.allXmpBytes) -
        Number(postflight.summary.allXmpBytes);
      if (this.store.getJob(job.id)?.cancelRequested) {
        await fs.rm(stagingOutput, { force: true });
        job = this.store.updateJob(job.id, {
          status: "cancelled",
          reasonCode: "CANCELLED_BEFORE_PUBLISH",
          progress: 1,
          progressStage: "publish",
          progressDetail: "校对已完成，但在发布前按你的要求取消",
          finishedAt: nowIso(),
        });
        await this.emit({
          jobId: job.id,
          level: "warning",
          stage: "publish",
          eventType: "PUBLISH_CANCELLED",
          message: "Cancellation was observed before publication; no output was published.",
        });
        await this.finishWithCurrentReport(job, undefined, null, true);
        await this.cleanupWork(job);
        this.changed(job);
        return;
      }
      let finalPath: string;
      if (validation.passed) {
        await moveWithoutOverwrite(stagingOutput, output.outputPath);
        finalPath = output.outputPath;
        job = this.store.updateJob(job.id, {
          status: "succeeded",
          reasonCode: "STRICT_VALIDATION_PASSED",
          progress: 1,
          progressStage: "publish",
          progressDetail: validation.errors.length
            ? "用户选定的验收标准已通过；其他检查警告已写入报告"
            : "全部自动检查通过，成品已发布",
          outputPath: finalPath,
          finishedAt: nowIso(),
        });
      } else {
        finalPath = path.join(
          storagePlan.outputRoot,
          ".psmetac-review",
          job.id,
          path.basename(output.outputPath),
        );
        await moveWithoutOverwrite(stagingOutput, finalPath);
        job = this.store.updateJob(job.id, {
          status: "quarantined",
          reasonCode:
            validation.blockingErrors[0] ||
            "SELECTED_VALIDATION_FAILED",
          progress: 1,
          progressStage: "validation_compare",
          progressDetail: "文件已生成，但未通过全部自动验收，等待你人工查看",
          quarantinePath: finalPath,
          finishedAt: nowIso(),
        });
      }
      const report = await this.buildExecutionReport({
        job,
        startedAt: executionStartedAt,
        sourceBefore,
        sourceAfter,
        preflight,
        decision,
        validation,
        postflight,
        finalPath,
        outputBytes: stagingStat.size,
        xmpRemovedBytes,
        smartObjectFailures: parseSmartFailures(logText),
        timing: {
          ...timing,
          totalExecutionMs: Date.now() - executionStartedMs,
        },
      });
      const written = await writeReport({
        report,
        centralDirectory: reportDirectory,
        sidecarBasePath: finalPath,
      });
      job = this.store.updateJob(job.id, {
        reportJsonPath: written.centralJson,
        reportHtmlPath: written.centralHtml,
      });
      await this.emit({
        jobId: job.id,
        level: job.status === "succeeded" ? "info" : "warning",
        stage: "complete",
        eventType:
          job.status === "succeeded"
            ? "OUTPUT_PUBLISHED"
            : "OUTPUT_QUARANTINED",
        message:
          job.status === "succeeded"
            ? validation.errors.length
              ? "The selected acceptance checks passed; a new copy was published with non-blocking warnings."
              : "All selected acceptance checks passed and a new copy was published."
            : "The output was isolated because strict validation did not pass.",
        data: {
          finalPath,
          validationErrors: validation.errors,
          blockingErrors: validation.blockingErrors,
        },
      });
      await this.cleanupWork(job);
      this.changed(job);
    } catch (error) {
      const message = (error as Error).message;
      const cancelled =
        message === "__JOB_CANCELLED__" ||
        this.store.getJob(job.id)?.cancelRequested === true;
      const sourceAfter = await snapshotFile(job.sourcePath).catch(() => null);
      if (
        sourceAfter &&
        !snapshotsEqual(sourceBefore, sourceAfter)
      ) {
        await this.criticalPause(
          job,
          "SOURCE_CHANGED_DURING_FAILURE",
          "Source changed while a failed task was being handled.",
        );
        return;
      }
      let diagnosticPath: string | null = null;
      let preserveWorkDirectory = false;
      if (cancelled) {
        if (job.executionMode === "safe_copy") {
          await fs.rm(stagingOutput, { force: true }).catch(() => {});
        }
      } else if (job.executionMode === "safe_copy") {
        const candidates = await listTaskOutputCandidates({
          workDirectory,
          expectedOutput: stagingOutput,
        });
        const recoveredPaths: string[] = [];
        const preservedPaths: string[] = [];
        for (let index = 0; index < candidates.length; index += 1) {
          const candidate = candidates[index];
          const candidateExtension = path.extname(candidate).toLowerCase();
          const candidateName =
            index === 0
              ? `${path.parse(output.outputPath).name}.unverified${candidateExtension}`
              : `${path.parse(output.outputPath).name}.unverified-candidate-${index + 1}${candidateExtension}`;
          const recoveryPath = path.join(
            storagePlan.outputRoot,
            ".psmetac-review",
            job.id,
            candidateName,
          );
          try {
            await moveWithoutOverwrite(candidate, recoveryPath);
            recoveredPaths.push(recoveryPath);
          } catch (moveError) {
            preservedPaths.push(candidate);
            await this.emit({
              jobId: job.id,
              level: "warning",
              stage: "quarantine",
              eventType: "UNVERIFIED_OUTPUT_MOVE_FAILED",
              message: (moveError as Error).message,
              data: { candidate },
            });
          }
        }
        preserveWorkDirectory = preservedPaths.length > 0;
        diagnosticPath = recoveredPaths[0] || preservedPaths[0] || null;
        if (recoveredPaths.length > 0) {
          await this.emit({
            jobId: job.id,
            level: "warning",
            stage: "quarantine",
            eventType: "UNVERIFIED_OUTPUTS_RECOVERED",
            message:
              "Photoshop did not finish normally, but task-specific output files were recovered for human inspection.",
            data: { recoveredPaths },
          });
        }
        if (preservedPaths.length > 0) {
          await this.emit({
            jobId: job.id,
            level: "warning",
            stage: "quarantine",
            eventType: "UNVERIFIED_OUTPUTS_PRESERVED_ON_WORK_VOLUME",
            message:
              "The review volume could not accept every recovery file, so remaining task outputs were preserved in the task work directory.",
            data: { preservedPaths, workDirectory },
          });
        }
      }
      job = this.store.updateJob(job.id, {
        status: cancelled
          ? "cancelled"
          : diagnosticPath
            ? "quarantined"
            : "failed",
        reasonCode: cancelled
          ? "CANCELLED_BEFORE_PHOTOSHOP_SAVE"
          : diagnosticPath
            ? preserveWorkDirectory
              ? "UNVERIFIED_OUTPUT_PRESERVED_ON_WORK_VOLUME"
              : "UNVERIFIED_OUTPUT_QUARANTINED"
            : "EXECUTION_FAILED",
        progress: 1,
        progressDetail: cancelled
          ? "已在当前安全检查点停止"
          : diagnosticPath
            ? preserveWorkDirectory
              ? "执行未正常完成；隔离盘无法接收结果，诊断副本已原地保留，等待人工查看"
              : "执行未正常完成，但已保留可供人工查看的诊断副本"
            : `任务在 ${job.progressStage || "执行"} 阶段失败`,
        quarantinePath: diagnosticPath,
        finishedAt: nowIso(),
      });
      await this.emit({
        jobId: job.id,
        level: cancelled ? "warning" : "error",
        stage: "execution",
        eventType: cancelled ? "JOB_CANCELLED" : "JOB_FAILED",
        message,
      });
      await this.finishWithCurrentReport(
        job,
        message,
        diagnosticPath,
        sourceAfter ? snapshotsEqual(sourceBefore, sourceAfter) : null,
      );
      if (!preserveWorkDirectory) {
        await this.cleanupWork(job);
      }
      this.changed(job);
    }
  }

  private async writePreflightReport(input: {
    job: JobRecord;
    startedAt: string;
    source: FileSnapshot;
    inspection: Record<string, any>;
    decision: ReturnType<typeof evaluatePolicy>;
    parserWarnings: string[];
    photoshop: PhotoshopInstallation | null;
    durationMs: number;
  }): Promise<void> {
    const report: FileReport = {
      schemaVersion: 1,
      reportVersion: "1.0",
      appVersion: APP_VERSION,
      jobId: input.job.id,
      machineId: input.job.machineId,
      status: input.job.status,
      reasonCode: input.job.reasonCode,
      startedAt: input.job.createdAt,
      finishedAt: nowIso(),
      source: {
        path: input.job.sourcePath,
        beforeBytes: input.source.bytes,
        beforeMtimeMs: input.source.mtimeMs,
        beforeSha256: input.source.sha256,
        afterBytes: input.source.bytes,
        afterMtimeMs: input.source.mtimeMs,
        afterSha256: input.source.sha256,
        unchanged: true,
      },
      policy: {
        profile: input.job.profile,
        definition: PROFILE_DEFINITIONS[input.job.profile],
        decision: input.decision,
        runMode: input.job.runMode,
        executionMode: input.job.executionMode,
        backupSource: input.job.backupSource,
        requiredValidationChecks:
          input.job.requiredValidationChecks,
        contentCleanup: contentCleanupPolicy(input.job),
        outputMode: input.job.outputMode,
      },
      environment: {
        ...systemInformation(),
        photoshop: photoshopReportDetails(
          input.photoshop,
          { productVersion: null, executableDirectory: null },
          this.config.verifiedPhotoshopVersions,
        ),
      },
      preflight: {
        summary: input.inspection.summary,
        cleanupPlan: input.inspection.cleanupPlan,
        parserWarnings: input.parserWarnings,
      },
      execution: {
        started: false,
        contentCleanup: contentCleanupPolicy(input.job),
        lastProgressStage: input.job.progressStage,
        lastProgressDetail: input.job.progressDetail,
      },
      validation: { errors: [], warnings: input.parserWarnings },
      output: {
        path: null,
        ...sizeChangeFields(input.source.bytes, null),
      },
      timing: {
        ...jobTiming(input.job),
        preflightMs: input.durationMs,
      },
      logs: {
        eventLog: path.join(
          this.config.dataRoot,
          "logs",
          "jobs",
          `${input.job.id}.events.jsonl`,
        ),
      },
    };
    const written = await writeReport({
      report,
      centralDirectory: this.reportDirectory(input.job.id),
    });
    const updated = this.store.updateJob(input.job.id, {
      reportJsonPath: written.centralJson,
      reportHtmlPath: written.centralHtml,
    });
    this.changed(updated);
  }

  private async buildInPlaceExecutionReport(input: {
    job: JobRecord;
    startedAt: string;
    sourceBefore: FileSnapshot;
    sourceAfter: FileSnapshot;
    preflight: Record<string, any>;
    decision: ReturnType<typeof evaluatePolicy>;
    backupPath: string | null;
    smartObjectFailures: string[];
    timing: Record<string, number>;
  }): Promise<FileReport> {
    const photoshopLogText = await fs
      .readFile(
        path.join(this.artifactDirectory(input.job.id), "photoshop.log"),
        "utf8",
      )
      .catch(() => "");
    return {
      schemaVersion: 1,
      reportVersion: "1.0",
      appVersion: APP_VERSION,
      jobId: input.job.id,
      machineId: input.job.machineId,
      status: input.job.status,
      reasonCode: input.job.reasonCode,
      startedAt: input.job.createdAt,
      finishedAt: input.job.finishedAt || nowIso(),
      source: {
        path: input.job.sourcePath,
        beforeBytes: input.sourceBefore.bytes,
        beforeMtimeMs: input.sourceBefore.mtimeMs,
        beforeSha256: input.sourceBefore.sha256,
        afterBytes: input.sourceAfter.bytes,
        afterMtimeMs: input.sourceAfter.mtimeMs,
        afterSha256: input.sourceAfter.sha256,
        unchanged: snapshotsEqual(input.sourceBefore, input.sourceAfter),
        overwrittenByInPlaceMode: true,
      },
      policy: {
        profile: input.job.profile,
        definition: PROFILE_DEFINITIONS[input.job.profile],
        decision: input.decision,
        runMode: input.job.runMode,
        executionMode: input.job.executionMode,
        backupSource: input.job.backupSource,
        requiredValidationChecks:
          input.job.requiredValidationChecks,
        contentCleanup: contentCleanupPolicy(input.job),
        outputMode: input.job.outputMode,
      },
      environment: {
        ...systemInformation(),
        photoshop: photoshopReportDetails(
          (await this.environment()).selected,
          parsePhotoshopRuntimeEnvironment(photoshopLogText),
          this.config.verifiedPhotoshopVersions,
        ),
      },
      preflight: {
        summary: input.preflight.summary,
        cleanupPlan: input.preflight.cleanupPlan,
      },
      execution: {
        attempted: true,
        mode: "in_place",
        contentCleanup: parseLayerCleanup(photoshopLogText),
        diskSpaceAssessment: await this.readDiskSpaceAssessment(input.job.id),
        lastProgressStage: input.job.progressStage,
        lastProgressDetail: input.job.progressDetail,
        sourceOverwritten: true,
        backupRequested: input.job.backupSource,
        backupPath: input.backupPath,
        photoshopLog: path.join(
          this.artifactDirectory(input.job.id),
          "photoshop.log",
        ),
      },
      validation: {
        performed: false,
        passed: null,
        skipReason: "IN_PLACE_MODE_REQUESTED_WITHOUT_POST_SAVE_VALIDATION",
        errors: [],
        warnings: [
          "源文件已直接保存；没有执行重新打开、结构、XMP 或像素验证。",
        ],
      },
      output: {
        path: input.job.sourcePath,
        isSourceFile: true,
        backupPath: input.backupPath,
        bytes: input.sourceAfter.bytes,
        ...sizeChangeFields(
          input.sourceBefore.bytes,
          input.sourceAfter.bytes,
        ),
        xmpBeforeBytes: Number(input.preflight.summary.allXmpBytes),
        xmpAfterBytes: null,
        xmpRemovedBytes: null,
        xmpRemovedVerified: false,
        documentAncestorsAfter: null,
        smartObjectFailureCount: input.smartObjectFailures.length,
        smartObjectFailures: input.smartObjectFailures,
      },
      timing: {
        ...jobTiming(input.job),
        ...input.timing,
      },
      logs: {
        eventLog: path.join(
          this.config.dataRoot,
          "logs",
          "jobs",
          `${input.job.id}.events.jsonl`,
        ),
        photoshopLog: path.join(
          this.artifactDirectory(input.job.id),
          "photoshop.log",
        ),
      },
    };
  }

  private async buildExecutionReport(input: {
    job: JobRecord;
    startedAt: string;
    sourceBefore: FileSnapshot;
    sourceAfter: FileSnapshot;
    preflight: Record<string, any>;
    decision: ReturnType<typeof evaluatePolicy>;
    validation: Awaited<ReturnType<typeof validateCleanup>>;
    postflight: Record<string, any>;
    finalPath: string;
    outputBytes: number;
    xmpRemovedBytes: number;
    smartObjectFailures: string[];
    timing: Record<string, number>;
  }): Promise<FileReport> {
    const photoshopLogText = await fs
      .readFile(
        path.join(this.artifactDirectory(input.job.id), "photoshop.log"),
        "utf8",
      )
      .catch(() => "");
    return {
      schemaVersion: 1,
      reportVersion: "1.0",
      appVersion: APP_VERSION,
      jobId: input.job.id,
      machineId: input.job.machineId,
      status: input.job.status,
      reasonCode: input.job.reasonCode,
      startedAt: input.job.createdAt,
      finishedAt: input.job.finishedAt || nowIso(),
      source: {
        path: input.job.sourcePath,
        beforeBytes: input.sourceBefore.bytes,
        beforeMtimeMs: input.sourceBefore.mtimeMs,
        beforeSha256: input.sourceBefore.sha256,
        afterBytes: input.sourceAfter.bytes,
        afterMtimeMs: input.sourceAfter.mtimeMs,
        afterSha256: input.sourceAfter.sha256,
        unchanged: snapshotsEqual(input.sourceBefore, input.sourceAfter),
      },
      policy: {
        profile: input.job.profile,
        definition: PROFILE_DEFINITIONS[input.job.profile],
        decision: input.decision,
        runMode: input.job.runMode,
        executionMode: input.job.executionMode,
        backupSource: input.job.backupSource,
        requiredValidationChecks:
          input.job.requiredValidationChecks,
        contentCleanup: contentCleanupPolicy(input.job),
        outputMode: input.job.outputMode,
      },
      environment: {
        ...systemInformation(),
        photoshop: photoshopReportDetails(
          (await this.environment()).selected,
          parsePhotoshopRuntimeEnvironment(photoshopLogText),
          this.config.verifiedPhotoshopVersions,
        ),
      },
      preflight: {
        summary: input.preflight.summary,
        cleanupPlan: input.preflight.cleanupPlan,
      },
      execution: {
        attempted: true,
        contentCleanup: parseLayerCleanup(photoshopLogText),
        diskSpaceAssessment: await this.readDiskSpaceAssessment(input.job.id),
        lastProgressStage: input.job.progressStage,
        lastProgressDetail: input.job.progressDetail,
        photoshopLog: path.join(
          this.artifactDirectory(input.job.id),
          "photoshop.log",
        ),
      },
      validation: input.validation,
      output: {
        path: input.finalPath,
        bytes: input.outputBytes,
        ...sizeChangeFields(
          input.sourceBefore.bytes,
          input.outputBytes,
        ),
        xmpBeforeBytes: Number(input.preflight.summary.allXmpBytes),
        xmpAfterBytes: Number(input.postflight.summary.allXmpBytes),
        xmpRemovedBytes: input.xmpRemovedBytes,
        documentAncestorsAfter: Number(
          input.postflight.summary.allDocumentAncestors,
        ),
        smartObjectFailureCount: input.smartObjectFailures.length,
        smartObjectFailures: input.smartObjectFailures,
      },
      timing: {
        ...jobTiming(input.job),
        ...input.timing,
      },
      logs: {
        eventLog: path.join(
          this.config.dataRoot,
          "logs",
          "jobs",
          `${input.job.id}.events.jsonl`,
        ),
        photoshopLog: path.join(
          this.artifactDirectory(input.job.id),
          "photoshop.log",
        ),
      },
    };
  }

  private async finishWithCurrentReport(
    job: JobRecord,
    errorMessage?: string,
    sidecarBasePath?: string | null,
    sourceUnchanged: boolean | null = null,
  ): Promise<void> {
    const sourceAfter = job.sourceSha256
      ? await snapshotFile(job.sourcePath).catch(() => null)
      : null;
    const derivedSourceUnchanged =
      sourceAfter && job.sourceBytes !== null && job.sourceMtimeMs !== null
        ? sourceAfter.bytes === job.sourceBytes &&
          Math.abs(sourceAfter.mtimeMs - job.sourceMtimeMs) <= 1 &&
          sourceAfter.sha256 === job.sourceSha256
        : null;
    const photoshop = await this.environment()
      .then((result) => result.selected)
      .catch(() => null);
    const photoshopLog = path.join(
      this.artifactDirectory(job.id),
      "photoshop.log",
    );
    const logText = await fs.readFile(photoshopLog, "utf8").catch(() => "");
    const smartObjectFailures = parseSmartFailures(logText);
    const photoshopTerminal = parsePhotoshopTerminalStatus(logText);
    const runtimePhotoshop = parsePhotoshopRuntimeEnvironment(logText);
    const savedPreflight = job.preflightJsonPath
      ? await fs
          .readFile(job.preflightJsonPath, "utf8")
          .then((text) => JSON.parse(text))
          .catch(() => null)
      : null;
    const resultBytes = sidecarBasePath
      ? await fs
          .stat(sidecarBasePath)
          .then((stat) => stat.size)
          .catch(() => null)
      : null;
    const report: FileReport = {
      schemaVersion: 1,
      reportVersion: "1.0",
      appVersion: APP_VERSION,
      jobId: job.id,
      machineId: job.machineId,
      status: job.status,
      reasonCode: job.reasonCode,
      startedAt: job.createdAt,
      finishedAt: job.finishedAt || nowIso(),
      source: {
        path: job.sourcePath,
        beforeBytes: job.sourceBytes,
        beforeMtimeMs: job.sourceMtimeMs,
        beforeSha256: job.sourceSha256,
        afterBytes: sourceAfter?.bytes ?? null,
        afterMtimeMs: sourceAfter?.mtimeMs ?? null,
        afterSha256: sourceAfter?.sha256 ?? null,
        unchanged: sourceUnchanged ?? derivedSourceUnchanged,
      },
      policy: {
        profile: job.profile,
        definition: PROFILE_DEFINITIONS[job.profile],
        runMode: job.runMode,
        executionMode: job.executionMode,
        backupSource: job.backupSource,
        requiredValidationChecks:
          job.requiredValidationChecks,
        contentCleanup: contentCleanupPolicy(job),
        outputMode: job.outputMode,
      },
      environment: {
        ...systemInformation(),
        photoshop: photoshopReportDetails(
          photoshop,
          runtimePhotoshop,
          this.config.verifiedPhotoshopVersions,
        ),
      },
      preflight: savedPreflight
        ? {
            summary: savedPreflight.summary,
            cleanupPlan: savedPreflight.cleanupPlan,
            parserWarnings: savedPreflight.warnings || [],
          }
        : {},
      execution: {
        error: errorMessage || null,
        contentCleanup: parseLayerCleanup(logText),
        diskSpaceAssessment: await this.readDiskSpaceAssessment(job.id),
        lastProgressStage: job.progressStage,
        lastProgressDetail: job.progressDetail,
        photoshopError:
          photoshopTerminal.status === "error"
            ? photoshopTerminal.detail
            : null,
        mode: job.executionMode,
        backupRequested: job.backupSource,
        backupPath: job.backupPath,
        photoshopLog: logText ? photoshopLog : null,
      },
      validation: {
        performed: false,
        passed: null,
        skipReason: errorMessage
          ? "EXECUTION_DID_NOT_REACH_VALIDATION"
          : "TASK_ENDED_BEFORE_VALIDATION",
        errors: errorMessage ? [errorMessage] : [],
        warnings: [],
      },
      output: {
        path: sidecarBasePath || null,
        backupPath: job.backupPath,
        bytes: resultBytes,
        ...sizeChangeFields(job.sourceBytes, resultBytes),
        smartObjectFailureCount: smartObjectFailures.length,
        smartObjectFailures,
      },
      timing: jobTiming(job),
      logs: {
        eventLog: path.join(
          this.config.dataRoot,
          "logs",
          "jobs",
          `${job.id}.events.jsonl`,
        ),
        photoshopLog: logText ? photoshopLog : null,
      },
    };
    const written = await writeReport({
      report,
      centralDirectory: this.reportDirectory(job.id),
      sidecarBasePath,
    });
    this.store.updateJob(job.id, {
      reportJsonPath: written.centralJson,
      reportHtmlPath: written.centralHtml,
    });
  }

  private async criticalPause(
    job: JobRecord,
    reasonCode: string,
    message: string,
  ): Promise<void> {
    this.store.setQueueState(true, reasonCode);
    const updated = this.store.updateJob(job.id, {
      status: "critical_paused",
      reasonCode,
      progress: 1,
      progressDetail: `在 ${job.progressStage || "安全检查"} 阶段发现严重问题，整个队列已暂停`,
      finishedAt: nowIso(),
    });
    await this.emit({
      jobId: job.id,
      level: "critical",
      stage: "safety",
      eventType: "QUEUE_CRITICAL_PAUSE",
      message,
      data: { reasonCode },
    });
    await this.finishWithCurrentReport(updated, message);
    this.changed(updated);
  }

  private async cleanupWork(job: JobRecord): Promise<void> {
    if (this.config.retentionPolicy === "manual") return;
    const assessment = await this.readDiskSpaceAssessment(job.id);
    const workDirectory =
      typeof assessment?.workDirectory === "string"
        ? assessment.workDirectory
        : this.workDirectory(job.id);
    const workRoot =
      typeof assessment?.workRoot === "string"
        ? assessment.workRoot
        : this.config.dataRoot;
    await safeRemoveWorkDirectory(
      workDirectory,
      workRoot,
    ).catch(async (error) => {
      await this.emit({
        jobId: job.id,
        level: "warning",
        stage: "retention",
        eventType: "WORK_CLEANUP_FAILED",
        message: (error as Error).message,
      });
    });
    if (path.basename(path.dirname(workDirectory)) === ".psmetac-work") {
      await fs.rmdir(path.dirname(workDirectory)).catch(() => {});
    }
    if (job.status === "quarantined" || job.quarantinePath) {
      await this.emit({
        jobId: job.id,
        level: "info",
        stage: "retention",
        eventType: "REVIEW_PREVIEWS_PRESERVED",
        message:
          "Visual previews were preserved because the output requires human review.",
      });
      return;
    }
    for (const name of [
      "before.png",
      "after_processing.png",
      "after_save.png",
      "after_reopen.png",
    ]) {
      await fs
        .rm(path.join(this.artifactDirectory(job.id), name), { force: true })
        .catch(() => {});
    }
  }
}
