import type { JobRecord } from "./types.ts";

export interface CompletionCounts {
  safeCopy: number;
  inPlaceWithBackup: number;
  inPlaceWithoutBackup: number;
  partialInPlace: number;
}

export function emptyCompletionCounts(): CompletionCounts {
  return {
    safeCopy: 0,
    inPlaceWithBackup: 0,
    inPlaceWithoutBackup: 0,
    partialInPlace: 0,
  };
}

export function addCompletedJob(
  counts: CompletionCounts,
  job: JobRecord,
): void {
  if (
    job.status === "partial" ||
    job.reasonCode === "IN_PLACE_PARTIAL_SAVED_UNVALIDATED"
  ) {
    counts.partialInPlace++;
    return;
  }
  if (job.executionMode === "in_place") {
    if (job.backupPath) counts.inPlaceWithBackup++;
    else counts.inPlaceWithoutBackup++;
    return;
  }
  counts.safeCopy++;
}

export function completionNotificationBody(
  counts: CompletionCounts,
): string {
  const parts: string[] = [];
  if (counts.safeCopy) {
    parts.push(`${counts.safeCopy} 个安全副本已通过所选验收并发布`);
  }
  if (counts.inPlaceWithBackup) {
    parts.push(
      `${counts.inPlaceWithBackup} 个原文件已直接保存（有备份，未做保存后校对）`,
    );
  }
  if (counts.inPlaceWithoutBackup) {
    parts.push(
      `${counts.inPlaceWithoutBackup} 个原文件已直接保存（无备份，未做保存后校对）`,
    );
  }
  if (counts.partialInPlace) {
    parts.push(
      `${counts.partialInPlace} 个原文件已保存，但有部分对象未完成（请查看报告）`,
    );
  }
  return parts.join("；") || "任务已完成";
}
