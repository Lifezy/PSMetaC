import fs from "node:fs/promises";
import path from "node:path";
import type { FileReport } from "./types.ts";
import { atomicWriteJson } from "./files.ts";

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatBytes(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = Math.abs(bytes);
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit++;
  }
  const decimals = unit === 0 ? 0 : amount < 10 ? 2 : 1;
  return `${bytes < 0 ? "-" : ""}${amount.toFixed(decimals)} ${units[unit]}`;
}

function formatSizeChangePercent(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return "未生成结果，无法计算";
  }
  const percent = Number(value);
  if (!Number.isFinite(percent)) return "未生成结果，无法计算";
  if (Math.abs(percent) < 0.01) return "基本不变（小于 0.01%）";
  return percent < 0
    ? `减少 ${Math.abs(percent).toFixed(2)}%`
    : `增加 ${percent.toFixed(2)}%`;
}

function row(label: string, value: unknown): string {
  return `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`;
}

function formatCheck(value: unknown, skipped = "未进行校对"): string {
  if (value === true) return "通过";
  if (value === false) return "未通过";
  return skipped;
}

function formatDuration(startedAt: string, finishedAt: string): string {
  const ms = Date.parse(finishedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remain = seconds % 60;
  return hours
    ? `${hours} 小时 ${minutes} 分`
    : minutes
      ? `${minutes} 分 ${remain} 秒`
      : `${remain} 秒`;
}

function formatMilliseconds(value: unknown): string {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remain = seconds % 60;
  return hours
    ? `${hours} 小时 ${minutes} 分`
    : minutes
      ? `${minutes} 分 ${remain} 秒`
      : `${remain} 秒`;
}

const VALIDATION_CHECK_LABELS: Record<string, string> = {
  target_xmp_removed: "目标 XMP 已清理",
  structure_topology: "图层结构顺序一致",
  smart_object_asset_ids: "智能对象资产 ID 一致",
  smart_object_success: "智能对象全部处理成功",
  reopen_success: "保存后能重新打开",
  pixel_exact: "前后像素完全一致",
  render_consistency: "保存与重开画面一致",
  parser_clean: "文件解析无警告",
};

function formatValidationChecks(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) {
    return "未设置可选阻止项（基础安全错误仍会阻止）";
  }
  return value
    .map((item) => VALIDATION_CHECK_LABELS[String(item)] || String(item))
    .join("、");
}

function humanizeIssue(value: unknown): string {
  const text = String(value || "");
  if (/duplicate asset ID/iu.test(text)) {
    return "清理计划发现多个嵌套位置使用了同一个智能对象身份，旧计划无法安全区分；请用当前版本重新预检。";
  }
  if (/cleanup plan coverage failed/iu.test(text)) {
    return "Photoshop 中没有找到清理计划要求的全部智能对象，程序已停止发布结果。";
  }
  if (/source is already open in Photoshop/iu.test(text)) {
    return "源文件正在 Photoshop 中打开；请正常关闭文档后重新创建任务。";
  }
  if (/PHOTOSHOP_VERSION_NOT_VERIFIED/iu.test(text)) {
    return "该旧任务曾被版本限制阻止；现在尚未验证的版本也允许执行，并在报告中保留提示。";
  }
  if (/PREFLIGHT_PROCESS_FAILED|PREFLIGHT_INVALID_JSON/iu.test(text)) {
    return "文件结构检查没有完成，Photoshop 没有开始保存；请导出诊断日志供排查。";
  }
  if (/CONTENT_LAYER_CHANGES_REQUIRE_REVIEW/iu.test(text)) {
    return "已按你的选择删除图层；这属于有意的文档结构变化，必须人工查看处理结果后再决定是否接受。";
  }
  return text;
}

