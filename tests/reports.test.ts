import assert from "node:assert/strict";
import test from "node:test";
import { renderReportHtml } from "../src/reports.ts";
import type { FileReport } from "../src/types.ts";

function baseReport(): FileReport {
  return {
    schemaVersion: 1,
    reportVersion: "1.0",
    appVersion: "0.1.0-alpha.9",
    jobId: "job-review",
    machineId: "machine-1",
    status: "quarantined",
    reasonCode: "PIXEL_NOT_EXACT",
    startedAt: "2026-07-29T03:00:00Z",
    finishedAt: "2026-07-29T03:10:00Z",
    source: { path: "G:\\input\\review.psb", unchanged: true },
    policy: { profile: "standard" },
    environment: {},
    preflight: {},
    execution: {
      diskSpaceAssessment: {
        requiredWorkBytes: 24_482_396_160,
        workFree: 19_757_072_384,
        outputFree: 19_757_072_384,
        workShortfallBytes: 4_725_323_776,
        outputShortfallBytes: 0,
        explanation: "这是安全门槛，不是成品最终体积。",
      },
    },
    validation: {
      errors: ["PIXEL_NOT_EXACT"],
      warnings: [],
      pixel: { beforeVsAfterReopen: { exact: false } },
    },
    output: {
      path: "G:\\quarantine\\review.psb",
      documentAncestorsAfter: 0,
      smartObjectFailureCount: 0,
    },
    timing: {},
    logs: {},
  };
}

test("HTML report escapes file names and exposes core evidence", () => {
  const report: FileReport = {
    schemaVersion: 1,
    reportVersion: "1.0",
    appVersion: "0.1.0-alpha.9",
    jobId: "job-1",
    machineId: "machine-1",
    status: "succeeded",
    reasonCode: "STRICT_VALIDATION_PASSED",
    startedAt: "2026-07-24T00:00:00Z",
    finishedAt: "2026-07-24T00:01:00Z",
    source: {
      path: "C:\\input\\<unsafe>.psb",
      beforeBytes: 100,
      unchanged: true,
    },
    policy: { profile: "standard" },
    environment: {},
    preflight: {},
    execution: {
      diskSpaceAssessment: {
        requiredWorkBytes: 24_482_396_160,
        workFree: 19_757_072_384,
        outputFree: 19_757_072_384,
        workShortfallBytes: 4_725_323_776,
        outputShortfallBytes: 0,
        explanation: "这是安全门槛，不是成品最终体积。",
      },
    },
    validation: {
      errors: [],
      warnings: [],
      pixel: { beforeVsAfterReopen: { exact: true } },
    },
    output: {
      path: "C:\\output\\safe.psb",
      bytes: 50,
      reductionBytes: 50,
      sizeChangePercent: -50,
      xmpRemovedBytes: 50,
      documentAncestorsAfter: 0,
      smartObjectFailureCount: 0,
    },
    timing: {},
    logs: {},
  };
  const html = renderReportHtml(report);
  assert.match(html, /源文件未变/);
  assert.match(html, /像素完全一致/);
  assert.doesNotMatch(html, /<unsafe>/);
  assert.match(html, /&lt;unsafe&gt;/);
  assert.match(html, /减少 50\.00%/u);
  assert.match(html, /安全处理估算空间/u);
  assert.match(html, /22\.8 GB/u);
  assert.match(html, /至少还差|工作盘尚缺空间/u);
  assert.match(html, /不是成品最终体积/u);
  assert.match(html, /图层整理范围[\s\S]*?未启用/u);
  assert.match(html, /0\.1\.0-alpha\.9/u);
});

