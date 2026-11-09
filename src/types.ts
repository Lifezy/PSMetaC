export const CLEANUP_PROFILES = ["standard", "deep", "conservative"] as const;
export type CleanupProfile = (typeof CLEANUP_PROFILES)[number];

export const RUN_MODES = [
  "inspect_only",
  "auto_if_eligible",
  "await_approval",
] as const;
export type RunMode = (typeof RUN_MODES)[number];

export const OUTPUT_MODES = [
  "specified_directory",
  "source_subfolder",
] as const;
export type OutputMode = (typeof OUTPUT_MODES)[number];

export const EXECUTION_MODES = ["safe_copy", "in_place"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export const COVERAGE_POLICIES = ["strict", "threshold", "skip"] as const;
export type CoveragePolicy = (typeof COVERAGE_POLICIES)[number];

export const VALIDATION_CHECKS = [
  "target_xmp_removed",
  "structure_topology",
  "smart_object_asset_ids",
  "smart_object_success",
  "reopen_success",
  "pixel_exact",
  "render_consistency",
  "parser_clean",
] as const;
export type ValidationCheck = (typeof VALIDATION_CHECKS)[number];
export const DEFAULT_VALIDATION_CHECKS: ValidationCheck[] = [
  "target_xmp_removed",
  "structure_topology",
  "smart_object_asset_ids",
  "smart_object_success",
  "pixel_exact",
  "parser_clean",
];

export const RETENTION_POLICIES = [
  "temporary_only",
  "manual",
] as const;
export type RetentionPolicy = (typeof RETENTION_POLICIES)[number];

export const QUARANTINE_CLEANUP_TRIGGERS = ["any", "all"] as const;
export type QuarantineCleanupTrigger =
  (typeof QUARANTINE_CLEANUP_TRIGGERS)[number];

export const JOB_STATUSES = [
  "waiting_stable",
  "queued_preflight",
  "preflighting",
  "preflight_complete",
  "skipped",
  "blocked",
  "ready",
  "awaiting_approval",
  "waiting_photoshop",
  "copying",
  "running",
  "validating",
  "succeeded",
  "partial",
  "quarantined",
  "discarded",
  "cancelled",
  "failed",
  "critical_paused",
  "interrupted",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export type EventLevel =
  | "debug"
  | "info"
  | "warning"
  | "error"
  | "critical";

export interface AppConfig {
  schemaVersion: 5;
  machineId: string;
  dataRoot: string;
  allowedInputRoots: string[];
  allowedOutputRoots: string[];
  deniedRoots: string[];
  verifiedPhotoshopVersions: string[];
  experimentalPsd: boolean;
  experimentalPsdUnattended: boolean;
  stabilitySeconds: number;
  sourceSubfolderName: string;
  retentionPolicy: RetentionPolicy;
  quarantineCleanupEnabled: boolean;
  quarantineRetentionDays: number;
  quarantineMaxBytes: number;
  quarantineCleanupTrigger: QuarantineCleanupTrigger;
  minimumSpaceMultiplier: number;
  minimumSpaceReserveBytes: number;
  pipeName: string;
  pipeToken: string;
  photoshopExecutable?: string;
  photoshopProgId?: string;
  watcherPollSeconds: number;
  pipelinePreflight: boolean;
  suppressDangerousOperationWarning: boolean;
  recentDirectories: {
    source?: string;
    output?: string;
    watcher?: string;
    settingsImport?: string;
    settingsExport?: string;
  };
}

export interface WatcherConfig {
  id: string;
  path: string;
  profile: CleanupProfile;
  runMode: RunMode;
  executionMode: ExecutionMode;
  backupSource: boolean;
  coveragePolicy?: CoveragePolicy;
  coverageThresholdPercent?: number;
  outputMode: OutputMode;
  outputDir?: string;
  recursive: boolean;
  requiredValidationChecks: ValidationCheck[];
  enabled: boolean;
  createdAt: string;
  lastScanAt: string | null;
  scanStatus: "idle" | "scanning" | "monitoring" | "error";
  scannedFiles: number;
  supportedFiles: number;
  waitingStableFiles: number;
  submittedJobs: number;
  skippedFiles: number;
  lastError: string | null;
}

export interface SubmitJobInput {
  sourcePath: string;
  profile?: CleanupProfile;
  runMode?: RunMode;
  executionMode?: ExecutionMode;
  backupSource?: boolean;
  coveragePolicy?: CoveragePolicy;
  coverageThresholdPercent?: number;
  outputMode?: OutputMode;
  outputDir?: string;
  clientRequestId?: string;
  source: "ui" | "watcher" | "mcp" | "cli";
  watcherId?: string;
  requiredValidationChecks?: ValidationCheck[];
  /** Delete directly hidden layers in the root document. Safe-copy UI jobs only. */
  deleteHiddenLayers?: boolean;
  /** Delete provably empty ordinary pixel layers in the root document. Safe-copy UI jobs only. */
  deleteEmptyLayers?: boolean;
}

export interface UserTag {
  id: string;
  name: string;
  color: string;
  createdAt: string;
  updatedAt: string;
}

export type ManualReviewStatus =
  | "accepted_with_warnings"
  | "kept_quarantined"
  | "discarded";

export interface JobRecord {
  id: string;
  machineId: string;
  clientRequestId: string | null;
  sourcePath: string;
  sourceBytes: number | null;
  sourceMtimeMs: number | null;
  sourceSha256: string | null;
  profile: CleanupProfile;
  runMode: RunMode;
  executionMode: ExecutionMode;
  backupSource: boolean;
  coveragePolicy: CoveragePolicy;
  coverageThresholdPercent: number;
  requiredValidationChecks: ValidationCheck[];
  deleteHiddenLayers: boolean;
  deleteEmptyLayers: boolean;
  outputMode: OutputMode;
  outputDir: string | null;
  status: JobStatus;
  reasonCode: string | null;
  progress: number;
  progressStage: string | null;
  progressCurrent: number | null;
  progressTotal: number | null;
  progressDetail: string | null;
  attempt: number;
  experimental: boolean;
  submissionSource: SubmitJobInput["source"];
  watcherId: string | null;
  photoshopVersion: string | null;
  explicitSourceSelection: boolean;
  explicitOutputSelection: boolean;
  cancelRequested: boolean;
  createdAt: string;
  updatedAt: string;
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
  reviewStatus: ManualReviewStatus | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewNote: string | null;
  preflightJsonPath: string | null;
  cleanupPlanPath: string | null;
  archivedAt: string | null;
  userTags: UserTag[];
}

export interface InspectionResult {
  target: string;
  fileBytes: number;
  fileGiB?: number;
  summary: {
    containersInspected: number;
    embeddedContainers: number;
    linkedRecords: number;
    maxDepthSeen: number;
    allXmpBytes: number;
    allDocumentAncestors: number;
    xmpPercentOfOuterFile: number;
    [key: string]: unknown;
  };
  cleanupPlan: {
    sourceBytes: number;
    sourceMtimeMs: number;
    rootCleanSelf: boolean;
    anomalousContainers: number;
    anomalousEmbeddedContainers: number;
    recordsRequiredToOpen: number;
    targetRecords: number;
    ancestorOnlyRecords: number;
    crossBitDepthRecords: number;
    records: Array<Record<string, unknown>>;
    [key: string]: unknown;
  };
  containers: Array<{
    id: string;
    depth: number;
    bytes: number;
    xmp?: {
      bytes?: number;
      documentAncestors?: number;
      [key: string]: unknown;
    };
    warnings?: string[];
    [key: string]: unknown;
  }>;
  linkedRecords: Array<Record<string, unknown>>;
  warnings: string[];
  [key: string]: unknown;
}

export interface CleanupEstimate {
  affectedContainers: number;
  affectedXmpBytes: number;
  affectedPercentOfSource: number;
  plannedObjects: number;
  estimatedPhotoshopActiveMs: number;
  estimatedPhotoshopRangeMs: {
    low: number;
    high: number;
  };
}

export interface PolicyDecision {
  eligible: boolean;
  profile: CleanupProfile;
  reasonCode:
    | "ELIGIBLE"
    | "CONTENT_CLEANUP_REQUESTED"
    | "NO_DOCUMENT_ANCESTORS"
    | "BELOW_PROFILE_THRESHOLD";
  explanation: string;
  estimate: CleanupEstimate;
}

export interface PixelComparison {
  comparable: boolean;
  exact: boolean;
  width?: number;
  height?: number;
  changedPixels?: number;
  maxChannelDiff?: number;
  alphaChangedPixels?: number;
  mse?: number;
  psnrDb?: number | null;
  reason?: string;
}

export interface FileReport {
  schemaVersion: 1;
  reportVersion: "1.0";
  appVersion: string;
  jobId: string;
  machineId: string;
  status: JobStatus;
  reasonCode: string | null;
  startedAt: string;
  finishedAt: string;
  source: Record<string, unknown>;
  policy: Record<string, unknown>;
  environment: Record<string, unknown>;
  preflight: Record<string, unknown>;
  execution: Record<string, unknown>;
  validation: Record<string, unknown>;
  output: Record<string, unknown>;
  timing: Record<string, unknown>;
  logs: Record<string, unknown>;
  manualReview?: {
    status: ManualReviewStatus;
    reviewedAt: string;
    reviewedBy: string;
    note: string;
    ignoredAutomaticChecks: string[];
    originalStatus: JobStatus;
    originalReasonCode: string | null;
    resultPath: string | null;
    recycledArtifacts?: Array<{
      kind: "work" | "preview" | "quarantine";
      path: string;
      bytes: number;
    }>;
    recycledBytes?: number;
    sourceFilePreserved?: boolean;
    reportsPreserved?: boolean;
    logsPreserved?: boolean;
    photoshopLogPreservedAt?: string | null;
  };
}
