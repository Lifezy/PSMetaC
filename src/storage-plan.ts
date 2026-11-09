import path from "node:path";
import type { ExecutionMode } from "./types.ts";

function volumeKey(candidate: string): string {
  return path.parse(path.resolve(candidate)).root.toLowerCase();
}

export interface ExecutionStoragePlan {
  executionMode: ExecutionMode;
  workRoot: string;
  outputRoot: string;
  requiredWorkBytes: number;
  requiredOutputBytes: number;
  workFree: number;
  outputFree: number;
  workShortfallBytes: number;
  outputShortfallBytes: number;
  sameWorkAndOutputVolume: boolean;
  eligible: boolean;
  explanation: string;
}

export function planExecutionStorage(input: {
  executionMode: ExecutionMode;
  backupSource: boolean;
  sourceBytes: number;
  minimumSpaceMultiplier: number;
  minimumSpaceReserveBytes: number;
  dataRoot: string;
  dataFree: number;
  outputRoot: string;
  outputFree: number;
}): ExecutionStoragePlan {
  const outputRoot = path.resolve(input.outputRoot);
  const dataRoot = path.resolve(input.dataRoot);
  const sourceSaveHeadroom = Math.ceil(input.sourceBytes * 1.2);
  if (input.executionMode === "safe_copy") {
    const requiredWorkBytes =
      input.sourceBytes * input.minimumSpaceMultiplier +
      input.minimumSpaceReserveBytes;
    const shortfall = Math.max(0, requiredWorkBytes - input.outputFree);
    return {
      executionMode: input.executionMode,
      workRoot: outputRoot,
      outputRoot,
      requiredWorkBytes,
      requiredOutputBytes: 0,
      workFree: input.outputFree,
      outputFree: input.outputFree,
      workShortfallBytes: shortfall,
      outputShortfallBytes: 0,
      sameWorkAndOutputVolume: true,
      eligible: shortfall === 0,
      explanation:
        "工作副本、Photoshop 临时成品和最终成品都放在成品盘；空间门槛按这块盘一次计算，数据目录只保存报告和日志。",
    };
  }

  const requiredWorkBytes =
    (input.backupSource ? input.sourceBytes : 0) +
    input.minimumSpaceReserveBytes;
  const requiredOutputBytes = sourceSaveHeadroom;
  const sameVolume = volumeKey(dataRoot) === volumeKey(outputRoot);
  const combinedRequired = requiredWorkBytes + requiredOutputBytes;
  const workShortfallBytes = Math.max(
    0,
    (sameVolume ? combinedRequired : requiredWorkBytes) - input.dataFree,
  );
  const outputShortfallBytes = sameVolume
    ? 0
    : Math.max(0, requiredOutputBytes - input.outputFree);
  return {
    executionMode: input.executionMode,
    workRoot: dataRoot,
    outputRoot,
    requiredWorkBytes,
    requiredOutputBytes,
    workFree: input.dataFree,
    outputFree: sameVolume ? input.dataFree : input.outputFree,
    workShortfallBytes,
    outputShortfallBytes,
    sameWorkAndOutputVolume: sameVolume,
    eligible: workShortfallBytes === 0 && outputShortfallBytes === 0,
    explanation:
      "直接保存原文件时，源文件所在盘承担 Photoshop 保存临时空间；数据目录只承担可选备份和最低安全余量。",
  };
}
