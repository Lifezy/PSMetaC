import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import type {
  AppConfig,
  JobRecord,
  SubmitJobInput,
  WatcherConfig,
} from "./types.ts";
import {
  CLEANUP_PROFILES,
  COVERAGE_POLICIES,
  DEFAULT_VALIDATION_CHECKS,
  EXECUTION_MODES,
  OUTPUT_MODES,
  RUN_MODES,
  VALIDATION_CHECKS,
} from "./types.ts";
import { JobStore } from "./database.ts";
import { JobWorker } from "./worker.ts";
import { WatcherManager } from "./watchers.ts";
import {
  assertInAllowedRoots,
  assertNotDenied,
  canonicalizeForPolicy,
  buildOutputPath,
  validateSourcePath,
} from "./paths.ts";
import { PROFILE_DEFINITIONS } from "./policies.ts";
import { diagnosePhotoshop, systemInformation } from "./environment.ts";
import { ensureDataDirectories } from "./config.ts";
import { saveConfig, validateConfig } from "./config.ts";
import {
  assertManagedReviewDirectory,
  previewRetentionMaintenance,
  recycleManualReviewArtifacts,
  runRetentionMaintenance,
} from "./retention.ts";
import { APP_VERSION } from "./version.ts";
import { resolvePhotoshopBridge } from "./photoshop.ts";
import {
  availableBytes,
  moveWithoutOverwrite,
  safeRemoveWorkDirectory,
} from "./files.ts";
import { writeReport } from "./reports.ts";
import {
  exportDiagnosticBundle,
  type DiagnosticExportResult,
} from "./diagnostic-export.ts";

export interface SubmissionPathAuthorizations {
  explicitlySelectedSources?: string[];
  explicitlySelectedOutputDirectories?: string[];
}

