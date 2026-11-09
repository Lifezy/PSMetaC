import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createDefaultConfig,
  ensureDataDirectories,
} from "../src/config.ts";
import { CleanerService } from "../src/service.ts";

test("invalid PSB is blocked with a per-file report and no Photoshop run", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "psb-service-test-"));
  const inputRoot = path.join(root, "input");
  const outputRoot = path.join(root, "output");
  const dataRoot = path.join(root, "data");
  await Promise.all([
    fs.mkdir(inputRoot),
    fs.mkdir(outputRoot),
    fs.mkdir(dataRoot),
  ]);
  const source = path.join(inputRoot, "invalid.psb");
  await fs.writeFile(source, "not a Photoshop document");
  const config = createDefaultConfig(dataRoot, {
    allowedInputRoots: [inputRoot],
    allowedOutputRoots: [outputRoot],
  });
  await ensureDataDirectories(config);
  const service = await CleanerService.open(config);
  try {
    const [{ job }] = await service.submitJobs([
      {
        sourcePath: source,
        profile: "standard",
        runMode: "inspect_only",
        outputMode: "specified_directory",
        source: "ui",
      },
    ]);
    let finished = service.getJob(job.id);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        ["blocked", "cancelled", "failed"].includes(finished.status) &&
        finished.reportJsonPath
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      finished = service.getJob(job.id);
    }
    assert.equal(finished.status, "blocked");
    assert.equal(finished.reasonCode, "PREFLIGHT_FAILED");
    assert.ok(finished.reportJsonPath);
    const report = (await service.getReport(job.id)) as Record<string, any>;
    assert.equal(report.status, "blocked");
    assert.equal(report.source.beforeSha256, report.source.afterSha256);
    assert.equal(report.source.unchanged, true);
    assert.ok("photoshop" in report.environment);
    assert.equal(finished.outputPath, null);
    assert.equal(finished.quarantinePath, null);
  } finally {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("inspect-first exposes its evidence and can finish without Photoshop", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "psmetac-inspect-decision-"));
  const dataRoot = path.join(root, "data");
  const inputRoot = path.join(root, "input");
  const outputRoot = path.join(root, "output");
  await Promise.all([
    fs.mkdir(dataRoot),
    fs.mkdir(inputRoot),
    fs.mkdir(outputRoot),
  ]);
  const source = path.join(inputRoot, "decision.psb");
  await fs.writeFile(source, "test source");
  const config = createDefaultConfig(dataRoot, {
    allowedInputRoots: [inputRoot],
    allowedOutputRoots: [outputRoot],
  });
  await ensureDataDirectories(config);
  const service = await CleanerService.open(config);
  service.pauseQueue();
  try {
    const { job } = service.store.createJob(
      {
        sourcePath: source,
        profile: "standard",
        runMode: "await_approval",
        executionMode: "safe_copy",
        outputMode: "specified_directory",
        outputDir: outputRoot,
        source: "ui",
      },
      source,
      false,
      true,
      true,
    );
    const reportDirectory = path.join(dataRoot, "reports", job.id);
    const reportJsonPath = path.join(reportDirectory, "report.json");
    const preflightJsonPath = path.join(dataRoot, "work", job.id, "preflight.json");
    await Promise.all([
      fs.mkdir(reportDirectory, { recursive: true }),
      fs.mkdir(path.dirname(preflightJsonPath), { recursive: true }),
    ]);
    await fs.writeFile(preflightJsonPath, JSON.stringify({ summary: {} }), "utf8");
    await fs.writeFile(
      reportJsonPath,
      JSON.stringify({
        schemaVersion: 1,
        reportVersion: "1.0",
        jobId: job.id,
        machineId: job.machineId,
        status: "awaiting_approval",
        reasonCode: "WAITING_FOR_USER_APPROVAL",
        startedAt: job.createdAt,
        finishedAt: new Date().toISOString(),
        source: { path: source, unchanged: true },
        policy: {
          decision: {
            eligible: true,
            reasonCode: "ELIGIBLE",
            explanation: "符合标准策略。",
            estimate: {
              affectedContainers: 3,
              affectedXmpBytes: 4096,
              plannedObjects: 2,
              estimatedPhotoshopRangeMs: { low: 1000, high: 3000 },
            },
          },
        },
        environment: {},
        preflight: {
          summary: { containersInspected: 4, allDocumentAncestors: 12 },
          parserWarnings: [],
        },
        execution: { started: false },
        validation: { errors: [], warnings: [] },
        output: { path: null },
        timing: {},
        logs: {},
      }),
      "utf8",
    );
    service.store.updateJob(job.id, {
      status: "awaiting_approval",
      reasonCode: "WAITING_FOR_USER_APPROVAL",
      preflightJsonPath,
      reportJsonPath,
      preflightFinishedAt: new Date().toISOString(),
    });

    const summaries = (await service.preflightSummaries({
      jobIds: [job.id],
    })) as Record<string, any>;
    assert.equal(summaries[job.id].eligible, true);
    assert.equal(summaries[job.id].documentAncestors, 12);
    assert.equal(summaries[job.id].estimate.plannedObjects, 2);

    const kept = await service.keepInspectionResult(job.id);
    assert.equal(kept.status, "preflight_complete");
    assert.equal(kept.reasonCode, "USER_KEPT_INSPECTION_RESULT");
    const savedReport = (await service.getReport(job.id)) as Record<string, any>;
    assert.equal(savedReport.execution.started, false);
    assert.equal(savedReport.source.unchanged, true);
  } finally {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("human review can keep an output quarantined and later accept it with warnings", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "psmetac-review-test-"));
  const dataRoot = path.join(root, "data");
  const inputRoot = path.join(root, "input");
  const outputRoot = path.join(root, "output");
  await Promise.all([
    fs.mkdir(dataRoot),
    fs.mkdir(inputRoot),
    fs.mkdir(outputRoot),
  ]);
  const source = path.join(inputRoot, "source.psb");
  const quarantinePath = path.join(
    dataRoot,
    "quarantine",
    "review-job",
    "cleaned.psb",
  );
  const outputPath = path.join(outputRoot, "cleaned.psb");
  await fs.writeFile(source, "source");
  await fs.mkdir(path.dirname(quarantinePath), { recursive: true });
  await fs.writeFile(quarantinePath, "cleaned");
  const config = createDefaultConfig(dataRoot, {
    allowedInputRoots: [inputRoot],
    allowedOutputRoots: [outputRoot],
  });
  await ensureDataDirectories(config);
  const service = await CleanerService.open(config);
  try {
    const { job } = service.store.createJob(
      {
        sourcePath: source,
        profile: "standard",
        runMode: "auto_if_eligible",
        executionMode: "safe_copy",
        outputMode: "specified_directory",
        outputDir: outputRoot,
        source: "ui",
      },
      source,
      false,
      true,
      true,
    );
    const reportDirectory = path.join(dataRoot, "reports", job.id);
    const reportJsonPath = path.join(reportDirectory, "report.json");
    const reportHtmlPath = path.join(reportDirectory, "report.html");
    await fs.mkdir(reportDirectory, { recursive: true });
    await fs.writeFile(
      reportJsonPath,
      JSON.stringify({
        schemaVersion: 1,
        reportVersion: "1.0",
        jobId: job.id,
        machineId: job.machineId,
        status: "quarantined",
        reasonCode: "PIXEL_NOT_EXACT",
        startedAt: job.createdAt,
        finishedAt: new Date().toISOString(),
        source: { path: source, unchanged: true },
        policy: {},
        environment: {},
        preflight: {},
        execution: {},
        validation: {
          passed: false,
          errors: ["PIXEL_NOT_EXACT"],
          warnings: ["CROSS_BIT_DEPTH_PATHS_PRESENT"],
        },
        output: { path: quarantinePath },
        timing: {},
        logs: {},
      }),
      "utf8",
    );
    await fs.writeFile(reportHtmlPath, "report", "utf8");
    service.store.updateJob(job.id, {
      status: "quarantined",
      reasonCode: "PIXEL_NOT_EXACT",
      outputPath,
      quarantinePath,
      reportJsonPath,
      reportHtmlPath,
      finishedAt: new Date().toISOString(),
    });

    const context = await service.getReviewContext(job.id);
    assert.equal(context.resultPath, quarantinePath);
    assert.equal(context.resultExists, true);
    assert.deepEqual(context.previews, {});

    const kept = await service.recordManualReview({
      jobId: job.id,
      decision: "keep_quarantined",
      note: "暂不交付",
    });
    assert.equal(kept.status, "quarantined");
    assert.equal(kept.reviewStatus, "kept_quarantined");
    assert.equal(kept.reviewNote, "暂不交付");
    assert.equal(await fs.readFile(quarantinePath, "utf8"), "cleaned");

    const accepted = await service.recordManualReview({
      jobId: job.id,
      decision: "accept_with_warnings",
      note: "肉眼检查未见异常",
    });
    assert.equal(accepted.status, "succeeded");
    assert.equal(accepted.reasonCode, "HUMAN_APPROVED_WITH_WARNINGS");
    assert.equal(accepted.reviewStatus, "accepted_with_warnings");
    assert.equal(accepted.quarantinePath, null);
    assert.equal(await fs.readFile(outputPath, "utf8"), "cleaned");
    await assert.rejects(fs.access(quarantinePath));
    const reviewedReport = (await service.getReport(job.id)) as Record<
      string,
      any
    >;
    assert.equal(
      reviewedReport.manualReview.status,
      "accepted_with_warnings",
    );
    assert.deepEqual(reviewedReport.manualReview.ignoredAutomaticChecks, [
      "PIXEL_NOT_EXACT",
      "CROSS_BIT_DEPTH_PATHS_PRESENT",
    ]);
    assert.equal(reviewedReport.output.path, outputPath);

    const { job: discardJob } = service.store.createJob(
      {
        sourcePath: source,
        profile: "standard",
        runMode: "auto_if_eligible",
        executionMode: "safe_copy",
        outputMode: "specified_directory",
        outputDir: outputRoot,
        source: "ui",
      },
      source,
      false,
      true,
      true,
    );
    const discardQuarantineDirectory = path.join(
      dataRoot,
      "quarantine",
      discardJob.id,
    );
    const discardQuarantinePath = path.join(
      discardQuarantineDirectory,
      "discard.psb",
    );
    const discardWorkDirectory = path.join(dataRoot, "work", discardJob.id);
    const discardReportDirectory = path.join(
      dataRoot,
      "reports",
      discardJob.id,
    );
    const discardArtifactsDirectory = path.join(
      discardReportDirectory,
      "artifacts",
    );
    const discardReportJsonPath = path.join(
      discardReportDirectory,
      "report.json",
    );
    const discardReportHtmlPath = path.join(
      discardReportDirectory,
      "report.html",
    );
    const backupPath = path.join(outputRoot, "source.backup.psb");
    await Promise.all([
      fs.mkdir(discardQuarantineDirectory, { recursive: true }),
      fs.mkdir(discardWorkDirectory, { recursive: true }),
      fs.mkdir(discardArtifactsDirectory, { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(discardQuarantinePath, "discard me"),
      fs.writeFile(path.join(discardWorkDirectory, "work.psb"), "work"),
      fs.writeFile(path.join(discardArtifactsDirectory, "before.png"), "preview"),
      fs.writeFile(
        path.join(discardArtifactsDirectory, "photoshop.log"),
        "photoshop detail",
      ),
      fs.writeFile(backupPath, "backup"),
      fs.writeFile(
        discardReportJsonPath,
        JSON.stringify({
          schemaVersion: 1,
          reportVersion: "1.0",
          appVersion: "test",
          jobId: discardJob.id,
          machineId: discardJob.machineId,
          status: "quarantined",
          reasonCode: "PIXEL_NOT_EXACT",
          startedAt: discardJob.createdAt,
          finishedAt: new Date().toISOString(),
          source: { path: source, unchanged: true },
          policy: {},
          environment: {},
          preflight: {},
          execution: {},
          validation: { errors: ["PIXEL_NOT_EXACT"], warnings: [] },
          output: { path: discardQuarantinePath },
          timing: {},
          logs: {},
        }),
        "utf8",
      ),
      fs.writeFile(discardReportHtmlPath, "report"),
    ]);
    service.store.updateJob(discardJob.id, {
      status: "quarantined",
      reasonCode: "PIXEL_NOT_EXACT",
      outputPath: path.join(outputRoot, "discard.psb"),
      quarantinePath: discardQuarantinePath,
      backupPath,
      reportJsonPath: discardReportJsonPath,
      reportHtmlPath: discardReportHtmlPath,
      finishedAt: new Date().toISOString(),
    });
    const discarded = await service.recordManualReview(
      {
        jobId: discardJob.id,
        decision: "discard_result",
        note: "画面不符合交付要求",
      },
      {
        recycleDirectory: async (target) => {
          await fs.rm(target, { recursive: true });
        },
      },
    );
    assert.equal(discarded.status, "discarded");
    assert.equal(discarded.reviewStatus, "discarded");
    assert.equal(discarded.reasonCode, "HUMAN_DISCARDED_REVIEW_RESULT");
    assert.equal(discarded.outputPath, null);
    assert.equal(discarded.quarantinePath, null);
    await assert.rejects(fs.access(discardQuarantineDirectory));
    await assert.rejects(fs.access(discardWorkDirectory));
    await assert.rejects(fs.access(discardArtifactsDirectory));
    assert.equal(await fs.readFile(source, "utf8"), "source");
    assert.equal(await fs.readFile(backupPath, "utf8"), "backup");
    const preservedPhotoshopLog = path.join(
      dataRoot,
      "logs",
      "jobs",
      `${discardJob.id}.photoshop.log`,
    );
    assert.equal(
      await fs.readFile(preservedPhotoshopLog, "utf8"),
      "photoshop detail",
    );
    const discardedReport = (await service.getReport(discardJob.id)) as Record<
      string,
      any
    >;
    assert.equal(discardedReport.manualReview.status, "discarded");
    assert.equal(discardedReport.manualReview.sourceFilePreserved, true);
    assert.equal(
      discardedReport.manualReview.photoshopLogPreservedAt,
      preservedPhotoshopLog,
    );
    assert.equal(discardedReport.logs.photoshopLog, preservedPhotoshopLog);
    assert.equal(discardedReport.output.path, null);
  } finally {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("service rejects invalid task and watcher enums before path access", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "psb-input-test-"));
  const config = createDefaultConfig(root, {
    allowedInputRoots: [root],
    allowedOutputRoots: [root],
  });
  await ensureDataDirectories(config);
  const service = await CleanerService.open(config);
  try {
    await assert.rejects(
      service.submitJobs([
        {
          sourcePath: "Z:\\not-read.psb",
          profile: "unsafe" as any,
          runMode: "inspect_only",
          outputMode: "specified_directory",
          source: "mcp",
        },
      ]),
      /无效的清理策略/,
    );
    await assert.rejects(
      service.addWatcher({
        path: root,
        profile: "standard",
        runMode: "unattended-unsafe" as any,
        outputMode: "source_subfolder",
        enabled: true,
      }),
      /无效的监控任务模式/,
    );
  } finally {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("automatic folder can pause and resume without cancelling existing jobs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "psmetac-watcher-toggle-"));
  const dataRoot = path.join(root, "data");
  const watcherRoot = path.join(root, "watcher");
  const outputRoot = path.join(root, "output");
  await Promise.all([
    fs.mkdir(dataRoot),
    fs.mkdir(watcherRoot),
    fs.mkdir(outputRoot),
  ]);
  const config = createDefaultConfig(dataRoot, {
    allowedInputRoots: [watcherRoot],
    allowedOutputRoots: [outputRoot],
  });
  await ensureDataDirectories(config);
  const service = await CleanerService.open(config);
  try {
    const watcher = await service.addWatcher({
      path: watcherRoot,
      profile: "standard",
      runMode: "auto_if_eligible",
      executionMode: "safe_copy",
      backupSource: true,
      outputMode: "specified_directory",
      outputDir: outputRoot,
      enabled: true,
    });
    const paused = await service.setWatcherEnabled({
      watcherId: watcher.id,
      enabled: false,
    });
    assert.equal(paused.enabled, false);
    assert.equal(paused.scanStatus, "idle");
    assert.equal(paused.waitingStableFiles, 0);
    const resumed = await service.setWatcherEnabled({
      watcherId: watcher.id,
      enabled: true,
    });
    assert.equal(resumed.enabled, true);
  } finally {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("desktop exact selections are recorded without widening configured roots", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "psb-ui-selection-"));
  const configuredInput = path.join(root, "configured-input");
  const configuredOutput = path.join(root, "configured-output");
  const manualInput = path.join(root, "manual-input");
  const manualOutput = path.join(root, "manual-output");
  const dataRoot = path.join(root, "data");
  await Promise.all([
    fs.mkdir(configuredInput),
    fs.mkdir(configuredOutput),
    fs.mkdir(manualInput),
    fs.mkdir(manualOutput),
    fs.mkdir(dataRoot),
  ]);
  const source = path.join(manualInput, "selected.psb");
  await fs.writeFile(source, "not a Photoshop document");
  const config = createDefaultConfig(dataRoot, {
    allowedInputRoots: [configuredInput],
    allowedOutputRoots: [configuredOutput],
  });
  await ensureDataDirectories(config);
  const service = await CleanerService.open(config);
  service.pauseQueue();
  try {
    const [{ job }] = await service.submitJobs(
      [
        {
          sourcePath: source,
          profile: "standard",
          runMode: "auto_if_eligible",
          outputMode: "specified_directory",
          outputDir: manualOutput,
          source: "ui",
        },
      ],
      {
        explicitlySelectedSources: [source],
        explicitlySelectedOutputDirectories: [manualOutput],
      },
    );
    assert.equal(job.explicitSourceSelection, true);
    assert.equal(job.explicitOutputSelection, true);
    assert.deepEqual(service.config.allowedInputRoots, [
      path.resolve(configuredInput),
    ]);
    assert.deepEqual(service.config.allowedOutputRoots, [
      path.resolve(configuredOutput),
    ]);
  } finally {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("destructive layer cleanup requires an explicitly selected safe-copy UI task", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "psmetac-layer-cleanup-"));
  const source = path.join(root, "selected.psb");
  await fs.writeFile(source, "not a Photoshop document");
  const config = createDefaultConfig(path.join(root, "data"), {
    allowedInputRoots: [root],
    allowedOutputRoots: [root],
  });
  await ensureDataDirectories(config);
  const service = await CleanerService.open(config);
  service.pauseQueue();
  try {
    const [{ job }] = await service.submitJobs(
      [
        {
          sourcePath: source,
          profile: "standard",
          runMode: "auto_if_eligible",
          executionMode: "safe_copy",
          outputMode: "source_subfolder",
          source: "ui",
          deleteHiddenLayers: true,
          deleteEmptyLayers: true,
          requiredValidationChecks: [
            "target_xmp_removed",
            "structure_topology",
          ],
        },
      ],
      { explicitlySelectedSources: [source] },
    );
    assert.equal(job.deleteHiddenLayers, true);
    assert.equal(job.deleteEmptyLayers, true);
    assert.deepEqual(job.requiredValidationChecks, ["target_xmp_removed"]);

    await assert.rejects(
      service.submitJobs(
        [
          {
            sourcePath: source,
            profile: "standard",
            runMode: "auto_if_eligible",
            executionMode: "in_place",
            outputMode: "source_subfolder",
            source: "ui",
            deleteHiddenLayers: true,
          },
        ],
        { explicitlySelectedSources: [source] },
      ),
      /只允许生成安全副本/u,
    );
    await assert.rejects(
      service.submitJobs([
        {
          sourcePath: source,
          profile: "standard",
          runMode: "auto_if_eligible",
          executionMode: "safe_copy",
          outputMode: "source_subfolder",
          source: "mcp",
          deleteEmptyLayers: true,
        },
      ]),
      /桌面界面手动选择/u,
    );
  } finally {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("history dashboard separates actual disk savings from output reduction and added copies", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "psmetac-history-stats-"));
  const dataRoot = path.join(root, "data");
  await ensureDataDirectories(
    createDefaultConfig(dataRoot, {
      allowedInputRoots: [root],
      allowedOutputRoots: [root],
    }),
  );
  const service = await CleanerService.open(
    createDefaultConfig(dataRoot, {
      allowedInputRoots: [root],
      allowedOutputRoots: [root],
    }),
  );
  service.pauseQueue();
  try {
    const directSource = path.join(root, "direct.psb");
    const copySource = path.join(root, "copy.psd");
    const copyOutput = path.join(root, "copy.cleaned.psd");
    await Promise.all([
      fs.writeFile(directSource, Buffer.alloc(50)),
      fs.writeFile(copySource, Buffer.alloc(100)),
      fs.writeFile(copyOutput, Buffer.alloc(40)),
    ]);
    const direct = service.store.createJob(
      {
        sourcePath: directSource,
        profile: "standard",
        runMode: "auto_if_eligible",
        executionMode: "in_place",
        outputMode: "source_subfolder",
        source: "ui",
      },
      directSource,
      false,
      true,
      true,
    ).job;
    const copied = service.store.createJob(
      {
        sourcePath: copySource,
        profile: "standard",
        runMode: "auto_if_eligible",
        executionMode: "safe_copy",
        outputMode: "specified_directory",
        outputDir: root,
        source: "ui",
        deleteHiddenLayers: true,
      },
      copySource,
      true,
      true,
      true,
    ).job;
    const directReport = path.join(dataRoot, "reports", direct.id, "report.json");
    const copyReport = path.join(dataRoot, "reports", copied.id, "report.json");
    await Promise.all([
      fs.mkdir(path.dirname(directReport), { recursive: true }),
      fs.mkdir(path.dirname(copyReport), { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(
        directReport,
        JSON.stringify({
          source: { beforeBytes: 100, afterBytes: 50 },
          output: { bytes: 50 },
          execution: {},
        }),
      ),
      fs.writeFile(
        copyReport,
        JSON.stringify({
          source: { beforeBytes: 100, afterBytes: 100 },
          output: { bytes: 40 },
          execution: {
            contentCleanup: {
              requested: { hidden: true, empty: false },
              deletedHidden: [{ path: "隐藏组" }],
              deletedEmpty: [],
            },
          },
        }),
      ),
    ]);
    service.store.updateJob(direct.id, {
      status: "succeeded",
      reportJsonPath: directReport,
      finishedAt: new Date().toISOString(),
    });
    service.store.updateJob(copied.id, {
      status: "quarantined",
      outputPath: copyOutput,
      reportJsonPath: copyReport,
      finishedAt: new Date().toISOString(),
    });

    const stats = (await service.historyStatistics({ periodDays: null })) as any;
    assert.equal(stats.tasks.total, 2);
    assert.equal(stats.tasks.uniqueSources, 2);
    assert.deepEqual(stats.tasks.byFormat, { psd: 1, psb: 1 });
    assert.equal(stats.storage.actualFreedBytes, 50);
    assert.equal(stats.storage.outputReductionBytes, 110);
    assert.equal(stats.storage.currentSafeCopyBytes, 40);
    assert.equal(stats.storage.currentAddedBytes, 40);
    assert.equal(stats.contentCleanup.tasks, 1);
    assert.equal(stats.contentCleanup.hiddenLayersDeleted, 1);
  } finally {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("experimental PSD rejects unattended automatic execution", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "psb-psd-mode-"));
  const source = path.join(root, "experimental.psd");
  await fs.writeFile(source, "not a Photoshop document");
  const config = createDefaultConfig(path.join(root, "data"), {
    allowedInputRoots: [root],
    allowedOutputRoots: [root],
    experimentalPsd: true,
  });
  await ensureDataDirectories(config);
  const service = await CleanerService.open(config);
  try {
    await assert.rejects(
      service.submitJobs([
        {
          sourcePath: source,
          profile: "standard",
          runMode: "auto_if_eligible",
          outputMode: "source_subfolder",
          source: "ui",
        },
      ]),
      /尚未开启 PSD 无人值守/,
    );
  } finally {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("experimental PSD accepts unattended automatic execution only when enabled", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "psb-psd-unattended-"));
  const source = path.join(root, "experimental.psd");
  await fs.writeFile(source, "not a Photoshop document");
  const config = createDefaultConfig(path.join(root, "data"), {
    allowedInputRoots: [root],
    allowedOutputRoots: [root],
    experimentalPsd: true,
    experimentalPsdUnattended: true,
  });
  await ensureDataDirectories(config);
  const service = await CleanerService.open(config);
  service.pauseQueue();
  try {
    const [{ job }] = await service.submitJobs([
      {
        sourcePath: source,
        profile: "standard",
        runMode: "auto_if_eligible",
        outputMode: "source_subfolder",
        source: "ui",
      },
    ]);
    assert.equal(job.experimental, true);
    assert.equal(job.runMode, "auto_if_eligible");
  } finally {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("batch validation is all-or-nothing before any job is created", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "psb-batch-atomic-"));
  const psb = path.join(root, "first.psb");
  const psd = path.join(root, "second.psd");
  await Promise.all([
    fs.writeFile(psb, "not a Photoshop document"),
    fs.writeFile(psd, "not a Photoshop document"),
  ]);
  const config = createDefaultConfig(path.join(root, "data"), {
    allowedInputRoots: [root],
    allowedOutputRoots: [root],
    experimentalPsd: false,
  });
  await ensureDataDirectories(config);
  const service = await CleanerService.open(config);
  service.pauseQueue();
  try {
    await assert.rejects(
      service.submitJobs([
        {
          sourcePath: psb,
          runMode: "inspect_only",
          outputMode: "specified_directory",
          source: "ui",
        },
        {
          sourcePath: psd,
          runMode: "inspect_only",
          outputMode: "specified_directory",
          source: "ui",
        },
      ]),
      /PSD 实验功能尚未启用/,
    );
    assert.equal(service.listJobs().length, 0);
  } finally {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("only one exclusive service can own a data directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "psmetac-lease-"));
  const config = createDefaultConfig(path.join(root, "data"), {
    allowedInputRoots: [root],
    allowedOutputRoots: [root],
  });
  await ensureDataDirectories(config);
  const first = await CleanerService.open(config);
  try {
    await assert.rejects(
      CleanerService.open(config),
      /PSMetaC 已在运行/,
    );
  } finally {
    await first.close();
  }
  const reopened = await CleanerService.open(config);
  await reopened.close();
  await fs.rm(root, { recursive: true, force: true });
});

test("desktop removal preserves task data until a separate explicit deletion", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "psmetac-archive-"));
  const source = path.join(root, "mistake.psb");
  const dataRoot = path.join(root, "data");
  await fs.writeFile(source, "not a Photoshop document");
  const config = createDefaultConfig(dataRoot, {
    allowedInputRoots: [root],
    allowedOutputRoots: [root],
  });
  await ensureDataDirectories(config);
  const service = await CleanerService.open(config);
  service.pauseQueue();
  try {
    const [{ job }] = await service.submitJobs([
      {
        sourcePath: source,
        profile: "standard",
        runMode: "inspect_only",
        outputMode: "specified_directory",
        source: "ui",
      },
    ]);
    const archived = await service.archiveJob(job.id);
    const reportPath = archived.reportJsonPath!;
    const eventLogPath = path.join(
      dataRoot,
      "logs",
      "jobs",
      `${job.id}.events.jsonl`,
    );
    assert.equal(archived.status, "cancelled");
    assert.ok(archived.archivedAt);
    assert.equal(service.listJobs().length, 0);
    await fs.access(reportPath);
    await fs.access(eventLogPath);
    const events = service.store.listEvents(job.id);
    assert.equal(
      events.at(-1)?.eventType,
      "JOB_REMOVED_FROM_LIST",
    );
    const deleted = await service.deleteJobData(job.id);
    assert.equal((deleted as any).sidecarReportsPreserved, true);
    await assert.rejects(fs.access(reportPath));
    await assert.rejects(fs.access(eventLogPath));
    assert.throws(() => service.getJob(job.id), /找不到任务/u);
    const audit = await fs.readFile(
      path.join(dataRoot, "logs", "audit.jsonl"),
      "utf8",
    );
    assert.match(audit, /JOB_DATA_DELETED/u);
  } finally {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("in-place jobs require explicit mode but do not require an output directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "psmetac-in-place-"));
  const source = path.join(root, "direct.psb");
  const dataRoot = path.join(root, "data");
  await fs.writeFile(source, "synthetic placeholder");
  const config = createDefaultConfig(dataRoot, {
    allowedInputRoots: [root],
    allowedOutputRoots: [],
  });
  await ensureDataDirectories(config);
  const service = await CleanerService.open(config);
  service.pauseQueue();
  try {
    const [{ job }] = await service.submitJobs(
      [
        {
          sourcePath: source,
          profile: "standard",
          runMode: "auto_if_eligible",
          executionMode: "in_place",
          backupSource: false,
          outputMode: "specified_directory",
          source: "ui",
        },
      ],
      { explicitlySelectedSources: [source] },
    );
    assert.equal(job.executionMode, "in_place");
    assert.equal(job.backupSource, false);
    assert.equal(job.outputDir, null);
    assert.equal(job.explicitSourceSelection, true);
    assert.equal(job.explicitOutputSelection, true);
  } finally {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("stop after current cancels every waiting job and keeps the queue paused", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "psmetac-stop-queue-"));
  const dataRoot = path.join(root, "data");
  const first = path.join(root, "first.psb");
  const second = path.join(root, "second.psb");
  await Promise.all([
    fs.writeFile(first, "synthetic placeholder"),
    fs.writeFile(second, "synthetic placeholder"),
  ]);
  const config = createDefaultConfig(dataRoot, {
    allowedInputRoots: [root],
    allowedOutputRoots: [root],
  });
  await ensureDataDirectories(config);
  const service = await CleanerService.open(config);
  service.pauseQueue();
  try {
    const created = await service.submitJobs([
      {
        sourcePath: first,
        runMode: "inspect_only",
        outputMode: "source_subfolder",
        source: "mcp",
      },
      {
        sourcePath: second,
        runMode: "inspect_only",
        outputMode: "source_subfolder",
        source: "mcp",
      },
    ]);
    const result = (await service.stopQueueAfterCurrent()) as Record<
      string,
      any
    >;
    assert.equal(result.paused, true);
    assert.deepEqual(
      new Set(result.cancelledJobIds),
      new Set(created.map((item) => item.job.id)),
    );
    for (const item of created) {
      assert.equal(service.getJob(item.job.id).status, "cancelled");
      assert.equal(
        service.getJob(item.job.id).reasonCode,
        "CANCELLED_BEFORE_PHOTOSHOP",
      );
    }
  } finally {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("pause records the active file so it can finish before the queue stays paused", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "psmetac-drain-"));
  const source = path.join(root, "active.psb");
  const dataRoot = path.join(root, "data");
  await fs.writeFile(source, "synthetic placeholder");
  const config = createDefaultConfig(dataRoot, {
    allowedInputRoots: [root],
    allowedOutputRoots: [root],
  });
  await ensureDataDirectories(config);
  const service = await CleanerService.open(config);
  service.pauseQueue();
  try {
    const [{ job }] = await service.submitJobs([
      {
        sourcePath: source,
        runMode: "inspect_only",
        outputMode: "source_subfolder",
        source: "mcp",
      },
    ]);
    service.store.updateJob(job.id, { status: "preflighting" });
    const paused = service.pauseQueue() as Record<string, any>;
    assert.equal(paused.completesCurrentBeforePause, true);
    assert.equal(paused.finishCurrentJobId, job.id);
    service.store.updateJob(job.id, {
      status: "preflight_complete",
      finishedAt: new Date().toISOString(),
    });
    await service.worker.tick();
    const after = service.queueStatus() as Record<string, any>;
    assert.equal(after.paused, true);
    assert.equal(after.finishCurrentJobId, null);
  } finally {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
