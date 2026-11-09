import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  createDefaultConfig,
  ensureDataDirectories,
} from "../src/config.ts";
import { JobStore } from "../src/database.ts";

test("SQLite store enforces idempotency and chains audit hashes", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "psb-db-test-"));
  const config = createDefaultConfig(root, {
    allowedInputRoots: [root],
    allowedOutputRoots: [root],
  });
  await ensureDataDirectories(config);
  const store = new JobStore(config);
  context.after(async () => {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  assert.equal(store.integrityCheck(), "ok");
  const input = {
    sourcePath: path.join(root, "sample.psb"),
    profile: "standard" as const,
    runMode: "inspect_only" as const,
    outputMode: "specified_directory" as const,
    source: "mcp" as const,
    clientRequestId: "stable-request-1",
    requiredValidationChecks: [
      "target_xmp_removed",
      "structure_topology",
    ] as const,
    watcherId: "watcher-source-1",
    deleteHiddenLayers: true,
    deleteEmptyLayers: true,
  };
  const first = store.createJob(input, input.sourcePath, false);
  const second = store.createJob(input, input.sourcePath, false);
  assert.equal(first.existing, false);
  assert.equal(second.existing, true);
  assert.equal(first.job.id, second.job.id);
  assert.equal(first.job.submissionSource, "mcp");
  assert.deepEqual(first.job.requiredValidationChecks, [
    "target_xmp_removed",
    "structure_topology",
  ]);
  assert.equal(first.job.watcherId, "watcher-source-1");
  assert.equal(first.job.coveragePolicy, "strict");
  assert.equal(first.job.coverageThresholdPercent, 5);
  assert.equal(first.job.deleteHiddenLayers, true);
  assert.equal(first.job.deleteEmptyLayers, true);
  const duplicatePath = store.createJob(
    { ...input, clientRequestId: "stable-request-2" },
    input.sourcePath,
    false,
  );
  assert.equal(duplicatePath.existing, true);
  assert.equal(duplicatePath.job.id, first.job.id);

  const progressed = store.updateJob(first.job.id, {
    progress: 0.42,
    progressStage: "work_copy",
    progressCurrent: 42,
    progressTotal: 100,
    progressDetail: "copying",
    photoshopVersion: "26.11",
    preflightStartedAt: "2026-07-29T01:00:00.000Z",
    preflightFinishedAt: "2026-07-29T01:00:05.000Z",
    executionStartedAt: "2026-07-29T01:00:10.000Z",
    validationStartedAt: "2026-07-29T01:01:00.000Z",
  });
  assert.equal(progressed.progressStage, "work_copy");
  assert.equal(progressed.progressCurrent, 42);
  assert.equal(progressed.progressTotal, 100);
  assert.equal(progressed.progressDetail, "copying");
  assert.equal(progressed.photoshopVersion, "26.11");
  assert.equal(progressed.preflightStartedAt, "2026-07-29T01:00:00.000Z");
  assert.equal(progressed.executionStartedAt, "2026-07-29T01:00:10.000Z");

  const tag = store.createUserTag("客户已确认", "#5965e8");
  store.setJobUserTags([first.job.id], [tag.id]);
  assert.deepEqual(store.listJobUserTags(first.job.id).map((item) => item.name), [
    "客户已确认",
  ]);
  const renamed = store.updateUserTag(tag.id, {
    name: "等待交付",
    color: "#008877",
  });
  assert.equal(renamed.name, "等待交付");
  assert.equal(renamed.color, "#008877");
  store.deleteUserTag(tag.id);
  assert.deepEqual(store.listJobUserTags(first.job.id), []);
  assert.equal(
    (
      store.db
        .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
        .get() as Record<string, unknown>
    ).value,
    "9",
  );

  const event1 = store.addEvent({
    jobId: first.job.id,
    level: "info",
    stage: "test",
    eventType: "FIRST",
    message: "first",
  });
  const event2 = store.addEvent({
    jobId: first.job.id,
    level: "info",
    stage: "test",
    eventType: "SECOND",
    message: "second",
  });
  assert.equal(event2.prevHash, event1.eventHash);
  assert.notEqual(event2.eventHash, event1.eventHash);
  assert.deepEqual(store.verifyEventChain(first.job.id), {
    valid: true,
    checked: 2,
    brokenAtSeq: null,
  });
  store.db
    .prepare("UPDATE events SET message = 'tampered' WHERE seq = ?")
    .run(event1.seq);
  assert.equal(store.verifyEventChain(first.job.id).valid, false);

  store.updateJob(first.job.id, { status: "succeeded" });
  const deliberateRerun = store.createJob(
    { ...input, clientRequestId: "stable-request-3" },
    input.sourcePath,
    false,
  );
  assert.equal(deliberateRerun.existing, false);
  assert.notEqual(deliberateRerun.job.id, first.job.id);
});