function pathAuthorizationKey(value: string): string {
  const resolved = path.resolve(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export class CleanerService extends EventEmitter {
  readonly config: AppConfig;
  readonly store: JobStore;
  readonly worker: JobWorker;
  readonly watchers: WatcherManager;
  private workerTimer: NodeJS.Timeout | null = null;
  private watcherTimer: NodeJS.Timeout | null = null;
  private retentionTimer: NodeJS.Timeout | null = null;
  private leaseTimer: NodeJS.Timeout | null = null;
  private historyStatisticsCache = new Map<
    string,
    { createdAt: number; value: Record<string, unknown> }
  >();
  private readonly leaseOwnerId: string | null;
  private static readonly LEASE_TTL_MS = 12_000;

  private managedQuarantineDirectories(): Array<{
    jobId: string;
    directory: string;
  }> {
    return this.store
      .listAllJobs()
      .filter((job) => job.status === "quarantined" && job.quarantinePath)
      .map((job) => ({
        jobId: job.id,
        directory: path.dirname(job.quarantinePath!),
      }));
  }

  private constructor(
    config: AppConfig,
    store: JobStore,
    leaseOwnerId: string | null,
  ) {
    super();
    this.config = config;
    this.store = store;
    this.leaseOwnerId = leaseOwnerId;
    this.worker = new JobWorker(config, store);
    this.watchers = new WatcherManager(config, store);
    this.worker.onJobChanged = (job) => this.emit("job-changed", job);
    this.watchers.onStableFile = async (
      watcher,
      sourcePath,
      clientRequestId,
    ) => {
      const [result] = await this.submitJobs([
        {
          sourcePath,
          profile: watcher.profile,
          runMode: watcher.runMode,
          executionMode: watcher.executionMode,
          backupSource: watcher.backupSource,
          coveragePolicy: watcher.coveragePolicy,
          coverageThresholdPercent: watcher.coverageThresholdPercent,
          requiredValidationChecks:
            watcher.requiredValidationChecks,
          outputMode: watcher.outputMode,
          outputDir: watcher.outputDir,
          clientRequestId,
          source: "watcher",
          watcherId: watcher.id,
        },
      ]);
      return { jobId: result.job.id };
    };
  }

  static async open(
    config: AppConfig,
    options: { exclusive?: boolean; recoverInterrupted?: boolean } = {},
  ): Promise<CleanerService> {
    await ensureDataDirectories(config);
    const store = new JobStore(config);
    const exclusive = options.exclusive !== false;
    const leaseOwnerId = exclusive ? crypto.randomUUID() : null;
    if (leaseOwnerId) {
      const lease = store.acquireServiceLease({
        ownerId: leaseOwnerId,
        pid: process.pid,
        ttlMs: CleanerService.LEASE_TTL_MS,
        isProcessAlive(pid) {
          try {
            process.kill(pid, 0);
            return true;
          } catch (error) {
            return (error as NodeJS.ErrnoException).code === "EPERM";
          }
        },
      });
      if (!lease.acquired) {
        store.close();
        const error = new Error(
          `PSMetaC 已在运行（进程 ${lease.holderPid ?? "未知"}）。请返回已经打开的窗口。`,
        );
        error.name = "ServiceAlreadyRunningError";
        throw error;
      }
    }
    const integrity = store.integrityCheck();
    if (integrity !== "ok") {
      store.setQueueState(true, `DATABASE_INTEGRITY_${integrity}`);
    }
    const service = new CleanerService(config, store, leaseOwnerId);
    if (options.recoverInterrupted !== false) {
      await service.recoverInterruptedJobs();
    }
    return service;
  }

  start(): void {
    if (this.leaseOwnerId && !this.leaseTimer) {
      this.leaseTimer = setInterval(() => {
        try {
          if (
            !this.store.renewServiceLease(
              this.leaseOwnerId!,
              CleanerService.LEASE_TTL_MS,
            )
          ) {
            this.store.setQueueState(true, "SERVICE_LEASE_LOST");
            this.emit(
              "service-error",
              new Error("后台执行权已丢失，队列已暂停以保护任务。"),
            );
          }
        } catch (error) {
          this.emit("service-error", error);
        }
      }, 4_000);
      this.leaseTimer.unref?.();
    }
    if (!this.workerTimer) {
      this.workerTimer = setInterval(() => {
        this.worker.tick().catch((error) => this.emit("service-error", error));
      }, 1_000);
      this.workerTimer.unref?.();
    }
    if (!this.watcherTimer) {
      this.watcherTimer = setInterval(() => {
        this.watchers
          .scanOnce()
          .catch((error) => this.emit("service-error", error));
      }, this.config.watcherPollSeconds * 1_000);
      this.watcherTimer.unref?.();
    }
    if (!this.retentionTimer) {
      const maintain = () => {
        runRetentionMaintenance(this.config, {
          lockedJobIds: this.store.listLockedQuarantineJobIds(),
          quarantineDirectories: this.managedQuarantineDirectories(),
          onRecycled: async (candidate) => {
            const event = this.store.addEvent({
              jobId: this.store.getJob(candidate.jobId)
                ? candidate.jobId
                : undefined,
              level: "warning",
              stage: "retention",
              eventType: "QUARANTINE_RECYCLED",
              message: "符合自动清理条件的隔离目录已移入 Windows 回收站。",
              data: candidate,
            });
            await this.store.appendEventFiles(event);
          },
        }).catch((error) => this.emit("service-error", error));
      };
      this.retentionTimer = setInterval(maintain, 6 * 60 * 60 * 1000);
      this.retentionTimer.unref?.();
      maintain();
    }
    void this.worker.tick();
    void this.watchers.scanOnce();
  }

  async close(): Promise<void> {
    if (this.workerTimer) clearInterval(this.workerTimer);
    if (this.watcherTimer) clearInterval(this.watcherTimer);
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.workerTimer = null;
    this.watcherTimer = null;
    this.retentionTimer = null;
    this.leaseTimer = null;
    await this.watchers.stop();
    if (this.leaseOwnerId) {
      this.store.releaseServiceLease(this.leaseOwnerId);
    }
    this.store.close();
  }

  capabilities(): Record<string, unknown> {
    return {
      product: "PaceSpace Metadata Cleaner",
      shortName: "PSMetaC",
      version: APP_VERSION,
      machineId: this.config.machineId,
      formats: {
        psb: "supported",
        psd: this.config.experimentalPsd
          ? this.config.experimentalPsdUnattended
            ? "experimental-unattended-enabled"
            : "experimental-manual-approval"
          : "disabled",
      },
      profiles: Object.keys(PROFILE_DEFINITIONS),
      runModes: ["inspect_only", "auto_if_eligible", "await_approval"],
      executionModes: ["safe_copy", "in_place"],
      outputModes: ["specified_directory", "source_subfolder"],
      validationChecks: VALIDATION_CHECKS,
      contentCleanup: {
        deleteHiddenLayers: true,
        deleteEmptyLayers: true,
        default: false,
        scope: "root_document_only",
        executionMode: "safe_copy",
        submissionSources: ["ui"],
        automaticPublication: false,
      },
      pipelinePreflight: {
        enabled: this.config.pipelinePreflight,
        preflightConcurrency: 1,
        photoshopConcurrency: 1,
      },
      overwriteSource: {
        supported: true,
        default: false,
        validation: "skipped",
        backupOptional: true,
        explicitSelectionRequired: true,
      },
      arbitraryScriptExecution: false,
      networkMcp: false,
      deniedRoots: this.config.deniedRoots,
      verifiedPhotoshopVersions: this.config.verifiedPhotoshopVersions,
      photoshopVersionPolicy: {
        executionLockedToVerifiedVersions: false,
        unadaptedVersionsCanExecute: true,
        notice:
          "尚未验证的 Photoshop 版本仍允许执行；报告会明确保留版本验证状态。",
      },
    };
  }

  listProfiles(): Record<string, unknown> {
    return PROFILE_DEFINITIONS;
  }

  async submitJobs(
    inputs: SubmitJobInput[],
    authorizations: SubmissionPathAuthorizations = {},
  ): Promise<Array<{ job: JobRecord; existing: boolean }>> {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new Error("请至少明确选择一个文件。");
    }
    const explicitlySelectedSources = new Set(
      (authorizations.explicitlySelectedSources || []).map(
        pathAuthorizationKey,
      ),
    );
    const explicitlySelectedOutputDirectories = new Set(
      (authorizations.explicitlySelectedOutputDirectories || []).map(
        pathAuthorizationKey,
      ),
    );
    const prepared: Array<{
      input: SubmitJobInput;
      sourcePath: string;
      experimental: boolean;
      explicitSourceSelection: boolean;
      explicitOutputSelection: boolean;
    }> = [];
    for (const input of inputs) {
      if (
        input.profile !== undefined &&
        !CLEANUP_PROFILES.includes(input.profile)
      ) {
        throw new Error(`无效的清理策略：${input.profile}`);
      }
      if (
        input.runMode !== undefined &&
        !RUN_MODES.includes(input.runMode)
      ) {
        throw new Error(`无效的任务模式：${input.runMode}`);
      }
      if (
        input.executionMode !== undefined &&
        !EXECUTION_MODES.includes(input.executionMode)
      ) {
        throw new Error(`无效的执行方式：${input.executionMode}`);
      }
      if (
        input.backupSource !== undefined &&
        typeof input.backupSource !== "boolean"
      ) {
        throw new Error("“处理前备份原文件”必须为真或假。");
      }
      for (const [label, value] of [
        ["删除隐藏图层", input.deleteHiddenLayers],
        ["删除空图层", input.deleteEmptyLayers],
      ] as const) {
        if (value !== undefined && typeof value !== "boolean") {
          throw new Error(`“${label}”必须为真或假。`);
        }
      }
      const contentCleanupRequested =
        input.deleteHiddenLayers === true || input.deleteEmptyLayers === true;
      if (
        contentCleanupRequested &&
        (input.executionMode || "safe_copy") !== "safe_copy"
      ) {
        throw new Error(
          "删除隐藏/空图层会改变文档内容，当前版本只允许生成安全副本。",
        );
      }
      if (contentCleanupRequested && input.source !== "ui") {
        throw new Error(
          "删除隐藏/空图层当前只允许在桌面界面手动选择文件后使用，自动处理文件夹、MCP 与命令行暂不开放。",
        );
      }
      if (
        input.coveragePolicy !== undefined &&
        !COVERAGE_POLICIES.includes(input.coveragePolicy)
      ) {
        throw new Error(`无效的计划覆盖策略：${input.coveragePolicy}`);
      }
      if (
        input.coverageThresholdPercent !== undefined &&
        (!Number.isFinite(input.coverageThresholdPercent) ||
          input.coverageThresholdPercent < 0 ||
          input.coverageThresholdPercent > 100)
      ) {
        throw new Error("计划覆盖遗漏比例必须在 0 至 100 之间。");
      }
      if (
        input.outputMode !== undefined &&
        !OUTPUT_MODES.includes(input.outputMode)
      ) {
        throw new Error(`无效的另存方式：${input.outputMode}`);
      }
      if (
        input.requiredValidationChecks !== undefined &&
        (!Array.isArray(input.requiredValidationChecks) ||
          input.requiredValidationChecks.some(
            (item) => !VALIDATION_CHECKS.includes(item),
          ))
      ) {
        throw new Error("包含无法识别的验收标准。");
      }
      if (
        input.clientRequestId !== undefined &&
        (!input.clientRequestId.trim() ||
          input.clientRequestId.length > 256)
      ) {
        throw new Error(
          "幂等请求编号必须包含 1 至 256 个字符。",
        );
      }
      if (
        input.runMode !== "inspect_only" &&
        (input.executionMode || "safe_copy") === "safe_copy" &&
        (input.outputMode || "specified_directory") ===
          "specified_directory" &&
        !input.outputDir
      ) {
        throw new Error(
          "可执行任务选择“指定目录”时必须明确选择成品目录。",
        );
      }
      const explicitSourceSelection =
        input.source === "ui" &&
        explicitlySelectedSources.has(
          pathAuthorizationKey(input.sourcePath),
        );
      if (contentCleanupRequested && !explicitSourceSelection) {
        throw new Error(
          "删除隐藏/空图层需要通过文件选择器或拖放明确授权每个源文件。",
        );
      }
      const outputMode = input.outputMode || "specified_directory";
      const executionMode = input.executionMode || "safe_copy";
      const explicitOutputSelection =
        input.source === "ui" &&
        (executionMode === "in_place"
          ? explicitSourceSelection
          : outputMode === "source_subfolder"
          ? explicitSourceSelection
          : Boolean(
              input.outputDir &&
                explicitlySelectedOutputDirectories.has(
                  pathAuthorizationKey(input.outputDir),
                ),
            ));
      const validated = await validateSourcePath(
        input.sourcePath,
        this.config,
        { allowOutsideAllowedRoots: explicitSourceSelection },
      );
      if (
        validated.experimental &&
        (input.runMode || "auto_if_eligible") === "auto_if_eligible" &&
        !this.config.experimentalPsdUnattended
      ) {
        throw new Error(
          "尚未开启 PSD 无人值守实验功能。请先在设置中开启，或选择“仅预检/预检后等待批准”。",
        );
      }
      prepared.push({
        input: {
          ...input,
          requiredValidationChecks: [
            ...new Set(
              input.requiredValidationChecks ||
                DEFAULT_VALIDATION_CHECKS,
            ),
          ].filter(
            (check) =>
              !contentCleanupRequested || check !== "structure_topology",
          ),
        },
        sourcePath: validated.sourcePath,
        experimental: validated.experimental,
        explicitSourceSelection,
        explicitOutputSelection,
      });
    }

    const results: Array<{ job: JobRecord; existing: boolean }> = [];
    for (const item of prepared) {
      const result = this.store.createJob(
        item.input,
        item.sourcePath,
        item.experimental,
        item.explicitSourceSelection,
        item.explicitOutputSelection,
      );
      if (!result.existing) {
        const event = this.store.addEvent({
          jobId: result.job.id,
          level: "info",
          stage: "ingress",
          eventType: "JOB_CREATED",
          message: `任务由 ${item.input.source} 创建。`,
          data: {
            profile: result.job.profile,
            runMode: result.job.runMode,
            executionMode: result.job.executionMode,
            backupSource: result.job.backupSource,
            coveragePolicy: result.job.coveragePolicy,
            coverageThresholdPercent:
              result.job.coverageThresholdPercent,
            requiredValidationChecks:
              result.job.requiredValidationChecks,
            contentCleanup: {
              deleteHiddenLayers: result.job.deleteHiddenLayers,
              deleteEmptyLayers: result.job.deleteEmptyLayers,
              scope: "root_document_only",
              automaticPublication: false,
            },
            outputMode: result.job.outputMode,
            watcherId: item.input.watcherId || null,
            explicitSourceSelection: item.explicitSourceSelection,
            explicitOutputSelection: item.explicitOutputSelection,
          },
        });
        await this.store.appendEventFiles(event);
      }
      results.push(result);
      this.emit("job-changed", result.job);
    }
    void this.worker.tick();
    return results;
  }

  async previewBatchCapacity(
    inputs: SubmitJobInput[],
    authorizations: SubmissionPathAuthorizations = {},
  ): Promise<Record<string, unknown>> {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new Error("请至少明确选择一个文件。");
    }
    const explicitlySelectedSources = new Set(
      (authorizations.explicitlySelectedSources || []).map(pathAuthorizationKey),
    );
    const explicitlySelectedOutputs = new Set(
      (authorizations.explicitlySelectedOutputDirectories || []).map(
        pathAuthorizationKey,
      ),
    );
    const dataFree = await availableBytes(this.config.dataRoot);
    const volumeGroups = new Map<
      string,
      {
        root: string;
        freeBytes: number;
        finalBytes: number;
        peakRequiredBytes: number;
        includeReserve: boolean;
        files: number;
      }
    >();
    let totalSourceBytes = 0;
    let backupBytes = 0;
    let executionFiles = 0;
    let inspectionOnlyFiles = 0;

    for (let index = 0; index < inputs.length; index += 1) {
      const input = inputs[index];
      const explicitSourceSelection =
        input.source === "ui" &&
        explicitlySelectedSources.has(pathAuthorizationKey(input.sourcePath));
      const validated = await validateSourcePath(input.sourcePath, this.config, {
        allowOutsideAllowedRoots: explicitSourceSelection,
      });
      const stat = await fs.stat(validated.sourcePath);
      totalSourceBytes += stat.size;
      if ((input.runMode || "auto_if_eligible") === "inspect_only") {
        inspectionOnlyFiles += 1;
        continue;
      }
      executionFiles += 1;
      const executionMode = input.executionMode || "safe_copy";
      if (executionMode === "in_place") {
        if (input.backupSource !== false) backupBytes += stat.size;
        const root = path.parse(path.resolve(validated.sourcePath)).root;
        const key = root.toLowerCase();
        let group = volumeGroups.get(key);
        if (!group) {
          group = {
            root,
            freeBytes: await availableBytes(validated.sourcePath),
            finalBytes: 0,
            peakRequiredBytes: 0,
            includeReserve: false,
            files: 0,
          };
          volumeGroups.set(key, group);
        }
        group.files += 1;
        group.peakRequiredBytes = Math.max(
          group.peakRequiredBytes,
          Math.ceil(stat.size * 1.2),
        );
        continue;
      }

      const outputMode = input.outputMode || "specified_directory";
      const explicitOutputSelection =
        outputMode === "source_subfolder"
          ? explicitSourceSelection
          : Boolean(
              input.outputDir &&
                explicitlySelectedOutputs.has(pathAuthorizationKey(input.outputDir)),
            );
      const output = await buildOutputPath({
        sourcePath: validated.sourcePath,
        jobId: `capacity-${String(index).padStart(8, "0")}`,
        outputMode,
        outputDir: input.outputDir,
        config: this.config,
        allowOutsideAllowedRoots: explicitOutputSelection,
      });
      const root = path.parse(path.resolve(output.outputDir)).root;
      const key = root.toLowerCase();
      let group = volumeGroups.get(key);
      if (!group) {
        group = {
          root,
          freeBytes: await availableBytes(output.outputDir),
          finalBytes: 0,
          peakRequiredBytes: 0,
          includeReserve: true,
          files: 0,
        };
        volumeGroups.set(key, group);
      }
      group.files += 1;
      group.includeReserve = true;
      group.peakRequiredBytes = Math.max(
        group.peakRequiredBytes,
        group.finalBytes + stat.size * this.config.minimumSpaceMultiplier,
      );
      group.finalBytes += stat.size;
    }

    const volumePlans = [...volumeGroups.values()].map((group) => {
      const requiredBytes =
        group.peakRequiredBytes +
        (group.includeReserve ? this.config.minimumSpaceReserveBytes : 0);
      return {
        volume: group.root,
        files: group.files,
        freeBytes: group.freeBytes,
        requiredBytes,
        shortfallBytes: Math.max(0, requiredBytes - group.freeBytes),
        estimatedFinalBytes: group.finalBytes,
      };
    });
    const backupRequiredBytes =
      backupBytes > 0
        ? backupBytes + this.config.minimumSpaceReserveBytes
        : 0;
    const dataShortfallBytes = Math.max(0, backupRequiredBytes - dataFree);
    const eligible =
      volumePlans.every((item) => item.shortfallBytes === 0) &&
      dataShortfallBytes === 0;
    return {
      eligible,
      files: inputs.length,
      executionFiles,
      inspectionOnlyFiles,
      totalSourceBytes,
      dataRoot: this.config.dataRoot,
      dataFreeBytes: dataFree,
      backupRequiredBytes,
      dataShortfallBytes,
      volumes: volumePlans,
      explanation:
        executionFiles === 0
          ? "本批任务只做检查，不需要 Photoshop 工作空间。"
          : "按队列顺序估算：成品盘同时承担当前文件的工作副本与临时成品，并累计此前已完成的成品；数据目录只计算直存备份。",
    };
  }

  getJob(id: string): JobRecord {
    const job = this.store.getJob(id);
    if (!job) throw new Error(`找不到任务：${id}`);
    return {
      ...job,
      userTags: this.store.listJobUserTags(id),
    };
  }

  listJobs(input: { limit?: number; status?: JobRecord["status"] } = {}): JobRecord[] {
    const jobs = this.store.listJobs(input);
    const tagsByJob = this.store.listUserTagsByJobIds(
      jobs.map((job) => job.id),
    );
    return jobs.map((job) => ({
      ...job,
      userTags: tagsByJob.get(job.id) || [],
    }));
  }

  async preflightSummaries(input: {
    jobIds?: string[];
  } = {}): Promise<Record<string, unknown>> {
    const requested = Array.isArray(input.jobIds)
      ? [...new Set(input.jobIds.map(String))].slice(0, 300)
      : [];
    const summaries: Record<string, unknown> = {};
    for (const jobId of requested) {
      const job = this.store.getJob(jobId);
      if (!job?.reportJsonPath || !job.preflightJsonPath) continue;
      const report = await fs
        .readFile(job.reportJsonPath, "utf8")
        .then((text) => JSON.parse(text) as Record<string, any>)
        .catch(() => null);
      if (!report) continue;
      const decision = report.policy?.decision || null;
      const preflight = report.preflight || {};
      summaries[jobId] = {
        eligible: decision?.eligible ?? null,
        reasonCode: decision?.reasonCode || job.reasonCode,
        explanation: decision?.explanation || null,
        estimate: decision?.estimate || null,
        containersInspected: Number(
          preflight.summary?.containersInspected || 0,
        ),
        documentAncestors: Number(
          preflight.summary?.allDocumentAncestors || 0,
        ),
        parserWarnings: Array.isArray(preflight.parserWarnings)
          ? preflight.parserWarnings.length
          : 0,
        sourceUnchanged: report.source?.unchanged ?? null,
      };
    }
    return summaries;
  }

  async historyStatistics(input: {
    periodDays?: number | null;
    format?: "all" | "psd" | "psb";
    executionMode?: "all" | "safe_copy" | "in_place";
  } = {}): Promise<Record<string, unknown>> {
    const periodDays =
      input.periodDays === null || input.periodDays === undefined
        ? null
        : Math.max(1, Math.min(3650, Number(input.periodDays)));
    const since = periodDays === null
      ? null
      : Date.now() - periodDays * 24 * 60 * 60 * 1000;
    const format = input.format || "all";
    const executionMode = input.executionMode || "all";
    const cacheKey = JSON.stringify({ periodDays, format, executionMode });
    const cached = this.historyStatisticsCache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < 10_000) {
      return cached.value;
    }
    const allJobs = this.store.listAllJobs();
    const filtered = allJobs.filter((job) => {
      if (since !== null && Date.parse(job.createdAt) < since) return false;
      const extension = path.extname(job.sourcePath).slice(1).toLowerCase();
      if (format !== "all" && extension !== format) return false;
      if (executionMode !== "all" && job.executionMode !== executionMode) {
        return false;
      }
      return true;
    });
    const statusCounts: Record<string, number> = {};
    const uniqueSources = new Set<string>();
    const formatCounts = { psd: 0, psb: 0 };
    let outputReductionBytes = 0;
    let actualFreedBytes = 0;
    let currentSafeCopyBytes = 0;
    let currentBackupBytes = 0;
    let currentQuarantineBytes = 0;
    let hiddenLayersDeleted = 0;
    let emptyLayersDeleted = 0;
    let contentCleanupTasks = 0;
    let reportsRead = 0;
    const currentPaths = new Set<string>();
    const statBytes = async (target: string | null): Promise<number> => {
      if (!target) return 0;
      const resolved = path.resolve(target);
      const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
      if (currentPaths.has(key)) return 0;
      currentPaths.add(key);
      return await fs.stat(resolved).then((item) => item.isFile() ? item.size : 0).catch(() => 0);
    };
    for (const job of filtered) {
      const outcomeStatus =
        job.reasonCode === "IN_PLACE_PARTIAL_SAVED_UNVALIDATED"
          ? "partial"
          : job.status;
      statusCounts[outcomeStatus] = (statusCounts[outcomeStatus] || 0) + 1;
      uniqueSources.add(pathAuthorizationKey(job.sourcePath));
      const extension = path.extname(job.sourcePath).slice(1).toLowerCase();
      if (extension === "psd" || extension === "psb") formatCounts[extension] += 1;
      const [outputBytesOnDisk, quarantineBytesOnDisk, backupBytesOnDisk] =
        await Promise.all([
          job.executionMode === "safe_copy" ? statBytes(job.outputPath) : 0,
          statBytes(job.quarantinePath),
          statBytes(job.backupPath),
        ]);
      currentSafeCopyBytes += outputBytesOnDisk + quarantineBytesOnDisk;
      currentQuarantineBytes += quarantineBytesOnDisk;
      currentBackupBytes += backupBytesOnDisk;
      if (!job.reportJsonPath) continue;
      const report = await fs
        .readFile(job.reportJsonPath, "utf8")
        .then((text) => JSON.parse(text) as Record<string, any>)
        .catch(() => null);
      if (!report) continue;
      reportsRead += 1;
      const sourceBefore = Number(report.source?.beforeBytes);
      const resultAfter = Number(report.output?.bytes ?? report.source?.afterBytes);
      if (
        Number.isFinite(sourceBefore) &&
        Number.isFinite(resultAfter) &&
        sourceBefore > resultAfter
      ) {
        outputReductionBytes += sourceBefore - resultAfter;
      }
      if (
        job.executionMode === "in_place" &&
        Number.isFinite(sourceBefore) &&
        Number.isFinite(resultAfter)
      ) {
        actualFreedBytes += Math.max(
          0,
          sourceBefore - resultAfter - backupBytesOnDisk,
        );
      }
      const contentCleanup = report.execution?.contentCleanup;
      if (contentCleanup?.requested?.hidden || contentCleanup?.requested?.empty) {
        contentCleanupTasks += 1;
        hiddenLayersDeleted += Array.isArray(contentCleanup.deletedHidden)
          ? contentCleanup.deletedHidden.length
          : 0;
        emptyLayersDeleted += Array.isArray(contentCleanup.deletedEmpty)
          ? contentCleanup.deletedEmpty.length
          : 0;
      }
    }
    const executedOutcomes = filtered.filter((job) =>
      ["succeeded", "partial", "quarantined", "failed", "discarded"].includes(
        job.reasonCode === "IN_PLACE_PARTIAL_SAVED_UNVALIDATED"
          ? "partial"
          : job.status,
      ),
    ).length;
    const failedExecutions = statusCounts.failed || 0;
    const result = {
      generatedAt: new Date().toISOString(),
      filters: { periodDays, format, executionMode },
      tasks: {
        total: filtered.length,
        uniqueSources: uniqueSources.size,
        byStatus: statusCounts,
        byFormat: formatCounts,
        inspectOnly: filtered.filter((job) => job.runMode === "inspect_only").length,
        safeCopy: filtered.filter((job) => job.executionMode === "safe_copy").length,
        inPlace: filtered.filter((job) => job.executionMode === "in_place").length,
        manualAccepted: filtered.filter(
          (job) => job.reviewStatus === "accepted_with_warnings",
        ).length,
        reportsRead,
      },
      reliability: {
        executedOutcomes,
        failedExecutions,
        partialExecutions: statusCounts.partial || 0,
        failureRatePercent:
          executedOutcomes > 0
            ? (failedExecutions / executedOutcomes) * 100
            : null,
        blocked: statusCounts.blocked || 0,
        cancelled: statusCounts.cancelled || 0,
        quarantined: statusCounts.quarantined || 0,
      },
      storage: {
        actualFreedBytes,
        outputReductionBytes,
        currentAddedBytes: currentSafeCopyBytes + currentBackupBytes,
        currentSafeCopyBytes,
        currentBackupBytes,
        currentQuarantineBytes,
      },
      contentCleanup: {
        tasks: contentCleanupTasks,
        hiddenLayersDeleted,
        emptyLayersDeleted,
      },
      definitions: {
        actualFreedBytes:
          "只统计直接保存后原文件实际缩小的体积，并扣除仍存在的恢复备份。安全副本不会计入真正释放。",
        outputReductionBytes:
          "比较处理结果与处理前源文件的体积差；安全副本也计入，但不代表磁盘净空间增加。",
        currentAddedBytes:
          "当前仍存在的安全副本、隔离结果和恢复备份占用；不包含源文件本身。",
        failureRatePercent:
          "分母仅包含已进入执行并产生成功、复核、放弃或失败结论的任务；安全阻止和取消单独列出。",
      },
    };
    this.historyStatisticsCache.set(cacheKey, {
      createdAt: Date.now(),
      value: result,
    });
    return result;
  }

  async previewQuarantineCleanup(): Promise<
    Awaited<ReturnType<typeof previewRetentionMaintenance>>
  > {
    return await previewRetentionMaintenance(this.config, {
      lockedJobIds: this.store.listLockedQuarantineJobIds(),
      quarantineDirectories: this.managedQuarantineDirectories(),
    });
  }

  async cleanQuarantineNow(input: {
    confirmedDirectories: string[];
  }): Promise<Awaited<ReturnType<typeof runRetentionMaintenance>>> {
    if (
      !Array.isArray(input.confirmedDirectories) ||
      input.confirmedDirectories.length === 0
    ) {
      throw new Error("没有确认任何待清理的隔离目录。");
    }
    const result = await runRetentionMaintenance(this.config, {
      ignoreDisabled: true,
      lockedJobIds: this.store.listLockedQuarantineJobIds(),
      quarantineDirectories: this.managedQuarantineDirectories(),
      confirmedDirectories: input.confirmedDirectories,
      onRecycled: async (candidate) => {
        const event = this.store.addEvent({
          jobId: this.store.getJob(candidate.jobId)
            ? candidate.jobId
            : undefined,
          level: "warning",
          stage: "retention",
          eventType: "QUARANTINE_RECYCLED_MANUALLY",
          message: "用户确认后，隔离目录已移入 Windows 回收站。",
          data: candidate,
        });
        await this.store.appendEventFiles(event);
      },
    });
    const summary = this.store.addEvent({
      level: result.failures.length ? "warning" : "info",
      stage: "retention",
      eventType: "QUARANTINE_CLEANUP_COMPLETED",
      message: "隔离文件立即清理已完成。",
      data: {
        confirmedCount: input.confirmedDirectories.length,
        recycledCount: result.recycled.length,
        recycledBytes: result.recycledBytes,
        failures: result.failures,
      },
    });
    await this.store.appendEventFiles(summary);
    return result;
  }

  listUserTags() {
    return this.store.listUserTags();
  }

  createUserTag(input: { name: string; color: string }) {
    return this.store.createUserTag(input.name, input.color);
  }

  updateUserTag(input: { tagId: string; name?: string; color?: string }) {
    return this.store.updateUserTag(input.tagId, {
      name: input.name,
      color: input.color,
    });
  }

  deleteUserTag(tagId: string): { deleted: boolean; tagId: string } {
    this.store.deleteUserTag(tagId);
    return { deleted: true, tagId };
  }

  setJobUserTags(input: { jobIds: string[]; tagIds: string[] }): JobRecord[] {
    if (!Array.isArray(input.jobIds) || input.jobIds.length === 0) {
      throw new Error("请至少选择一个任务。");
    }
    if (!Array.isArray(input.tagIds)) {
      throw new Error("任务标签必须是标签编号列表。");
    }
    this.store.setJobUserTags(input.jobIds, input.tagIds);
    const jobs = input.jobIds.map((id) => this.getJob(id));
    for (const job of jobs) this.emit("job-changed", job);
    return jobs;
  }

  async getReport(id: string): Promise<Record<string, unknown>> {
    const job = this.getJob(id);
    if (!job.reportJsonPath) {
      return { jobId: id, available: false, status: job.status };
    }
    return JSON.parse(await fs.readFile(job.reportJsonPath, "utf8"));
  }

  async getReviewContext(id: string): Promise<Record<string, unknown>> {
    const job = this.getJob(id);
    const report = await this.getReport(id);
    const resultPath = job.quarantinePath || job.outputPath;
    const artifactDirectory = path.join(
      this.config.dataRoot,
      "reports",
      id,
      "artifacts",
    );
    const previewNames = [
      "before.png",
      "after_processing.png",
      "after_save.png",
      "after_reopen.png",
    ];
    const previews: Record<string, string> = {};
    for (const name of previewNames) {
      const target = path.join(artifactDirectory, name);
      if (await fs.stat(target).then(() => true).catch(() => false)) {
        previews[path.parse(name).name] = target;
      }
    }
    return {
      job,
      report,
      resultPath,
      sourceExists: await fs
        .stat(job.sourcePath)
        .then(() => true)
        .catch(() => false),
      resultExists: resultPath
        ? await fs.stat(resultPath).then(() => true).catch(() => false)
        : false,
      previews,
      previewRetentionExplanation:
        Object.keys(previews).length > 0
          ? null
          : "这个任务没有保留下可视化预览。旧版本会在报告生成后清理临时预览；请使用下方按钮分别打开原件和处理结果进行人工比较。",
    };
  }

  async recordManualReview(input: {
    jobId: string;
    decision:
      | "accept_with_warnings"
      | "keep_quarantined"
      | "discard_result";
    note?: string;
  }, options: {
    recycleDirectory?: (target: string) => Promise<void>;
  } = {}): Promise<JobRecord> {
    let job = this.getJob(input.jobId);
    if (job.executionMode !== "safe_copy") {
      throw new Error("直接保存原文件的任务没有独立结果副本，不能使用此复核流程。");
    }
    if (!job.quarantinePath || job.status !== "quarantined") {
      throw new Error("只有仍在隔离区的处理副本可以进行人工处置。");
    }
    const note = String(input.note || "").trim().slice(0, 2000);
    const report = (await this.getReport(job.id)) as Record<string, any>;
    const ignoredAutomaticChecks = [
      ...(Array.isArray(report.validation?.errors)
        ? report.validation.errors
        : []),
      ...(Array.isArray(report.validation?.warnings)
        ? report.validation.warnings
        : []),
    ].map(String);
    const reviewedAt = new Date().toISOString();
    const reviewedBy = os.userInfo().username;
    const originalStatus = job.status;
    const originalReasonCode = job.reasonCode;
    let resultPath: string | null = job.quarantinePath;
    let reviewStatus: NonNullable<JobRecord["reviewStatus"]>;
    let discardedArtifacts:
      | Awaited<ReturnType<typeof recycleManualReviewArtifacts>>
      | null = null;
    let preservedPhotoshopLog: string | null = null;

    if (input.decision === "accept_with_warnings") {
      if (!job.outputPath) {
        throw new Error("任务没有记录原定成品位置，无法安全发布；请继续隔离。");
      }
      assertNotDenied(job.outputPath, this.config.deniedRoots);
      await moveWithoutOverwrite(job.quarantinePath, job.outputPath);
      resultPath = job.outputPath;
      reviewStatus = "accepted_with_warnings";
      job = this.store.updateJob(job.id, {
        status: "succeeded",
        reasonCode: "HUMAN_APPROVED_WITH_WARNINGS",
        progressStage: "human_review",
        progressDetail: "已由用户人工复核并接受为有风险成品；自动检查警告仍保留",
        quarantinePath: null,
        reviewStatus,
        reviewedAt,
        reviewedBy,
        reviewNote: note,
      });
    } else if (input.decision === "keep_quarantined") {
      reviewStatus = "kept_quarantined";
      job = this.store.updateJob(job.id, {
        progressStage: "human_review",
        progressDetail: "用户已人工复核，决定继续保留在隔离区",
        reviewStatus,
        reviewedAt,
        reviewedBy,
        reviewNote: note,
      });
    } else if (input.decision === "discard_result") {
      const expectedQuarantineDirectory = assertManagedReviewDirectory(
        this.config,
        job.id,
        path.dirname(job.quarantinePath),
      );
      if (
        pathAuthorizationKey(path.dirname(job.quarantinePath)) !==
        pathAuthorizationKey(expectedQuarantineDirectory)
      ) {
        throw new Error(
          "隔离副本位置与任务编号不完全对应，已停止清理；原件没有改动。",
        );
      }
      const artifactPhotoshopLog = path.join(
        this.config.dataRoot,
        "reports",
        job.id,
        "artifacts",
        "photoshop.log",
      );
      const photoshopLogStat = await fs
        .lstat(artifactPhotoshopLog)
        .catch(() => null);
      if (photoshopLogStat) {
        if (photoshopLogStat.isSymbolicLink() || !photoshopLogStat.isFile()) {
          throw new Error(
            "Photoshop 日志不是受控的普通文件，已停止清理。",
          );
        }
        preservedPhotoshopLog = path.join(
          this.config.dataRoot,
          "logs",
          "jobs",
          `${job.id}.photoshop.log`,
        );
        await fs.mkdir(path.dirname(preservedPhotoshopLog), { recursive: true });
        await fs.copyFile(artifactPhotoshopLog, preservedPhotoshopLog);
      }
      discardedArtifacts = await recycleManualReviewArtifacts(
        this.config,
        job.id,
        {
          recycleDirectory: options.recycleDirectory,
          quarantineDirectory: expectedQuarantineDirectory,
        },
      );
      resultPath = null;
      reviewStatus = "discarded";
      job = this.store.updateJob(job.id, {
        status: "discarded",
        reasonCode: "HUMAN_DISCARDED_REVIEW_RESULT",
        progressStage: "human_review",
        progressDetail:
          "用户复核后放弃处理结果；隔离副本和可丢弃的派生文件已移入回收站",
        outputPath: null,
        quarantinePath: null,
        reviewStatus,
        reviewedAt,
        reviewedBy,
        reviewNote: note,
      });
    } else {
      throw new Error("未知的人工复核决定。");
    }

    const manualReview = {
      status: reviewStatus,
      reviewedAt,
      reviewedBy,
      note,
      ignoredAutomaticChecks,
      originalStatus,
      originalReasonCode,
      resultPath,
      ...(discardedArtifacts
        ? {
            recycledArtifacts: discardedArtifacts.directories.map((item) => ({
              kind: item.kind,
              path: item.directory,
              bytes: item.bytes,
            })),
            recycledBytes: discardedArtifacts.recycledBytes,
            sourceFilePreserved: true,
            reportsPreserved: true,
            logsPreserved: true,
            photoshopLogPreservedAt: preservedPhotoshopLog,
          }
        : {}),
    };
    const updatedReport = {
      ...report,
      status: job.status,
      reasonCode: job.reasonCode,
      output: {
        ...(report.output || {}),
        path: resultPath,
      },
      logs: {
        ...(report.logs || {}),
        ...(preservedPhotoshopLog
          ? { photoshopLog: preservedPhotoshopLog }
          : {}),
      },
      manualReview,
    };
    const written = await writeReport({
      report: updatedReport,
      centralDirectory: path.join(this.config.dataRoot, "reports", job.id),
      sidecarBasePath: resultPath,
    });
    job = this.store.updateJob(job.id, {
      reportJsonPath: written.centralJson,
      reportHtmlPath: written.centralHtml,
    });
    const event = this.store.addEvent({
      jobId: job.id,
      level:
        reviewStatus === "accepted_with_warnings" || reviewStatus === "discarded"
          ? "warning"
          : "info",
      stage: "human_review",
      eventType:
        reviewStatus === "accepted_with_warnings"
          ? "HUMAN_APPROVED_WITH_WARNINGS"
          : reviewStatus === "discarded"
            ? "HUMAN_REVIEW_RESULT_DISCARDED"
            : "HUMAN_REVIEW_KEPT_QUARANTINED",
      message:
        reviewStatus === "accepted_with_warnings"
          ? "用户人工查看后接受了带自动检查警告的结果。"
          : reviewStatus === "discarded"
            ? "用户人工查看后放弃了处理结果；原件、报告和日志均保留。"
            : "用户人工查看后决定继续隔离结果。",
      data: manualReview,
    });
    await this.store.appendEventFiles(event);
    this.emit("job-changed", job);
    return {
      ...job,
      userTags: this.store.listJobUserTags(job.id),
    };
  }

  async cancelJob(id: string): Promise<JobRecord> {
    return await this.worker.cancelJob(id);
  }

  async approveJob(id: string): Promise<JobRecord> {
    return await this.worker.approveJob(id);
  }

  async keepInspectionResult(id: string): Promise<JobRecord> {
    return await this.worker.keepInspectionResult(id);
  }

  async archiveJob(id: string): Promise<JobRecord> {
    let job = this.getJob(id);
    if (job.archivedAt) return job;
    if (["preflighting", "copying", "running", "validating"].includes(job.status)) {
      throw new Error(
        "这个任务仍在检查、复制、清理或验证。请先安全取消，等待任务停止后再从列表移除。",
      );
    }
    if (
      [
        "waiting_stable",
        "queued_preflight",
        "ready",
        "awaiting_approval",
        "waiting_photoshop",
      ].includes(job.status)
    ) {
      job = await this.worker.cancelJob(id);
    }
    const event = this.store.addEvent({
      jobId: id,
      level: "warning",
      stage: "history",
      eventType: "JOB_REMOVED_FROM_LIST",
      message: "用户从桌面任务列表中移除了任务记录。",
      data: {
        statusAtRemoval: job.status,
        reportsPreserved: true,
        logsPreserved: true,
        outputFilesPreserved: true,
      },
    });
    await this.store.appendEventFiles(event);
    const archived = this.store.archiveJob(id);
    this.emit("job-changed", archived);
    return archived;
  }

  async deleteJobData(id: string): Promise<Record<string, unknown>> {
    const job = this.getJob(id);
    if (
      [
        "waiting_stable",
        "queued_preflight",
        "preflighting",
        "ready",
        "awaiting_approval",
        "waiting_photoshop",
        "copying",
        "running",
        "validating",
      ].includes(job.status)
    ) {
      throw new Error(
        "这个任务尚未结束。请先安全取消并等待停止，再删除任务资料。",
      );
    }
    const reportDirectory = path.join(this.config.dataRoot, "reports", id);
    const workDirectory = path.join(this.config.dataRoot, "work", id);
    const eventLog = path.join(
      this.config.dataRoot,
      "logs",
      "jobs",
      `${id}.events.jsonl`,
    );
    await safeRemoveWorkDirectory(reportDirectory, this.config.dataRoot);
    await safeRemoveWorkDirectory(workDirectory, this.config.dataRoot);
    await fs.rm(eventLog, { force: true });
    const event = this.store.addEvent({
      level: "warning",
      stage: "history",
      eventType: "JOB_DATA_DELETED",
      message: "用户从桌面程序删除了任务资料。",
      data: {
        removedJobId: id,
        statusAtDeletion: job.status,
        sourcePathHash: crypto
          .createHash("sha256")
          .update(job.sourcePath)
          .digest("hex"),
        sourceFilePreserved: true,
        outputFilePreserved: true,
        quarantineFilePreserved: true,
        backupFilePreserved: true,
        sidecarReportsPreserved: true,
      },
    });
    await this.store.appendEventFiles(event);
    this.store.purgeJobRecord(id);
    this.emit("job-changed", {
      ...job,
      archivedAt: job.archivedAt || new Date().toISOString(),
    });
    return {
      removedJobId: id,
      deleted: [reportDirectory, workDirectory, eventLog],
      preserved: [
        job.sourcePath,
        job.outputPath,
        job.quarantinePath,
        job.backupPath,
      ].filter(Boolean),
      sidecarReportsPreserved: true,
    };
  }

  queueStatus(): Record<string, unknown> {
    return {
      ...this.store.getQueueState(),
      runnable: this.store.listJobs({ limit: 500 }).filter((job) =>
        ["queued_preflight", "ready", "waiting_photoshop"].includes(job.status),
      ).length,
    };
  }

  pauseQueue(): Record<string, unknown> {
    const currentQueue = this.store.getQueueState();
    const active = this.store
      .listJobs({ limit: 500 })
      .filter((job) =>
        ["preflighting", "copying", "running", "validating"].includes(
          job.status,
        ),
      );
    this.store.setQueueState(
      true,
      currentQueue.criticalReason,
      currentQueue.criticalReason
        ? currentQueue.finishCurrentJobId
        : active[0]?.id || null,
    );
    this.emit("queue-changed", this.queueStatus());
    return {
      ...this.queueStatus(),
      completesCurrentBeforePause: active.length > 0,
      activeJobIds: active.map((job) => job.id),
    };
  }

  async stopQueueAfterCurrent(): Promise<Record<string, unknown>> {
    const currentQueue = this.store.getQueueState();
    const activeStatuses = new Set([
      "preflighting",
      "copying",
      "running",
      "validating",
    ]);
    const cancellableWaitingStatuses = new Set([
      "waiting_stable",
      "queued_preflight",
      "ready",
      "awaiting_approval",
      "waiting_photoshop",
    ]);
    const all = this.store.listJobs({ limit: 500 });
    const active = all.filter((job) => activeStatuses.has(job.status));
    this.store.setQueueState(
      true,
      currentQueue.criticalReason,
      currentQueue.criticalReason
        ? currentQueue.finishCurrentJobId
        : active[0]?.id || null,
    );
    const waiting = all.filter((job) =>
      cancellableWaitingStatuses.has(job.status),
    );
    const cancelledJobIds: string[] = [];
    for (const job of waiting) {
      await this.worker.cancelJob(job.id);
      cancelledJobIds.push(job.id);
    }
    const event = this.store.addEvent({
      level: "warning",
      stage: "control",
      eventType: "QUEUE_STOP_AFTER_CURRENT_REQUESTED",
      message:
        "队列将在当前文件安全结束后停止；尚未开始的任务已取消。",
      data: {
        activeJobIds: active.map((job) => job.id),
        cancelledJobIds,
      },
    });
    await this.store.appendEventFiles(event);
    this.emit("queue-changed", this.queueStatus());
    return {
      ...this.queueStatus(),
      completesCurrentBeforeStop: active.length > 0,
      activeJobIds: active.map((job) => job.id),
      cancelledJobIds,
    };
  }

  resumeQueue(): Record<string, unknown> {
    const current = this.store.getQueueState();
    if (current.criticalReason) {
      throw new Error(
        `队列存在严重安全暂停，必须在桌面程序确认后才能继续：${current.criticalReason}`,
      );
    }
    this.store.setQueueState(false, null);
    this.emit("queue-changed", this.queueStatus());
    void this.worker.tick();
    return this.queueStatus();
  }

  acknowledgeCriticalPause(): Record<string, unknown> {
    this.store.setQueueState(false, null);
    this.emit("queue-changed", this.queueStatus());
    return this.queueStatus();
  }

  async previewWatcher(input: {
    path: string;
    recursive?: boolean;
    outputDir?: string;
  }): Promise<Record<string, unknown>> {
    const watcherPath = await canonicalizeForPolicy(input.path);
    assertNotDenied(watcherPath, this.config.deniedRoots);
    assertInAllowedRoots(
      watcherPath,
      this.config.allowedInputRoots,
      "input",
    );
    const outputDir = input.outputDir
      ? await canonicalizeForPolicy(input.outputDir)
      : undefined;
    const preview = await this.watchers.preview(
      watcherPath,
      Boolean(input.recursive),
      outputDir,
    );
    return {
      ...preview,
      stabilitySeconds: this.config.stabilitySeconds,
    };
  }

  async scanWatchersNow(): Promise<WatcherConfig[]> {
    await this.watchers.scanOnce();
    return this.listWatchers();
  }

  async addWatcher(
    input: Omit<
      WatcherConfig,
      | "id"
      | "createdAt"
      | "lastScanAt"
      | "scanStatus"
      | "scannedFiles"
      | "supportedFiles"
      | "waitingStableFiles"
      | "submittedJobs"
      | "skippedFiles"
      | "lastError"
      | "recursive"
      | "requiredValidationChecks"
    > &
      Partial<
        Pick<WatcherConfig, "recursive" | "requiredValidationChecks">
      >,
  ): Promise<WatcherConfig> {
    if (!CLEANUP_PROFILES.includes(input.profile)) {
      throw new Error(`无效的监控清理策略：${input.profile}`);
    }
    if (!RUN_MODES.includes(input.runMode)) {
      throw new Error(`无效的监控任务模式：${input.runMode}`);
    }
    const executionMode = input.executionMode || "safe_copy";
    const backupSource = input.backupSource !== false;
    const coveragePolicy = input.coveragePolicy || "strict";
    const coverageThresholdPercent = Number(
      input.coverageThresholdPercent ?? 5,
    );
    if (!EXECUTION_MODES.includes(executionMode)) {
      throw new Error(`无效的监控执行方式：${input.executionMode}`);
    }
    if (
      input.backupSource !== undefined &&
      typeof input.backupSource !== "boolean"
    ) {
      throw new Error("监控任务的备份选项必须为真或假。");
    }
    if (!COVERAGE_POLICIES.includes(coveragePolicy)) {
      throw new Error(`无效的计划覆盖策略：${input.coveragePolicy}`);
    }
    if (
      !Number.isFinite(coverageThresholdPercent) ||
      coverageThresholdPercent < 0 ||
      coverageThresholdPercent > 100
    ) {
      throw new Error("计划覆盖率容忍值必须在 0% 到 100% 之间。");
    }
    if (!OUTPUT_MODES.includes(input.outputMode)) {
      throw new Error(`无效的监控另存方式：${input.outputMode}`);
    }
    if (
      executionMode === "safe_copy" &&
      input.outputMode === "specified_directory" &&
      !input.outputDir
    ) {
      throw new Error("自动处理选择“指定成品目录”时必须选择目录。");
    }
    const requiredValidationChecks =
      input.requiredValidationChecks || DEFAULT_VALIDATION_CHECKS;
    if (
      !Array.isArray(requiredValidationChecks) ||
      requiredValidationChecks.some(
        (item) => !VALIDATION_CHECKS.includes(item),
      )
    ) {
      throw new Error("自动处理规则包含无法识别的验收标准。");
    }
    const watcherPath = await canonicalizeForPolicy(input.path);
    assertNotDenied(watcherPath, this.config.deniedRoots);
    assertInAllowedRoots(
      watcherPath,
      this.config.allowedInputRoots,
      "input",
    );
    if (executionMode === "in_place") {
      // The monitored input root already authorizes the exact files that may
      // be overwritten. No separate output root is used in this mode.
    } else if (input.outputMode === "source_subfolder") {
      assertInAllowedRoots(
        watcherPath,
        this.config.allowedOutputRoots,
        "output",
      );
    } else if (input.outputDir) {
      const outputDir = await canonicalizeForPolicy(input.outputDir);
      assertNotDenied(outputDir, this.config.deniedRoots);
      assertInAllowedRoots(
        outputDir,
        this.config.allowedOutputRoots,
        "output",
      );
    }
    const watcher: WatcherConfig = {
      ...input,
      executionMode,
      backupSource,
      coveragePolicy,
      coverageThresholdPercent,
      requiredValidationChecks: [
        ...new Set(requiredValidationChecks),
      ],
      recursive: Boolean(input.recursive),
      path: watcherPath,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      lastScanAt: null,
      scanStatus: "idle",
      scannedFiles: 0,
      supportedFiles: 0,
      waitingStableFiles: 0,
      submittedJobs: 0,
      skippedFiles: 0,
      lastError: null,
    };
    this.store.upsertWatcher(watcher);
    void this.watchers.scanOnce();
    return watcher;
  }

  listWatchers(): WatcherConfig[] {
    return this.store.listWatchers();
  }

  async setWatcherEnabled(input: {
    watcherId: string;
    enabled: boolean;
  }): Promise<WatcherConfig> {
    if (typeof input.enabled !== "boolean") {
      throw new Error("自动处理文件夹的启用状态必须为真或假。");
    }
    const current = this.listWatchers().find(
      (item) => item.id === String(input.watcherId || ""),
    );
    if (!current) {
      throw new Error("没有找到这个自动处理文件夹。");
    }
    const updated: WatcherConfig = {
      ...current,
      enabled: input.enabled,
      scanStatus: "idle",
      waitingStableFiles: input.enabled ? current.waitingStableFiles : 0,
    };
    this.store.upsertWatcher(updated);
    this.store.updateWatcherRuntime(updated.id, {
      scanStatus: "idle",
      waitingStableFiles: updated.waitingStableFiles,
    });
    const event = this.store.addEvent({
      level: "info",
      stage: "watcher",
      eventType: input.enabled ? "WATCHER_RESUMED" : "WATCHER_PAUSED",
      message: input.enabled
        ? "用户恢复了自动处理文件夹。"
        : "用户暂停了自动处理文件夹；已创建的任务不受影响。",
      data: {
        watcherId: updated.id,
        path: updated.path,
        enabled: input.enabled,
        existingJobsPreserved: true,
      },
    });
    await this.store.appendEventFiles(event);
    if (input.enabled) void this.watchers.scanOnce();
    return this.listWatchers().find((item) => item.id === updated.id)!;
  }

  async testPhotoshopConnection(input: {
    executable?: string;
    progId?: string;
  }): Promise<Record<string, unknown>> {
    const candidateConfig = validateConfig({
      ...this.config,
      photoshopExecutable: input.executable || this.config.photoshopExecutable,
      photoshopProgId: input.progId || undefined,
    });
    const photoshop = await diagnosePhotoshop({
      configuredExecutable: candidateConfig.photoshopExecutable,
      verifiedVersions: candidateConfig.verifiedPhotoshopVersions,
    });
    const resolution = photoshop.selected
      ? await resolvePhotoshopBridge(
          photoshop.selected,
          candidateConfig.photoshopProgId,
        )
      : null;
    return {
      photoshop,
      automationBridge: resolution?.selected
        ? {
            ...resolution.selected,
            mode: resolution.mode,
            attempts: resolution.attempts,
          }
        : null,
    };
  }

  async photoshopInstallations(): Promise<Record<string, unknown>> {
    const photoshop = await diagnosePhotoshop({
      configuredExecutable: this.config.photoshopExecutable,
      verifiedVersions: this.config.verifiedPhotoshopVersions,
    });
    return {
      appVersion: APP_VERSION,
      photoshop,
      automationBridge: null,
      passive: true,
      notice:
        "这里只读取安装路径、文件版本和 COM 注册，不创建 Photoshop 自动化对象。",
    };
  }

  async diagnostics(): Promise<Record<string, unknown>> {
    const firstOutputRoot = this.config.allowedOutputRoots[0] || null;
    const [photoshop, dataFreeBytes, outputFreeBytes] = await Promise.all([
      diagnosePhotoshop({
        configuredExecutable: this.config.photoshopExecutable,
        verifiedVersions: this.config.verifiedPhotoshopVersions,
      }),
      availableBytes(this.config.dataRoot),
      firstOutputRoot
        ? availableBytes(firstOutputRoot).catch(() => null)
        : Promise.resolve(null),
    ]);
    const bridgeResolution = photoshop.selected
      ? await resolvePhotoshopBridge(
          photoshop.selected,
          this.config.photoshopProgId,
        )
      : null;
    const automationBridge = bridgeResolution?.selected
      ? {
          ...bridgeResolution.selected,
          mode: bridgeResolution.mode,
          attempts: bridgeResolution.attempts,
        }
      : null;
    return {
      appVersion: APP_VERSION,
      system: systemInformation(),
      photoshop,
      automationBridge,
      database: {
        path: this.store.dbPath,
        integrity: this.store.integrityCheck(),
      },
      storage: {
        dataRoot: this.config.dataRoot,
        dataFreeBytes,
        minimumReserveBytes: this.config.minimumSpaceReserveBytes,
        firstOutputRoot,
        outputFreeBytes,
      },
      dataRoot: this.config.dataRoot,
      queue: this.queueStatus(),
      photoshopVersionPolicy: {
        executionLockedToVerifiedVersions: false,
        notice:
          "尚未验证的版本允许执行；完成实机样本验证后再加入正式支持清单。",
      },
    };
  }

  async exportDiagnosticLogs(
    target: string,
    jobIds: string[] = [],
  ): Promise<DiagnosticExportResult> {
    const requestedIds = [...new Set(jobIds.map(String))];
    const jobs =
      requestedIds.length > 0
        ? requestedIds.map((jobId) => {
            const job = this.store.getJob(jobId);
            if (!job) throw new Error(`任务不存在：${jobId}`);
            return job;
          })
        : this.store.listJobs({ limit: 500, includeArchived: true });
    const result = await exportDiagnosticBundle({
      config: this.config,
      jobs,
      diagnostics: await this.diagnostics(),
      queue: this.queueStatus(),
      database: {
        path: this.store.dbPath,
        integrity: this.store.integrityCheck(),
      },
      target,
    });
    const event = this.store.addEvent({
      level: "info",
      stage: "diagnostics",
      eventType: "DIAGNOSTIC_LOGS_EXPORTED",
      message: "用户导出了诊断日志包。",
      data: {
        target: result.path,
        selectedJobCount: result.selectedJobCount,
        includedFileCount: result.includedFileCount,
        includedBytes: result.includedBytes,
        missingFileCount: result.missingFiles.length,
      },
    });
    await this.store.appendEventFiles(event);
    return result;
  }

  async exportSettings(target: string): Promise<string> {
    const payload = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      settings: {
        allowedInputRoots: this.config.allowedInputRoots,
        allowedOutputRoots: this.config.allowedOutputRoots,
        deniedRoots: this.config.deniedRoots,
        verifiedPhotoshopVersions: this.config.verifiedPhotoshopVersions,
        experimentalPsd: this.config.experimentalPsd,
        experimentalPsdUnattended:
          this.config.experimentalPsdUnattended,
        stabilitySeconds: this.config.stabilitySeconds,
        sourceSubfolderName: this.config.sourceSubfolderName,
        retentionPolicy: this.config.retentionPolicy,
        quarantineCleanupEnabled:
          this.config.quarantineCleanupEnabled,
        quarantineRetentionDays:
          this.config.quarantineRetentionDays,
        quarantineMaxBytes: this.config.quarantineMaxBytes,
        quarantineCleanupTrigger:
          this.config.quarantineCleanupTrigger,
        photoshopExecutable: this.config.photoshopExecutable,
        photoshopProgId: this.config.photoshopProgId,
        pipelinePreflight: this.config.pipelinePreflight,
      },
      watchers: this.listWatchers(),
    };
    await fs.writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return path.resolve(target);
  }

  async importSettings(source: string): Promise<{
    importedSettings: string[];
    importedWatchers: number;
  }> {
    const payload = JSON.parse(await fs.readFile(source, "utf8"));
    if (payload.schemaVersion !== 1 || !payload.settings) {
      throw new Error("设置文件无效或版本不受支持。");
    }
    const allowedKeys = [
      "allowedInputRoots",
      "allowedOutputRoots",
      "deniedRoots",
      "verifiedPhotoshopVersions",
      "experimentalPsd",
      "experimentalPsdUnattended",
      "stabilitySeconds",
      "sourceSubfolderName",
      "retentionPolicy",
      "quarantineCleanupEnabled",
      "quarantineRetentionDays",
      "quarantineMaxBytes",
      "quarantineCleanupTrigger",
      "photoshopExecutable",
      "photoshopProgId",
      "pipelinePreflight",
    ] as const;
    const patch: Record<string, unknown> = {};
    for (const key of allowedKeys) {
      if (payload.settings[key] !== undefined) {
        patch[key] = payload.settings[key];
      }
    }
    if (patch.retentionPolicy === "quarantine_30d") {
      patch.retentionPolicy = "temporary_only";
      patch.quarantineCleanupEnabled = true;
      patch.quarantineRetentionDays = 30;
      patch.quarantineMaxBytes = 100 * 1024 ** 3;
      patch.quarantineCleanupTrigger = "any";
    }
    await this.updateSettings(patch as any);
    const existingPaths = new Set(
      this.listWatchers().map((item) => path.resolve(item.path).toLowerCase()),
    );
    let importedWatchers = 0;
    for (const item of Array.isArray(payload.watchers)
      ? payload.watchers
      : []) {
      const resolved = path.resolve(String(item.path));
      if (existingPaths.has(resolved.toLowerCase())) continue;
      await this.addWatcher({
        path: resolved,
        profile: item.profile,
        runMode: item.runMode,
        executionMode: item.executionMode || "safe_copy",
        backupSource: item.backupSource !== false,
        requiredValidationChecks:
          item.requiredValidationChecks ||
          DEFAULT_VALIDATION_CHECKS,
        outputMode: item.outputMode,
        outputDir: item.outputDir,
        recursive: Boolean(item.recursive),
        enabled: item.enabled !== false,
      });
      existingPaths.add(resolved.toLowerCase());
      importedWatchers++;
    }
    const event = this.store.addEvent({
      level: "warning",
      stage: "settings",
      eventType: "SETTINGS_IMPORTED",
      message: "已从本地文件导入设置。",
      data: {
        source: path.resolve(source),
        importedSettings: Object.keys(patch),
        importedWatchers,
      },
    });
    await this.store.appendEventFiles(event);
    return {
      importedSettings: Object.keys(patch),
      importedWatchers,
    };
  }

  async updateSettings(
    patch: Partial<
      Pick<
        AppConfig,
        | "allowedInputRoots"
        | "allowedOutputRoots"
        | "deniedRoots"
        | "verifiedPhotoshopVersions"
        | "experimentalPsd"
        | "experimentalPsdUnattended"
        | "stabilitySeconds"
        | "sourceSubfolderName"
        | "retentionPolicy"
        | "quarantineCleanupEnabled"
        | "quarantineRetentionDays"
        | "quarantineMaxBytes"
        | "quarantineCleanupTrigger"
        | "photoshopExecutable"
        | "photoshopProgId"
        | "pipelinePreflight"
        | "suppressDangerousOperationWarning"
        | "recentDirectories"
      >
    >,
  ): Promise<AppConfig> {
    const checked = validateConfig({ ...this.config, ...patch });
    await saveConfig(checked);
    Object.assign(this.config, checked);
    if (
      Object.hasOwn(patch, "photoshopExecutable") ||
      Object.hasOwn(patch, "photoshopProgId") ||
      Object.hasOwn(patch, "verifiedPhotoshopVersions")
    ) {
      this.worker.invalidatePhotoshopDiagnostic();
    }
    const event = this.store.addEvent({
      level: "warning",
      stage: "settings",
      eventType: "SETTINGS_UPDATED_FROM_DESKTOP",
      message: "桌面设置已更新。",
      data: {
        changedKeys: Object.keys(patch),
        // Tokens and full configuration are intentionally not logged.
      },
    });
    await this.store.appendEventFiles(event);
    this.emit("settings-changed", this.publicSettings());
    return this.config;
  }

  publicSettings(): Record<string, unknown> {
    return {
      ...this.config,
      pipeToken: "[redacted]",
    };
  }

  private async recoverInterruptedJobs(): Promise<void> {
    for (const job of this.store.interruptedJobs()) {
      let recoverable = false;
      const checkpointChain = this.store.verifyEventChain(job.id);
      try {
        const stat = await fs.stat(job.sourcePath);
        recoverable =
          checkpointChain.valid &&
          (job.sourceBytes === null ||
            (stat.size === job.sourceBytes &&
              Math.abs(stat.mtimeMs - (job.sourceMtimeMs || 0)) <= 1));
      } catch {
        recoverable = false;
      }
      const status: JobRecord["status"] =
        recoverable && job.attempt < 1 ? "queued_preflight" : "interrupted";
      this.store.updateJob(job.id, {
        status,
        reasonCode: recoverable
          ? "RECOVERED_AFTER_RESTART"
          : checkpointChain.valid
            ? "INTERRUPTED_REQUIRES_REVIEW"
            : "CHECKPOINT_CHAIN_INVALID",
        attempt: job.attempt + 1,
      });
      const event = this.store.addEvent({
        jobId: job.id,
        level: recoverable ? "warning" : "error",
        stage: "recovery",
        eventType: "INTERRUPTED_JOB_RECOVERY",
        message: recoverable
          ? "The interrupted job was returned to read-only preflight."
          : checkpointChain.valid
            ? "中断的任务需要人工复核。"
            : "断点记录的校验链不完整，已禁止自动续跑。",
        data: { checkpointChain },
      });
      await this.store.appendEventFiles(event);
    }
  }
}
