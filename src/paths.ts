import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import type { AppConfig, OutputMode } from "./types.ts";

export class PathPolicyError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PathPolicyError";
    this.code = code;
  }
}

function comparisonValue(value: string): string {
  const absolute = path.resolve(value);
  let existing = absolute;
  for (;;) {
    try {
      existing = path.resolve(
        realpathSync.native(existing),
        path.relative(existing, absolute),
      );
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) {
        existing = absolute;
        break;
      }
      existing = parent;
    }
  }
  const resolved = existing.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isPathInside(candidate: string, root: string): boolean {
  const child = comparisonValue(candidate);
  const parent = comparisonValue(root);
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

export function assertNotDenied(
  candidate: string,
  deniedRoots: string[],
): void {
  const denied = deniedRoots.find((root) => isPathInside(candidate, root));
  if (denied) {
    throw new PathPolicyError(
      "DENIED_PATH",
      `该路径位于用户配置的排除目录中（${denied}）：${candidate}`,
    );
  }
}

export function assertInAllowedRoots(
  candidate: string,
  roots: string[],
  kind: "input" | "output",
): void {
  if (roots.length === 0) {
    throw new PathPolicyError(
      `NO_ALLOWED_${kind.toUpperCase()}_ROOTS`,
      kind === "input"
        ? "尚未配置允许输入目录。手动选择单个文件不受此限制；监控目录和 MCP 必须先配置允许输入目录。"
        : "尚未配置允许输出目录。请在设置中添加目录，或在创建任务时明确选择成品目录。",
    );
  }
  if (!roots.some((root) => isPathInside(candidate, root))) {
    throw new PathPolicyError(
      `${kind.toUpperCase()}_OUTSIDE_ALLOWED_ROOTS`,
      kind === "input"
        ? `输入路径不在允许输入目录中：${candidate}`
        : `输出路径不在允许输出目录中：${candidate}`,
    );
  }
}

async function nearestExistingParent(candidate: string): Promise<string> {
  let current = path.resolve(candidate);
  for (;;) {
    try {
      await fs.access(current);
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw new PathPolicyError(
          "NO_EXISTING_PARENT",
          `找不到现有父目录：${candidate}`,
        );
      }
      current = parent;
    }
  }
}

export async function canonicalizeForPolicy(
  candidate: string,
): Promise<string> {
  const absolute = path.resolve(candidate);
  const existingParent = await nearestExistingParent(absolute);
  const realParent = await fs.realpath(existingParent);
  const remainder = path.relative(existingParent, absolute);
  return path.resolve(realParent, remainder);
}

async function assertSourceIsRegularFile(sourcePath: string): Promise<void> {
  const stat = await fs.lstat(sourcePath);
  if (stat.isSymbolicLink()) {
    throw new PathPolicyError(
      "SOURCE_SYMLINK_FORBIDDEN",
      `不允许把符号链接作为源文件：${sourcePath}`,
    );
  }
  if (!stat.isFile()) {
    throw new PathPolicyError(
      "SOURCE_NOT_FILE",
      `源路径不是普通文件：${sourcePath}`,
    );
  }
}

export async function validateSourcePath(
  sourceInput: string,
  config: AppConfig,
  options: { allowOutsideAllowedRoots?: boolean } = {},
): Promise<{ sourcePath: string; experimental: boolean }> {
  if (!path.isAbsolute(sourceInput)) {
    throw new PathPolicyError(
      "SOURCE_NOT_ABSOLUTE",
      `源文件必须使用绝对路径：${sourceInput}`,
    );
  }
  const sourcePath = await canonicalizeForPolicy(sourceInput);
  assertNotDenied(sourcePath, config.deniedRoots);
  if (!options.allowOutsideAllowedRoots) {
    assertInAllowedRoots(sourcePath, config.allowedInputRoots, "input");
  }
  await assertSourceIsRegularFile(sourcePath);
  const extension = path.extname(sourcePath).toLowerCase();
  if (extension === ".psb") {
    return { sourcePath, experimental: false };
  }
  if (extension === ".psd" && config.experimentalPsd) {
    return { sourcePath, experimental: true };
  }
  throw new PathPolicyError(
    extension === ".psd"
      ? "PSD_EXPERIMENT_DISABLED"
      : "UNSUPPORTED_FILE_EXTENSION",
    extension === ".psd"
      ? "PSD 实验功能尚未启用。请在“设置 → 实验功能”中开启；PSD 只能仅预检或预检后人工批准，不能自动执行。"
      : `不支持的文件类型：${extension || "无扩展名"}。当前支持 PSB；PSD 需显式开启实验功能。`,
  );
}

function timestampForFile(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

export async function buildOutputPath(input: {
  sourcePath: string;
  jobId: string;
  outputMode: OutputMode;
  outputDir?: string | null;
  config: AppConfig;
  allowOutsideAllowedRoots?: boolean;
  now?: Date;
}): Promise<{ outputDir: string; outputPath: string }> {
  const { sourcePath, jobId, outputMode, config } = input;
  let outputDir: string;
  if (outputMode === "source_subfolder") {
    outputDir = path.join(
      path.dirname(sourcePath),
      config.sourceSubfolderName,
    );
  } else {
    if (!input.outputDir) {
      throw new PathPolicyError(
        "OUTPUT_DIRECTORY_REQUIRED",
        "选择“指定目录”时必须明确选择成品目录。",
      );
    }
    outputDir = path.resolve(input.outputDir);
  }
  const canonicalDir = await canonicalizeForPolicy(outputDir);
  assertNotDenied(canonicalDir, config.deniedRoots);
  if (!input.allowOutsideAllowedRoots) {
    assertInAllowedRoots(canonicalDir, config.allowedOutputRoots, "output");
  }

  const parsed = path.parse(sourcePath);
  const fileName = `${parsed.name}.cleaned-${timestampForFile(input.now)}-${jobId.slice(0, 8)}${parsed.ext.toLowerCase()}`;
  const outputPath = path.join(canonicalDir, fileName);
  if (comparisonValue(outputPath) === comparisonValue(sourcePath)) {
    throw new PathPolicyError(
      "OUTPUT_EQUALS_SOURCE",
      "成品路径不能与源文件相同。",
    );
  }
  try {
    await fs.access(outputPath);
    throw new PathPolicyError(
      "OUTPUT_ALREADY_EXISTS",
      `拒绝覆盖已经存在的成品：${outputPath}`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return { outputDir: canonicalDir, outputPath };
}

export function assertPathWithinDataRoot(
  candidate: string,
  dataRoot: string,
): void {
  if (!isPathInside(candidate, dataRoot) || comparisonValue(candidate) === comparisonValue(dataRoot)) {
    throw new PathPolicyError(
      "UNSAFE_DATA_ROOT_OPERATION",
      `操作目标必须位于软件数据目录内部：${candidate}`,
    );
  }
}
