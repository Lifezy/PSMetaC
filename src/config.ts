import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AppConfig,
  QuarantineCleanupTrigger,
  RetentionPolicy,
} from "./types.ts";

export const CONFIG_FILE_NAME = "psmetac_config.json";
export const LEGACY_CONFIG_FILE_NAME = "config.json";
export const BOOTSTRAP_FILE_NAME = "bootstrap.json";
export const GIB = 1024 ** 3;

function normalizeRoot(value: string): string {
  return path.resolve(value).replace(/[\\/]+$/, "");
}

function pathInside(candidate: string, root: string): boolean {
  const fold = (value: string) =>
    normalizeRoot(value).toLowerCase();
  const child = fold(candidate);
  const parent = fold(root);
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

function machineFingerprint(): string {
  return crypto
    .createHash("sha256")
    .update(`${os.hostname()}\0${os.userInfo().username}\0${os.arch()}`)
    .digest("hex")
    .slice(0, 16);
}

export function createDefaultConfig(
  dataRoot: string,
  overrides: Partial<AppConfig> = {},
): AppConfig {
  const resolvedDataRoot = normalizeRoot(dataRoot);
  const machineId = overrides.machineId || machineFingerprint();
  const pipeSeed = crypto
    .createHash("sha256")
    .update(`${machineId}\0${resolvedDataRoot}`)
    .digest("hex")
    .slice(0, 20);
  return {
    schemaVersion: 5,
    machineId,
    dataRoot: resolvedDataRoot,
    allowedInputRoots: [],
    allowedOutputRoots: [],
    deniedRoots: [],
    verifiedPhotoshopVersions: ["26.11"],
    experimentalPsd: false,
    experimentalPsdUnattended: false,
    stabilitySeconds: 60,
    sourceSubfolderName: "PSB_Cleaned",
    retentionPolicy: "temporary_only",
    quarantineCleanupEnabled: false,
    quarantineRetentionDays: 30,
    quarantineMaxBytes: 100 * GIB,
    quarantineCleanupTrigger: "any",
    minimumSpaceMultiplier: 3,
    minimumSpaceReserveBytes: 10 * GIB,
    pipeName: `psmetac-${pipeSeed}`,
    pipeToken: crypto.randomBytes(32).toString("hex"),
    watcherPollSeconds: 10,
    pipelinePreflight: false,
    suppressDangerousOperationWarning: false,
    recentDirectories: {},
    ...overrides,
    schemaVersion: 5,
    dataRoot: resolvedDataRoot,
    deniedRoots: (overrides.deniedRoots || []).map(normalizeRoot),
    allowedInputRoots: (overrides.allowedInputRoots || []).map(normalizeRoot),
    allowedOutputRoots: (overrides.allowedOutputRoots || []).map(normalizeRoot),
  };
}

export function validateConfig(value: unknown): AppConfig {
  if (!value || typeof value !== "object") {
    throw new Error("配置内容必须是一个对象。");
  }
  const config = value as AppConfig;
  if (config.schemaVersion !== 5) {
    throw new Error(`不支持的配置版本：${config.schemaVersion}`);
  }
  if (!path.isAbsolute(config.dataRoot)) {
    throw new Error("软件数据目录必须是绝对路径。");
  }
  if (!Array.isArray(config.deniedRoots)) {
    throw new Error("排除目录必须是数组，可以为空。");
  }
  if (!Array.isArray(config.allowedInputRoots)) {
    throw new Error("允许输入目录必须是数组。");
  }
  if (!Array.isArray(config.allowedOutputRoots)) {
    throw new Error("允许输出目录必须是数组。");
  }
  for (const item of [
    ...config.deniedRoots,
    ...config.allowedInputRoots,
    ...config.allowedOutputRoots,
  ]) {
    if (!path.isAbsolute(item)) {
      throw new Error(`路径必须是绝对路径：${item}`);
    }
  }
  const retentionValues: RetentionPolicy[] = [
    "temporary_only",
    "manual",
  ];
  if (!retentionValues.includes(config.retentionPolicy)) {
    throw new Error(`无效的保留策略：${config.retentionPolicy}`);
  }
  if (typeof config.experimentalPsdUnattended !== "boolean") {
    throw new Error("PSD 无人值守实验设置必须为真或假。");
  }
  if (config.experimentalPsdUnattended && !config.experimentalPsd) {
    throw new Error("启用 PSD 无人值守前，必须先启用 PSD 实验功能。");
  }
  if (
    config.photoshopExecutable !== undefined &&
    (typeof config.photoshopExecutable !== "string" ||
      !path.isAbsolute(config.photoshopExecutable) ||
      path.basename(config.photoshopExecutable).toLowerCase() !==
        "photoshop.exe")
  ) {
    throw new Error("Photoshop 程序路径必须指向绝对路径中的 Photoshop.exe。");
  }
  if (
    config.photoshopProgId !== undefined &&
    (typeof config.photoshopProgId !== "string" ||
      config.photoshopProgId.length > 128 ||
      !/^Photoshop\.Application(?:\.[A-Za-z0-9]+)*$/iu.test(
        config.photoshopProgId,
      ))
  ) {
    throw new Error(
      "Photoshop 连接接口必须以 Photoshop.Application 开头，且只能包含字母、数字和点。",
    );
  }
  if (typeof config.quarantineCleanupEnabled !== "boolean") {
    throw new Error("隔离文件自动清理设置必须为真或假。");
  }
  if (
    !Number.isInteger(config.quarantineRetentionDays) ||
    config.quarantineRetentionDays < 0 ||
    config.quarantineRetentionDays > 3_650
  ) {
    throw new Error("隔离文件保留天数必须是 0 至 3650 的整数。");
  }
  if (
    !Number.isSafeInteger(config.quarantineMaxBytes) ||
    config.quarantineMaxBytes < 0
  ) {
    throw new Error("隔离文件容量上限必须是非负整数原始字节数。");
  }
  const cleanupTriggers: QuarantineCleanupTrigger[] = ["any", "all"];
  if (!cleanupTriggers.includes(config.quarantineCleanupTrigger)) {
    throw new Error(`无效的隔离文件清理条件：${config.quarantineCleanupTrigger}`);
  }
  if (
    config.quarantineCleanupEnabled &&
    config.quarantineRetentionDays === 0 &&
    config.quarantineMaxBytes === 0
  ) {
    throw new Error("启用隔离文件自动清理时，至少设置一个时间或容量阈值。");
  }
  if (!config.pipeName || !config.pipeToken) {
    throw new Error("本地通信凭据缺失。");
  }
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(config.pipeName)) {
    throw new Error("本地通信管道名称包含不安全字符。");
  }
  if (!/^[0-9a-f]{64}$/i.test(config.pipeToken)) {
    throw new Error("本地通信令牌必须是 256 位十六进制值。");
  }
  if (
    !Number.isFinite(config.stabilitySeconds) ||
    config.stabilitySeconds < 10 ||
    config.stabilitySeconds > 3_600
  ) {
    throw new Error("文件稳定等待时间必须在 10 至 3600 秒之间。");
  }
  if (
    !config.sourceSubfolderName ||
    config.sourceSubfolderName === "." ||
    config.sourceSubfolderName === ".." ||
    /[\\/:*?"<>|]/.test(config.sourceSubfolderName)
  ) {
    throw new Error("源目录成品子文件夹名称无效。");
  }
  if (
    config.deniedRoots.some((root) => pathInside(config.dataRoot, root))
  ) {
    throw new Error("软件数据目录不能位于排除目录中。");
  }
  for (const allowed of [
    ...config.allowedInputRoots,
    ...config.allowedOutputRoots,
  ]) {
    if (config.deniedRoots.some((root) => pathInside(allowed, root))) {
      throw new Error(`允许目录与排除目录重叠：${allowed}`);
    }
  }
  if (typeof config.pipelinePreflight !== "boolean") {
    throw new Error("流水线预检设置必须为真或假。");
  }
  if (typeof config.suppressDangerousOperationWarning !== "boolean") {
    throw new Error("危险操作提醒设置必须为真或假。");
  }
  if (
    !config.recentDirectories ||
    typeof config.recentDirectories !== "object" ||
    Array.isArray(config.recentDirectories)
  ) {
    throw new Error("最近使用目录设置无效。");
  }
  for (const [key, value] of Object.entries(config.recentDirectories)) {
    if (
      ![
        "source",
        "output",
        "watcher",
        "settingsImport",
        "settingsExport",
      ].includes(key)
    ) {
      throw new Error(`未知的最近目录类型：${key}`);
    }
    if (value !== undefined && !path.isAbsolute(String(value))) {
      throw new Error(`最近使用目录必须为绝对路径：${value}`);
    }
  }
  return {
    ...config,
    dataRoot: normalizeRoot(config.dataRoot),
    deniedRoots: config.deniedRoots.map(normalizeRoot),
    allowedInputRoots: config.allowedInputRoots.map(normalizeRoot),
    allowedOutputRoots: config.allowedOutputRoots.map(normalizeRoot),
    recentDirectories: Object.fromEntries(
      Object.entries(config.recentDirectories).map(([key, value]) => [
        key,
        value === undefined ? undefined : normalizeRoot(String(value)),
      ]),
    ),
  };
}

export async function ensureDataDirectories(config: AppConfig): Promise<void> {
  const directories = [
    config.dataRoot,
    path.join(config.dataRoot, "db"),
    path.join(config.dataRoot, "logs"),
    path.join(config.dataRoot, "logs", "jobs"),
    path.join(config.dataRoot, "reports"),
    path.join(config.dataRoot, "work"),
    path.join(config.dataRoot, "quarantine"),
  ];
  for (const directory of directories) {
    await fs.mkdir(directory, { recursive: true });
  }
}

export async function saveConfig(config: AppConfig): Promise<string> {
  const checked = validateConfig(config);
  await ensureDataDirectories(checked);
  const configPath = path.join(checked.dataRoot, CONFIG_FILE_NAME);
  const temporary = `${configPath}.partial-${process.pid}`;
  await fs.writeFile(temporary, `${JSON.stringify(checked, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(temporary, configPath);
  return configPath;
}

export async function loadConfig(dataRoot: string): Promise<AppConfig> {
  const resolvedRoot = path.resolve(dataRoot);
  const configPath = path.join(resolvedRoot, CONFIG_FILE_NAME);
  let raw: Record<string, any>;
  let originalConfigText = "";
  let originalConfigPath = configPath;
  let migratedLegacyFile = false;
  try {
    originalConfigText = await fs.readFile(configPath, "utf8");
    raw = JSON.parse(originalConfigText);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    originalConfigPath = path.join(resolvedRoot, LEGACY_CONFIG_FILE_NAME);
    originalConfigText = await fs.readFile(originalConfigPath, "utf8");
    raw = JSON.parse(originalConfigText);
    migratedLegacyFile = true;
  }
  const migratedLegacyConfig = raw.schemaVersion === 1;
  if (migratedLegacyConfig) {
    raw.schemaVersion = 2;
    raw.deniedRoots = Array.isArray(raw.deniedRoots)
      ? raw.deniedRoots.filter(
          (item: unknown) =>
            normalizeRoot(String(item)).toLowerCase() !== "e:\\work",
        )
      : [];
  }
  const migratedAlpha7Config = raw.schemaVersion === 2;
  if (migratedAlpha7Config) {
    raw.schemaVersion = 3;
    raw.pipelinePreflight = false;
    raw.suppressDangerousOperationWarning = false;
    raw.recentDirectories = {};
  }
  const migratedAlpha9Config = raw.schemaVersion === 3;
  if (migratedAlpha9Config) {
    const legacyQuarantine30d = raw.retentionPolicy === "quarantine_30d";
    raw.schemaVersion = 4;
    raw.experimentalPsdUnattended = false;
    raw.retentionPolicy = legacyQuarantine30d
      ? "temporary_only"
      : raw.retentionPolicy;
    raw.quarantineCleanupEnabled = legacyQuarantine30d;
    raw.quarantineRetentionDays = 30;
    raw.quarantineMaxBytes = 100 * GIB;
    raw.quarantineCleanupTrigger = "any";
  }
  const migratedAlpha10Config = raw.schemaVersion === 4;
  if (migratedAlpha10Config) {
    raw.schemaVersion = 5;
    delete raw.photoshopProgId;
  }
  const checked = validateConfig(raw);
  if (
    migratedLegacyConfig ||
    migratedAlpha7Config ||
    migratedAlpha9Config ||
    migratedAlpha10Config ||
    migratedLegacyFile
  ) {
    const backupDirectory = path.join(resolvedRoot, "config-backups");
    await fs.mkdir(backupDirectory, { recursive: true });
    const backupName = `${path.basename(originalConfigPath)}.before-schema-5-${new Date()
      .toISOString()
      .replace(/[:.]/gu, "-")}.json`;
    await fs.writeFile(
      path.join(backupDirectory, backupName),
      originalConfigText,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    await saveConfig(checked);
  }
  return checked;
}

export function defaultBootstrapDirectory(): string {
  const base =
    process.env.APPDATA ||
    path.join(os.homedir(), "AppData", "Roaming");
  return path.join(base, "PSMetaC");
}

export function legacyBootstrapDirectory(): string {
  const base =
    process.env.APPDATA ||
    path.join(os.homedir(), "AppData", "Roaming");
  return path.join(base, "PSBMetadataCleaner");
}

export async function saveBootstrap(
  bootstrapDirectory: string,
  dataRoot: string,
): Promise<string> {
  await fs.mkdir(bootstrapDirectory, { recursive: true });
  const target = path.join(bootstrapDirectory, BOOTSTRAP_FILE_NAME);
  await fs.writeFile(
    target,
    `${JSON.stringify({ schemaVersion: 1, dataRoot: path.resolve(dataRoot) }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return target;
}

export async function loadBootstrap(
  bootstrapDirectory = defaultBootstrapDirectory(),
): Promise<{ schemaVersion: 1; dataRoot: string } | null> {
  const read = async (directory: string) => {
    const raw = JSON.parse(
      await fs.readFile(
        path.join(directory, BOOTSTRAP_FILE_NAME),
        "utf8",
      ),
    );
    if (raw.schemaVersion !== 1 || !path.isAbsolute(raw.dataRoot)) {
      return null;
    }
    return raw as { schemaVersion: 1; dataRoot: string };
  };
  try {
    return await read(bootstrapDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (
      path.resolve(bootstrapDirectory).toLowerCase() !==
      path.resolve(defaultBootstrapDirectory()).toLowerCase()
    ) return null;
    try {
      const legacy = await read(legacyBootstrapDirectory());
      if (legacy) {
        await saveBootstrap(defaultBootstrapDirectory(), legacy.dataRoot);
      }
      return legacy;
    } catch (legacyError) {
      if ((legacyError as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw legacyError;
    }
  }
}
