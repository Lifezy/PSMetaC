import assert from "node:assert/strict";
import test from "node:test";
import {
  addCompletedJob,
  completionNotificationBody,
  emptyCompletionCounts,
} from "../src/notifications.ts";

test("completion notification distinguishes safe copies from direct saves", () => {
  const counts = emptyCompletionCounts();
  addCompletedJob(counts, { executionMode: "safe_copy" } as any);
  addCompletedJob(counts, {
    executionMode: "in_place",
    backupPath: "D:\\backup\\source.psb",
  } as any);
  addCompletedJob(counts, {
    executionMode: "in_place",
    backupPath: null,
  } as any);
  const body = completionNotificationBody(counts);
  assert.match(body, /1 个安全副本/u);
  assert.match(body, /1 个原文件已直接保存（有备份/u);
  assert.match(body, /1 个原文件已直接保存（无备份/u);
  assert.doesNotMatch(body, /3 个新副本/u);
});

test("partial direct saves are never announced as fully completed", () => {
  const counts = emptyCompletionCounts();
  addCompletedJob(counts, {
    status: "partial",
    reasonCode: "IN_PLACE_PARTIAL_SAVED_UNVALIDATED",
    executionMode: "in_place",
    backupPath: "D:\\backup\\partial.psb",
  } as any);
  const body = completionNotificationBody(counts);
  assert.match(body, /部分对象未完成/u);
  assert.doesNotMatch(body, /已直接保存（有备份/u);
});
