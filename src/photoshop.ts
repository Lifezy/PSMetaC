import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveLegacyAssets } from "./legacy-assets.ts";
import { runProcess, type ProcessResult } from "./process-runner.ts";
import {
  normalizePhotoshopVersion,
  runningPhotoshopExecutables,
  type PhotoshopInstallation,
} from "./environment.ts";

function cscriptPath(): string {
  return path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "cscript.exe",
  );
}

function pathKey(value: string): string {
  const resolved = path.resolve(value).replace(/[\\/]+$/u, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function keyValues(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/u)) {
    const delimiter = line.indexOf("=");
    if (delimiter <= 0) continue;
    result[line.slice(0, delimiter).replace(/^\uFEFF/u, "").trim()] = line
      .slice(delimiter + 1)
      .trim();
  }
  return result;
}

function decodedValue(value: string | undefined): string {
  if (!value) return "";
  let decoded = value;
  for (let index = 0; index < 3; index += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

const BRIDGE_PROBE_JSX = `#target photoshop
var psmetacBridgeOutput = new File(String(arguments[0]));
psmetacBridgeOutput.encoding = "UTF8";
if (!psmetacBridgeOutput.open("w")) {
    throw new Error("Cannot create PSMetaC bridge result");
}
try {
    var psmetacApplicationPath = app.path && app.path.fsName
        ? String(app.path.fsName)
        : String(app.path);
    psmetacBridgeOutput.writeln("STATUS=OK");
    psmetacBridgeOutput.writeln("VERSION=" + encodeURIComponent(String(app.version)));
    psmetacBridgeOutput.writeln("APPLICATION_PATH=" + encodeURIComponent(psmetacApplicationPath));
} finally {
    psmetacBridgeOutput.close();
}
`;

export interface PhotoshopBridgeProbe {
  ok: boolean;
  reasonCode:
    | "BRIDGE_OK"
    | "PHOTOSHOP_COM_NOT_REGISTERED"
    | "PHOTOSHOP_COM_CREATE_FAILED"
    | "PHOTOSHOP_JAVASCRIPT_UNAVAILABLE"
    | "PHOTOSHOP_BRIDGE_TIMEOUT"
    | "PHOTOSHOP_PROCESS_NOT_AUTOMATION_READY"
    | "PHOTOSHOP_SELECTED_INSTANCE_BUSY"
    | "PHOTOSHOP_EXECUTABLE_MISMATCH"
    | "PHOTOSHOP_VERSION_MISMATCH"
    | "PHOTOSHOP_BRIDGE_UNKNOWN_FAILURE";
  progId: string | null;
  method: string | null;
  expectedExecutable: string;
  actualExecutable: string | null;
  expectedVersion: string;
  actualVersion: string | null;
  errorNumber: string | null;
  errorHex: string | null;
  errorDescription: string | null;
  stdout: string;
  stderr: string;
  exitCode: number;
}

function bridgeReasonDescription(
  reasonCode: PhotoshopBridgeProbe["reasonCode"],
  progId: string,
): string | null {
  const descriptions: Partial<
    Record<PhotoshopBridgeProbe["reasonCode"], string>
  > = {
    PHOTOSHOP_COM_NOT_REGISTERED: "没有找到可用的 Photoshop 自动化接口。",
    PHOTOSHOP_COM_CREATE_FAILED: `Windows 无法通过 ${progId} 连接 Photoshop。`,
    PHOTOSHOP_JAVASCRIPT_UNAVAILABLE: `Photoshop 已响应 ${progId}，但没有执行无文件 JSX 握手。`,
    PHOTOSHOP_BRIDGE_TIMEOUT: `连接 ${progId} 超过 45 秒没有返回。`,
    PHOTOSHOP_PROCESS_NOT_AUTOMATION_READY:
      "所选 Photoshop 已在后台运行，但没有注册为可控制实例。PSMetaC 不会强行关闭它；请先保存工作并正常退出这个 Photoshop，再重试，或选择另一版本。",
    PHOTOSHOP_SELECTED_INSTANCE_BUSY:
      "所选 Photoshop 正在使用或暂时无法确认空闲。PSMetaC 已跳过连接测试，不会激活、抢占或操作这个实例；请等它空闲后重试，或选择另一版本。",
    PHOTOSHOP_EXECUTABLE_MISMATCH:
      "接口连接到了另一套 Photoshop，实际路径与所选版本不一致。",
    PHOTOSHOP_VERSION_MISMATCH:
      "接口返回的 Photoshop 版本与所选安装不一致。",
    PHOTOSHOP_BRIDGE_UNKNOWN_FAILURE:
      "Photoshop 自动化握手没有返回完整的版本和安装路径。",
  };
  return descriptions[reasonCode] || null;
}

export async function probePhotoshopBridge(
  installation: PhotoshopInstallation,
  progId = installation.progId || "",
): Promise<PhotoshopBridgeProbe> {
  if (!progId) {
    return {
      ok: false,
      reasonCode: "PHOTOSHOP_COM_NOT_REGISTERED",
      progId: null,
      method: null,
      expectedExecutable: installation.executable,
      actualExecutable: null,
      expectedVersion: installation.productVersion,
      actualVersion: null,
      errorNumber: null,
      errorHex: null,
      errorDescription:
        "检测到 Photoshop.exe，但没有找到指向该安装的 COM 注册。",
      stdout: "",
      stderr: "",
      exitCode: 3,
    };
  }
  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "psmetac-bridge-"),
  );
  const jsxPath = path.join(temporaryDirectory, "probe.jsx");
  const resultPath = path.join(temporaryDirectory, "jsx-result.txt");
  const statusPath = path.join(temporaryDirectory, "bridge-status.txt");
  await fs.writeFile(jsxPath, BRIDGE_PROBE_JSX, "utf8");
  let result: ProcessResult;
  let statusText = "";
  let jsxText = "";
  try {
    result = await runProcess(
      cscriptPath(),
      [
        "//Nologo",
        "//U",
        resolveLegacyAssets().bridgeProbeVbs,
        progId,
        jsxPath,
        resultPath,
        statusPath,
      ],
      {
        timeoutMs: 45_000,
        stdoutEncoding: "utf16le",
        stderrEncoding: "utf16le",
      },
    );
    [statusText, jsxText] = await Promise.all([
      fs.readFile(statusPath, "utf16le").catch(() => ""),
      fs.readFile(resultPath, "utf8").catch(() => ""),
    ]);
  } finally {
    const resolvedTemporary = path.resolve(temporaryDirectory);
    const resolvedRoot = path.resolve(os.tmpdir());
    if (resolvedTemporary.startsWith(`${resolvedRoot}${path.sep}`)) {
      await fs.rm(resolvedTemporary, { recursive: true, force: true });
    }
  }
  const values = keyValues(
    `${statusText}\n${jsxText}\n${result.stdout}\n${result.stderr}`,
  );
  const applicationPath = decodedValue(values.APPLICATION_PATH);
  const actualExecutable = applicationPath
    ? /Photoshop\.exe$/iu.test(applicationPath)
      ? path.resolve(applicationPath)
      : path.resolve(applicationPath, "Photoshop.exe")
    : null;
  let reasonCode: PhotoshopBridgeProbe["reasonCode"] = "BRIDGE_OK";
  if (result.timedOut) {
    reasonCode = "PHOTOSHOP_BRIDGE_TIMEOUT";
  } else if (values.STATUS === "COM_CREATE_FAILED" || result.code === 3) {
    reasonCode = "PHOTOSHOP_COM_CREATE_FAILED";
  } else if (
    values.STATUS === "JAVASCRIPT_FILE_FAILED" ||
    result.code === 4
  ) {
    reasonCode = "PHOTOSHOP_JAVASCRIPT_UNAVAILABLE";
  } else if (result.code !== 0 || values.STATUS !== "OK") {
    reasonCode = "PHOTOSHOP_BRIDGE_UNKNOWN_FAILURE";
  } else if (!actualExecutable) {
    reasonCode = "PHOTOSHOP_BRIDGE_UNKNOWN_FAILURE";
  } else if (
    pathKey(actualExecutable) !== pathKey(installation.executable)
  ) {
    reasonCode = "PHOTOSHOP_EXECUTABLE_MISMATCH";
  } else if (
    normalizePhotoshopVersion(values.VERSION || "") !==
    normalizePhotoshopVersion(installation.productVersion)
  ) {
    reasonCode = "PHOTOSHOP_VERSION_MISMATCH";
  }
  return {
    ok: reasonCode === "BRIDGE_OK",
    reasonCode,
    progId,
    method: values.METHOD || null,
    expectedExecutable: installation.executable,
    actualExecutable,
    expectedVersion: installation.productVersion,
    actualVersion: decodedValue(values.VERSION) || null,
    errorNumber: values.ERROR_NUMBER || null,
    errorHex: values.ERROR_HEX || null,
    errorDescription:
      values.ERROR_DESCRIPTION || bridgeReasonDescription(reasonCode, progId),
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.code,
  };
}

