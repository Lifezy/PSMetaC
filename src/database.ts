import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AppConfig,
  EventLevel,
  JobRecord,
  JobStatus,
  SubmitJobInput,
  UserTag,
  WatcherConfig,
} from "./types.ts";
import {
  DEFAULT_VALIDATION_CHECKS,
  VALIDATION_CHECKS,
  type ValidationCheck,
} from "./types.ts";

const ACTIVE_STATUSES: JobStatus[] = [
  "waiting_stable",
  "queued_preflight",
  "preflighting",
  "ready",
  "awaiting_approval",
  "waiting_photoshop",
  "copying",
  "running",
  "validating",
];

export interface WatcherFileRecord {
  watcherId: string;
  sourcePath: string;
  sizeBytes: number;
  mtimeMs: number;
  unchangedSince: number;
  lastSubmittedSignature: string | null;
  lastJobId: string | null;
  state: string;
  updatedAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function asBoolean(value: unknown): boolean {
  return Number(value) === 1;
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function validationChecksFromJson(value: unknown): ValidationCheck[] {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    if (
      Array.isArray(parsed) &&
      parsed.every((item) => VALIDATION_CHECKS.includes(item))
    ) {
      return [...new Set(parsed)] as ValidationCheck[];
    }
  } catch {
    // Old or damaged optional values fall back to the strict policy.
  }
  return [...DEFAULT_VALIDATION_CHECKS];
}

function rowToTag(row: Record<string, unknown>): UserTag {
  return {
    id: String(row.id),
    name: String(row.name),
    color: String(row.color),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToJob(row: Record<string, unknown>): JobRecord {
  return {
    id: String(row.id),
    machineId: String(row.machine_id),
    clientRequestId:
      row.client_request_id === null ? null : String(row.client_request_id),
    sourcePath: String(row.source_path),
    sourceBytes:
      row.source_bytes === null ? null : Number(row.source_bytes),
    sourceMtimeMs:
      row.source_mtime_ms === null ? null : Number(row.source_mtime_ms),
    sourceSha256:
      row.source_sha256 === null ? null : String(row.source_sha256),
    profile: row.profile as JobRecord["profile"],
    runMode: row.run_mode as JobRecord["runMode"],
    executionMode:
      (row.execution_mode as JobRecord["executionMode"]) || "safe_copy",
    backupSource:
      row.backup_source === undefined ? true : asBoolean(row.backup_source),
    coveragePolicy:
      (row.coverage_policy as JobRecord["coveragePolicy"]) || "strict",
    coverageThresholdPercent:
      row.coverage_threshold_percent === undefined ||
      row.coverage_threshold_percent === null
        ? 5
        : Number(row.coverage_threshold_percent),
    requiredValidationChecks: validationChecksFromJson(
      row.validation_checks_json,
    ),
    deleteHiddenLayers: asBoolean(row.delete_hidden_layers),
    deleteEmptyLayers: asBoolean(row.delete_empty_layers),
    outputMode: row.output_mode as JobRecord["outputMode"],
    outputDir: row.output_dir === null ? null : String(row.output_dir),
    status: row.status as JobStatus,
    reasonCode: row.reason_code === null ? null : String(row.reason_code),
    progress: Number(row.progress),
    progressStage:
      row.progress_stage === null || row.progress_stage === undefined
        ? null
        : String(row.progress_stage),
    progressCurrent: nullableNumber(row.progress_current),
    progressTotal: nullableNumber(row.progress_total),
    progressDetail:
      row.progress_detail === null || row.progress_detail === undefined
        ? null
        : String(row.progress_detail),
    attempt: Number(row.attempt),
    experimental: asBoolean(row.experimental),
    submissionSource:
      (row.submission_source as JobRecord["submissionSource"]) || "ui",
    watcherId:
      row.watcher_id === null || row.watcher_id === undefined
        ? null
        : String(row.watcher_id),
    photoshopVersion:
      row.photoshop_version === null || row.photoshop_version === undefined
        ? null
        : String(row.photoshop_version),
    explicitSourceSelection: asBoolean(row.explicit_source_selection),
    explicitOutputSelection: asBoolean(row.explicit_output_selection),
    cancelRequested: asBoolean(row.cancel_requested),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    preflightStartedAt:
      row.preflight_started_at === null ||
      row.preflight_started_at === undefined
        ? null
        : String(row.preflight_started_at),
    preflightFinishedAt:
      row.preflight_finished_at === null ||
      row.preflight_finished_at === undefined
        ? null
        : String(row.preflight_finished_at),
    executionStartedAt:
      row.execution_started_at === null ||
      row.execution_started_at === undefined
        ? null
        : String(row.execution_started_at),
    validationStartedAt:
      row.validation_started_at === null ||
      row.validation_started_at === undefined
        ? null
        : String(row.validation_started_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
    reportJsonPath:
      row.report_json_path === null ? null : String(row.report_json_path),
    reportHtmlPath:
      row.report_html_path === null ? null : String(row.report_html_path),
    outputPath: row.output_path === null ? null : String(row.output_path),
    backupPath:
      row.backup_path === null || row.backup_path === undefined
        ? null
        : String(row.backup_path),
    quarantinePath:
      row.quarantine_path === null ? null : String(row.quarantine_path),
    reviewStatus:
      row.review_status === null || row.review_status === undefined
        ? null
        : (String(row.review_status) as JobRecord["reviewStatus"]),
    reviewedAt:
      row.reviewed_at === null || row.reviewed_at === undefined
        ? null
        : String(row.reviewed_at),
    reviewedBy:
      row.reviewed_by === null || row.reviewed_by === undefined
        ? null
        : String(row.reviewed_by),
    reviewNote:
      row.review_note === null || row.review_note === undefined
        ? null
        : String(row.review_note),
    preflightJsonPath:
      row.preflight_json_path === null
        ? null
        : String(row.preflight_json_path),
    cleanupPlanPath:
      row.cleanup_plan_path === null ? null : String(row.cleanup_plan_path),
    archivedAt:
      row.archived_at === null ? null : String(row.archived_at),
    userTags: [],
  };
}

export class JobStore {
  readonly config: AppConfig;
  readonly dbPath: string;
  readonly db: DatabaseSync;

  constructor(config: AppConfig) {
    this.config = config;
    this.dbPath = path.join(config.dataRoot, "db", "jobs.sqlite");
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=FULL");
    this.migrate();
  }

  private currentSchemaVersion(): number {
    try {
      const exists = this.db
        .prepare(
          "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='schema_meta'",
        )
        .get() as { present?: number } | undefined;
      if (!exists?.present) return 0;
      const row = this.db
        .prepare("SELECT value FROM schema_meta WHERE key='schema_version'")
        .get() as { value?: string } | undefined;
      return Number(row?.value || 0);
    } catch {
      return 0;
    }
  }

  private backupBeforeMigration(previousVersion: number): void {
    if (previousVersion <= 0 || previousVersion >= 9) return;
    const backupDirectory = path.join(this.config.dataRoot, "db", "backups");
    fsSync.mkdirSync(backupDirectory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const backupPath = path.join(
      backupDirectory,
      `jobs-before-schema-9-${stamp}.sqlite`,
    );
    this.db.exec("PRAGMA wal_checkpoint(FULL)");
    this.db.exec(`VACUUM INTO '${backupPath.replace(/'/gu, "''")}'`);
  }

  private migrate(): void {
    const previousVersion = this.currentSchemaVersion();
    this.backupBeforeMigration(previousVersion);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.applyMigrations();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private applyMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
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
        coverage_policy TEXT NOT NULL DEFAULT 'strict',
        coverage_threshold_percent REAL NOT NULL DEFAULT 5,
        validation_checks_json TEXT NOT NULL DEFAULT '["target_xmp_removed","structure_topology","smart_object_asset_ids","smart_object_success","pixel_exact","parser_clean"]',
        delete_hidden_layers INTEGER NOT NULL DEFAULT 0,
        delete_empty_layers INTEGER NOT NULL DEFAULT 0,
        output_mode TEXT NOT NULL,
        output_dir TEXT,
        status TEXT NOT NULL,
        reason_code TEXT,
        progress REAL NOT NULL DEFAULT 0,
        progress_stage TEXT,
        progress_current INTEGER,
        progress_total INTEGER,
        progress_detail TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        experimental INTEGER NOT NULL DEFAULT 0,
        submission_source TEXT NOT NULL DEFAULT 'ui',
        watcher_id TEXT,
        photoshop_version TEXT,
        explicit_source_selection INTEGER NOT NULL DEFAULT 0,
        explicit_output_selection INTEGER NOT NULL DEFAULT 0,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        preflight_started_at TEXT,
        preflight_finished_at TEXT,
        execution_started_at TEXT,
        validation_started_at TEXT,
        finished_at TEXT,
        report_json_path TEXT,
        report_html_path TEXT,
        output_path TEXT,
        backup_path TEXT,
        quarantine_path TEXT,
        review_status TEXT,
        reviewed_at TEXT,
        reviewed_by TEXT,
        review_note TEXT,
        preflight_json_path TEXT,
        cleanup_plan_path TEXT
        ,archived_at TEXT
      );
      CREATE INDEX IF NOT EXISTS jobs_status_created_idx
        ON jobs(status, created_at);
      CREATE INDEX IF NOT EXISTS jobs_archived_created_idx
        ON jobs(archived_at, created_at);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT,
        timestamp TEXT NOT NULL,
        level TEXT NOT NULL,
        stage TEXT NOT NULL,
        event_type TEXT NOT NULL,
        message TEXT NOT NULL,
        data_json TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        event_hash TEXT NOT NULL,
        FOREIGN KEY(job_id) REFERENCES jobs(id)
      );
      CREATE INDEX IF NOT EXISTS events_job_seq_idx
        ON events(job_id, seq);
      CREATE TABLE IF NOT EXISTS watchers (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        profile TEXT NOT NULL,
        run_mode TEXT NOT NULL,
        execution_mode TEXT NOT NULL DEFAULT 'safe_copy',
        backup_source INTEGER NOT NULL DEFAULT 1,
        coverage_policy TEXT NOT NULL DEFAULT 'strict',
        coverage_threshold_percent REAL NOT NULL DEFAULT 5,
        validation_checks_json TEXT NOT NULL DEFAULT '["target_xmp_removed","structure_topology","smart_object_asset_ids","smart_object_success","pixel_exact","parser_clean"]',
        output_mode TEXT NOT NULL,
        output_dir TEXT,
        recursive INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        last_scan_at TEXT,
        scan_status TEXT NOT NULL DEFAULT 'idle',
        scanned_files INTEGER NOT NULL DEFAULT 0,
        supported_files INTEGER NOT NULL DEFAULT 0,
        waiting_stable_files INTEGER NOT NULL DEFAULT 0,
        submitted_jobs INTEGER NOT NULL DEFAULT 0,
        skipped_files INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS watcher_files (
        watcher_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        unchanged_since INTEGER NOT NULL,
        last_submitted_signature TEXT,
        last_job_id TEXT,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(watcher_id, source_path),
        FOREIGN KEY(watcher_id) REFERENCES watchers(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS queue_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        paused INTEGER NOT NULL,
        critical_reason TEXT,
        finish_current_job_id TEXT,
        updated_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO queue_state(singleton, paused, critical_reason, updated_at)
        VALUES(1, 0, NULL, '${nowIso()}');
      CREATE TABLE IF NOT EXISTS service_lease (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        owner_id TEXT NOT NULL,
        pid INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_tags (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        color TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS job_user_tags (
        job_id TEXT NOT NULL,
        tag_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(job_id, tag_id),
        FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE,
        FOREIGN KEY(tag_id) REFERENCES user_tags(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS job_user_tags_tag_idx
        ON job_user_tags(tag_id, job_id);
      INSERT OR REPLACE INTO schema_meta(key, value) VALUES('schema_version', '9');
    `);
    const jobColumns = new Set(
      (this.db.prepare("PRAGMA table_info(jobs)").all() as Array<Record<string, unknown>>)
        .map((column) => String(column.name)),
    );
    if (!jobColumns.has("explicit_source_selection")) {
      this.db.exec(
        "ALTER TABLE jobs ADD COLUMN explicit_source_selection INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!jobColumns.has("explicit_output_selection")) {
      this.db.exec(
        "ALTER TABLE jobs ADD COLUMN explicit_output_selection INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!jobColumns.has("archived_at")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN archived_at TEXT");
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS jobs_archived_created_idx ON jobs(archived_at, created_at)",
      );
    }
    if (!jobColumns.has("execution_mode")) {
      this.db.exec(
        "ALTER TABLE jobs ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'safe_copy'",
      );
    }
    if (!jobColumns.has("backup_source")) {
      this.db.exec(
        "ALTER TABLE jobs ADD COLUMN backup_source INTEGER NOT NULL DEFAULT 1",
      );
    }
    if (!jobColumns.has("coverage_policy")) {
      this.db.exec(
        "ALTER TABLE jobs ADD COLUMN coverage_policy TEXT NOT NULL DEFAULT 'strict'",
      );
    }
    if (!jobColumns.has("coverage_threshold_percent")) {
      this.db.exec(
        "ALTER TABLE jobs ADD COLUMN coverage_threshold_percent REAL NOT NULL DEFAULT 5",
      );
    }
    if (!jobColumns.has("backup_path")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN backup_path TEXT");
    }
    if (!jobColumns.has("progress_stage")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN progress_stage TEXT");
    }
    if (!jobColumns.has("progress_current")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN progress_current INTEGER");
    }
    if (!jobColumns.has("progress_total")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN progress_total INTEGER");
    }
    if (!jobColumns.has("progress_detail")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN progress_detail TEXT");
    }
    if (!jobColumns.has("submission_source")) {
      this.db.exec(
        "ALTER TABLE jobs ADD COLUMN submission_source TEXT NOT NULL DEFAULT 'ui'",
      );
    }
    if (!jobColumns.has("watcher_id")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN watcher_id TEXT");
    }
    if (!jobColumns.has("photoshop_version")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN photoshop_version TEXT");
    }
    if (!jobColumns.has("review_status")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN review_status TEXT");
    }
    if (!jobColumns.has("reviewed_at")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN reviewed_at TEXT");
    }
    if (!jobColumns.has("reviewed_by")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN reviewed_by TEXT");
    }
    if (!jobColumns.has("review_note")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN review_note TEXT");
    }
    if (!jobColumns.has("validation_checks_json")) {
      this.db.exec(
        `ALTER TABLE jobs ADD COLUMN validation_checks_json TEXT NOT NULL DEFAULT '${JSON.stringify(DEFAULT_VALIDATION_CHECKS)}'`,
      );
    }
    if (!jobColumns.has("delete_hidden_layers")) {
      this.db.exec(
        "ALTER TABLE jobs ADD COLUMN delete_hidden_layers INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!jobColumns.has("delete_empty_layers")) {
      this.db.exec(
        "ALTER TABLE jobs ADD COLUMN delete_empty_layers INTEGER NOT NULL DEFAULT 0",
      );
    }
    for (const column of [
      "preflight_started_at",
      "preflight_finished_at",
      "execution_started_at",
      "validation_started_at",
    ]) {
      if (!jobColumns.has(column)) {
        this.db.exec(`ALTER TABLE jobs ADD COLUMN ${column} TEXT`);
      }
    }
    const watcherColumns = new Set(
      (
        this.db
          .prepare("PRAGMA table_info(watchers)")
          .all() as Array<Record<string, unknown>>
      ).map((column) => String(column.name)),
    );
    if (!watcherColumns.has("execution_mode")) {
      this.db.exec(
        "ALTER TABLE watchers ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'safe_copy'",
      );
    }
    if (!watcherColumns.has("backup_source")) {
      this.db.exec(
        "ALTER TABLE watchers ADD COLUMN backup_source INTEGER NOT NULL DEFAULT 1",
      );
    }
    if (!watcherColumns.has("coverage_policy")) {
      this.db.exec(
        "ALTER TABLE watchers ADD COLUMN coverage_policy TEXT NOT NULL DEFAULT 'strict'",
      );
    }
    if (!watcherColumns.has("coverage_threshold_percent")) {
      this.db.exec(
        "ALTER TABLE watchers ADD COLUMN coverage_threshold_percent REAL NOT NULL DEFAULT 5",
      );
    }
    if (!watcherColumns.has("validation_checks_json")) {
      this.db.exec(
        `ALTER TABLE watchers ADD COLUMN validation_checks_json TEXT NOT NULL DEFAULT '${JSON.stringify(DEFAULT_VALIDATION_CHECKS)}'`,
      );
    }
    const watcherColumnDefinitions: Record<string, string> = {
      recursive: "INTEGER NOT NULL DEFAULT 0",
      last_scan_at: "TEXT",
      scan_status: "TEXT NOT NULL DEFAULT 'idle'",
      scanned_files: "INTEGER NOT NULL DEFAULT 0",
      supported_files: "INTEGER NOT NULL DEFAULT 0",
      waiting_stable_files: "INTEGER NOT NULL DEFAULT 0",
      submitted_jobs: "INTEGER NOT NULL DEFAULT 0",
      skipped_files: "INTEGER NOT NULL DEFAULT 0",
      last_error: "TEXT",
    };
    for (const [column, definition] of Object.entries(
      watcherColumnDefinitions,
    )) {
      if (!watcherColumns.has(column)) {
        this.db.exec(`ALTER TABLE watchers ADD COLUMN ${column} ${definition}`);
      }
    }
    const queueColumns = new Set(
      (
        this.db
          .prepare("PRAGMA table_info(queue_state)")
          .all() as Array<Record<string, unknown>>
      ).map((column) => String(column.name)),
    );
    if (!queueColumns.has("finish_current_job_id")) {
      this.db.exec(
        "ALTER TABLE queue_state ADD COLUMN finish_current_job_id TEXT",
      );
    }
  }

  integrityCheck(): string {
    const row = this.db.prepare("PRAGMA integrity_check").get() as
      | Record<string, unknown>
      | undefined;
    return String(row?.integrity_check || "unknown");
  }

  close(): void {
    this.db.close();
  }

  createJob(
    input: SubmitJobInput,
    normalizedSourcePath: string,
    experimental: boolean,
    explicitSourceSelection = false,
    explicitOutputSelection = false,
  ): { job: JobRecord; existing: boolean } {
    if (input.clientRequestId) {
      const existing = this.getJobByClientRequestId(input.clientRequestId);
      if (existing) {
        return { job: existing, existing: true };
      }
    }
    const activeDuplicate = this.getActiveJobBySourcePath(
      normalizedSourcePath,
    );
    if (activeDuplicate) {
      return { job: activeDuplicate, existing: true };
    }
    const id = crypto.randomUUID();
    const stamp = nowIso();
    this.db
      .prepare(`
        INSERT INTO jobs(
          id, machine_id, client_request_id, source_path, profile, run_mode,
          execution_mode, backup_source, validation_checks_json,
          delete_hidden_layers, delete_empty_layers,
          coverage_policy, coverage_threshold_percent,
          output_mode, output_dir,
          status, progress, progress_stage, progress_detail, experimental,
          submission_source, watcher_id,
          explicit_source_selection, explicit_output_selection,
          created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued_preflight', 0, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        this.config.machineId,
        input.clientRequestId || null,
        normalizedSourcePath,
        input.profile || "standard",
        input.runMode || "auto_if_eligible",
        input.executionMode || "safe_copy",
        input.backupSource === false ? 0 : 1,
        JSON.stringify(
          input.requiredValidationChecks || DEFAULT_VALIDATION_CHECKS,
        ),
        input.deleteHiddenLayers ? 1 : 0,
        input.deleteEmptyLayers ? 1 : 0,
        input.coveragePolicy || "strict",
        Math.max(
          0,
          Math.min(100, Number(input.coverageThresholdPercent ?? 5)),
        ),
        input.outputMode || "specified_directory",
        input.outputDir || null,
        "等待开始只读检查",
        experimental ? 1 : 0,
        input.source,
        input.watcherId || null,
        explicitSourceSelection ? 1 : 0,
        explicitOutputSelection ? 1 : 0,
        stamp,
        stamp,
      );
    const job = this.getJob(id);
    if (!job) {
      throw new Error(`Failed to read newly-created job ${id}`);
    }
    return { job, existing: false };
  }

  getJob(id: string): JobRecord | null {
    const row = this.db
      .prepare("SELECT * FROM jobs WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToJob(row) : null;
  }

  getJobByClientRequestId(clientRequestId: string): JobRecord | null {
    const row = this.db
      .prepare("SELECT * FROM jobs WHERE client_request_id = ?")
      .get(clientRequestId) as Record<string, unknown> | undefined;
    return row ? rowToJob(row) : null;
  }

  getActiveJobBySourcePath(sourcePath: string): JobRecord | null {
    const placeholders = ACTIVE_STATUSES.map(() => "?").join(",");
    const row = this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE lower(source_path) = lower(?)
           AND status IN (${placeholders})
           AND archived_at IS NULL
         ORDER BY created_at ASC
         LIMIT 1`,
      )
      .get(sourcePath, ...ACTIVE_STATUSES) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToJob(row) : null;
  }

  listJobs(
    input: {
      limit?: number;
      status?: JobStatus;
      includeArchived?: boolean;
    } = {},
  ): JobRecord[] {
    const limit = Math.max(1, Math.min(500, input.limit || 100));
    const archiveClause = input.includeArchived ? "" : "archived_at IS NULL";
    const rows = input.status
      ? (this.db
          .prepare(
            `SELECT * FROM jobs WHERE status = ?${
              archiveClause ? ` AND ${archiveClause}` : ""
            } ORDER BY created_at DESC LIMIT ?`,
          )
          .all(input.status, limit) as Record<string, unknown>[])
      : (this.db
          .prepare(
            `SELECT * FROM jobs${
              archiveClause ? ` WHERE ${archiveClause}` : ""
            } ORDER BY created_at DESC LIMIT ?`,
          )
          .all(limit) as Record<string, unknown>[]);
    return rows.map(rowToJob);
  }

  /** Full task ledger for aggregate statistics; archived rows remain evidence. */
  listAllJobs(): JobRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM jobs ORDER BY created_at DESC")
      .all() as Record<string, unknown>[];
    return rows.map(rowToJob);
  }

  listLockedQuarantineJobIds(): string[] {
    return (
      this.db
        .prepare(
          `SELECT id FROM jobs
           WHERE review_status = 'kept_quarantined'
             AND quarantine_path IS NOT NULL`,
        )
        .all() as Array<{ id: string }>
    ).map((row) => String(row.id));
  }

  nextRunnableJob(): JobRecord | null {
    const row = this.db
      .prepare(`
        SELECT * FROM jobs
        WHERE status IN ('queued_preflight', 'ready', 'waiting_photoshop')
          AND cancel_requested = 0
          AND archived_at IS NULL
        ORDER BY created_at ASC
        LIMIT 1
      `)
      .get() as Record<string, unknown> | undefined;
    return row ? rowToJob(row) : null;
  }

  nextPreflightJob(): JobRecord | null {
    const row = this.db
      .prepare(`
        SELECT * FROM jobs
        WHERE status = 'queued_preflight'
          AND cancel_requested = 0
          AND archived_at IS NULL
        ORDER BY created_at ASC
        LIMIT 1
      `)
      .get() as Record<string, unknown> | undefined;
    return row ? rowToJob(row) : null;
  }

  nextExecutionJob(): JobRecord | null {
    const row = this.db
      .prepare(`
        SELECT * FROM jobs
        WHERE status IN ('ready', 'waiting_photoshop')
          AND cancel_requested = 0
          AND archived_at IS NULL
        ORDER BY created_at ASC
        LIMIT 1
      `)
      .get() as Record<string, unknown> | undefined;
    return row ? rowToJob(row) : null;
  }

  updateJob(
    id: string,
    values: Partial<{
      sourceBytes: number | null;
      sourceMtimeMs: number | null;
      sourceSha256: string | null;
      requiredValidationChecks: ValidationCheck[];
      deleteHiddenLayers: boolean;
      deleteEmptyLayers: boolean;
      coveragePolicy: JobRecord["coveragePolicy"];
      coverageThresholdPercent: number;
      status: JobStatus;
      reasonCode: string | null;
      progress: number;
      progressStage: string | null;
      progressCurrent: number | null;
      progressTotal: number | null;
      progressDetail: string | null;
      attempt: number;
      photoshopVersion: string | null;
      cancelRequested: boolean;
      preflightStartedAt: string | null;
      preflightFinishedAt: string | null;
      executionStartedAt: string | null;
      validationStartedAt: string | null;
      finishedAt: string | null;
      reportJsonPath: string | null;
      reportHtmlPath: string | null;
      outputPath: string | null;
      backupPath: string | null;
      quarantinePath: string | null;
      reviewStatus: JobRecord["reviewStatus"];
      reviewedAt: string | null;
      reviewedBy: string | null;
      reviewNote: string | null;
      preflightJsonPath: string | null;
      cleanupPlanPath: string | null;
      archivedAt: string | null;
    }>,
  ): JobRecord {
    const mapping: Record<string, string> = {
      sourceBytes: "source_bytes",
      sourceMtimeMs: "source_mtime_ms",
      sourceSha256: "source_sha256",
      requiredValidationChecks: "validation_checks_json",
      deleteHiddenLayers: "delete_hidden_layers",
      deleteEmptyLayers: "delete_empty_layers",
      coveragePolicy: "coverage_policy",
      coverageThresholdPercent: "coverage_threshold_percent",
      status: "status",
      reasonCode: "reason_code",
      progress: "progress",
      progressStage: "progress_stage",
      progressCurrent: "progress_current",
      progressTotal: "progress_total",
      progressDetail: "progress_detail",
      attempt: "attempt",
      photoshopVersion: "photoshop_version",
      cancelRequested: "cancel_requested",
      preflightStartedAt: "preflight_started_at",
      preflightFinishedAt: "preflight_finished_at",
      executionStartedAt: "execution_started_at",
      validationStartedAt: "validation_started_at",
      finishedAt: "finished_at",
      reportJsonPath: "report_json_path",
      reportHtmlPath: "report_html_path",
      outputPath: "output_path",
      backupPath: "backup_path",
      quarantinePath: "quarantine_path",
      reviewStatus: "review_status",
      reviewedAt: "reviewed_at",
      reviewedBy: "reviewed_by",
      reviewNote: "review_note",
      preflightJsonPath: "preflight_json_path",
      cleanupPlanPath: "cleanup_plan_path",
      archivedAt: "archived_at",
    };
    const entries = Object.entries(values);
    if (entries.length === 0) {
      const unchanged = this.getJob(id);
      if (!unchanged) throw new Error(`Unknown job: ${id}`);
      return unchanged;
    }
    const set = entries.map(([key]) => `${mapping[key]} = ?`);
    const params = entries.map(([key, value]) => {
      if (
        key === "cancelRequested" ||
        key === "deleteHiddenLayers" ||
        key === "deleteEmptyLayers"
      ) return value ? 1 : 0;
      if (key === "requiredValidationChecks") return JSON.stringify(value);
      return value;
    });
    set.push("updated_at = ?");
    params.push(nowIso(), id);
    this.db
      .prepare(`UPDATE jobs SET ${set.join(", ")} WHERE id = ?`)
      .run(...params);
    const updated = this.getJob(id);
    if (!updated) throw new Error(`Unknown job: ${id}`);
    return updated;
  }

  requestCancellation(id: string): JobRecord {
    return this.updateJob(id, { cancelRequested: true });
  }

  interruptedJobs(): JobRecord[] {
    const placeholders = ACTIVE_STATUSES.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs WHERE status IN (${placeholders}) AND archived_at IS NULL`,
      )
      .all(...ACTIVE_STATUSES) as Record<string, unknown>[];
    return rows.map(rowToJob);
  }

  archiveJob(id: string): JobRecord {
    return this.updateJob(id, { archivedAt: nowIso() });
  }

  purgeJobRecord(id: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM job_user_tags WHERE job_id = ?").run(id);
      this.db.prepare("DELETE FROM events WHERE job_id = ?").run(id);
      const result = this.db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
      if (Number(result.changes) !== 1) {
        throw new Error(`Unknown job: ${id}`);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listUserTags(): UserTag[] {
    return (
      this.db
        .prepare("SELECT * FROM user_tags ORDER BY name COLLATE NOCASE ASC")
        .all() as Record<string, unknown>[]
    ).map(rowToTag);
  }

  createUserTag(name: string, color: string): UserTag {
    const normalizedName = this.validateTagName(name);
    const normalizedColor = this.validateTagColor(color);
    const stamp = nowIso();
    const id = crypto.randomUUID();
    this.db
      .prepare(
        "INSERT INTO user_tags(id, name, color, created_at, updated_at) VALUES(?, ?, ?, ?, ?)",
      )
      .run(id, normalizedName, normalizedColor, stamp, stamp);
    return this.getUserTag(id)!;
  }

  updateUserTag(id: string, values: { name?: string; color?: string }): UserTag {
    const current = this.getUserTag(id);
    if (!current) throw new Error(`Unknown user tag: ${id}`);
    const name =
      values.name === undefined ? current.name : this.validateTagName(values.name);
    const color =
      values.color === undefined
        ? current.color
        : this.validateTagColor(values.color);
    this.db
      .prepare("UPDATE user_tags SET name = ?, color = ?, updated_at = ? WHERE id = ?")
      .run(name, color, nowIso(), id);
    return this.getUserTag(id)!;
  }

  deleteUserTag(id: string): void {
    const result = this.db.prepare("DELETE FROM user_tags WHERE id = ?").run(id);
    if (Number(result.changes) !== 1) {
      throw new Error(`Unknown user tag: ${id}`);
    }
  }

  listJobUserTags(jobId: string): UserTag[] {
    return (
      this.db
        .prepare(`
          SELECT t.*
          FROM user_tags t
          INNER JOIN job_user_tags jt ON jt.tag_id = t.id
          WHERE jt.job_id = ?
          ORDER BY t.name COLLATE NOCASE ASC
        `)
        .all(jobId) as Record<string, unknown>[]
    ).map(rowToTag);
  }

  listUserTagsByJobIds(jobIds: string[]): Map<string, UserTag[]> {
    const result = new Map<string, UserTag[]>();
    for (const id of jobIds) result.set(id, []);
    if (jobIds.length === 0) return result;
    const placeholders = jobIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(`
        SELECT jt.job_id, t.*
        FROM job_user_tags jt
        INNER JOIN user_tags t ON t.id = jt.tag_id
        WHERE jt.job_id IN (${placeholders})
        ORDER BY t.name COLLATE NOCASE ASC
      `)
      .all(...jobIds) as Record<string, unknown>[];
    for (const row of rows) {
      result.get(String(row.job_id))?.push(rowToTag(row));
    }
    return result;
  }

  setJobUserTags(jobIds: string[], tagIds: string[]): void {
    const normalizedJobIds = [...new Set(jobIds.map(String))];
    const normalizedTagIds = [...new Set(tagIds.map(String))];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const jobExists = this.db.prepare("SELECT 1 FROM jobs WHERE id = ?");
      const tagExists = this.db.prepare("SELECT 1 FROM user_tags WHERE id = ?");
      const remove = this.db.prepare("DELETE FROM job_user_tags WHERE job_id = ?");
      const add = this.db.prepare(
        "INSERT INTO job_user_tags(job_id, tag_id, created_at) VALUES(?, ?, ?)",
      );
      for (const jobId of normalizedJobIds) {
        if (!jobExists.get(jobId)) throw new Error(`Unknown job: ${jobId}`);
        remove.run(jobId);
        for (const tagId of normalizedTagIds) {
          if (!tagExists.get(tagId)) throw new Error(`Unknown user tag: ${tagId}`);
          add.run(jobId, tagId, nowIso());
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private getUserTag(id: string): UserTag | null {
    const row = this.db
      .prepare("SELECT * FROM user_tags WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToTag(row) : null;
  }

  private validateTagName(name: string): string {
    const normalized = String(name || "").trim();
    if (!normalized || normalized.length > 24) {
      throw new Error("标签名称必须包含 1 至 24 个字符。");
    }
    return normalized;
  }

  private validateTagColor(color: string): string {
    const normalized = String(color || "").trim().toLowerCase();
    if (!/^#[0-9a-f]{6}$/u.test(normalized)) {
      throw new Error("标签颜色必须使用 #RRGGBB 格式。");
    }
    return normalized;
  }

  acquireServiceLease(input: {
    ownerId: string;
    pid: number;
    ttlMs: number;
    isProcessAlive: (pid: number) => boolean;
  }): { acquired: boolean; holderPid: number | null } {
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db
        .prepare("SELECT * FROM service_lease WHERE singleton = 1")
        .get() as Record<string, unknown> | undefined;
      const heldByAnotherLiveProcess =
        current &&
        String(current.owner_id) !== input.ownerId &&
        Number(current.expires_at) > now &&
        input.isProcessAlive(Number(current.pid));
      if (heldByAnotherLiveProcess) {
        this.db.exec("COMMIT");
        return { acquired: false, holderPid: Number(current.pid) };
      }
      this.db
        .prepare(`
          INSERT INTO service_lease(singleton, owner_id, pid, expires_at, updated_at)
          VALUES(1, ?, ?, ?, ?)
          ON CONFLICT(singleton) DO UPDATE SET
            owner_id = excluded.owner_id,
            pid = excluded.pid,
            expires_at = excluded.expires_at,
            updated_at = excluded.updated_at
        `)
        .run(
          input.ownerId,
          input.pid,
          now + input.ttlMs,
          nowIso(),
        );
      this.db.exec("COMMIT");
      return { acquired: true, holderPid: null };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  renewServiceLease(ownerId: string, ttlMs: number): boolean {
    const result = this.db
      .prepare(`
        UPDATE service_lease
        SET expires_at = ?, updated_at = ?
        WHERE singleton = 1 AND owner_id = ?
      `)
      .run(Date.now() + ttlMs, nowIso(), ownerId);
    return Number(result.changes) === 1;
  }

  releaseServiceLease(ownerId: string): void {
    this.db
      .prepare("DELETE FROM service_lease WHERE singleton = 1 AND owner_id = ?")
      .run(ownerId);
  }

  addEvent(input: {
    jobId?: string | null;
    level: EventLevel;
    stage: string;
    eventType: string;
    message: string;
    data?: Record<string, unknown>;
  }): Record<string, unknown> {
    const timestamp = nowIso();
    const previous = this.db
      .prepare(
        input.jobId
          ? "SELECT event_hash FROM events WHERE job_id = ? ORDER BY seq DESC LIMIT 1"
          : "SELECT event_hash FROM events WHERE job_id IS NULL ORDER BY seq DESC LIMIT 1",
      )
      .get(...(input.jobId ? [input.jobId] : [])) as
      | Record<string, unknown>
      | undefined;
    const prevHash = String(previous?.event_hash || "");
    const dataJson = JSON.stringify(input.data || {});
    const canonical = JSON.stringify({
      jobId: input.jobId || null,
      timestamp,
      level: input.level,
      stage: input.stage,
      eventType: input.eventType,
      message: input.message,
      data: JSON.parse(dataJson),
      prevHash,
    });
    const eventHash = crypto
      .createHash("sha256")
      .update(canonical)
      .digest("hex");
    const result = this.db
      .prepare(`
        INSERT INTO events(
          job_id, timestamp, level, stage, event_type, message,
          data_json, prev_hash, event_hash
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.jobId || null,
        timestamp,
        input.level,
        input.stage,
        input.eventType,
        input.message,
        dataJson,
        prevHash,
        eventHash,
      );
    return {
      seq: Number(result.lastInsertRowid),
      jobId: input.jobId || null,
      timestamp,
      level: input.level,
      stage: input.stage,
      eventType: input.eventType,
      message: input.message,
      data: JSON.parse(dataJson),
      prevHash,
      eventHash,
    };
  }

  listEvents(jobId: string): Record<string, unknown>[] {
    return (
      this.db
        .prepare("SELECT * FROM events WHERE job_id = ? ORDER BY seq ASC")
        .all(jobId) as Record<string, unknown>[]
    ).map((row) => ({
      seq: Number(row.seq),
      jobId: row.job_id,
      timestamp: row.timestamp,
      level: row.level,
      stage: row.stage,
      eventType: row.event_type,
      message: row.message,
      data: JSON.parse(String(row.data_json)),
      prevHash: row.prev_hash,
      eventHash: row.event_hash,
    }));
  }

  verifyEventChain(jobId: string): {
    valid: boolean;
    checked: number;
    brokenAtSeq: number | null;
  } {
    const events = this.listEvents(jobId);
    let expectedPreviousHash = "";
    for (const event of events) {
      const previousHash = String(event.prevHash || "");
      const canonical = JSON.stringify({
        jobId: event.jobId || null,
        timestamp: event.timestamp,
        level: event.level,
        stage: event.stage,
        eventType: event.eventType,
        message: event.message,
        data: event.data || {},
        prevHash: previousHash,
      });
      const expectedHash = crypto
        .createHash("sha256")
        .update(canonical)
        .digest("hex");
      if (
        previousHash !== expectedPreviousHash ||
        String(event.eventHash || "") !== expectedHash
      ) {
        return {
          valid: false,
          checked: events.indexOf(event),
          brokenAtSeq: Number(event.seq),
        };
      }
      expectedPreviousHash = expectedHash;
    }
    return { valid: true, checked: events.length, brokenAtSeq: null };
  }

  getQueueState(): {
    paused: boolean;
    criticalReason: string | null;
    finishCurrentJobId: string | null;
    updatedAt: string;
  } {
    const row = this.db
      .prepare("SELECT * FROM queue_state WHERE singleton = 1")
      .get() as Record<string, unknown>;
    return {
      paused: asBoolean(row.paused),
      criticalReason:
        row.critical_reason === null ? null : String(row.critical_reason),
      finishCurrentJobId:
        row.finish_current_job_id === null
          ? null
          : String(row.finish_current_job_id),
      updatedAt: String(row.updated_at),
    };
  }

  setQueueState(
    paused: boolean,
    criticalReason: string | null = null,
    finishCurrentJobId: string | null = null,
  ): void {
    this.db
      .prepare(
        "UPDATE queue_state SET paused = ?, critical_reason = ?, finish_current_job_id = ?, updated_at = ? WHERE singleton = 1",
      )
      .run(paused ? 1 : 0, criticalReason, finishCurrentJobId, nowIso());
  }

  upsertWatcher(watcher: WatcherConfig): void {
    this.db
      .prepare(`
        INSERT INTO watchers(
          id, path, profile, run_mode, execution_mode, backup_source,
          coverage_policy, coverage_threshold_percent,
          validation_checks_json, output_mode, output_dir, recursive,
          enabled, created_at, last_scan_at, scan_status, scanned_files,
          supported_files, waiting_stable_files, submitted_jobs,
          skipped_files, last_error
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          path = excluded.path,
          profile = excluded.profile,
          run_mode = excluded.run_mode,
          execution_mode = excluded.execution_mode,
          backup_source = excluded.backup_source,
          coverage_policy = excluded.coverage_policy,
          coverage_threshold_percent = excluded.coverage_threshold_percent,
          validation_checks_json = excluded.validation_checks_json,
          output_mode = excluded.output_mode,
          output_dir = excluded.output_dir,
          recursive = excluded.recursive,
          enabled = excluded.enabled
      `)
      .run(
        watcher.id,
        watcher.path,
        watcher.profile,
        watcher.runMode,
        watcher.executionMode,
        watcher.backupSource ? 1 : 0,
        watcher.coveragePolicy || "strict",
        Math.max(
          0,
          Math.min(100, Number(watcher.coverageThresholdPercent ?? 5)),
        ),
        JSON.stringify(watcher.requiredValidationChecks),
        watcher.outputMode,
        watcher.outputDir || null,
        watcher.recursive ? 1 : 0,
        watcher.enabled ? 1 : 0,
        watcher.createdAt,
        watcher.lastScanAt,
        watcher.scanStatus,
        watcher.scannedFiles,
        watcher.supportedFiles,
        watcher.waitingStableFiles,
        watcher.submittedJobs,
        watcher.skippedFiles,
        watcher.lastError,
      );
  }

  listWatchers(): WatcherConfig[] {
    const rows = this.db
      .prepare("SELECT * FROM watchers ORDER BY created_at ASC")
      .all() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      path: String(row.path),
      profile: row.profile as WatcherConfig["profile"],
      runMode: row.run_mode as WatcherConfig["runMode"],
      executionMode:
        (row.execution_mode as WatcherConfig["executionMode"]) || "safe_copy",
      backupSource:
        row.backup_source === undefined ? true : asBoolean(row.backup_source),
      coveragePolicy:
        (row.coverage_policy as WatcherConfig["coveragePolicy"]) || "strict",
      coverageThresholdPercent:
        row.coverage_threshold_percent === undefined ||
        row.coverage_threshold_percent === null
          ? 5
          : Number(row.coverage_threshold_percent),
      requiredValidationChecks: validationChecksFromJson(
        row.validation_checks_json,
      ),
      outputMode: row.output_mode as WatcherConfig["outputMode"],
      outputDir: row.output_dir === null ? undefined : String(row.output_dir),
      recursive: asBoolean(row.recursive),
      enabled: asBoolean(row.enabled),
      createdAt: String(row.created_at),
      lastScanAt:
        row.last_scan_at === null || row.last_scan_at === undefined
          ? null
          : String(row.last_scan_at),
      scanStatus:
        (row.scan_status as WatcherConfig["scanStatus"]) || "idle",
      scannedFiles: Number(row.scanned_files || 0),
      supportedFiles: Number(row.supported_files || 0),
      waitingStableFiles: Number(row.waiting_stable_files || 0),
      submittedJobs: Number(row.submitted_jobs || 0),
      skippedFiles: Number(row.skipped_files || 0),
      lastError:
        row.last_error === null || row.last_error === undefined
          ? null
          : String(row.last_error),
    }));
  }

  updateWatcherRuntime(
    id: string,
    values: Partial<
      Pick<
        WatcherConfig,
        | "lastScanAt"
        | "scanStatus"
        | "scannedFiles"
        | "supportedFiles"
        | "waitingStableFiles"
        | "submittedJobs"
        | "skippedFiles"
        | "lastError"
      >
    >,
  ): void {
    const mapping: Record<string, string> = {
      lastScanAt: "last_scan_at",
      scanStatus: "scan_status",
      scannedFiles: "scanned_files",
      supportedFiles: "supported_files",
      waitingStableFiles: "waiting_stable_files",
      submittedJobs: "submitted_jobs",
      skippedFiles: "skipped_files",
      lastError: "last_error",
    };
    const entries = Object.entries(values);
    if (!entries.length) return;
    this.db
      .prepare(
        `UPDATE watchers SET ${entries
          .map(([key]) => `${mapping[key]} = ?`)
          .join(", ")} WHERE id = ?`,
      )
      .run(...entries.map(([, value]) => value), id);
  }

  getWatcherFile(
    watcherId: string,
    sourcePath: string,
  ): WatcherFileRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM watcher_files WHERE watcher_id = ? AND source_path = ?",
      )
      .get(watcherId, sourcePath) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      watcherId: String(row.watcher_id),
      sourcePath: String(row.source_path),
      sizeBytes: Number(row.size_bytes),
      mtimeMs: Number(row.mtime_ms),
      unchangedSince: Number(row.unchanged_since),
      lastSubmittedSignature:
        row.last_submitted_signature === null
          ? null
          : String(row.last_submitted_signature),
      lastJobId: row.last_job_id === null ? null : String(row.last_job_id),
      state: String(row.state),
      updatedAt: String(row.updated_at),
    };
  }

  upsertWatcherFile(
    value: Omit<WatcherFileRecord, "updatedAt">,
  ): void {
    this.db
      .prepare(`
        INSERT INTO watcher_files(
          watcher_id, source_path, size_bytes, mtime_ms, unchanged_since,
          last_submitted_signature, last_job_id, state, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(watcher_id, source_path) DO UPDATE SET
          size_bytes = excluded.size_bytes,
          mtime_ms = excluded.mtime_ms,
          unchanged_since = excluded.unchanged_since,
          last_submitted_signature = excluded.last_submitted_signature,
          last_job_id = excluded.last_job_id,
          state = excluded.state,
          updated_at = excluded.updated_at
      `)
      .run(
        value.watcherId,
        value.sourcePath,
        value.sizeBytes,
        value.mtimeMs,
        value.unchangedSince,
        value.lastSubmittedSignature,
        value.lastJobId,
        value.state,
        nowIso(),
      );
  }

  async appendEventFiles(event: Record<string, unknown>): Promise<void> {
    const line = `${JSON.stringify(event)}\n`;
    await fs.appendFile(
      path.join(this.config.dataRoot, "logs", "audit.jsonl"),
      line,
      "utf8",
    );
    if (event.jobId) {
      await fs.appendFile(
        path.join(
          this.config.dataRoot,
          "logs",
          "jobs",
          `${event.jobId}.events.jsonl`,
        ),
        line,
        "utf8",
      );
    }
  }
}