function reportConclusion(report: FileReport): {
  title: string;
  detail: string;
  tone: string;
} {
  const execution = report.execution as Record<string, unknown>;
  const diskSpace = (execution.diskSpaceAssessment || {}) as Record<
    string,
    unknown
  >;
  const source = report.source as Record<string, unknown>;
  if (report.manualReview?.status === "accepted_with_warnings") {
    return {
      title: "人工复核后接受为成品，自动警告仍然存在",
      detail:
        "这是用户作出的风险覆盖决定，不代表自动检查全部通过。报告继续保留原始失败项、警告、复核人、时间和备注。",
      tone: "warning",
    };
  }
  if (report.manualReview?.status === "kept_quarantined") {
    return {
      title: "人工复核完成，决定继续隔离",
      detail:
        "处理副本仍保留在隔离区，没有作为成品发布；原始自动检查结果和人工备注均已记录。",
      tone: "warning",
    };
  }
  if (report.manualReview?.status === "discarded") {
    return {
      title: "已放弃这次处理结果",
      detail:
        "隔离副本、工作副本和临时预览已移入 Windows 回收站；源文件、权威报告和操作日志均保留。",
      tone: "neutral",
    };
  }
  if (
    report.status === "partial" ||
    report.reasonCode === "IN_PLACE_PARTIAL_SAVED_UNVALIDATED"
  ) {
    return {
      title: "原文件已保存，但有部分对象没有处理完成",
      detail:
        "已完成的清理已经保存在原文件中，未完成对象及原因保留在报告里；本次不能算作完整成功，也没有执行保存后重新打开或像素校对。",
      tone: "warning",
    };
  }
  if (report.status === "succeeded" && execution.mode === "in_place") {
    return {
      title: "原文件已直接保存，但没有做保存后校对",
      detail:
        "这是你选择的高风险直存模式：源文件已被覆盖。请根据下方“备份文件”确认是否保留了可恢复副本；结构、重新打开和像素一致性均未验证。",
      tone: "warning",
    };
  }
  if (report.status === "succeeded") {
    const validation = report.validation as Record<string, unknown>;
    const hasWarnings =
      Array.isArray(validation.errors) && validation.errors.length > 0;
    return {
      title: hasWarnings
        ? "清理完成，已通过你选择的验收标准"
        : "清理完成，新副本已通过全部自动检查",
      detail: hasWarnings
        ? "成品已发布；未设为必须通过的检查仍发现警告，请在下方查看。"
        : "源文件未变，清理后的新文件可以作为成品使用。",
      tone: hasWarnings ? "warning" : "good",
    };
  }
  if (
    report.status === "quarantined" &&
    report.reasonCode === "CONTENT_LAYER_CHANGES_REQUIRE_REVIEW"
  ) {
    return {
      title: "图层整理已完成，等待你查看结果",
      detail:
        "安全副本已经生成，并按你的选择删除了隐藏图层或空图层。因为这是有意的结构变化，程序不会自动把它当作成品；请打开处理结果检查画面和图层后再决定。",
      tone: "warning",
    };
  }
  if (
    report.status === "quarantined" &&
    report.reasonCode === "UNVERIFIED_OUTPUT_PRESERVED_ON_WORK_VOLUME"
  ) {
    return {
      title: "任务未正常完成，诊断副本已保留在成品盘",
      detail:
        "程序无法把结果转移到原定复核位置，因此没有删除任务工作目录。请从“人工复核”打开这个诊断副本；源文件未被这次恢复操作改动。",
      tone: "warning",
    };
  }
  if (report.status === "quarantined") {
    return {
      title: "清理生成了副本，但检查未全部通过",
      detail:
        "结果已放入隔离区。请打开 PSMetaC 的“人工复核”页面，点击对应文件的“开始复核”，实际查看原件和处理结果后再决定继续隔离或接受为有风险成品。",
      tone: "warning",
    };
  }
  if (report.status === "skipped" || report.status === "preflight_complete") {
    return {
      title: "已完成检查，没有改动文件",
      detail:
        report.status === "skipped"
          ? "文件未达到所选清理条件，Photoshop 没有执行保存。"
          : "这是仅预检任务，报告只说明预计可清理量。",
      tone: "neutral",
    };
  }
  if (report.status === "cancelled") {
    return {
      title: "任务已安全取消",
      detail: "未发布半成品；如取消发生在保存期间，程序会先完成安全收尾。",
      tone: "neutral",
    };
  }
  if (report.reasonCode === "INSUFFICIENT_DISK_SPACE") {
    const workShortfall = Number(diskSpace.workShortfallBytes || 0);
    const outputShortfall = Number(diskSpace.outputShortfallBytes || 0);
    const shortfall = Math.max(workShortfall, outputShortfall);
    return {
      title: "未开始清理：磁盘空间不足",
      detail: `Photoshop 没有启动，源文件保持不变。程序估算本次安全处理需要 ${formatBytes(
        diskSpace.requiredWorkBytes,
      )}，工作盘当前可用 ${formatBytes(diskSpace.workFree)}${
        shortfall > 0 ? `，至少还差 ${formatBytes(shortfall)}` : ""
      }。这是包含工作副本、保存临时空间和安全余量的门槛，不是最终成品体积。`,
      tone: "bad",
    };
  }
  if (report.reasonCode === "SOURCE_OPEN_IN_PHOTOSHOP") {
    return {
      title: "未开始清理：源文件正在 Photoshop 中打开",
      detail: "请先正常关闭该文档，再重新创建任务；程序没有改动源文件。",
      tone: "bad",
    };
  }
  if (report.reasonCode === "PREFLIGHT_FAILED") {
    return {
      title: "文件检查没有完成，未开始清理",
      detail: `Photoshop 没有执行保存；源文件${source.unchanged === true ? "已确认保持不变" : "状态需要人工确认"}。请查看下方具体错误。`,
      tone: "bad",
    };
  }
  const photoshopError = execution.photoshopError;
  if (
    /duplicate asset ID/iu.test(
      String(photoshopError || execution.error || ""),
    )
  ) {
    return {
      title: "未开始清理：共享智能对象计划无法安全区分",
      detail:
        "清理计划把同一智能对象身份列在多个嵌套位置，程序在实际保存前停止。源文件指纹未变时可以直接使用当前版本重新预检；如果仍失败，请导出诊断日志。",
      tone: "bad",
    };
  }
  return {
    title: photoshopError
      ? "Photoshop 没有保存成功"
      : report.status === "blocked"
        ? "安全检查阻止了处理"
        : "任务没有完成",
    detail: photoshopError
      ? `Photoshop 返回的具体原因：${humanizeIssue(photoshopError)}`
      : "请查看下方“问题与提醒”和技术记录中的具体原因。",
    tone: "bad",
  };
}