export interface PhotoshopBridgeResolution {
  ok: boolean;
  selected: PhotoshopBridgeProbe | null;
  attempts: PhotoshopBridgeProbe[];
  mode: "automatic" | "specified";
}

export async function resolvePhotoshopBridge(
  installation: PhotoshopInstallation,
  specifiedProgId?: string,
): Promise<PhotoshopBridgeResolution> {
  const candidates = specifiedProgId
    ? [specifiedProgId]
    : installation.comCandidates.map((item) => item.progId);
  if (!candidates.length && installation.progId) {
    candidates.push(installation.progId);
  }
  const attempts: PhotoshopBridgeProbe[] = [];
  if (!candidates.length) {
    attempts.push(await probePhotoshopBridge(installation, ""));
  }
  const firstCandidate = candidates[0];
  const candidateIsRegistered = installation.comCandidates.some(
    (item) => item.progId.toLowerCase() === firstCandidate?.toLowerCase(),
  );
  if (firstCandidate && candidateIsRegistered) {
    const [idle, runningExecutables] = await Promise.all([
      probePhotoshopIdle(undefined, firstCandidate),
      runningPhotoshopExecutables(),
    ]);
    const selectedProcessExists = runningExecutables.some(
      (item) => pathKey(item) === pathKey(installation.executable),
    );
    if (idle.state === "not_running" && selectedProcessExists) {
      const blocked: PhotoshopBridgeProbe = {
        ok: false,
        reasonCode: "PHOTOSHOP_PROCESS_NOT_AUTOMATION_READY",
        progId: firstCandidate,
        method: null,
        expectedExecutable: installation.executable,
        actualExecutable: installation.executable,
        expectedVersion: installation.productVersion,
        actualVersion: null,
        errorNumber: null,
        errorHex: null,
        errorDescription: bridgeReasonDescription(
          "PHOTOSHOP_PROCESS_NOT_AUTOMATION_READY",
          firstCandidate,
        ),
        stdout: "",
        stderr: "",
        exitCode: 5,
      };
      attempts.push(blocked);
      return {
        ok: false,
        selected: blocked,
        attempts,
        mode: specifiedProgId ? "specified" : "automatic",
      };
    }
    if (
      selectedProcessExists &&
      ["busy", "source_open", "unknown"].includes(idle.state)
    ) {
      const blocked: PhotoshopBridgeProbe = {
        ok: false,
        reasonCode: "PHOTOSHOP_SELECTED_INSTANCE_BUSY",
        progId: firstCandidate,
        method: null,
        expectedExecutable: installation.executable,
        actualExecutable: installation.executable,
        expectedVersion: installation.productVersion,
        actualVersion: null,
        errorNumber: null,
        errorHex: null,
        errorDescription: `${bridgeReasonDescription(
          "PHOTOSHOP_SELECTED_INSTANCE_BUSY",
          firstCandidate,
        )} 当前状态：${idle.detail || idle.state}`,
        stdout: "",
        stderr: "",
        exitCode: 6,
      };
      attempts.push(blocked);
      return {
        ok: false,
        selected: blocked,
        attempts,
        mode: specifiedProgId ? "specified" : "automatic",
      };
    }
  }
  for (const candidate of [...new Set(candidates)]) {
    const attempt = await probePhotoshopBridge(installation, candidate);
    attempts.push(attempt);
    if (attempt.ok) {
      return {
        ok: true,
        selected: attempt,
        attempts,
        mode: specifiedProgId ? "specified" : "automatic",
      };
    }
    if (attempt.reasonCode === "PHOTOSHOP_BRIDGE_TIMEOUT") break;
  }
  return {
    ok: false,
    selected: attempts.at(-1) || null,
    attempts,
    mode: specifiedProgId ? "specified" : "automatic",
  };
}