test("existing queue database gains finish-current column before it is used", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "psmetac-db-migrate-"));
  const config = createDefaultConfig(root, {
    allowedInputRoots: [root],
    allowedOutputRoots: [root],
  });
  await ensureDataDirectories(config);
  const dbPath = path.join(root, "db", "jobs.sqlite");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE queue_state (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      paused INTEGER NOT NULL,
      critical_reason TEXT,
      updated_at TEXT NOT NULL
    );
    INSERT INTO queue_state(singleton, paused, critical_reason, updated_at)
      VALUES(1, 0, NULL, '2026-07-28T00:00:00.000Z');
  `);
  legacy.close();

  const store = new JobStore(config);
  context.after(async () => {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  assert.equal(store.getQueueState().finishCurrentJobId, null);
  store.setQueueState(true, null, "job-being-finished");
  assert.equal(
    store.getQueueState().finishCurrentJobId,
    "job-being-finished",
  );
});

test("existing alpha.5 job database gains staged progress and user tags", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "psmetac-db-v5-"));
  const config = createDefaultConfig(root, {
    allowedInputRoots: [root],
    allowedOutputRoots: [root],
  });
  await ensureDataDirectories(config);
  const dbPath = path.join(root, "db", "jobs.sqlite");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL,
      client_request_id TEXT UNIQUE,
      source_path TEXT NOT NULL,
      source_bytes INTEGER,
      source_mtime_ms INTEGER,
      source_sha256 TEXT,
      profile TEXT NOT NULL,
      run_mode TEXT NOT NULL,
      execution_mode TEXT NOT NULL DEFAULT 'safe_copy',
      backup_source INTEGER NOT NULL DEFAULT 1,
      output_mode TEXT NOT NULL,
      output_dir TEXT,
      status TEXT NOT NULL,
      reason_code TEXT,
      progress REAL NOT NULL DEFAULT 0,
      attempt INTEGER NOT NULL DEFAULT 0,
      experimental INTEGER NOT NULL DEFAULT 0,
      explicit_source_selection INTEGER NOT NULL DEFAULT 0,
      explicit_output_selection INTEGER NOT NULL DEFAULT 0,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT,
      report_json_path TEXT,
      report_html_path TEXT,
      output_path TEXT,
      backup_path TEXT,
      quarantine_path TEXT,
      preflight_json_path TEXT,
      cleanup_plan_path TEXT,
      archived_at TEXT
    );
  `);
  legacy.close();

  const store = new JobStore(config);
  context.after(async () => {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const input = {
    sourcePath: path.join(root, "legacy.psb"),
    profile: "standard" as const,
    runMode: "inspect_only" as const,
    outputMode: "specified_directory" as const,
    source: "cli" as const,
  };
  const { job } = store.createJob(input, input.sourcePath, false);
  assert.equal(job.submissionSource, "cli");
  assert.equal(job.progressStage, "queued");
  assert.equal(job.progressDetail, "等待开始只读检查");
  assert.equal(job.reviewStatus, null);
  assert.equal(job.reviewedAt, null);
  assert.equal(job.reviewedBy, null);
  assert.equal(job.reviewNote, null);
  const tag = store.createUserTag("旧库升级", "#445566");
  store.setJobUserTags([job.id], [tag.id]);
  assert.equal(store.listJobUserTags(job.id)[0]?.name, "旧库升级");
});

test("schema 7 database is backed up before transactional migration", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "psmetac-db-v7-backup-"));
  const config = createDefaultConfig(root, {
    allowedInputRoots: [root],
    allowedOutputRoots: [root],
  });
  await ensureDataDirectories(config);
  const dbPath = path.join(root, "db", "jobs.sqlite");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO schema_meta(key, value) VALUES('schema_version', '7');
    CREATE TABLE legacy_marker (value TEXT NOT NULL);
    INSERT INTO legacy_marker(value) VALUES('must-survive');
  `);
  legacy.close();

  const store = new JobStore(config);
  context.after(async () => {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const backups = await fs.readdir(path.join(root, "db", "backups"));
  assert.equal(backups.length, 1);
  const backup = new DatabaseSync(path.join(root, "db", "backups", backups[0]));
  assert.equal(
    (backup.prepare("SELECT value FROM legacy_marker").get() as { value: string }).value,
    "must-survive",
  );
  backup.close();
  assert.equal(
    (
      store.db
        .prepare("SELECT value FROM schema_meta WHERE key='schema_version'")
        .get() as { value: string }
    ).value,
    "9",
  );
});

test("automatic folder persists coverage policy for unattended jobs", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "psmetac-watcher-policy-"));
  const config = createDefaultConfig(root, {
    allowedInputRoots: [root],
    allowedOutputRoots: [root],
  });
  await ensureDataDirectories(config);
  const store = new JobStore(config);
  context.after(async () => {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  store.upsertWatcher({
    id: "watcher-coverage",
    path: root,
    profile: "standard",
    runMode: "auto_if_eligible",
    executionMode: "safe_copy",
    backupSource: true,
    coveragePolicy: "threshold",
    coverageThresholdPercent: 2.5,
    outputMode: "specified_directory",
    outputDir: root,
    recursive: true,
    requiredValidationChecks: ["target_xmp_removed"],
    enabled: true,
    createdAt: new Date().toISOString(),
    lastScanAt: null,
    scanStatus: "idle",
    scannedFiles: 0,
    supportedFiles: 0,
    waitingStableFiles: 0,
    submittedJobs: 0,
    skippedFiles: 0,
    lastError: null,
  });
  const watcher = store.listWatchers()[0];
  assert.equal(watcher.coveragePolicy, "threshold");
  assert.equal(watcher.coverageThresholdPercent, 2.5);
});