export function renderReportHtml(report: FileReport): string {
  const source = report.source as Record<string, unknown>;
  const output = report.output as Record<string, unknown>;
  const validation = report.validation as Record<string, unknown>;
  const preflight = report.preflight as Record<string, unknown>;
  const execution = report.execution as Record<string, unknown>;
  const contentCleanup = (execution.contentCleanup || {}) as Record<
    string,
    unknown
  >;
  const diskSpace = (execution.diskSpaceAssessment || {}) as Record<
    string,
    unknown
  >;
  const environment = report.environment as Record<string, unknown>;
  const photoshop = (environment.photoshop || {}) as Record<string, unknown>;
  const timing = (report.timing || {}) as Record<string, unknown>;
  const policy = (report.policy || {}) as Record<string, unknown>;
  const pixel = (validation.pixel || {}) as Record<string, unknown>;
  const structure = (validation.structure || {}) as Record<string, unknown>;
  const beforeVsAfter = (pixel.beforeVsAfterReopen || {}) as Record<
    string,
    unknown
  >;
  const errors = Array.isArray(validation.errors)
    ? validation.errors
    : [];
  const warnings = Array.isArray(validation.warnings)
    ? validation.warnings
    : [];
  const conclusion = reportConclusion(report);
  const inPlace = execution.mode === "in_place";
  const deletedHidden = Array.isArray(contentCleanup.deletedHidden)
    ? contentCleanup.deletedHidden
    : [];
  const deletedEmpty = Array.isArray(contentCleanup.deletedEmpty)
    ? contentCleanup.deletedEmpty
    : [];
  const skippedEmpty = Array.isArray(contentCleanup.skippedEmpty)
    ? contentCleanup.skippedEmpty
    : [];
  const skippedHidden = Array.isArray(contentCleanup.skippedHidden)
    ? contentCleanup.skippedHidden
    : [];
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>PSMetaC 处理报告 ${escapeHtml(report.jobId)}</title>
  <style>
    :root{font-family:"Segoe UI","Microsoft YaHei",sans-serif;color:#172033;background:#f3f5f8}
    body{max-width:980px;margin:0 auto;padding:32px 20px}
    .hero,.card{background:#fff;border:1px solid #dce1e9;border-radius:14px;padding:24px;margin-bottom:16px;box-shadow:0 8px 28px #1b2a4410}
    h1{margin:0 0 8px;font-size:26px}.status{font-weight:700;color:${report.status === "succeeded" ? "#087f5b" : report.status === "quarantined" ? "#b26a00" : report.status === "discarded" ? "#59657b" : "#a61b1b"}}
    table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:10px;border-bottom:1px solid #edf0f4;vertical-align:top}th{width:230px;color:#526077}
    code{font-family:"Cascadia Mono",monospace;word-break:break-all}.tag{display:inline-block;padding:4px 9px;margin:3px;border-radius:99px;background:#eef2f8}
    .conclusion{border-left:5px solid #6c78a0}.conclusion.good{border-left-color:#15916f}.conclusion.warning{border-left-color:#d08a20}.conclusion.bad{border-left-color:#c53448}
    .conclusion h2{margin:0 0 8px}.conclusion p{margin:0;color:#526077;line-height:1.65}
    .plain-note{color:#68758d;font-size:13px;line-height:1.6}
  </style>
</head>
<body>
  <section class="hero">
    <h1>PSMetaC 单文件处理报告</h1>
    <div class="status">${escapeHtml(conclusion.title)}</div>
    <p>任务 ${escapeHtml(report.jobId)} · 机器 ${escapeHtml(report.machineId)}</p>
  </section>
  <section class="card conclusion ${escapeHtml(conclusion.tone)}"><h2>${escapeHtml(
    conclusion.title,
  )}</h2><p>${escapeHtml(conclusion.detail)}</p></section>
  <section class="card"><h2>你最需要知道的结果</h2><table>
    ${row("处理方式", inPlace ? "直接保存原文件（未校对）" : "生成安全新副本")}
    ${row("源文件", source.path)}
    ${row("源文件未变", inPlace ? "不适用：已按所选模式覆盖" : formatCheck(source.unchanged, "未能确认"))}
    ${row("备份文件", execution.backupPath || (inPlace ? "未创建备份" : "不适用"))}
    ${row("成品/隔离文件", inPlace ? "直接保存到原文件" : output.path || "未生成")}
    ${row("源文件体积", formatBytes(source.beforeBytes))}
    ${row("输出体积", formatBytes(output.bytes))}
    ${row("体积变化", formatBytes(output.reductionBytes))}
    ${row("体积变化百分比", formatSizeChangePercent(output.sizeChangePercent))}
    ${row("安全处理估算空间", diskSpace.requiredWorkBytes === undefined ? "—" : formatBytes(diskSpace.requiredWorkBytes))}
    ${row("工作盘检查时可用", diskSpace.workFree === undefined ? "—" : formatBytes(diskSpace.workFree))}
    ${row("输出盘检查时可用", diskSpace.outputFree === undefined ? "—" : formatBytes(diskSpace.outputFree))}
    ${row("工作盘尚缺空间", diskSpace.workShortfallBytes === undefined ? "—" : Number(diskSpace.workShortfallBytes) > 0 ? formatBytes(diskSpace.workShortfallBytes) : "不缺")}
    ${row("输出盘尚缺空间", diskSpace.outputShortfallBytes === undefined ? "—" : Number(diskSpace.outputShortfallBytes) > 0 ? formatBytes(diskSpace.outputShortfallBytes) : "不缺")}
    ${row("空间估算说明", diskSpace.explanation || "—")}
    ${row("XMP 清理量", inPlace ? "未做保存后校对，无法确认" : formatBytes(output.xmpRemovedBytes))}
    ${row("DocumentAncestors 清理后", inPlace ? "未做保存后校对" : output.documentAncestorsAfter)}
    ${row("结构拓扑", formatCheck(structure.topologyMatch ?? validation.structureMatch))}
    ${row("智能对象资产 ID", formatCheck(structure.assetIdsMatch ?? validation.structureMatch))}
    ${row("像素完全一致", formatCheck(beforeVsAfter.exact))}
    ${row("变化像素", beforeVsAfter.changedPixels ?? "—")}
    ${row("智能对象失败项", output.smartObjectFailureCount ?? "—")}
    ${row("删除隐藏图层", deletedHidden.length)}
    ${row("删除空图层", deletedEmpty.length)}
    ${row("因安全条件跳过的隐藏图层", skippedHidden.length)}
    ${row("因安全条件跳过的空图层", skippedEmpty.length)}
    ${row(
      "图层整理范围",
      (contentCleanup.requested as Record<string, unknown> | undefined)?.hidden === true ||
        (contentCleanup.requested as Record<string, unknown> | undefined)?.empty === true
        ? "仅根文档；不进入链接智能对象，删除后必须人工复核"
        : "未启用",
    )}
    ${row("清理计划项", (preflight.cleanupPlan as Record<string, unknown> | undefined)?.recordsRequiredToOpen ?? "—")}
    ${row("不同智能对象身份", (preflight.cleanupPlan as Record<string, unknown> | undefined)?.uniqueAssetRecords ?? "—")}
    ${row("共享/重复身份组", Array.isArray((preflight.cleanupPlan as Record<string, unknown> | undefined)?.duplicateAssetGroups) ? ((preflight.cleanupPlan as Record<string, unknown>).duplicateAssetGroups as unknown[]).length : "—")}
    ${row("Photoshop 实际版本", photoshop.runtimeProductVersion || photoshop.productVersion || "未能读取")}
    ${row("Photoshop 支持状态", photoshop.formallyAdapted === true ? "正式支持" : photoshop.productVersion || photoshop.runtimeProductVersion ? "尚未完成实机验证（允许执行）" : "未能确认")}
    ${row("版本说明", photoshop.compatibilityNotice || "—")}
    ${row("必须通过的自动验收", formatValidationChecks(policy.requiredValidationChecks))}
    ${row(
      "阻止自动放行的问题",
      Array.isArray(validation.blockingErrors) &&
        validation.blockingErrors.length
        ? validation.blockingErrors.join("、")
        : "没有",
    )}
    ${row(
      "人工复核",
      report.manualReview
        ? report.manualReview.status === "accepted_with_warnings"
          ? "人工接受（有风险）"
          : report.manualReview.status === "discarded"
            ? "已放弃处理结果"
            : "已查看，继续隔离"
        : "尚未人工复核",
    )}
    ${row(
      "回收的派生文件",
      report.manualReview?.status === "discarded"
        ? `${formatBytes(report.manualReview.recycledBytes)}（可从 Windows 回收站恢复）`
        : "—",
    )}
    ${row("复核人", report.manualReview?.reviewedBy || "—")}
    ${row("复核时间", report.manualReview?.reviewedAt || "—")}
    ${row("复核备注", report.manualReview?.note || "—")}
    ${row("排队等待", formatMilliseconds(timing.queueWaitMs))}
    ${row("只读检查", formatMilliseconds(timing.preflightMs))}
    ${row("等待 Photoshop", formatMilliseconds(timing.photoshopWaitMs))}
    ${row("处理与校对", formatMilliseconds(timing.executionMs))}
    ${row("总耗时", formatDuration(report.startedAt, report.finishedAt))}
    ${row("PSMetaC 版本", report.appVersion)}
  </table></section>
  ${
    deletedHidden.length || deletedEmpty.length || skippedHidden.length || skippedEmpty.length
      ? `<section class="card"><h2>图层整理记录</h2><p class="plain-note">路径按删除发生前的文档层级记录；隐藏组的 subtreeLayers 包含随组一并删除的子层。</p><pre>${escapeHtml(
          JSON.stringify(
            { deletedHidden, deletedEmpty, skippedHidden, skippedEmpty },
            null,
            2,
          ),
        )}</pre></section>`
      : ""
  }
  <section class="card"><h2>检查和执行依据</h2>
    <p class="plain-note">这里记录为什么执行、跳过或阻止。专业字段保留下来，方便后续追查。</p>
    <pre>${escapeHtml(JSON.stringify({ reasonCode: report.reasonCode, policy: report.policy, preflight }, null, 2))}</pre>
  </section>
  <section class="card"><h2>问题与提醒</h2>
    <div>${errors.length ? errors.map((item) => `<span class="tag">${escapeHtml(humanizeIssue(item))}</span>`).join("") : "没有记录到错误"}</div>
    <div>${warnings.map((item) => `<span class="tag">${escapeHtml(humanizeIssue(item))}</span>`).join("")}</div>
  </section>
  <section class="card"><h2>完整技术记录</h2><p class="plain-note">这部分供排错和审计使用，普通使用时不必逐项阅读。</p><pre>${escapeHtml(JSON.stringify(report, null, 2))}</pre></section>
</body></html>`;
}

export async function writeReport(input: {
  report: FileReport;
  centralDirectory: string;
  sidecarBasePath?: string | null;
}): Promise<{
  centralJson: string;
  centralHtml: string;
  sidecarJson: string | null;
  sidecarHtml: string | null;
}> {
  await fs.mkdir(input.centralDirectory, { recursive: true });
  const centralJson = path.join(input.centralDirectory, "report.json");
  const centralHtml = path.join(input.centralDirectory, "report.html");
  await atomicWriteJson(centralJson, input.report);
  await fs.writeFile(centralHtml, renderReportHtml(input.report), "utf8");
  let sidecarJson: string | null = null;
  let sidecarHtml: string | null = null;
  if (input.sidecarBasePath) {
    sidecarJson = `${input.sidecarBasePath}.report.json`;
    sidecarHtml = `${input.sidecarBasePath}.report.html`;
    await atomicWriteJson(sidecarJson, input.report);
    await fs.writeFile(sidecarHtml, renderReportHtml(input.report), "utf8");
  }
  return { centralJson, centralHtml, sidecarJson, sidecarHtml };
}