export async function probePhotoshopIdle(
  sourcePath?: string,
  progId = "Photoshop.Application",
): Promise<{
  state: "not_running" | "idle" | "busy" | "source_open" | "unknown";
  detail: string;
}> {
  if (process.platform !== "win32") {
    return { state: "unknown", detail: "Photoshop automation is Windows-only." };
  }
  const probePath = resolveLegacyAssets().idleProbeVbs;
  const result = await runProcess(
    cscriptPath(),
    ["//Nologo", probePath, sourcePath ? path.resolve(sourcePath) : "", progId],
    {
      timeoutMs: 15_000,
      stdoutEncoding: "utf8",
      stderrEncoding: "utf8",
    },
  );
  const detail = (result.stdout || result.stderr).trim();
  if (detail === "NOT_RUNNING") return { state: "not_running", detail };
  if (detail === "IDLE") return { state: "idle", detail };
  if (detail === "SOURCE_OPEN" || result.code === 11) {
    return { state: "source_open", detail };
  }
  if (detail.startsWith("BUSY_") || result.code === 10) {
    return { state: "busy", detail };
  }
  return { state: "unknown", detail: detail || `exit=${result.code}` };
}

export async function createCancellationFlag(
  artifactDirectory: string,
): Promise<string> {
  const target = path.join(artifactDirectory, "CANCEL.flag");
  await fs.writeFile(
    target,
    `cancel-requested-at=${new Date().toISOString()}\n`,
    { encoding: "utf8", flag: "wx" },
  ).catch(async (error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  return target;
}

export async function runPhotoshopCleanup(input: {
  workingSource: string;
  stagingOutput: string;
  artifactDirectory: string;
  progId: string;
  executionMode?: "safe_copy" | "in_place";
  coveragePolicy?: "strict" | "threshold" | "skip";
  coverageThresholdPercent?: number;
  reopenRequired?: boolean;
  deleteHiddenLayers?: boolean;
  deleteEmptyLayers?: boolean;
  isCancelled?: () => boolean | Promise<boolean>;
  onPoll?: () => void | Promise<void>;
}): Promise<ProcessResult> {
  const assets = resolveLegacyAssets();
  const jobPath = path.join(input.artifactDirectory, "photoshop_job.tsv");
  const job = [
    "#PSB_METADATA_CLEANER_JOB_V1",
    `SOURCE_PATH\t${encodeURIComponent(input.workingSource)}`,
    `OUTPUT_PATH\t${encodeURIComponent(input.stagingOutput)}`,
    `ARTIFACT_DIR\t${encodeURIComponent(input.artifactDirectory)}`,
    `EXECUTION_MODE\t${input.executionMode || "safe_copy"}`,
    `COVERAGE_POLICY\t${input.coveragePolicy || "strict"}`,
    `COVERAGE_THRESHOLD_PERCENT\t${Math.max(0, Math.min(100, input.coverageThresholdPercent ?? 5))}`,
    `REOPEN_REQUIRED\t${input.reopenRequired === false ? "false" : "true"}`,
    `DELETE_HIDDEN_LAYERS\t${input.deleteHiddenLayers === true ? "true" : "false"}`,
    `DELETE_EMPTY_LAYERS\t${input.deleteEmptyLayers === true ? "true" : "false"}`,
    "",
  ].join("\n");
  await fs.writeFile(jobPath, job, "utf8");
  const photoshopLogPath = path.join(input.artifactDirectory, "photoshop.log");
  let lastHeartbeatSignature = "";
  return await runProcess(
    cscriptPath(),
    [
      "//Nologo",
      "//U",
      assets.bridgeVbs,
      assets.cleanupJsx,
      jobPath,
      input.progId,
    ],
    {
      cwd: input.artifactDirectory,
      // Photoshop may legitimately spend hours saving a very large PSB. A
      // wall-clock timeout would destroy useful work merely because the file
      // is slow, so cleanup uses activity-based supervision instead.
      timeoutMs: 0,
      inactivityTimeoutMs: 6 * 60 * 60 * 1000,
      stdoutEncoding: "utf16le",
      stderrEncoding: "utf16le",
      // Do not kill Photoshop on cancellation. The JSX observes CANCEL.flag.
      isCancelled: undefined,
      onPoll: async () => {
        await input.onPoll?.();
        const stat = await fs.stat(photoshopLogPath).catch(() => null);
        if (!stat) return false;
        const signature = `${stat.size}:${stat.mtimeMs}`;
        if (signature === lastHeartbeatSignature) return false;
        lastHeartbeatSignature = signature;
        return true;
      },
      progressPollMs: 1_000,
    },
  );
}