test("in-place report clearly says the source was overwritten without validation", () => {
  const report: FileReport = {
    schemaVersion: 1,
    reportVersion: "1.0",
    appVersion: "0.1.0-alpha.9",
    jobId: "job-direct",
    machineId: "machine-1",
    status: "succeeded",
    reasonCode: "IN_PLACE_SAVED_UNVALIDATED",
    startedAt: "2026-07-24T00:00:00Z",
    finishedAt: "2026-07-24T00:02:03Z",
    source: {
      path: "C:\\input\\direct.psb",
      beforeBytes: 200,
      unchanged: false,
    },
    policy: { profile: "standard", executionMode: "in_place" },
    environment: {},
    preflight: {},
    execution: {
      mode: "in_place",
      sourceOverwritten: true,
      backupPath: "D:\\backup\\direct.psb",
    },
    validation: {
      performed: false,
      errors: [],
      warnings: [],
    },
    output: {
      path: "C:\\input\\direct.psb",
      bytes: 100,
      reductionBytes: 100,
      xmpRemovedBytes: null,
    },
    timing: {},
    logs: {},
  };
  const html = renderReportHtml(report);
  assert.match(html, /原文件已直接保存，但没有做保存后校对/u);
  assert.match(html, /已按所选模式覆盖/u);
  assert.match(html, /未做保存后校对，无法确认/u);
  assert.match(html, /2 分 3 秒/u);
});

test("partial in-place report leads with the saved-but-incomplete conclusion", () => {
  const report = {
    ...baseReport(),
    status: "partial",
    reasonCode: "IN_PLACE_PARTIAL_SAVED_UNVALIDATED",
    policy: { executionMode: "in_place" },
    output: {
      path: "G:\\input\\partial.psb",
      smartObjectFailureCount: 2,
      smartObjectFailures: ["Nail Glue [1.psb]", "图层 1 [图层 1.psb]"],
    },
  } as any;
  const html = renderReportHtml(report);
  assert.match(html, /原文件已保存，但有部分对象没有处理完成/u);
  assert.match(html, /不能算作完整成功/u);
  assert.doesNotMatch(html, /全部检查通过/u);
});

test("manual acceptance remains visibly marked as risky", () => {
  const report = {
    ...baseReport(),
    status: "succeeded",
    reasonCode: "HUMAN_APPROVED_WITH_WARNINGS",
    manualReview: {
      status: "accepted_with_warnings",
      reviewedAt: "2026-07-29T04:00:00.000Z",
      reviewedBy: "designer",
      note: "肉眼检查未见异常",
      ignoredAutomaticChecks: ["PIXEL_NOT_EXACT"],
      originalStatus: "quarantined",
      originalReasonCode: "PIXEL_NOT_EXACT",
      resultPath: "G:\\output\\accepted.psb",
    },
  } as any;
  const html = renderReportHtml(report);
  assert.match(html, /人工复核后接受为成品，自动警告仍然存在/u);
  assert.match(html, /人工接受（有风险）/u);
  assert.match(html, /designer/u);
  assert.match(html, /肉眼检查未见异常/u);
});

test("discarded review result explains what was recycled and preserved", () => {
  const report = {
    ...baseReport(),
    status: "discarded",
    reasonCode: "HUMAN_DISCARDED_REVIEW_RESULT",
    output: { path: null },
    manualReview: {
      status: "discarded",
      reviewedAt: "2026-08-03T04:00:00.000Z",
      reviewedBy: "designer",
      note: "画面不符合交付要求",
      ignoredAutomaticChecks: ["PIXEL_NOT_EXACT"],
      originalStatus: "quarantined",
      originalReasonCode: "PIXEL_NOT_EXACT",
      resultPath: null,
      recycledArtifacts: [
        {
          kind: "quarantine",
          path: "G:\\data\\quarantine\\job",
          bytes: 1024,
        },
      ],
      recycledBytes: 1024,
      sourceFilePreserved: true,
      reportsPreserved: true,
      logsPreserved: true,
    },
  } as any;
  const html = renderReportHtml(report);
  assert.match(html, /已放弃这次处理结果/u);
  assert.match(html, /源文件、权威报告和操作日志均保留/u);
  assert.match(html, /1\.00 KB（可从 Windows 回收站恢复）/u);
});
