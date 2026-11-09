import fs from "node:fs/promises";
import path from "node:path";
import { resolveLegacyAssets } from "./legacy-assets.ts";
import { runProcess } from "./process-runner.ts";
import type { InspectionResult } from "./types.ts";

export async function inspectPsb(input: {
  sourcePath: string;
  cleanupPlanPath: string;
  artifactDirectory: string;
  isCancelled?: () => boolean | Promise<boolean>;
}): Promise<InspectionResult> {
  const assets = resolveLegacyAssets();
  await fs.mkdir(input.artifactDirectory, { recursive: true });
  const result = await runProcess(
    process.execPath,
    [assets.inspector, input.sourcePath, input.cleanupPlanPath],
    {
      cwd: input.artifactDirectory,
      env: { ELECTRON_RUN_AS_NODE: "1" },
      timeoutMs: 6 * 60 * 60 * 1000,
      isCancelled: input.isCancelled,
    },
  );
  if (result.cancelled) throw new Error("__JOB_CANCELLED__");
  if (result.timedOut) throw new Error("PREFLIGHT_TIMEOUT");
  if (result.code !== 0) {
    throw new Error(
      `PREFLIGHT_PROCESS_FAILED (${result.code}): ${result.stderr || result.stdout}`,
    );
  }
  let parsed: InspectionResult;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `PREFLIGHT_INVALID_JSON: ${(error as Error).message}; stderr=${result.stderr}`,
    );
  }
  if (path.resolve(parsed.target) !== path.resolve(input.sourcePath)) {
    throw new Error("PREFLIGHT_SOURCE_PATH_MISMATCH");
  }
  return parsed;
}
