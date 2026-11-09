const api = window.psbCleaner;
let selectedFiles = [];
let selectedPendingFileKeys = new Set();
let jobs = [];
let settings = null;
let capabilities = null;
let historyStatistics = null;
let preflightSummaries = {};
let selectedJobIds = new Set();
let availableUserTags = [];
let jobPool = "active";
const poolJobFilters = {
  active: new Set(),
  completed: new Set(),
};
const poolJobSearch = {
  active: "",
  completed: "",
};
let jobFilters = poolJobFilters.active;
const JOB_PAGE_SIZE = 80;
let jobRenderPage = 0;
let jobSearch = "";
let tagAssignmentJobIds = [];
let reviewJobId = null;
let reviewContext = null;
let reviewCompareMode = "split";
let toastTimer = null;
let dangerDialogResolve = null;
let quarantineCleanupPreview = null;
let quarantineFilter = "all";
let settingsCategory =
  localStorage.getItem("psmetac.settingsCategory") || "photoshop";
let helpTopic = localStorage.getItem("psmetac.helpTopic") || "intro";
let lastPhotoshopDiagnosis = null;
let photoshopConnectionTestKey = null;
let bootstrapConnectionTestKey = null;

function selectedFileKey(value) {
  return String(value).replace(/[\\/]+$/u, "").toLowerCase();
}

function photoshopConnectionKey(executable, progId) {
  return `${selectedFileKey(executable || "")}\0${String(progId || "").trim().toLowerCase()}`;
}

function renderSelectedFiles() {
  const container = $("#selected-files");
  $("#pick-files").textContent = selectedFiles.length
    ? "继续添加文件"
    : "选择 PSD / PSB 文件";
  $("#pending-file-toolbar").classList.toggle(
    "hidden",
    selectedFiles.length === 0,
  );
  if (!selectedFiles.length) {
    container.classList.add("empty");
    container.textContent = "尚未选择文件";
    selectedPendingFileKeys.clear();
    $("#pending-selection-label").textContent = "已选择 0 项";
    $("#select-all-pending-files").checked = false;
    $("#select-all-pending-files").indeterminate = false;
    $("#create-tasks-button").textContent = "确认并创建 0 个任务";
    $("#create-tasks-button").disabled = true;
    return;
  }
  const selectedCount = selectedFiles.filter((filePath) =>
    selectedPendingFileKeys.has(selectedFileKey(filePath)),
  ).length;
  const selectAll = $("#select-all-pending-files");
  selectAll.checked = selectedCount === selectedFiles.length;
  selectAll.indeterminate = selectedCount > 0 && selectedCount < selectedFiles.length;
  $("#pending-selection-label").textContent = `已选择 ${selectedCount} / ${selectedFiles.length} 项`;
  $("#remove-selected-files").disabled = selectedCount === 0;
  $("#create-tasks-button").textContent = `确认并创建 ${selectedCount} 个任务`;
  $("#create-tasks-button").disabled = selectedCount === 0;
  container.classList.remove("empty");
  container.innerHTML = selectedFiles
    .map(
      (filePath) => {
        const selected = selectedPendingFileKeys.has(selectedFileKey(filePath));
        return `<div class="selected-file-row${selected ? " is-selected" : ""}" data-pending-file-row="${escapeHtml(
          filePath,
        )}"><input class="selected-file-check" type="checkbox" data-select-pending-file="${escapeHtml(
          filePath,
        )}" ${selected ? "checked" : ""} aria-label="选择 ${escapeHtml(
          filePath.split(/[\\/]/u).pop() || filePath,
        )}"><button class="selected-file-remove" type="button" data-remove-selected-file="${escapeHtml(
          filePath,
        )}" title="从本次选择中移除" aria-label="从本次选择中移除 ${escapeHtml(
          filePath.split(/[\\/]/u).pop() || filePath,
        )}"><svg aria-hidden="true"><use href="#i-remove"/></svg></button><span title="${escapeHtml(
          filePath,
        )}">${escapeHtml(filePath)}</span></div>`;
      },
    )
    .join("");
}

function selectedFilesForTask() {
  return selectedFiles.filter((filePath) =>
    selectedPendingFileKeys.has(selectedFileKey(filePath)),
  );
}

function addPendingFiles(filePaths) {
  const known = new Set(selectedFiles.map(selectedFileKey));
  let addedCount = 0;
  for (const filePath of filePaths) {
    const key = selectedFileKey(filePath);
    if (!key || known.has(key)) continue;
    known.add(key);
    selectedFiles.push(filePath);
    addedCount += 1;
  }
  selectedPendingFileKeys = new Set(selectedFiles.map(selectedFileKey));
  renderSelectedFiles();
  return addedCount;
}

function updateSelectedFileTypeNotice() {
  if (selectedFilesForTask().some((item) => item.toLowerCase().endsWith(".psd"))) {
    if (
      $("#run-mode").value === "auto_if_eligible" &&
      !settings?.experimentalPsdUnattended
    ) {
      $("#run-mode").value = "await_approval";
      updateTaskProfileSummary(true);
    }
    $("#task-result").textContent = settings?.experimentalPsdUnattended
      ? "检测到 PSD；已启用实验性无人值守，可按当前条件自动处理。"
      : settings?.experimentalPsd
        ? "检测到 PSD，处理方式已切换为“检查后等我确认”。"
        : "检测到 PSD。请先在“设置 → 文件类型”开启 PSD 实验功能。";
  } else {
    $("#task-result").textContent = "";
  }
}

const DIRECTORY_KINDS = {
  "task-output": "output",
  "watcher-path": "watcher",
  "watcher-output": "output",
  "data-root": "output",
  "input-root": "source",
  "output-root": "output",
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

$$('.nav[data-title]').forEach((button) => {
  button.title = button.dataset.title;
});

const TASK_PRESETS = {
  "safe-standard": {
    name: "安全标准",
    profile: "standard",
    runMode: "auto_if_eligible",
    executionMode: "safe_copy",
    backupSource: true,
    deleteHiddenLayers: false,
    deleteEmptyLayers: false,
    checks: [
      "target_xmp_removed",
      "structure_topology",
      "smart_object_asset_ids",
      "smart_object_success",
      "pixel_exact",
      "parser_clean",
    ],
  },
  "inspect-first": {
    name: "先检查再决定",
    profile: "standard",
    runMode: "await_approval",
    executionMode: "safe_copy",
    backupSource: true,
    deleteHiddenLayers: false,
    deleteEmptyLayers: false,
    checks: [
      "target_xmp_removed",
      "structure_topology",
      "smart_object_asset_ids",
      "smart_object_success",
      "pixel_exact",
      "parser_clean",
    ],
  },
  "direct-backup": {
    name: "直接保存并备份",
    profile: "standard",
    runMode: "auto_if_eligible",
    executionMode: "in_place",
    backupSource: true,
    deleteHiddenLayers: false,
    deleteEmptyLayers: false,
    checks: ["target_xmp_removed", "smart_object_success"],
  },
};
let applyingTaskPreset = false;

function taskProfileSummary() {
  const execution = $("#execution-mode").value;
  const profile = $("#profile").selectedOptions[0]?.textContent?.split("—")[0]?.trim() || "标准";
  const runMode = $("#run-mode").selectedOptions[0]?.textContent || "符合条件后自动处理";
  const checks = selectedValidationChecks("task");
  const validation =
    execution === "in_place"
      ? $("#backup-source").checked
        ? "处理前创建备份"
        : "不创建备份"
      : checks.includes("pixel_exact")
        ? "严格像素验收"
        : `${checks.length} 项自动验收`;
  const layerActions = [
    $("#delete-hidden-layers").checked ? "删除隐藏图层" : "",
    $("#delete-empty-layers").checked ? "删除空图层" : "",
  ].filter(Boolean);
  return `${execution === "in_place" ? "直接保存原文件" : "生成安全副本"} · ${profile}清理 · ${runMode} · ${validation}${layerActions.length ? ` · ${layerActions.join(" + ")}（需复核）` : ""}`;
}

function updateTaskProfileSummary(markCustom = false) {
  if (markCustom && !applyingTaskPreset) {
    $("#task-preset").value = "custom";
    localStorage.setItem("psmetac.taskPreset", "custom");
  }
  const preset = TASK_PRESETS[$("#task-preset").value];
  $("#task-profile-name").textContent = preset?.name || "自定义方案";
  $("#task-profile-summary").textContent = taskProfileSummary();
}

function applyTaskPreset(key, { remember = true } = {}) {
  const preset = TASK_PRESETS[key];
  if (!preset) {
    $("#task-preset").value = "custom";
    updateTaskProfileSummary(false);
    return;
  }
  applyingTaskPreset = true;
  $("#task-preset").value = key;
  $("#profile").value = preset.profile;
  $("#run-mode").value = preset.runMode;
  $("#execution-mode").value = preset.executionMode;
  $("#backup-source").checked = preset.backupSource;
  $("#delete-hidden-layers").checked = preset.deleteHiddenLayers;
  $("#delete-empty-layers").checked = preset.deleteEmptyLayers;
  const selected = new Set(preset.checks);
  $$('[data-validation="task"]').forEach((checkbox) => {
    checkbox.checked = selected.has(checkbox.value);
  });
  updateExecutionModeUi();
  updateContentCleanupUi(false);
  applyingTaskPreset = false;
  if (remember) localStorage.setItem("psmetac.taskPreset", key);
  updateTaskProfileSummary(false);
}

function setTaskOptionsDrawer(open) {
  $("#task-options-drawer").classList.toggle("hidden", !open);
  $("#task-options-backdrop").classList.toggle("hidden", !open);
  $("#task-options-drawer").setAttribute("aria-hidden", String(!open));
  $("#task-options-backdrop").setAttribute("aria-hidden", String(!open));
  document.body.classList.toggle("task-options-open", open);
  if (open) $("#close-task-options").focus();
}

function applyTheme(theme) {
  const normalized = ["light", "dark"].includes(theme) ? theme : "system";
  if (normalized === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.dataset.theme = normalized;
  }
  $$('[data-theme-choice]').forEach((button) => {
    const active = button.dataset.themeChoice === normalized;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  localStorage.setItem("psmetac.theme", normalized);
}

const STATUS_LABELS = {
  waiting_stable: "等待文件复制完成",
  queued_preflight: "等待检查",
  preflighting: "正在检查文件",
  preflight_complete: "检查完成",
  skipped: "无需处理",
  blocked: "安全阻止",
  ready: "准备处理",
  awaiting_approval: "等你确认",
  waiting_photoshop: "等待 Photoshop 空闲",
  copying: "正在制作工作副本",
  running: "正在清理副本",
  validating: "正在检查结果",
  succeeded: "已通过",
  partial: "部分完成",
  quarantined: "需要复核",
  discarded: "已放弃处理结果",
  cancelled: "已取消",
  failed: "处理失败",
  critical_paused: "队列已安全暂停",
  interrupted: "意外中断",
};
const REASON_LABELS = {
  ELIGIBLE: "达到所选清理条件",
  NO_DOCUMENT_ANCESTORS: "没有发现目标编辑溯源信息",
  BELOW_PROFILE_THRESHOLD: "可清理量未达到所选程度",
  PREFLIGHT_FAILED: "文件检查没有完成",
  PSD_REQUIRES_MANUAL_APPROVAL: "PSD 需要你确认后才能处理",
  EXECUTION_CONFIGURATION_BLOCKED: "运行设置不满足安全条件",
  PIXEL_DIFFERENCE: "清理前后画面存在像素差异",
  STRUCTURE_CHANGED: "图层或文档结构发生变化",
  SMART_OBJECT_FAILURE: "至少一个智能对象没有处理成功",
  SOURCE_CHANGED: "源文件在任务期间发生变化",
  RECOVERED_AFTER_RESTART: "程序重启后重新检查",
  CANCELLED_DURING_PREFLIGHT: "检查文件时收到取消请求",
  CANCELLED_BEFORE_PHOTOSHOP: "启动 Photoshop 前已取消",
  IN_PLACE_SAVED_UNVALIDATED: "原文件已直接保存；按所选模式未做保存后校对",
  PHOTOSHOP_SAVE_OR_EXECUTION_ERROR: "Photoshop 保存或清理失败",
  QUEUE_STOP_AFTER_CURRENT: "按要求在当前文件完成后终止",
  HUMAN_APPROVED_WITH_WARNINGS: "人工查看后接受；自动警告仍保留",
  HUMAN_DISCARDED_REVIEW_RESULT: "人工复核后放弃处理结果",
  STRUCTURE_TOPOLOGY_MISMATCH: "文档或图层结构顺序与原件不完全一致",
  PIXEL_NOT_EXACT: "处理前后像素并非完全一致",
  CROSS_BIT_DEPTH_PATHS_PRESENT: "包含跨位深智能对象，Photoshop 保存可能产生细微变化",
  CONTENT_CLEANUP_REQUESTED: "已选择图层内容整理，因此即使元数据未达到阈值也会处理安全副本",
  CONTENT_LAYER_CHANGES_REQUIRE_REVIEW: "已按计划删除图层，等待你人工查看处理结果",
  INSPECT_ONLY_COMPLETE: "检查已完成；未启动 Photoshop",
  WAITING_FOR_USER_APPROVAL: "检查已完成，等待你决定是否处理",
  USER_KEPT_INSPECTION_RESULT: "已保留检查结果；未启动 Photoshop",
  IN_PLACE_PARTIAL_SAVED_UNVALIDATED: "原文件已保存，但有部分智能对象没有处理完成",
  UNVERIFIED_OUTPUT_PRESERVED_ON_WORK_VOLUME: "隔离位置空间不足；诊断副本已保留在成品盘",
};
const PROFILE_LABELS = {
  standard: "标准",
  deep: "彻底",
  conservative: "谨慎",
};
const RUN_MODE_LABELS = {
  inspect_only: "只检查",
  auto_if_eligible: "符合条件后自动处理",
  await_approval: "检查后等我确认",
};
const EXECUTION_MODE_LABELS = {
  safe_copy: "安全副本",
  in_place: "直接保存原文件",
};
const VIEW_SUBTITLES = {
  dashboard: "查看当前任务和需要你留意的结果。",
  "new-task": "只处理你明确选择的文件，并始终输出到新副本。",
  jobs: "查看、取消或移除单文件任务记录。",
  watchers: "为无人值守处理设置固定文件夹和规则。",
  reports: "查看每个文件的处理原因和安全验证结果。",
  quarantine: "复核没有通过全部安全检查的新副本。",
  diagnostics: "用普通语言判断当前电脑能否安全运行。",
  settings: "管理自动处理权限、实验功能和保留方式。",
  help: "了解 PSMetaC 能做什么、不能做什么以及如何安全使用。",
  about: "查看产品定位、格式支持、版本和本次更新内容。",
};
const PROCESSING_STATUSES = new Set([
  "preflighting",
  "copying",
  "running",
  "validating",
]);
const CANCELLABLE_STATUSES = new Set([
  "waiting_stable",
  "queued_preflight",
  "preflighting",
  "ready",
  "waiting_photoshop",
  "copying",
  "running",
  "validating",
  "awaiting_approval",
]);
const TERMINAL_STATUSES = new Set([
  "preflight_complete",
  "skipped",
  "blocked",
  "succeeded",
  "partial",
  "quarantined",
  "discarded",
  "cancelled",
  "failed",
  "critical_paused",
  "interrupted",
]);
const PROGRESS_STAGE_LABELS = {
  queued: "等待开始",
  preflight_snapshot: "读取源文件指纹",
  preflight_scan: "只读扫描文件",
  preflight_decision: "判断处理条件",
  safety_checks: "执行安全检查",
  waiting_photoshop: "等待 Photoshop",
  work_copy: "复制工作副本",
  backup: "备份源文件",
  work_copy_scan: "复核工作副本",
  photoshop_start: "启动 Photoshop",
  photoshop_open: "打开工作文件",
  photoshop_prepare: "核对图层和计划",
  photoshop_objects: "处理智能对象",
  photoshop_layers: "整理根文档图层",
  photoshop_save: "Photoshop 保存文件",
  photoshop_reopen: "重新打开核对",
  photoshop_complete: "接收 Photoshop 结果",
  validation_scan: "扫描处理结果",
  source_integrity: "确认源文件未变",
  validation_compare: "结构、XMP 和像素比较",
  publish: "发布结果",
};
const SOURCE_LABELS = {
  ui: "手动选择",
  watcher: "自动文件夹",
  mcp: "MCP",
  cli: "命令行",
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function friendlyError(error) {
  let message = String(error?.message || error || "发生了未知问题");
  message = message
    .replace(/^Error invoking remote method '[^']+':\s*/u, "")
    .replace(/^PathPolicyError:\s*/u, "")
    .replace(/^Error:\s*/u, "");
  const translations = [
    [
      /input path is outside configured allowed roots:\s*(.*)/iu,
      "这个文件不在自动处理允许的目录中：$1。手动任务请重新点击“选择 PSD / PSB 文件”；自动监控或 MCP 任务请先在设置中添加允许自动读取的目录。",
    ],
    [
      /Only PSB is enabled for automatic use; received \.psd\./iu,
      "当前没有开启 PSD 实验功能。请进入“设置 → 文件类型”开启；PSD 只能用于只检查或检查后人工确认。",
    ],
    [
      /output path is outside configured allowed roots:\s*(.*)/iu,
      "这个保存位置不在自动保存允许的目录中：$1。手动任务请使用“选择”按钮；自动任务请先在设置中添加允许自动保存的目录。",
    ],
    [
      /No allowed input roots are configured\./iu,
      "尚未配置自动处理允许读取的目录。你仍可以手动选择单个文件；自动监控和 MCP 需要先完成设置。",
    ],
    [
      /listen EADDRINUSE:[\s\S]*/iu,
      "PSMetaC 已经在运行。请返回已经打开的窗口；再次启动会自动切换到原窗口。",
    ],
    [
      /PSMetaC 已在运行[\s\S]*/iu,
      "PSMetaC 已经在运行。请返回已经打开的窗口。",
    ],
  ];
  for (const [pattern, replacement] of translations) {
    if (pattern.test(message)) return message.replace(pattern, replacement);
  }
  return message;
}

function parseRootList(value) {
  return [...new Set(
    String(value || "")
      .split(/\r?\n/u)
      .map((item) => item.trim())
      .filter(Boolean),
  )];
}

function formatRootList(value) {
  return Array.isArray(value) ? value.join("\n") : "";
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return "未知";
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

function renderBatchCapacity(plan) {
  const panel = $("#batch-capacity");
  panel.classList.remove("hidden", "is-blocked", "is-ready");
  panel.classList.add(plan.eligible ? "is-ready" : "is-blocked");
  const volumes = (plan.volumes || [])
    .map(
      (item) => `<li><strong>${escapeHtml(item.volume || "成品盘")}</strong><span>需要 ${formatBytes(
        item.requiredBytes,
      )} · 可用 ${formatBytes(item.freeBytes)}${
        Number(item.shortfallBytes) > 0
          ? ` · 尚缺 ${formatBytes(item.shortfallBytes)}`
          : " · 空间足够"
      }</span></li>`,
    )
    .join("");
  const backup = Number(plan.backupRequiredBytes) > 0
    ? `<li><strong>数据目录备份</strong><span>需要 ${formatBytes(plan.backupRequiredBytes)} · 可用 ${formatBytes(
        plan.dataFreeBytes,
      )}${Number(plan.dataShortfallBytes) > 0 ? ` · 尚缺 ${formatBytes(plan.dataShortfallBytes)}` : " · 空间足够"}</span></li>`
    : "";
  panel.innerHTML = `<div><span>批量空间计划</span><strong>${
    plan.eligible ? "可以完整创建这批任务" : "空间不足，暂不创建任务"
  }</strong><p>${escapeHtml(plan.explanation || "")}</p></div>${
    volumes || backup ? `<ul>${volumes}${backup}</ul>` : ""
  }`;
}

function historyFilterInput() {
  const period = $("#history-period")?.value || "30";
  return {
    periodDays: period === "all" ? null : Number(period),
    format: $("#history-format")?.value || "all",
    executionMode: $("#history-mode")?.value || "all",
  };
}

function renderHistoryStatistics(result) {
  if (!result) return;
  const storage = result.storage || {};
  const tasks = result.tasks || {};
  const reliability = result.reliability || {};
  const layer = result.contentCleanup || {};
  $("#history-actual-freed").textContent = formatBytes(storage.actualFreedBytes || 0);
  $("#history-output-reduction").textContent = formatBytes(storage.outputReductionBytes || 0);
  $("#history-added-bytes").textContent = formatBytes(storage.currentAddedBytes || 0);
  $("#history-unique-sources").textContent = String(tasks.uniqueSources || 0);
  $("#history-task-detail").textContent = `${tasks.total || 0} 项任务 · ${tasks.byFormat?.psb || 0} PSB · ${tasks.byFormat?.psd || 0} PSD`;
  $("#history-added-detail").textContent = `安全副本/结果 ${formatBytes(storage.currentSafeCopyBytes || 0)} · 备份 ${formatBytes(storage.currentBackupBytes || 0)} · 其中隔离 ${formatBytes(storage.currentQuarantineBytes || 0)}`;
  const failureRate = Number(reliability.failureRatePercent);
  $("#history-outcome-summary").textContent = reliability.executedOutcomes
    ? `已进入执行并形成结论 ${reliability.executedOutcomes} 项 · 部分完成 ${reliability.partialExecutions || 0} 项 · 失败 ${reliability.failedExecutions || 0} 项（${Number.isFinite(failureRate) ? failureRate.toFixed(1) : "0.0"}%） · 安全阻止 ${reliability.blocked || 0} · 取消 ${reliability.cancelled || 0}`
    : `尚无执行结果 · 安全阻止 ${reliability.blocked || 0} · 取消 ${reliability.cancelled || 0}`;
  $("#history-layer-summary").textContent = layer.tasks
    ? `图层整理 ${layer.tasks} 项 · 删除隐藏图层 ${layer.hiddenLayersDeleted || 0} · 删除空图层 ${layer.emptyLayersDeleted || 0}`
    : "未使用图层整理";
}

function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
}

function showToast(message, kind = "normal") {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  toast.dataset.kind = kind;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 5_000);
}

function showView(name) {
  $$(".view").forEach((view) =>
    view.classList.toggle("active", view.id === `view-${name}`),
  );
  $$(".nav").forEach((button) =>
    button.classList.toggle("active", button.dataset.view === name),
  );
  const nav = $(`.nav[data-view="${name}"]`);
  $("#view-title").textContent = nav?.dataset.title || "PSMetaC";
  $("#view-subtitle").textContent = VIEW_SUBTITLES[name] || "";
  let hasPageActions = false;
  $$('[data-view-actions]').forEach((actions) => {
    const active = actions.dataset.viewActions === name;
    actions.classList.toggle("hidden", !active);
    if (active) hasPageActions = true;
  });
  $("#queue-topbar-actions").classList.toggle("hidden", hasPageActions);
  $("#view-scroll").scrollTop = 0;
  if (name === "settings") setSettingsCategory(settingsCategory);
  if (name === "help") setHelpTopic(helpTopic);
  if (name === "quarantine") void refreshQuarantineOverview();
}

function setSettingsCategory(category) {
  const available = new Set(
    $$('[data-settings-pane]').map((pane) => pane.dataset.settingsPane),
  );
  settingsCategory = available.has(category) ? category : "photoshop";
  localStorage.setItem("psmetac.settingsCategory", settingsCategory);
  $$('[data-settings-category]').forEach((button) => {
    const active = button.dataset.settingsCategory === settingsCategory;
    button.classList.toggle("active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  });
  $$('[data-settings-pane]').forEach((pane) =>
    pane.classList.toggle(
      "active",
      pane.dataset.settingsPane === settingsCategory,
    ),
  );
}

function setHelpTopic(topic) {
  const available = new Set(
    $$('[data-help-pane]').map((pane) => pane.dataset.helpPane),
  );
  helpTopic = available.has(topic) ? topic : "intro";
  localStorage.setItem("psmetac.helpTopic", helpTopic);
  $$('[data-help-topic]').forEach((button) => {
    const active = button.dataset.helpTopic === helpTopic;
    button.classList.toggle("active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  });
  $$('[data-help-pane]').forEach((pane) =>
    pane.classList.toggle("active", pane.dataset.helpPane === helpTopic),
  );
}

async function pickInto(id) {
  const value = await api.chooseDirectory(DIRECTORY_KINDS[id] || "output");
  if (value) {
    $(`#${id}`).value = value;
    if (id === "watcher-path" || id === "watcher-output") {
      await previewWatcher();
    }
  }
}

function jobStatusLabel(job) {
  if (job.reviewStatus === "accepted_with_warnings") {
    return "人工接受（有风险）";
  }
  if (job.reviewStatus === "kept_quarantined") {
    return "已复核，继续隔离";
  }
  if (job.reviewStatus === "discarded") {
    return "已放弃处理结果";
  }
  const status = effectiveJobStatus(job);
  if (job.executionMode === "in_place") {
    if (status === "partial") return "已保存，部分对象未完成";
    if (status === "succeeded") return "直存完成（未校对）";
    if (job.status === "running") return "正在清理并保存原文件";
    if (job.status === "copying") {
      return job.backupSource ? "正在备份原文件" : "正在准备直接保存";
    }
  }
  return STATUS_LABELS[status] || status;
}

function effectiveJobStatus(job) {
  return job.status === "partial" ||
    job.reasonCode === "IN_PLACE_PARTIAL_SAVED_UNVALIDATED"
    ? "partial"
    : job.status;
}

function isTerminalJob(job) {
  return TERMINAL_STATUSES.has(effectiveJobStatus(job));
}

function statusBadge(job) {
  return `<span class="status ${escapeHtml(effectiveJobStatus(job))}">${escapeHtml(
    jobStatusLabel(job),
  )}</span>`;
}

function elapsedText(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remain = seconds % 60;
  return hours
    ? `${hours}小时${String(minutes).padStart(2, "0")}分`
    : minutes
      ? `${minutes}分${String(remain).padStart(2, "0")}秒`
      : `${remain}秒`;
}

function durationText(job, now = Date.now()) {
  const created = Date.parse(job.createdAt || "");
  const preflightStarted = Date.parse(job.preflightStartedAt || "");
  const preflightFinished = Date.parse(job.preflightFinishedAt || "");
  const executionStarted = Date.parse(job.executionStartedAt || "");
  const finished = Date.parse(job.finishedAt || "");
  const terminal = isTerminalJob(job);
  if (terminal && Number.isFinite(created) && Number.isFinite(finished)) {
    const total = elapsedText(finished - created);
    if (Number.isFinite(executionStarted)) {
      return `处理 ${elapsedText(finished - executionStarted)} · 总历时 ${total}`;
    }
    if (Number.isFinite(preflightStarted)) {
      return `检查 ${elapsedText((Number.isFinite(preflightFinished) ? preflightFinished : finished) - preflightStarted)} · 总历时 ${total}`;
    }
    return `总历时 ${total}`;
  }
  if (job.status === "preflighting" && Number.isFinite(preflightStarted)) {
    return `检查已用 ${elapsedText(now - preflightStarted)}`;
  }
  if (
    ["copying", "running", "validating"].includes(job.status) &&
    Number.isFinite(executionStarted)
  ) {
    return `处理已用 ${elapsedText(now - executionStarted)}`;
  }
  if (job.status === "waiting_photoshop" && Number.isFinite(preflightFinished)) {
    return `已检查 · 等待 Photoshop ${elapsedText(now - preflightFinished)}`;
  }
  return "尚未开始处理计时";
}

function selectedValidationChecks(scope) {
  return $$(`[data-validation="${scope}"]:checked`).map(
    (input) => input.value,
  );
}

async function previewWatcher() {
  const sourcePath = $("#watcher-path")?.value;
  const preview = $("#watcher-preview");
  if (!sourcePath || !preview) {
    if (preview) preview.textContent = "选择文件夹后会显示当前扫描结果。";
    return null;
  }
  preview.className = "watcher-preview full";
  preview.textContent = "正在扫描当前文件夹…";
  try {
    const outputDir =
      $("#watcher-execution-mode").value === "safe_copy" &&
      $("#watcher-output-mode").value === "specified_directory"
        ? $("#watcher-output").value || undefined
        : undefined;
    const result = await api.invoke("preview_watcher", {
      path: sourcePath,
      recursive: $("#watcher-recursive").checked,
      outputDir,
    });
    preview.innerHTML =
      `<strong>当前可自动处理 ${result.supportedFiles} 个 Photoshop 文件</strong>` +
      `；其中 PSB ${result.psbFiles} 个、PSD ${result.psdFiles} 个` +
      (settings?.experimentalPsdUnattended
        ? "（PSD 实验无人值守已开启）"
        : "（PSD 不会自动创建任务）") +
      `；` +
      `共查看 ${result.scannedFiles} 个文件。启用后，每个文件稳定 ${result.stabilitySeconds} 秒才会创建任务。` +
      (result.errors?.length
        ? `<br>有 ${result.errors.length} 个位置无法读取，请查看设置或权限。`
        : "");
    preview.classList.toggle("warning", Boolean(result.errors?.length));
    return result;
  } catch (error) {
    preview.className = "watcher-preview full warning";
    preview.textContent = `扫描没有完成：${friendlyError(error)}`;
    return null;
  }
}

function settleDangerDialog(result) {
  $("#danger-overlay").classList.add("hidden");
  const resolve = dangerDialogResolve;
  dangerDialogResolve = null;
  resolve?.(result);
}

async function confirmDanger(
  message,
  { alwaysConfirm = false, allowNeverRemind = true } = {},
) {
  if (!alwaysConfirm && settings?.suppressDangerousOperationWarning) return true;
  if (dangerDialogResolve) settleDangerDialog(false);
  $("#danger-dialog-message").textContent = message;
  $("#danger-never-remind").checked = false;
  $("#danger-never-remind-field").classList.toggle(
    "hidden",
    !allowNeverRemind,
  );
  $("#danger-overlay").classList.remove("hidden");
  return await new Promise((resolve) => {
    dangerDialogResolve = resolve;
  });
}

function iconButton({ icon, label, attribute, value, enabled = true, danger = false }) {
  const data = enabled && attribute ? ` data-${attribute}="${escapeHtml(value)}"` : "";
  return `<button class="action-icon${danger ? " danger" : ""}" type="button" title="${escapeHtml(
    label,
  )}" aria-label="${escapeHtml(label)}"${data}${enabled ? "" : " disabled"}><svg><use href="#i-${icon}"/></svg></button>`;
}

function canArchive(job) {
  return !PROCESSING_STATUSES.has(job.status);
}

function canDeleteJobData(job) {
  return [
    "preflight_complete",
    "skipped",
    "blocked",
    "succeeded",
    "partial",
    "quarantined",
    "cancelled",
    "failed",
    "critical_paused",
    "interrupted",
  ].includes(job.status);
}

function systemJobTags(job) {
  const status = effectiveJobStatus(job);
  const extension = job.sourcePath.toLowerCase().endsWith(".psd") ? "PSD" : "PSB";
  const tags = [
    { group: "status", key: `${status}:${job.reviewStatus || ""}`, label: jobStatusLabel(job) },
    {
      group: "execution",
      key: job.executionMode,
      label: EXECUTION_MODE_LABELS[job.executionMode] || job.executionMode,
    },
    {
      group: "run",
      key: job.runMode,
      label: RUN_MODE_LABELS[job.runMode] || job.runMode,
    },
    {
      group: "profile",
      key: job.profile,
      label: `清理程度：${PROFILE_LABELS[job.profile] || job.profile}`,
    },
    { group: "file", key: extension, label: extension },
    {
      group: "source",
      key: job.submissionSource || "ui",
      label: SOURCE_LABELS[job.submissionSource] || job.submissionSource || "手动选择",
    },
  ];
  if (job.executionMode === "in_place") {
    tags.push({
      group: "backup",
      key: job.backupSource ? "with_backup" : "without_backup",
      label: job.backupSource ? "有备份" : "无备份",
    });
  }
  if (job.photoshopVersion) {
    tags.push({
      group: "photoshop",
      key: job.photoshopVersion,
      label: `Photoshop ${job.photoshopVersion}`,
    });
  }
  for (const tag of job.userTags || []) {
    tags.push({
      group: "user",
      key: tag.id,
      label: tag.name,
      color: tag.color,
    });
  }
  return tags;
}

function poolJobs() {
  return jobs.filter((job) =>
    jobPool === "completed"
      ? isTerminalJob(job)
      : !isTerminalJob(job),
  );
}

function filteredPoolJobs() {
  const selectedByGroup = new Map();
  for (const value of jobFilters) {
    const splitAt = value.indexOf("|");
    const group = value.slice(0, splitAt);
    const key = value.slice(splitAt + 1);
    if (!selectedByGroup.has(group)) selectedByGroup.set(group, new Set());
    selectedByGroup.get(group).add(key);
  }
  const query = jobSearch.trim().toLocaleLowerCase("zh-CN");
  return poolJobs().filter((job) => {
    if (query && !job.sourcePath.toLocaleLowerCase("zh-CN").includes(query)) {
      return false;
    }
    const tags = systemJobTags(job);
    return [...selectedByGroup].every(([group, keys]) =>
      tags.some((tag) => tag.group === group && keys.has(String(tag.key))),
    );
  });
}

function renderJobFilters() {
  const counts = new Map();
  for (const job of poolJobs()) {
    for (const tag of systemJobTags(job)) {
      const filterKey = `${tag.group}|${tag.key}`;
      const current = counts.get(filterKey) || { ...tag, count: 0 };
      current.count++;
      counts.set(filterKey, current);
    }
  }
  const groupOrder = [
    "status",
    "execution",
    "backup",
    "run",
    "profile",
    "file",
    "source",
    "photoshop",
    "user",
  ];
  const chips = [...counts.entries()].sort(([, a], [, b]) => {
    const groupDifference =
      groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group);
    return groupDifference || a.label.localeCompare(b.label, "zh-CN");
  });
  const groupLabels = {
    status: "结果/状态",
    execution: "保存方式",
    backup: "备份",
    run: "执行规则",
    profile: "清理程度",
    file: "文件类型",
    source: "任务来源",
    photoshop: "Photoshop",
    user: "我的标签",
  };
  const grouped = new Map();
  for (const entry of chips) {
    const group = entry[1].group;
    if (!grouped.has(group)) grouped.set(group, []);
    grouped.get(group).push(entry);
  }
  $("#job-filter-chips").innerHTML = grouped.size
    ? [...grouped].map(([group, entries]) => {
      const options = entries
        .map(([key, item]) => `<button type="button" class="filter-chip${jobFilters.has(key) ? " active" : ""}" data-job-filter="${escapeHtml(
          key,
        )}" aria-pressed="${jobFilters.has(key)}"${item.color ? ` style="--tag-color:${escapeHtml(item.color)}"` : ""}>${escapeHtml(
          item.label,
        )}<span>${item.count}</span></button>`)
        .join("");
      return `<div class="job-filter-group"><strong class="filter-group-label">${escapeHtml(groupLabels[group] || group)}</strong><div class="job-filter-options">${options}</div></div>`;
      })
      .join("")
    : '<p class="job-filter-empty">当前列表还没有可用的筛选条件。</p>';
  const visible = filteredPoolJobs().length;
  $("#job-filter-summary").textContent =
    jobFilters.size || jobSearch
      ? `已从 ${poolJobs().length} 项中筛选出 ${visible} 项；同类标签满足任一项，不同类别需同时满足。`
      : `共 ${visible} 项。点击标签可以组合筛选，再点一次取消。`;
  const countBadge = $("#active-job-filter-count");
  countBadge.textContent = String(jobFilters.size);
  countBadge.classList.toggle("hidden", jobFilters.size === 0);
  $("#clear-job-filters").classList.toggle("hidden", jobFilters.size === 0);
}

function progressDisplay(job) {
  const stage =
    PROGRESS_STAGE_LABELS[job.progressStage] ||
    STATUS_LABELS[job.status] ||
    "尚未记录阶段";
  const detail = job.progressDetail || REASON_LABELS[job.reasonCode] || "";
  if (isTerminalJob(job)) {
    return `<div class="job-stop-stage"><strong>${escapeHtml(
      ["succeeded", "partial", "preflight_complete"].includes(effectiveJobStatus(job))
        ? `完成于：${stage}`
        : `停止于：${stage}`,
    )}</strong><small>${escapeHtml(detail)}</small></div>`;
  }
  const percent = Math.max(0, Math.min(100, Math.round(Number(job.progress || 0) * 100)));
  let amount = "";
  if (
    Number.isFinite(Number(job.progressCurrent)) &&
    Number.isFinite(Number(job.progressTotal)) &&
    Number(job.progressTotal) > 0
  ) {
    amount =
      ["work_copy", "backup"].includes(job.progressStage)
        ? `${formatBytes(job.progressCurrent)} / ${formatBytes(job.progressTotal)}`
        : `${job.progressCurrent} / ${job.progressTotal}`;
  }
  return `<div class="job-progress"><div class="job-progress-head"><span>${escapeHtml(
    stage,
  )}</span><strong>${percent}%</strong></div><div class="progress-track"><i style="width:${percent}%"></i></div><small>${escapeHtml(
    amount ? `${amount} · ${detail}` : detail,
  )}</small></div>`;
}

function taskStageTimeline(job) {
  const stages = [
    { label: "预检", keys: ["queued", "preflight_snapshot", "preflight_scan", "preflight_decision", "safety_checks"] },
    { label: "工作副本", keys: ["work_copy", "backup", "work_copy_scan"] },
    { label: "清理对象", keys: ["photoshop_start", "photoshop_open", "photoshop_prepare", "photoshop_objects"] },
    { label: "根文档", keys: ["photoshop_layers", "photoshop_complete"] },
    { label: "保存", keys: ["photoshop_save"] },
    { label: "重新打开", keys: ["photoshop_reopen"] },
    { label: "检查结果", keys: ["validation_scan", "source_integrity", "validation_compare", "publish"] },
  ];
  let activeIndex = stages.findIndex((stage) =>
    stage.keys.includes(job.progressStage),
  );
  if (activeIndex < 0) {
    activeIndex = ["waiting_photoshop"].includes(job.progressStage) ? 1 : 0;
  }
  return `<div class="job-stage-track" aria-label="处理阶段">${stages
    .map((stage, index) => {
      const state = index < activeIndex ? "done" : index === activeIndex ? "active" : "pending";
      return `<span class="${state}"><i></i>${escapeHtml(stage.label)}</span>`;
    })
    .join("")}</div>`;
}

function primaryJobAction(job, { canReview, canApprove }) {
  if (canReview) {
    const label =
      job.reviewStatus === "kept_quarantined"
        ? "再次复核"
        : job.reviewStatus
          ? "查看复核记录"
          : "开始复核";
    return `<button class="job-main-action review" type="button" data-review-job="${escapeHtml(
      job.id,
    )}"><svg><use href="#i-review"/></svg>${label}</button>`;
  }
  if (canApprove) {
    return `<div class="job-decision-actions"><button class="job-main-action quiet" type="button" data-keep-inspection="${escapeHtml(
      job.id,
    )}">仅保留检查结果</button><button class="job-main-action" type="button" data-approve="${escapeHtml(
      job.id,
    )}"><svg><use href="#i-check"/></svg>开始处理</button></div>`;
  }
  return "";
}

function preflightDecisionSummary(job) {
  const summary = preflightSummaries[job.id];
  if (!summary) return "";
  const estimate = summary.estimate || {};
  const eligible = summary.eligible === true;
  const conclusion = eligible ? "建议处理" : "当前无需处理";
  const evidence = [
    Number(summary.documentAncestors) > 0
      ? `发现 ${Number(summary.documentAncestors)} 条编辑溯源记录`
      : "未发现目标编辑溯源记录",
    Number(estimate.affectedContainers) > 0
      ? `涉及 ${Number(estimate.affectedContainers)} 个容器`
      : "没有受影响容器",
    Number(estimate.affectedXmpBytes) > 0
      ? `预计可减少 ${formatBytes(estimate.affectedXmpBytes)}`
      : "预计不会释放明显空间",
  ];
  const objectCount = Number(estimate.plannedObjects || 0);
  const range = estimate.estimatedPhotoshopRangeMs || {};
  const timing = Number(range.high) > 0
    ? `预计 Photoshop 活跃时间 ${elapsedText(Number(range.low) || 0)}–${elapsedText(Number(range.high))}`
    : "本次无需估算 Photoshop 处理时间";
  const next = job.status === "awaiting_approval"
    ? "下一步：开始处理，或仅保留本次检查结果。"
    : "检查已经结束，可打开报告查看完整技术明细。";
  return `<section class="preflight-decision ${eligible ? "eligible" : "not-needed"}"><div class="preflight-conclusion"><span>检查结论</span><strong>${escapeHtml(
    conclusion,
  )}</strong></div><p>${escapeHtml(evidence.join(" · "))}</p><small>${escapeHtml(
    `${objectCount} 个对象计划进入 Photoshop · ${timing} · 源文件${summary.sourceUnchanged === false ? "发生过变化" : "未被修改"}${Number(summary.parserWarnings) ? ` · ${Number(summary.parserWarnings)} 条扫描警告` : ""}`,
  )}</small><b>${escapeHtml(next)}</b></section>`;
}

function jobRows(items, options = {}) {
  if (!items.length) {
    return '<div class="empty-state">这里还没有任务。</div>';
  }
  const selectable = options.selectable === true;
  const rows = items
    .map((job) => {
      const resultPath = job.quarantinePath || job.outputPath;
      const canApprove = job.status === "awaiting_approval";
      const canCancel = CANCELLABLE_STATUSES.has(job.status);
      const canRemove = canArchive(job);
      const canDelete = canDeleteJobData(job);
      const canReview =
        job.status === "quarantined" ||
        Boolean(job.reviewStatus) ||
        Boolean(job.quarantinePath);
      const actions = [
        iconButton({
          icon: "cancel",
          label: canCancel ? "安全取消任务" : "当前状态不能取消",
          attribute: "cancel",
          value: job.id,
          enabled: canCancel,
          danger: true,
        }),
        iconButton({
          icon: "report",
          label: job.reportHtmlPath ? "打开处理报告" : "报告尚未生成",
          attribute: "open-job-target",
          value: `${job.id}|report`,
          enabled: Boolean(job.reportHtmlPath),
        }),
        iconButton({
          icon: "open",
          label: resultPath ? "打开结果文件" : "结果文件尚未生成",
          attribute: "open-job-target",
          value: `${job.id}|result`,
          enabled: Boolean(resultPath),
        }),
        iconButton({
          icon: "remove",
          label: canRemove ? "从任务列表移除" : "处理中不能移除",
          attribute: "archive",
          value: job.id,
          enabled: canRemove,
          danger: true,
        }),
        iconButton({
          icon: "more",
          label: "标签和更多操作",
          attribute: "more-job",
          value: job.id,
          enabled: true,
        }),
      ].filter(Boolean);
      const checkbox =
        selectable && canArchive(job)
          ? `<input type="checkbox" data-select-job="${job.id}" ${
              selectedJobIds.has(job.id) ? "checked" : ""
            } aria-label="选择 ${escapeHtml(job.sourcePath)}">`
          : "";
      const reason = REASON_LABELS[job.reasonCode] || job.reasonCode || "—";
      const name = job.sourcePath.split(/[\\/]/u).pop();
      const userTagMarkup = (job.userTags || [])
        .map(
          (tag) =>
            `<span class="mini-tag" style="--tag-color:${escapeHtml(tag.color)}">${escapeHtml(
              tag.name,
            )}</span>`,
        )
        .join("");
      const extension = name.toLowerCase().endsWith(".psd") ? "PSD" : "PSB";
      const effectiveStatus = effectiveJobStatus(job);
      const active = !isTerminalJob(job);
      const activeProgress = active ? progressDisplay(job) : "";
      return `<article class="job-row job-row-${escapeHtml(effectiveStatus)}${
        active ? " is-active" : ""
      }${selectable ? " is-selectable" : ""}" data-job-row="${escapeHtml(job.id)}">
        ${selectable ? `<label class="job-select">${checkbox}</label>` : ""}
        <span class="job-thumb" aria-hidden="true">${extension}</span>
        <div class="job-body">
          <div class="job-heading"><strong title="${escapeHtml(job.sourcePath)}">${escapeHtml(
            name,
          )}</strong><span>${escapeHtml(formatTime(job.createdAt))} · ${escapeHtml(
            EXECUTION_MODE_LABELS[job.executionMode] || "安全副本",
          )}</span></div>
          <p class="job-reason" title="${escapeHtml(job.reasonCode || "")}">${escapeHtml(
            reason,
          )}</p>
          ${preflightDecisionSummary(job)}
          ${userTagMarkup ? `<span class="job-user-tags">${userTagMarkup}</span>` : ""}
          ${activeProgress ? `<div class="job-running-detail">${activeProgress}${taskStageTimeline(job)}</div>` : ""}
        </div>
        <div class="job-side">
          <div class="job-state">${statusBadge(job)}<span class="job-duration" data-job-duration="${job.id}">${escapeHtml(
            durationText(job),
          )}</span></div>
          <div class="actions">${primaryJobAction(job, { canReview, canApprove })}${actions.join("")}</div>
        </div>
      </article>`;
    })
    .join("");
  return `<div class="job-list">${
    selectable
      ? '<label class="job-list-select-all"><input id="select-all-jobs" type="checkbox" aria-label="选择所有可移除任务">选择当前列表中可管理的任务</label>'
      : ""
  }${rows}</div>`;
}

function watcherStatus(item) {
  if (!item.enabled) {
    return { label: "已暂停", tone: "paused", detail: "不会继续扫描或创建新任务" };
  }
  if (item.scanStatus === "error") {
    return { label: "扫描遇到问题", tone: "error", detail: item.lastError || "请检查目录权限" };
  }
  if (item.scanStatus === "scanning") {
    return { label: "正在扫描", tone: "running", detail: "正在读取文件夹内容" };
  }
  return { label: "正在监控", tone: "monitoring", detail: "等待发现新文件" };
}

function watcherCards(items) {
  if (!items.length) {
    return '<div class="empty-state watcher-empty"><strong>还没有自动处理文件夹</strong><span>点击右上角“添加文件夹”，设置固定规则后由 PSMetaC 自动扫描。</span></div>';
  }
  const formatLabel = settings?.experimentalPsdUnattended ? "PSD + PSB" : "PSB";
  return `<div class="watcher-cards">${items
    .map((item) => {
      const status = watcherStatus(item);
      const waiting = Number(item.waitingStableFiles || 0);
      const progress = waiting
        ? `<div class="watcher-live"><span>有 ${waiting} 个文件正在等待稳定</span><strong>稳定 ${settings?.stabilitySeconds || 60} 秒后预检</strong></div>`
        : "";
      return `<article class="watcher-card watcher-${escapeHtml(status.tone)}">
        <div class="watcher-card-head">
          <span class="watcher-folder" aria-hidden="true"><svg><use href="#i-folder"/></svg></span>
          <div class="watcher-identity"><strong class="overflow-text" tabindex="0" title="${escapeHtml(item.path)}">${escapeHtml(item.path)}</strong><span>${escapeHtml(status.detail)}${item.lastScanAt ? ` · ${escapeHtml(formatTime(item.lastScanAt))}` : ""}</span></div>
          <span class="watcher-status ${escapeHtml(status.tone)}">${escapeHtml(status.label)}</span>
          <button class="watcher-toggle" type="button" data-watcher-toggle="${escapeHtml(item.id)}" data-watcher-enable="${item.enabled ? "false" : "true"}"><svg><use href="#${item.enabled ? "i-pause" : "i-play"}"/></svg>${item.enabled ? "暂停" : "继续"}</button>
        </div>
        <div class="watcher-rules">
          <span>处理方案 <strong>${escapeHtml(item.executionMode === "in_place" ? `直接保存${item.backupSource ? "并备份" : "（无备份）"}` : "安全副本")}</strong></span>
          <span>清理程度 <strong>${escapeHtml(PROFILE_LABELS[item.profile] || item.profile)}</strong></span>
          <span>执行 <strong>${escapeHtml(RUN_MODE_LABELS[item.runMode] || item.runMode)}</strong></span>
          <span>格式 <strong>${formatLabel}</strong></span>
          <span>${item.recursive ? "包含子文件夹" : "仅当前文件夹"}</span>
        </div>
        <div class="watcher-counts"><span>可处理 <strong>${Number(item.supportedFiles || 0)}</strong></span><span>等待稳定 <strong>${waiting}</strong></span><span>已创建任务 <strong>${Number(item.submittedJobs || 0)}</strong></span><span>已跳过 <strong>${Number(item.skippedFiles || 0)}</strong></span></div>
        ${progress}
      </article>`;
    })
    .join("")}</div>`;
}

function quarantineAge(job) {
  const timestamp = Date.parse(job.finishedAt || job.updatedAt || "");
  if (!Number.isFinite(timestamp)) return "时间未知";
  const days = Math.max(0, Math.floor((Date.now() - timestamp) / 86_400_000));
  return days === 0 ? "今天" : `已保留 ${days} 天`;
}

function quarantineRows(items) {
  if (!items.length) {
    return '<div class="empty-state"><strong>当前筛选下没有隔离文件</strong><span>处理结果通过验收、被接受或清理后会离开这里。</span></div>';
  }
  const eligibleByJob = new Map(
    (quarantineCleanupPreview?.candidates || []).map((item) => [item.jobId, item]),
  );
  return `<div class="quarantine-rows">${items
    .map((job) => {
      const name = job.sourcePath.split(/[\\/]/u).pop() || job.sourcePath;
      const extension = name.toLowerCase().endsWith(".psd") ? "PSD" : "PSB";
      const eligible = eligibleByJob.get(job.id);
      const kept = job.reviewStatus === "kept_quarantined";
      const stateLabel = kept ? "已复核，继续隔离" : eligible ? "可以清理" : "等待复核";
      const stateClass = kept ? "kept" : eligible ? "eligible" : "pending";
      const reason = REASON_LABELS[job.reasonCode] || job.reasonCode || "自动验收没有全部通过";
      const mainAction = primaryJobAction(job, { canReview: true, canApprove: false });
      const reportAction = iconButton({
        icon: "report",
        label: job.reportHtmlPath ? "打开处理报告" : "报告尚未生成",
        attribute: "open-job-target",
        value: `${job.id}|report`,
        enabled: Boolean(job.reportHtmlPath),
      });
      const moreAction = iconButton({
        icon: "more",
        label: "标签和更多操作",
        attribute: "more-job",
        value: job.id,
        enabled: true,
      });
      return `<article class="quarantine-row ${stateClass}">
        <span class="quarantine-thumb" aria-hidden="true">${extension}</span>
        <div class="quarantine-copy">
          <strong class="overflow-text" tabindex="0" title="${escapeHtml(job.sourcePath)}">${escapeHtml(name)}</strong>
          <span>${escapeHtml(`${formatBytes(job.sourceBytes)} 原件 · ${quarantineAge(job)} · ${EXECUTION_MODE_LABELS[job.executionMode] || "安全副本"}`)}</span>
          <small class="overflow-text" tabindex="0" title="${escapeHtml(reason)}">${escapeHtml(reason)}</small>
        </div>
        <div class="quarantine-actions"><span class="quarantine-state ${stateClass}">${stateLabel}</span><div>${mainAction}${reportAction}${moreAction}</div></div>
      </article>`;
    })
    .join("")}</div>`;
}

function renderQuarantineView() {
  const quarantined = jobs.filter((job) => job.status === "quarantined");
  const eligibleIds = new Set(
    (quarantineCleanupPreview?.candidates || []).map((item) => item.jobId),
  );
  const pending = quarantined.filter((job) => job.reviewStatus !== "kept_quarantined");
  const kept = quarantined.filter((job) => job.reviewStatus === "kept_quarantined");
  const eligible = quarantined.filter((job) => eligibleIds.has(job.id));
  const filtered =
    quarantineFilter === "pending"
      ? pending
      : quarantineFilter === "kept"
        ? kept
        : quarantineFilter === "eligible"
          ? eligible
          : quarantined;
  $("#quarantine-count-all").textContent = quarantined.length;
  $("#quarantine-count-pending").textContent = pending.length;
  $("#quarantine-count-kept").textContent = kept.length;
  $("#quarantine-count-eligible").textContent = eligible.length;
  $$('[data-quarantine-filter]').forEach((button) => {
    button.classList.toggle("active", button.dataset.quarantineFilter === quarantineFilter);
  });
  const summary = $("#quarantine-summary");
  if (quarantineCleanupPreview) {
    summary.innerHTML = `<strong>隔离区共 ${quarantineCleanupPreview.totalDirectories} 项、${formatBytes(quarantineCleanupPreview.totalBytes)}</strong><span>当前清理条件命中 ${quarantineCleanupPreview.candidates.length} 项、${formatBytes(quarantineCleanupPreview.candidateBytes)}；${quarantineCleanupPreview.lockedDirectories} 项因“继续隔离”已锁定。</span>`;
  } else {
    summary.innerHTML = `<strong>共 ${quarantined.length} 个处理结果等待管理</strong><span>源文件、成品、备份、报告和日志不在自动清理范围。</span>`;
  }
  $("#quarantine-clean-now").disabled = !quarantineCleanupPreview?.candidates?.length;
  $("#quarantine-list").innerHTML = quarantineRows(filtered);
}

function updateSelectionBar() {
  const count = selectedJobIds.size;
  $("#selected-job-count").textContent = `已选择 ${count} 项`;
  $("#job-selection-bar").classList.toggle("hidden", count === 0);
  const selectAll = $("#select-all-jobs");
  if (selectAll) {
    const selectableIds = filteredPoolJobs().filter(canArchive).map((job) => job.id);
    selectAll.checked =
      selectableIds.length > 0 &&
      selectableIds.every((id) => selectedJobIds.has(id));
    selectAll.indeterminate =
      !selectAll.checked && selectableIds.some((id) => selectedJobIds.has(id));
  }
}

function renderJobsView() {
  const activeCount = jobs.filter((job) => !TERMINAL_STATUSES.has(job.status)).length;
  const completedCount = jobs.length - activeCount;
  $("#active-job-count").textContent = activeCount;
  $("#completed-job-count").textContent = completedCount;
  $$(".job-pool-tab").forEach((button) =>
    button.classList.toggle("active", button.dataset.jobPool === jobPool),
  );
  renderJobFilters();
  const visibleJobs = filteredPoolJobs();
  const visibleIds = new Set(visibleJobs.map((job) => job.id));
  selectedJobIds = new Set(
    [...selectedJobIds].filter((id) => visibleIds.has(id)),
  );
  const pageCount = Math.max(1, Math.ceil(visibleJobs.length / JOB_PAGE_SIZE));
  jobRenderPage = Math.min(jobRenderPage, pageCount - 1);
  const pageStart = jobRenderPage * JOB_PAGE_SIZE;
  const renderedJobs = visibleJobs.slice(pageStart, pageStart + JOB_PAGE_SIZE);
  $("#jobs-table").innerHTML =
    jobRows(renderedJobs, { selectable: true }) +
    (visibleJobs.length > JOB_PAGE_SIZE
      ? `<nav class="job-pagination" aria-label="任务列表分页"><button type="button" data-job-page="previous"${jobRenderPage === 0 ? " disabled" : ""}>上一页</button><span>第 ${jobRenderPage + 1} / ${pageCount} 页 · ${pageStart + 1}–${pageStart + renderedJobs.length} / ${visibleJobs.length}</span><button type="button" data-job-page="next"${jobRenderPage >= pageCount - 1 ? " disabled" : ""}>下一页</button></nav>`
      : "");
  updateSelectionBar();
}

function renderQueue(queue) {
  const paused = Boolean(queue.paused);
  const critical = Boolean(queue.criticalReason);
  const label = critical
    ? "任务队列已安全暂停"
    : paused
      ? "已暂停处理新任务"
      : "后台正常运行";
  $("#queue-pill").textContent = label;
  $("#queue-dot").className = critical ? "critical" : paused ? "paused" : "";
  const active = jobs.find((job) => PROCESSING_STATUSES.has(job.status));
  $("#queue-current").textContent = active
    ? `${jobStatusLabel(active)} · ${active.sourcePath.split(/[\\/]/u).pop()}`
    : `${queue.runnable || 0} 个任务等待处理`;
  const toggleText = paused ? "继续处理任务" : active ? "完成当前项后暂停" : "暂停处理新任务";
  $("#queue-toggle").textContent = toggleText;
  $("#sidebar-queue-toggle").textContent = toggleText;
  $("#queue-stop").disabled = critical;
  $("#sidebar-queue-stop").disabled = critical;
  renderGlobalTaskDock(queue, active);
}

function renderGlobalTaskDock(queue, activeJob) {
  const dock = $("#global-task-dock");
  const thumb = $("#global-task-thumb");
  const title = $("#global-task-title");
  const detail = $("#global-task-detail");
  const progress = $("#global-task-progress");
  const progressBar = $("#global-task-progress-bar");
  const percentLabel = $("#global-task-percent");
  const toggle = $("#global-task-toggle");
  const stop = $("#global-task-stop");
  const primary = $("#global-task-primary");
  const open = $("#global-task-open");
  const pendingReviews = jobs.filter(
    (job) =>
      job.status === "quarantined" &&
      job.reviewStatus !== "kept_quarantined",
  ).length;

  dock.className = "global-task-dock";
  progress.classList.add("hidden");
  toggle.classList.add("hidden");
  stop.classList.add("hidden");
  primary.classList.remove("hidden");
  open.classList.add("hidden");
  primary.dataset.dockAction = "new-task";
  primary.textContent = "处理文件";
  thumb.textContent = "PS";

  if (queue.criticalReason) {
    dock.classList.add("is-critical");
    title.textContent = "任务队列已安全暂停";
    detail.textContent = "需要先检查运行环境或任务记录中的严重问题";
    primary.dataset.dockAction = "diagnostics";
    primary.textContent = "运行检测";
    return;
  }

  if (activeJob) {
    const fileName = activeJob.sourcePath.split(/[\\/]/u).pop() || activeJob.sourcePath;
    const extension = fileName.split(".").pop()?.toUpperCase() || "PS";
    const stage =
      PROGRESS_STAGE_LABELS[activeJob.progressStage] ||
      STATUS_LABELS[activeJob.status] ||
      "正在处理";
    const current = Number(activeJob.progressCurrent);
    const total = Number(activeJob.progressTotal);
    const amount =
      Number.isFinite(current) && Number.isFinite(total) && total > 0
        ? ["work_copy", "backup"].includes(activeJob.progressStage)
          ? `${formatBytes(current)} / ${formatBytes(total)}`
          : `${current} / ${total}`
        : "";
    const percent = Math.max(
      0,
      Math.min(100, Math.round(Number(activeJob.progress || 0) * 100)),
    );

    dock.classList.add("is-running");
    thumb.textContent = extension;
    title.textContent = fileName;
    title.title = activeJob.sourcePath;
    detail.textContent = `${stage}${amount ? ` ${amount}` : ""} · ${durationText(activeJob)}`;
    progressBar.style.width = `${percent}%`;
    percentLabel.textContent = `${percent}%`;
    progress.classList.remove("hidden");
    toggle.classList.remove("hidden");
    stop.classList.remove("hidden");
    primary.classList.add("hidden");
    open.classList.remove("hidden");
    toggle.title = queue.paused ? "继续处理任务" : "完成当前项后暂停";
    toggle.setAttribute("aria-label", toggle.title);
    return;
  }

  if (pendingReviews > 0) {
    dock.classList.add("is-attention");
    thumb.textContent = String(pendingReviews);
    title.textContent = `${pendingReviews} 个处理结果需要你复核`;
    detail.textContent = "处理结果可以打开；请比较画面并作出人工决定";
    primary.dataset.dockAction = "review";
    primary.textContent = "开始复核";
    return;
  }

  if (queue.paused) {
    dock.classList.add("is-paused");
    title.textContent = "任务队列已暂停";
    detail.textContent = `${queue.runnable || 0} 个任务等待继续处理`;
    primary.dataset.dockAction = "resume";
    primary.textContent = "继续处理";
    return;
  }

  dock.classList.add("is-idle");
  title.textContent = "当前没有任务";
  detail.textContent = settings?.photoshopExecutable
    ? "任务专用 Photoshop 已配置 · 可以开始处理文件"
    : "尚未选择任务专用 Photoshop · 建议先运行检测";
}

async function refresh() {
  if (!(await api.bootstrapStatus()).initialized) return;
  if ($("#task-action-menu") && !$("#task-action-menu").classList.contains("hidden")) {
    closeTaskActionMenu();
  }
  [jobs, settings, availableUserTags, capabilities, historyStatistics] = await Promise.all([
    api.invoke("list_jobs", { limit: 300 }),
    api.invoke("settings"),
    api.invoke("list_user_tags"),
    api.invoke("capabilities"),
    api.invoke("history_statistics", historyFilterInput()).catch(() => null),
  ]);
  const preflightJobIds = jobs
    .filter((job) => ["awaiting_approval", "preflight_complete", "skipped"].includes(effectiveJobStatus(job)))
    .map((job) => job.id);
  preflightSummaries = preflightJobIds.length
    ? await api.invoke("preflight_summaries", { jobIds: preflightJobIds }).catch(() => ({}))
    : {};
  renderHistoryStatistics(historyStatistics);
  const visibleIds = new Set(jobs.map((job) => job.id));
  selectedJobIds = new Set(
    [...selectedJobIds].filter((id) => visibleIds.has(id)),
  );
  const queue = await api.invoke("queue_status");
  renderQueue(queue);
  $("#count-waiting").textContent = jobs.filter((job) =>
    CANCELLABLE_STATUSES.has(job.status),
  ).length;
  $("#count-success").textContent = jobs.filter(
    (job) =>
      effectiveJobStatus(job) === "succeeded" &&
      job.reasonCode === "STRICT_VALIDATION_PASSED",
  ).length;
  const quarantined = jobs.filter((job) => job.status === "quarantined");
  const pendingReviews = quarantined.filter(
    (job) => job.reviewStatus !== "kept_quarantined",
  );
  $("#count-quarantine").textContent = pendingReviews.length;
  $("#quarantine-nav-count").textContent = pendingReviews.length;
  $("#quarantine-nav-count").classList.toggle(
    "hidden",
    pendingReviews.length === 0,
  );
  $("#count-failed").textContent = jobs.filter((job) =>
    ["partial", "failed", "blocked", "critical_paused", "interrupted"].includes(effectiveJobStatus(job)),
  ).length;
  const attentionJobs = jobs.filter(
    (job) =>
      (job.status === "quarantined" && job.reviewStatus !== "kept_quarantined") ||
      job.status === "awaiting_approval" ||
      ["partial", "failed", "blocked", "critical_paused", "interrupted"].includes(effectiveJobStatus(job)),
  );
  const runningJobs = jobs.filter((job) => !isTerminalJob(job));
  const dashboardAttentionAction = $("#dashboard-attention-action");
  if (attentionJobs.length > 0) {
    $("#dashboard-attention-title").textContent = `${attentionJobs.length} 项结果需要你处理`;
    $("#dashboard-attention-copy").textContent =
      "先看结论和下一步；技术代码只保留在报告的技术详情中。";
    $("#dashboard-attention-jobs").innerHTML = jobRows(attentionJobs.slice(0, 3));
    dashboardAttentionAction.classList.remove("hidden");
    dashboardAttentionAction.dataset.go = pendingReviews.length > 0 ? "quarantine" : "jobs";
    dashboardAttentionAction.textContent = pendingReviews.length > 0 ? "开始复核" : "查看任务";
  } else {
    $("#dashboard-attention-title").textContent = "当前没有需要处理的事项";
    $("#dashboard-attention-copy").textContent =
      "发生安全阻止、处理失败或需要人工复核时，会优先显示在这里。";
    $("#dashboard-attention-jobs").innerHTML =
      '<div class="compact-success"><svg><use href="#i-check"/></svg><span><strong>目前无需你操作</strong><small>PSMetaC 会继续在后台记录任务和检查结果。</small></span></div>';
    dashboardAttentionAction.classList.add("hidden");
  }
  $("#dashboard-running-panel").classList.toggle("hidden", runningJobs.length === 0);
  $("#dashboard-running-jobs").innerHTML =
    runningJobs.length > 0 ? jobRows(runningJobs.slice(0, 2)) : "";
  const recentCompleted = jobs.filter((job) => isTerminalJob(job));
  $("#recent-jobs").innerHTML = jobRows(recentCompleted.slice(0, 5));
  renderJobsView();
  $("#reports-list").innerHTML = jobRows(
    jobs.filter((job) => job.reportHtmlPath),
  );
  renderQuarantineView();

  $("#retention").value = settings.retentionPolicy;
  $("#quarantine-cleanup-enabled").checked =
    settings.quarantineCleanupEnabled;
  $("#quarantine-retention-days").value =
    settings.quarantineRetentionDays;
  $("#quarantine-max-gb").value = Math.round(
    Number(settings.quarantineMaxBytes || 0) / 1024 ** 3,
  );
  $("#quarantine-cleanup-trigger").value =
    settings.quarantineCleanupTrigger;
  $("#stability").value = settings.stabilitySeconds;
  $("#experimental-psd").checked = settings.experimentalPsd;
  $("#experimental-psd-unattended").checked =
    settings.experimentalPsdUnattended;
  $("#experimental-psd-unattended").disabled =
    !settings.experimentalPsd;
  $("#pipeline-preflight").checked = Boolean(settings.pipelinePreflight);
  $("#allowed-input-roots").value = formatRootList(settings.allowedInputRoots);
  $("#allowed-output-roots").value = formatRootList(settings.allowedOutputRoots);
  $("#denied-roots").value = formatRootList(settings.deniedRoots);
  const photoshopSelect = $("#photoshop-executable");
  if (settings.photoshopExecutable) {
    const configuredKey = selectedFileKey(settings.photoshopExecutable);
    if (
      ![...photoshopSelect.options].some(
        (option) => selectedFileKey(option.value) === configuredKey,
      )
    ) {
      photoshopSelect.innerHTML = `<option value="${escapeHtml(
        settings.photoshopExecutable,
      )}">当前设置 · ${escapeHtml(settings.photoshopExecutable)}</option>`;
    }
    photoshopSelect.value = [...photoshopSelect.options].find(
      (option) => selectedFileKey(option.value) === configuredKey,
    )?.value || settings.photoshopExecutable;
    photoshopSelect.disabled = false;
  }
  renderPhotoshopVersionCards(
    lastPhotoshopDiagnosis,
    photoshopSelect.value || settings.photoshopExecutable || "",
  );
  $("#photoshop-connection-mode").value = settings.photoshopProgId
    ? "specified"
    : "auto";
  $("#photoshop-progid").value = settings.photoshopProgId || "";
  updatePhotoshopConnectionUi("photoshop-");
  $("#danger-warning-status").textContent =
    settings.suppressDangerousOperationWarning
      ? "危险操作提醒已关闭。直接保存原文件仍是高风险操作，可在下方恢复提醒。"
      : "直接保存原文件时会显示一次确认，并可选择以后不再提醒。";
  $("#restore-danger-warning").disabled =
    !settings.suppressDangerousOperationWarning;
  $("#settings-json").textContent = JSON.stringify(settings, null, 2);
  const displayedVersion = `v${capabilities?.version || "版本未知"}`;
  $("#about-version").textContent = displayedVersion;
  $("#about-release-version").textContent = displayedVersion;

  const watchers = await api.invoke("list_watchers");
  $("#watcher-list").innerHTML = watcherCards(watchers);
}

function diagnosisModel(result) {
  const items = [];
  let severity = 0;
  const add = (level, title, detail) => {
    items.push({ level, title, detail });
    severity = Math.max(severity, level === "bad" ? 2 : level === "warning" ? 1 : 0);
  };

  const photoshop = result?.photoshop;
  if (!photoshop?.selected) {
    add("warning", "没有找到 Photoshop", "仍可检查文件，但不能自动清理。请确认 Photoshop 2025 已正确安装。");
  } else if (!photoshop.selected.verified) {
    add(
      "warning",
      `Photoshop ${photoshop.selected.productVersion || "版本未知"} 尚未验证`,
      "该版本仍可执行任务；报告会保留版本提示，完成实机样本验证后再列为正式支持。",
    );
  } else {
    add(
      "good",
      `Photoshop ${photoshop.selected.productVersion} 可以使用`,
      "版本已通过当前兼容性验证。",
    );
  }
  if (photoshop?.selected) {
    const bridge = result?.automationBridge;
    if (!photoshop.selected.comRegistered) {
      add(
        "bad",
        "这个 Photoshop 没有可用的自动化注册",
        "安装文件存在，但 Windows 不知道怎样把 PSMetaC 连接到它。任务只允许预检；可尝试用官方安装器修复 Photoshop。",
      );
    } else if (bridge?.reasonCode === "PHOTOSHOP_SELECTED_INSTANCE_BUSY") {
      add(
        "warning",
        "所选 Photoshop 正在使用，连接测试已暂缓",
        bridge.errorDescription,
      );
    } else if (!bridge?.ok) {
      add(
        "bad",
        "Photoshop 自动化桥接未通过",
        bridge?.errorDescription ||
          `原因：${bridge?.reasonCode || "无法确认"}。复制大型工作副本前会阻止执行。`,
      );
    } else {
      add(
        "good",
        "Photoshop 自动化桥接已验证",
        `实际连接 ${bridge.actualVersion || "版本未知"}，COM 标识 ${bridge.progId}；可以执行 JSX。`,
      );
    }
  }

  if (result?.database) {
    if (result.database.integrity === "ok") {
      add("good", "任务记录正常", "本地任务数据库没有发现损坏。");
    } else {
      add("bad", "任务记录可能损坏", "队列不能继续处理，请保留数据目录并查看技术详情。");
    }
  }

  if (result?.storage) {
    const free = result.storage.dataFreeBytes;
    const reserve = result.storage.minimumReserveBytes;
    if (Number.isFinite(free) && Number.isFinite(reserve) && free < reserve) {
      add(
        "bad",
        "软件数据目录空间不足",
        `当前可用 ${formatBytes(free)}，至少需要保留 ${formatBytes(reserve)}。请选择空间更充足的位置。`,
      );
    } else {
      add(
        "good",
        `数据目录可用空间 ${formatBytes(free)}`,
        "基础空间检查通过；具体文件仍会按文件大小、保存方式和备份设置单独估算。",
      );
    }
    if (result.storage.firstOutputRoot) {
      add(
        Number.isFinite(result.storage.outputFreeBytes) ? "good" : "warning",
        "成品目录已检查",
        Number.isFinite(result.storage.outputFreeBytes)
          ? `当前可用 ${formatBytes(result.storage.outputFreeBytes)}。处理单个文件时仍会按文件大小再次计算。`
          : "暂时无法读取成品目录的可用空间。",
      );
    }
  }

  if (result?.queue?.criticalReason) {
    add(
      "bad",
      "队列因安全原因暂停",
      `原因：${REASON_LABELS[result.queue.criticalReason] || result.queue.criticalReason}。请先查看相关任务报告。`,
    );
  }

  for (const warning of result?.warnings || []) {
    if (!items.some((item) => item.detail.includes(warning))) {
      add("warning", "需要留意", warning);
    }
  }

  const tone = severity === 2 ? "bad" : severity === 1 ? "warning" : "good";
  const title =
    severity === 2
      ? "目前不能安全执行清理"
      : severity === 1
        ? "可以检查文件，但部分自动功能不可用"
        : "当前环境可以正常使用";
  const summary =
    severity === 2
      ? "至少一项关键检查未通过。程序会阻止清理，不会冒险处理文件。"
      : severity === 1
        ? "你可以继续做只读检查；需要解决下列提醒后才能无人值守清理。"
        : "Photoshop、任务记录和磁盘空间均通过当前检查。";
  const next =
    severity === 2
      ? "下一步：按红色项目中的说明处理，再点击“重新检查”。"
      : severity === 1
        ? "下一步：可以先选择“只检查”；需要自动清理时再处理黄色提醒。"
        : "下一步：可以创建任务。重要文件第一次仍建议先选择“只检查”。";
  return { tone, title, summary, items, next };
}

function renderPhotoshopChoices(result, selectId, preferredValue = "") {
  const select = $(`#${selectId}`);
  if (!select) return;
  const installations = result?.photoshop?.installations || [];
  const selectedValue =
    preferredValue || result?.photoshop?.selected?.executable || "";
  select.innerHTML = installations.length
    ? installations
        .map(
          (item) =>
            `<option value="${escapeHtml(item.executable)}">Photoshop ${escapeHtml(
              item.productVersion || "版本未知",
            )} · ${item.comRegistered ? "自动化已注册" : "未注册自动化"} · ${escapeHtml(
              item.executable,
            )}</option>`,
        )
        .join("")
    : '<option value="">没有检测到 Photoshop</option>';
  select.disabled = installations.length === 0;
  select.dataset.discovered = "true";
  if (
    selectedValue &&
    installations.some(
      (item) => selectedFileKey(item.executable) === selectedFileKey(selectedValue),
    )
  ) {
    select.value = installations.find(
      (item) => selectedFileKey(item.executable) === selectedFileKey(selectedValue),
    ).executable;
  }
  if (selectId === "photoshop-executable") {
    renderPhotoshopVersionCards(result, select.value || selectedValue);
  }
}

function renderPhotoshopVersionCards(result, selectedValue = "") {
  const container = $("#photoshop-version-cards");
  if (!container) return;
  let installations = result?.photoshop?.installations || [];
  if (!installations.length && selectedValue) {
    installations = [
      {
        executable: selectedValue,
        productVersion: "当前设置",
        verified: false,
        comRegistered: false,
        configuredOnly: true,
      },
    ];
  }
  if (!installations.length) {
    container.innerHTML =
      '<div class="settings-empty">点击“重新读取安装列表”检测这台电脑上的 Photoshop。</div>';
    return;
  }
  container.innerHTML = installations
    .map((item) => {
      const selected =
        selectedFileKey(item.executable) === selectedFileKey(selectedValue);
      const state = item.configuredOnly
        ? "等待检测"
        : item.verified
          ? "已适配"
          : "尚未验证";
      const detail = item.configuredOnly
        ? "已保存的路径，尚未重新检测"
        : item.comRegistered
          ? "自动化已注册"
          : "自动化未注册";
      return `<button class="photoshop-version-card${selected ? " selected" : ""}" type="button" role="radio" aria-checked="${selected}" data-photoshop-executable="${escapeHtml(
        item.executable,
      )}" title="${escapeHtml(item.executable)}"><span class="photoshop-version-icon">Ps</span><span class="photoshop-version-copy"><strong>Photoshop ${escapeHtml(
        item.productVersion || "版本未知",
      )}</strong><span>${escapeHtml(detail)} · ${escapeHtml(
        item.executable,
      )}</span></span><span class="photoshop-version-state${
        item.verified ? "" : " unverified"
      }">${state}</span></button>`;
    })
    .join("");
}

function selectedPhotoshopInstallation(result, selectId) {
  const executable = $(`#${selectId}`)?.value || "";
  return (result?.photoshop?.installations || []).find(
    (item) => selectedFileKey(item.executable) === selectedFileKey(executable),
  );
}

function renderProgIdChoices(result, selectId, inputId, datalistId) {
  const installation = selectedPhotoshopInstallation(result, selectId);
  const options = installation?.comCandidates || [];
  $(`#${datalistId}`).innerHTML = options
    .map((item) => {
      const kind = /^Photoshop\.Application\.\d+$/iu.test(item.progId)
        ? "版本专用接口（推荐）"
        : item.progId === "Photoshop.Application"
          ? "通用接口"
          : "兼容别名接口（实验）";
      return `<option value="${escapeHtml(item.progId)}">${escapeHtml(
        kind,
      )} · ${escapeHtml(item.executable)}</option>`;
    })
    .join("");
  const input = $(`#${inputId}`);
  if (!input.value && options[0]) input.value = options[0].progId;
}

function updatePhotoshopConnectionUi(prefix = "") {
  const specified = $(`#${prefix}connection-mode`).value === "specified";
  const field = $(`#${prefix}progid-field`);
  field.classList.toggle("hidden", !specified);
  const input = $(`#${prefix}progid`);
  input.disabled = !specified;
  if (specified && !input.value && lastPhotoshopDiagnosis) {
    renderProgIdChoices(
      lastPhotoshopDiagnosis,
      prefix === "bootstrap-"
        ? "bootstrap-photoshop"
        : "photoshop-executable",
      `${prefix}progid`,
      `${prefix}progid-options`,
    );
  }
}

function renderConnectionResult(target, bridge) {
  if (!bridge) {
    target.className = "connection-result bad";
    target.innerHTML =
      "<strong>没有可用连接</strong><span>没有检测到能执行无文件 JSX 的 Photoshop 接口。</span>";
    return;
  }
  if (bridge.ok) {
    target.className = "connection-result good";
    target.innerHTML = `<strong>连接成功</strong><span>实际使用 Photoshop ${escapeHtml(
      bridge.actualVersion || "版本未知",
    )} · ${escapeHtml(bridge.actualExecutable || "路径未知")} · ${escapeHtml(
      bridge.progId || "接口未知",
    )}${bridge.method ? ` · ${escapeHtml(bridge.method)}` : ""}。可用于无人值守，任务开始前仍会快速复核。</span>`;
    return;
  }
  const deferred = bridge.reasonCode === "PHOTOSHOP_SELECTED_INSTANCE_BUSY";
  target.className = `connection-result ${deferred ? "warning" : "bad"}`;
  target.innerHTML = `<strong>${deferred ? "暂缓测试" : "连接失败"}</strong><span>${escapeHtml(
    bridge.errorDescription || bridge.reasonCode,
  )}${bridge.progId ? ` · ${escapeHtml(bridge.progId)}` : ""}</span>`;
}

function diagnosticIcon(title) {
  if (/Photoshop/u.test(title)) return "i-screen";
  if (/任务记录|数据库/u.test(title)) return "i-storage";
  if (/目录|空间/u.test(title)) return "i-folder";
  if (/MCP/u.test(title)) return "i-terminal";
  return "i-health";
}

function diagnosticStatus(item) {
  if (item.level === "bad") return "需要处理";
  if (item.level === "warning") return "需要留意";
  if (/桥接|连接/u.test(item.title)) return "已连接";
  if (/任务记录|数据库/u.test(item.title)) return "正常";
  if (/空间/u.test(item.title)) return "空间充足";
  return "可用";
}

function renderDiagnosis(result, target) {
  const model = diagnosisModel(result);
  target.innerHTML = `<section class="diagnostic-summary ${model.tone}"><span class="diagnostic-summary-icon">${
    model.tone === "good" ? "✓" : model.tone === "warning" ? "!" : "×"
  }</span><div><h2>${escapeHtml(model.title)}</h2><p>${escapeHtml(
    model.summary,
  )}</p><strong>${escapeHtml(model.next)}</strong></div></section>
  <div class="diagnostic-section-heading"><h2>检测结果</h2><span>${
    model.items.length
  } 项已检查</span></div>
  <div class="diagnostic-check-list">${model.items
    .map(
      (item) =>
        `<div class="diagnostic-check-row ${item.level}"><span class="diagnostic-check-icon"><svg><use href="#${diagnosticIcon(
          item.title,
        )}"/></svg></span><div class="diagnostic-check-name"><strong>${escapeHtml(
          item.title,
        )}</strong><span>${escapeHtml(
          item.level === "good"
            ? "检查通过"
            : item.level === "warning"
              ? "可以继续只读检查"
              : "会阻止自动清理",
        )}</span></div><p>${escapeHtml(item.detail)}</p><b>${diagnosticStatus(
          item,
        )}</b></div>`,
    )
    .join("")}</div>`;
  target.className = `diagnosis ${model.tone}`;
}

async function runDiagnostics() {
  const button = $("#run-diagnostics");
  button.disabled = true;
  button.textContent = "正在检测…";
  $("#diagnostics-result").className = "diagnosis empty-diagnosis";
  $("#diagnostics-result").textContent =
    "正在检查 Photoshop 自动化连接、任务记录和磁盘空间…";
  try {
    const result = await api.invoke("diagnostics");
    lastPhotoshopDiagnosis = result;
    renderDiagnosis(result, $("#diagnostics-result"));
    renderPhotoshopChoices(
      result,
      "photoshop-executable",
      settings?.photoshopExecutable || "",
    );
    renderProgIdChoices(
      result,
      "photoshop-executable",
      "photoshop-progid",
      "photoshop-progid-options",
    );
    renderConnectionResult(
      $("#photoshop-connection-result"),
      result.automationBridge,
    );
    if (result.automationBridge?.ok) {
      photoshopConnectionTestKey = photoshopConnectionKey(
        result.automationBridge.expectedExecutable,
        settings?.photoshopProgId || "",
      );
    }
    $("#photoshop-selection-status").textContent = result.automationBridge?.ok
      ? `自动化桥接已验证：Photoshop ${result.automationBridge.actualVersion || "版本未知"}`
      : result.automationBridge?.errorDescription ||
        "尚未验证所选 Photoshop 的自动化桥接。";
    $("#diagnostics-technical").textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    $("#diagnostics-result").className = "diagnosis bad";
    $("#diagnostics-result").innerHTML = `<div class="diagnosis-head"><span class="diagnosis-icon">×</span><div><h3>诊断没有完成</h3><p>${escapeHtml(
      friendlyError(error),
    )}</p></div></div><p class="next-action"><strong>下一步：确认没有重复启动程序，然后再试一次。</strong></p>`;
    $("#diagnostics-technical").textContent = String(error?.stack || error);
  } finally {
    button.disabled = false;
    button.textContent = "重新检测";
  }
}

async function refreshPhotoshopInstallations() {
  const button = $("#refresh-photoshop-installations");
  button.disabled = true;
  button.textContent = "正在读取…";
  try {
    const result = await api.invoke("list_photoshop_installations");
    lastPhotoshopDiagnosis = result;
    renderPhotoshopChoices(
      result,
      "photoshop-executable",
      settings?.photoshopExecutable || "",
    );
    renderProgIdChoices(
      result,
      "photoshop-executable",
      "photoshop-progid",
      "photoshop-progid-options",
    );
    const count = result.photoshop?.installations?.length || 0;
    $("#photoshop-selection-status").textContent = count
      ? `发现 ${count} 个 Photoshop 安装；尚未测试自动化连接。`
      : "没有从安装路径和注册表发现 Photoshop。";
    $("#diagnostics-technical").textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    $("#photoshop-selection-status").textContent = friendlyError(error);
  } finally {
    button.disabled = false;
    button.textContent = "重新读取安装列表";
  }
}

async function testCurrentPhotoshopConnection() {
  const button = $("#test-photoshop-connection");
  const resultTarget = $("#photoshop-connection-result");
  const specified =
    $("#photoshop-connection-mode").value === "specified";
  const progId = specified ? $("#photoshop-progid").value.trim() : "";
  if (specified && !progId) {
    throw new Error("请先选择或输入一个 Photoshop 连接接口。");
  }
  button.disabled = true;
  button.textContent = "正在测试…";
  resultTarget.className = "connection-result neutral";
  resultTarget.innerHTML =
    "<strong>正在测试</strong><span>只查询 Photoshop 版本和安装位置，不会打开或保存设计文件。</span>";
  try {
    const result = await api.invoke("test_photoshop_connection", {
      executable: $("#photoshop-executable").value,
      progId: progId || undefined,
    });
    lastPhotoshopDiagnosis = result;
    renderConnectionResult(resultTarget, result.automationBridge);
    if (result.automationBridge?.ok) {
      photoshopConnectionTestKey = photoshopConnectionKey(
        $("#photoshop-executable").value,
        progId,
      );
      $("#photoshop-selection-status").textContent =
        "连接测试已通过；保存后任务会使用该设置，并在执行前再次复核。";
    } else {
      photoshopConnectionTestKey = null;
    }
    $("#diagnostics-technical").textContent = JSON.stringify(
      result,
      null,
      2,
    );
    return result;
  } finally {
    button.disabled = false;
    button.textContent = "测试当前连接";
  }
}

async function exportDiagnosticLogs() {
  const status = $("#diagnostic-export-status");
  const target = await api.chooseDiagnosticExport();
  if (!target) return;
  status.textContent = "正在收集并压缩诊断日志，请稍候…";
  try {
    const result = await api.invoke("export_diagnostic_logs", {
      target,
      jobIds: [],
    });
    status.textContent = `日志包已生成：共收集 ${result.selectedJobCount} 个任务、${result.includedFileCount} 个文件。`;
    await api.revealExport(result.path);
  } catch (error) {
    status.textContent = `导出失败：${friendlyError(error)}`;
  }
}

async function toggleQueue() {
  const state = await api.invoke("queue_status");
  if (state.paused && state.criticalReason) {
    if (
      !window.confirm(
        `队列因为安全原因暂停：${state.criticalReason}\n\n请先确认你已经查看相关任务报告。确定要解除暂停吗？`,
      )
    ) {
      return;
    }
    await api.invoke("acknowledge_critical");
  } else {
    const active = jobs.find((job) => PROCESSING_STATUSES.has(job.status));
    if (
      !state.paused &&
      active &&
      !window.confirm(
        `当前正在处理：${active.sourcePath.split(/[\\/]/u).pop()}\n\n为了确保文件安全，暂停会在当前文件处理并安全保存完成后生效，不会中途强行关闭 Photoshop。\n\n确定要在当前项完成后暂停吗？`,
      )
    ) {
      return;
    }
    await api.invoke(state.paused ? "resume_queue" : "pause_queue");
    if (!state.paused && active) {
      showToast("已申请暂停。当前文件会先安全处理完成，之后不再开始新任务。");
    }
  }
  await refresh();
}

async function stopQueueAfterCurrent() {
  const active = jobs.find((job) => PROCESSING_STATUSES.has(job.status));
  const waitingCount = jobs.filter(
    (job) => CANCELLABLE_STATUSES.has(job.status) && job.id !== active?.id,
  ).length;
  if (
    !window.confirm(
      active
        ? `当前文件会先处理并安全保存完成，然后终止批处理。\n\n不会强行关闭 Photoshop；其余 ${waitingCount} 个尚未开始的任务将被取消。终止后如需再处理，必须重新创建或提交任务。\n\n确定继续吗？`
        : `将终止队列并取消 ${waitingCount} 个尚未开始的任务。确定继续吗？`,
    )
  ) {
    return;
  }
  const result = await api.invoke("stop_queue_after_current");
  showToast(
    result.activeJobIds?.length
      ? `终止请求已记录。当前 ${result.activeJobIds.length} 个文件会先安全完成；已取消 ${result.cancelledJobIds?.length || 0} 个等待任务。`
      : `队列已终止；已取消 ${result.cancelledJobIds?.length || 0} 个等待任务。`,
  );
  await refresh();
}

async function archiveOne(jobId) {
  if (
    !window.confirm(
      "确定从任务列表移除这项记录吗？\n\n成品、问题副本、报告和日志都会保留，不会删除文件。",
    )
  ) {
    return;
  }
  await api.invoke("archive_job", { jobId });
  selectedJobIds.delete(jobId);
  showToast("任务已从列表移除；相关文件、报告和日志仍然保留。");
  await refresh();
}

async function deleteJobData(jobId) {
  if (
    !window.confirm(
      "确定删除这项任务的内部资料吗？\n\n将删除：软件数据目录中的权威报告、该任务详细日志和临时工作区。\n\n不会删除：源文件、成品、问题副本，以及成品/问题副本旁的随附报告。",
    )
  ) {
    return;
  }
  await api.invoke("delete_job_data", { jobId });
  selectedJobIds.delete(jobId);
  showToast("任务资料已删除；源文件、结果文件和随附报告仍然保留。");
  await refresh();
}

function renderTagDialog() {
  const assignedJobs = tagAssignmentJobIds
    .map((id) => jobs.find((job) => job.id === id))
    .filter(Boolean);
  const commonTagIds = new Set(
    availableUserTags
      .filter((tag) =>
        assignedJobs.length > 0 &&
        assignedJobs.every((job) =>
          (job.userTags || []).some((item) => item.id === tag.id),
        ),
      )
      .map((tag) => tag.id),
  );
  $("#tag-assignment").classList.toggle("hidden", assignedJobs.length === 0);
  $("#tag-assignment-context").textContent =
    assignedJobs.length > 1
      ? `将为 ${assignedJobs.length} 个任务设置相同的用户标签。未勾选的用户标签会从这些任务移除。`
      : assignedJobs.length === 1
        ? `正在设置：${assignedJobs[0].sourcePath.split(/[\\/]/u).pop()}`
        : "";
  $("#tag-assignment-options").innerHTML = availableUserTags.length
    ? availableUserTags
        .map(
          (tag) =>
            `<label class="tag-choice" style="--tag-color:${escapeHtml(tag.color)}"><input type="checkbox" data-assign-tag="${escapeHtml(
              tag.id,
            )}" ${commonTagIds.has(tag.id) ? "checked" : ""}><span class="mini-tag">${escapeHtml(
              tag.name,
            )}</span></label>`,
        )
        .join("")
    : '<span class="field-help">还没有用户标签。请先在下方新建一个。</span>';
  $("#user-tag-list").innerHTML = availableUserTags.length
    ? availableUserTags
        .map(
          (tag) => `<div class="user-tag-row" data-user-tag-row="${escapeHtml(tag.id)}">
            <input type="color" value="${escapeHtml(tag.color)}" data-user-tag-color aria-label="标签颜色">
            <input value="${escapeHtml(tag.name)}" maxlength="24" data-user-tag-name aria-label="标签名称">
            <span class="mini-tag" style="--tag-color:${escapeHtml(tag.color)}">${escapeHtml(tag.name)}</span>
            <button type="button" data-save-user-tag="${escapeHtml(tag.id)}">保存修改</button>
            <button type="button" class="danger-quiet" data-delete-user-tag="${escapeHtml(tag.id)}">删除</button>
          </div>`,
        )
        .join("")
    : '<div class="empty-state">还没有自定义标签。</div>';
}

function openTagDialog(jobIds = []) {
  tagAssignmentJobIds = [...new Set(jobIds)];
  $("#tag-dialog-title").textContent = tagAssignmentJobIds.length
    ? "给任务添加标签"
    : "管理我的标签";
  $("#tag-dialog-description").textContent = tagAssignmentJobIds.length
    ? "用户标签只用于查找和整理，不会改变文件处理规则。"
    : "可以新建、改名、换颜色或删除标签。系统状态标签会自动维护，不能手动修改。";
  renderTagDialog();
  $("#tag-overlay").classList.remove("hidden");
}

function closeTagDialog() {
  tagAssignmentJobIds = [];
  $("#tag-overlay").classList.add("hidden");
}

function localFileUrl(target) {
  return encodeURI(`file:///${String(target || "").replaceAll("\\", "/")}`);
}

function reviewCheck(label, passed, detail) {
  const tone = passed === true ? "good" : passed === false ? "warning" : "neutral";
  return `<article class="review-check ${tone}"><span>${
    passed === true ? "✓" : passed === false ? "!" : "—"
  }</span><div><strong>${escapeHtml(label)}</strong><small>${escapeHtml(detail)}</small></div></article>`;
}

function setReviewComparePosition(value) {
  const percent = Math.max(0, Math.min(100, Number(value) || 0));
  const after = $("#review-after-image");
  const divider = $("#review-preview-divider");
  $("#review-compare-range").value = String(percent);
  $("#review-slider-output").textContent = `${Math.round(percent)}%`;
  if (reviewCompareMode === "overlay") {
    after.style.clipPath = "none";
    after.style.opacity = String(percent / 100);
    after.style.mixBlendMode = "normal";
    after.style.filter = "none";
    divider.classList.add("hidden");
    return;
  }
  if (reviewCompareMode === "difference") {
    after.style.clipPath = "none";
    after.style.opacity = "1";
    after.style.mixBlendMode = "difference";
    after.style.filter = `contrast(${1 + (percent / 100) * 4})`;
    divider.classList.add("hidden");
    return;
  }
  after.style.clipPath = `inset(0 ${100 - percent}% 0 0)`;
  after.style.opacity = "1";
  after.style.mixBlendMode = "normal";
  after.style.filter = "none";
  divider.style.left = `${percent}%`;
  divider.classList.remove("hidden");
}

function setReviewCompareMode(mode) {
  reviewCompareMode = ["split", "overlay", "difference"].includes(mode)
    ? mode
    : "split";
  $("#review-preview-stage").dataset.compareMode = reviewCompareMode;
  $$('[data-review-compare-mode]').forEach((button) => {
    const active = button.dataset.reviewCompareMode === reviewCompareMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  $("#review-slider-label").textContent =
    reviewCompareMode === "overlay"
      ? "处理后画面透明度"
      : reviewCompareMode === "difference"
        ? "差异增强强度"
        : "拖动查看处理前后";
  $("#review-compare-help").textContent =
    reviewCompareMode === "overlay"
      ? "调节处理后画面的透明度，用重影检查位置和尺寸变化。"
      : reviewCompareMode === "difference"
        ? "亮处代表视觉差异；这里只辅助人眼查看，不代替报告中的正式像素验收。"
        : "拖动分隔线快速检查构图和大面积变化。";
  setReviewComparePosition($("#review-compare-range").value);
}

function renderReviewDialog() {
  const context = reviewContext || {};
  const job = context.job || {};
  const report = context.report || {};
  const validation = report.validation || {};
  const structure = validation.structure || {};
  const pixel = validation.pixel?.beforeVsAfterReopen || {};
  const output = report.output || {};
  const errors = Array.isArray(validation.errors) ? validation.errors : [];
  const warnings = Array.isArray(validation.warnings) ? validation.warnings : [];
  const review = report.manualReview || null;
  const fileName = String(job.sourcePath || "").split(/[\\/]/u).pop() || "处理结果";
  $("#review-dialog-title").textContent = fileName;
  $("#review-dialog-description").textContent = review
    ? review.status === "accepted_with_warnings"
      ? "你已接受这个结果；自动检查警告仍保留在报告中。"
      : review.status === "discarded"
        ? "你已放弃这次处理结果；原件、报告和操作日志仍然保留。"
        : "你已查看并决定继续隔离；以后仍可再次打开并改为接受。"
    : "请先查看原件和处理结果，再记录你的决定。";
  $("#review-state").className = `review-state ${
    review?.status === "accepted_with_warnings"
      ? "accepted"
      : review?.status === "kept_quarantined"
        ? "kept"
        : review?.status === "discarded"
          ? "discarded"
        : "pending"
  }`;
  $("#review-state").innerHTML = review
    ? `<strong>${
        review.status === "accepted_with_warnings"
          ? "人工接受（有风险）"
          : review.status === "discarded"
            ? "已放弃处理结果"
            : "已复核，继续隔离"
      }</strong><span>${escapeHtml(
        `${review.reviewedBy || "当前用户"} · ${formatTime(review.reviewedAt)}${
          review.note ? ` · ${review.note}` : ""
        }`,
      )}</span>`
    : `<strong>等待你人工复核</strong><span>自动检查发现 ${errors.length} 个失败项、${warnings.length} 个提醒。</span>`;
  $("#review-summary").innerHTML = [
    reviewCheck(
      "源文件未变",
      report.source?.unchanged,
      report.source?.unchanged === true ? "处理只发生在新副本上" : "未能确认源文件指纹",
    ),
    reviewCheck(
      "目标 XMP",
      Number(output.documentAncestorsAfter) === 0,
      `已清理 ${formatBytes(output.xmpRemovedBytes)}；DocumentAncestors 剩余 ${
        output.documentAncestorsAfter ?? "未知"
      }`,
    ),
    reviewCheck(
      "智能对象",
      Number(output.smartObjectFailureCount) === 0,
      `失败 ${output.smartObjectFailureCount ?? "未知"} 项`,
    ),
    reviewCheck(
      "结构检查",
      structure.topologyMatch ?? validation.structureMatch,
      structure.topologyMatch === false
        ? "自动检查发现结构顺序或记录对应关系变化"
        : "结构拓扑与原件一致",
    ),
    reviewCheck(
      "像素完全一致",
      pixel.exact,
      pixel.comparable
        ? `变化 ${Number(pixel.changedPixels || 0).toLocaleString("zh-CN")} 像素，最大 RGB 差值 ${
            pixel.maxRgbDelta ?? pixel.maxChannelDiff ?? "未知"
          }`
        : "没有可比较的像素结果",
    ),
    reviewCheck(
      "处理结果可打开",
      context.resultExists,
      context.resultExists ? "处理副本仍在磁盘上" : "没有找到处理副本",
    ),
  ].join("");
  const before = context.previews?.before;
  const after =
    context.previews?.after_reopen ||
    context.previews?.after_processing ||
    context.previews?.after_save;
  const hasPreviewPair = Boolean(before && after);
  $("#review-preview").classList.toggle("hidden", !hasPreviewPair);
  $("#review-preview-fallback").classList.toggle("hidden", hasPreviewPair);
  if (hasPreviewPair) {
    $("#review-before-image").src = localFileUrl(before);
    $("#review-after-image").src = localFileUrl(after);
    $("#review-compare-range").value = "50";
    setReviewCompareMode("split");
  }
  $("#review-preview-fallback").textContent = hasPreviewPair
    ? ""
    : context.previewRetentionExplanation ||
      "没有取得可视化预览，请分别打开原件和处理结果进行比较。";
  $("#review-paths").innerHTML = `
    <dt>原件</dt><dd>${escapeHtml(job.sourcePath || "未记录")}</dd>
    <dt>处理结果</dt><dd>${escapeHtml(context.resultPath || "未生成")}</dd>
    <dt>自动检查失败项</dt><dd>${escapeHtml(
      errors.map((item) => REASON_LABELS[item] || item).join("；") || "没有",
    )}</dd>
    <dt>提醒</dt><dd>${escapeHtml(
      warnings.map((item) => REASON_LABELS[item] || item).join("；") || "没有",
    )}</dd>`;
  $$("[data-open-review-target]").forEach((button) => {
    if (button.dataset.openReviewTarget === "source") {
      button.disabled = !context.sourceExists;
    } else if (
      button.dataset.openReviewTarget === "result" ||
      button.dataset.openReviewTarget === "result_folder"
    ) {
      button.disabled = !context.resultExists;
    } else {
      button.disabled = !job.reportHtmlPath;
    }
  });
  $("#review-note").value = review?.note || "";
  $("#review-confirm-risk").checked = false;
  const canDecide = job.status === "quarantined" && context.resultExists;
  $("#review-keep").disabled = !canDecide;
  $("#review-accept").disabled = !canDecide;
  $("#review-discard").disabled = !canDecide;
  $("#review-decision-help").textContent = canDecide
    ? "你可以继续隔离、接受为有风险成品，或把本次产生的隔离副本和临时文件移入回收站。任何决定都不会把自动警告改成通过。"
    : review?.status === "accepted_with_warnings"
      ? "这个结果已经发布为人工接受的有风险成品。"
      : review?.status === "discarded"
        ? "本次处理产生的隔离副本和临时文件已移入 Windows 回收站；权威报告和日志仍可查看。"
        : "当前没有可供处置的隔离副本。";
}

async function openReviewDialog(jobId) {
  reviewJobId = jobId;
  reviewContext = await api.invoke("get_review_context", { jobId });
  renderReviewDialog();
  $("#review-overlay").classList.remove("hidden");
}

function closeReviewDialog() {
  reviewJobId = null;
  reviewContext = null;
  $("#review-overlay").classList.add("hidden");
}

async function submitManualReview(decision) {
  if (!reviewJobId || !reviewContext) return;
  if (!$("#review-confirm-risk").checked) {
    showToast("请先实际查看处理结果，并勾选复核确认。", "error");
    return;
  }
  const accepting = decision === "accept_with_warnings";
  const discarding = decision === "discard_result";
  const risks = [
    ...(reviewContext.report?.validation?.errors || []),
    ...(reviewContext.report?.validation?.warnings || []),
  ];
  const confirmed = window.confirm(
    accepting
      ? `确定接受这个处理副本作为“有风险成品”吗？\n\n自动检查仍有：${risks.join(
          "、",
        ) || "未确认项"}\n\n文件会移动到原定成品位置，不会覆盖原件。`
      : discarding
        ? "确定放弃这次处理结果吗？\n\n将移入 Windows 回收站：\n• 处理结果和隔离副本\n• 工作副本\n• 预览图和临时比对文件\n\n始终保留：\n• Photoshop 原件\n• 权威处理报告\n• 操作日志\n• 原件备份（如有）\n\n这不是永久删除，但恢复时需要从 Windows 回收站手动还原。"
        : "确定记录为“已查看，继续隔离”吗？\n\n处理副本会留在隔离区，以后仍可再次复核。",
  );
  if (!confirmed) return;
  await api.invoke("record_manual_review", {
    jobId: reviewJobId,
    decision,
    note: $("#review-note").value,
  });
  closeReviewDialog();
  await refresh();
  showToast(
    accepting
      ? "已记录为“人工接受（有风险）”，自动警告仍保留。"
      : discarding
        ? "已放弃处理结果；派生文件已移入回收站，原件、报告和日志均保留。"
        : "已记录复核结果，处理副本继续保留在隔离区。",
  );
}

let actionMenuCloseTimer = null;

function closeTaskActionMenu() {
  clearTimeout(actionMenuCloseTimer);
  $("#task-action-menu").classList.add("hidden");
  $("#task-action-menu").replaceChildren();
}

function scheduleTaskActionMenuClose() {
  clearTimeout(actionMenuCloseTimer);
  actionMenuCloseTimer = setTimeout(closeTaskActionMenu, 220);
}

function openTaskActionMenu(button) {
  const job = jobs.find((item) => item.id === button.dataset.moreJob);
  if (!job) return;
  clearTimeout(actionMenuCloseTimer);
  const menu = $("#task-action-menu");
  menu.innerHTML = `<button type="button" data-edit-job-tags="${escapeHtml(
    job.id,
  )}" role="menuitem">添加或修改标签</button>${
    canDeleteJobData(job)
      ? `<button type="button" class="danger-menu" data-delete-job-data="${escapeHtml(
          job.id,
        )}" role="menuitem">删除内部任务资料…</button>`
      : ""
  }`;
  menu.classList.remove("hidden");
  const rect = button.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const top =
    rect.bottom + menuRect.height + 8 <= window.innerHeight
      ? rect.bottom + 5
      : rect.top - menuRect.height - 5;
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - menuRect.width - 8, rect.right - menuRect.width))}px`;
  menu.style.top = `${Math.max(8, top)}px`;
}

document.addEventListener("pointerover", (event) => {
  const button = event.target.closest("[data-more-job]");
  if (button) openTaskActionMenu(button);
});
document.addEventListener("pointerout", (event) => {
  if (
    event.target.closest("[data-more-job]") &&
    !event.relatedTarget?.closest?.("#task-action-menu")
  ) {
    scheduleTaskActionMenuClose();
  }
});
$("#task-action-menu").addEventListener("pointerenter", () =>
  clearTimeout(actionMenuCloseTimer),
);
$("#task-action-menu").addEventListener("pointerleave", scheduleTaskActionMenuClose);

document.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.view || button.dataset.go) {
    showView(button.dataset.view || button.dataset.go);
  }
  try {
    if (button.dataset.settingsCategory) {
      setSettingsCategory(button.dataset.settingsCategory);
    }
    if (button.dataset.helpTopic) {
      setHelpTopic(button.dataset.helpTopic);
    }
    if (button.dataset.photoshopExecutable) {
      const select = $("#photoshop-executable");
      select.value = button.dataset.photoshopExecutable;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (button.dataset.jobPool) {
      poolJobSearch[jobPool] = jobSearch;
      jobPool = button.dataset.jobPool;
      jobFilters = poolJobFilters[jobPool];
      jobSearch = poolJobSearch[jobPool];
      $("#job-search").value = jobSearch;
      selectedJobIds.clear();
      jobRenderPage = 0;
      renderJobsView();
    }
    if (button.dataset.jobFilter) {
      if (jobFilters.has(button.dataset.jobFilter)) {
        jobFilters.delete(button.dataset.jobFilter);
      } else {
        jobFilters.add(button.dataset.jobFilter);
      }
      selectedJobIds.clear();
      jobRenderPage = 0;
      renderJobsView();
    }
    if (button.dataset.quarantineFilter) {
      quarantineFilter = button.dataset.quarantineFilter;
      renderQuarantineView();
    }
    if (button.dataset.watcherToggle) {
      await api.invoke("set_watcher_enabled", {
        watcherId: button.dataset.watcherToggle,
        enabled: button.dataset.watcherEnable === "true",
      });
      showToast(
        button.dataset.watcherEnable === "true"
          ? "已恢复自动处理；正在重新扫描这个文件夹。"
          : "已暂停后续扫描；已经创建的任务会照常完成。",
      );
      await refresh();
    }
    if (button.dataset.clearJobFilters) {
      jobFilters.clear();
      selectedJobIds.clear();
      jobRenderPage = 0;
      renderJobsView();
    }
    if (button.dataset.jobPage) {
      jobRenderPage += button.dataset.jobPage === "next" ? 1 : -1;
      jobRenderPage = Math.max(0, jobRenderPage);
      renderJobsView();
    }
    if (button.dataset.pick) await pickInto(button.dataset.pick);
    if (button.dataset.appendRoot) {
      const selected = await api.chooseDirectory(
        button.dataset.appendRoot === "allowed-input-roots"
          ? "source"
          : "output",
      );
      if (selected) {
        const target = $(`#${button.dataset.appendRoot}`);
        target.value = formatRootList([
          ...parseRootList(target.value),
          selected,
        ]);
      }
    }
    if (button.dataset.cancel) {
      await api.invoke("cancel_job", { jobId: button.dataset.cancel });
      showToast("已发送安全取消请求。正在保存时会先完成安全收尾。");
      await refresh();
    }
    if (button.dataset.approve) {
      await api.invoke("approve_job", { jobId: button.dataset.approve });
      showToast("已确认处理，任务会在 Photoshop 空闲时继续。");
      await refresh();
    }
    if (button.dataset.keepInspection) {
      await api.invoke("keep_inspection_result", {
        jobId: button.dataset.keepInspection,
      });
      showToast("已保留检查结果；不会启动 Photoshop，也不会修改源文件。");
      await refresh();
    }
    if (button.dataset.archive) await archiveOne(button.dataset.archive);
    if (button.dataset.deleteJobData) {
      await deleteJobData(button.dataset.deleteJobData);
      closeTaskActionMenu();
    }
    if (button.dataset.editJobTags) {
      openTagDialog([button.dataset.editJobTags]);
      closeTaskActionMenu();
    }
    if (button.dataset.saveUserTag) {
      const row = button.closest("[data-user-tag-row]");
      await api.invoke("update_user_tag", {
        tagId: button.dataset.saveUserTag,
        name: row.querySelector("[data-user-tag-name]").value,
        color: row.querySelector("[data-user-tag-color]").value,
      });
      availableUserTags = await api.invoke("list_user_tags");
      renderTagDialog();
      await refresh();
      showToast("标签修改已保存。");
    }
    if (button.dataset.deleteUserTag) {
      const tag = availableUserTags.find(
        (item) => item.id === button.dataset.deleteUserTag,
      );
      if (
        window.confirm(
          `确定删除标签“${tag?.name || ""}”吗？\n\n只会移除标签，不会删除任务或文件。`,
        )
      ) {
        await api.invoke("delete_user_tag", {
          tagId: button.dataset.deleteUserTag,
        });
        poolJobFilters.active.delete(`user|${button.dataset.deleteUserTag}`);
        poolJobFilters.completed.delete(`user|${button.dataset.deleteUserTag}`);
        availableUserTags = await api.invoke("list_user_tags");
        renderTagDialog();
        await refresh();
      }
    }
    if (button.dataset.moreJob) openTaskActionMenu(button);
    if (button.dataset.reviewJob) {
      await openReviewDialog(button.dataset.reviewJob);
    }
    if (button.dataset.openReviewTarget && reviewJobId) {
      await api.openJobTarget(reviewJobId, button.dataset.openReviewTarget);
    }
    if (button.dataset.openJobTarget) {
      const [jobId, kind] = button.dataset.openJobTarget.split("|");
      await api.openJobTarget(jobId, kind);
    }
    if (button.dataset.open) {
      await api.openPath(decodeURIComponent(button.dataset.open));
    }
  } catch (error) {
    showToast(friendlyError(error), "error");
  }
});

document.addEventListener("change", (event) => {
  const checkbox = event.target.closest("[data-select-job]");
  if (checkbox) {
    if (checkbox.checked) selectedJobIds.add(checkbox.dataset.selectJob);
    else selectedJobIds.delete(checkbox.dataset.selectJob);
    updateSelectionBar();
  }
  if (event.target.id === "select-all-jobs") {
    for (const job of filteredPoolJobs().filter(canArchive)) {
      if (event.target.checked) selectedJobIds.add(job.id);
      else selectedJobIds.delete(job.id);
    }
    renderJobsView();
  }
});

$("#remove-selected-jobs").addEventListener("click", async () => {
  const ids = [...selectedJobIds];
  if (!ids.length) return;
  if (
    !window.confirm(
      `确定从任务列表移除选中的 ${ids.length} 项记录吗？\n\n成品、问题副本、报告和日志都会保留。`,
    )
  ) {
    return;
  }
  const failures = [];
  for (const jobId of ids) {
    try {
      await api.invoke("archive_job", { jobId });
      selectedJobIds.delete(jobId);
    } catch (error) {
      failures.push(friendlyError(error));
    }
  }
  showToast(
    failures.length
      ? `已移除 ${ids.length - failures.length} 项；${failures.length} 项需要先安全取消。`
      : `已从列表移除 ${ids.length} 项；文件、报告和日志仍然保留。`,
    failures.length ? "error" : "normal",
  );
  await refresh();
});

$("#clear-job-selection").addEventListener("click", () => {
  selectedJobIds.clear();
  renderJobsView();
});

$("#job-search").addEventListener("input", (event) => {
  jobSearch = event.target.value;
  poolJobSearch[jobPool] = jobSearch;
  selectedJobIds.clear();
  jobRenderPage = 0;
  renderJobsView();
});

$("#toggle-job-filters").addEventListener("click", () => {
  const panel = $("#job-filter-panel");
  const opening = panel.classList.contains("hidden");
  panel.classList.toggle("hidden", !opening);
  $("#toggle-job-filters").setAttribute("aria-expanded", String(opening));
});

$("#clear-job-filters").addEventListener("click", () => {
  jobFilters.clear();
  selectedJobIds.clear();
  jobRenderPage = 0;
  renderJobsView();
});

for (const selector of ["#history-period", "#history-format", "#history-mode"]) {
  $(selector).addEventListener("change", async () => {
    historyStatistics = await api
      .invoke("history_statistics", historyFilterInput())
      .catch((error) => {
        showToast(friendlyError(error), "error");
        return null;
      });
    renderHistoryStatistics(historyStatistics);
  });
}

$("#manage-user-tags").addEventListener("click", () => openTagDialog());
$("#tag-selected-jobs").addEventListener("click", () =>
  openTagDialog([...selectedJobIds]),
);
$("#close-tag-dialog").addEventListener("click", closeTagDialog);
$("#close-review-dialog").addEventListener("click", closeReviewDialog);
$("#review-keep").addEventListener("click", () =>
  submitManualReview("keep_quarantined"),
);
$("#review-accept").addEventListener("click", () =>
  submitManualReview("accept_with_warnings"),
);
$("#review-discard").addEventListener("click", () =>
  submitManualReview("discard_result"),
);
$("#review-compare-range").addEventListener("input", (event) =>
  setReviewComparePosition(event.target.value),
);
$$('[data-review-compare-mode]').forEach((button) => {
  button.addEventListener("click", () =>
    setReviewCompareMode(button.dataset.reviewCompareMode),
  );
});
function updateReviewCompareFromPointer(event) {
  const stage = $("#review-preview-stage");
  const rect = stage.getBoundingClientRect();
  if (!rect.width) return;
  setReviewComparePosition(((event.clientX - rect.left) / rect.width) * 100);
}
$("#review-preview-stage").addEventListener("pointerdown", (event) => {
  event.currentTarget.setPointerCapture?.(event.pointerId);
  updateReviewCompareFromPointer(event);
});
$("#review-preview-stage").addEventListener("pointermove", (event) => {
  if (event.buttons === 1) updateReviewCompareFromPointer(event);
});
$("#tag-overlay").addEventListener("click", (event) => {
  if (event.target.id === "tag-overlay") closeTagDialog();
});

$("#create-tag-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api.invoke("create_user_tag", {
      name: $("#new-tag-name").value,
      color: $("#new-tag-color").value,
    });
    $("#new-tag-name").value = "";
    availableUserTags = await api.invoke("list_user_tags");
    renderTagDialog();
    showToast("新标签已创建。");
  } catch (error) {
    showToast(friendlyError(error), "error");
  }
});

$("#save-job-tags").addEventListener("click", async () => {
  if (!tagAssignmentJobIds.length) return;
  try {
    const assignmentCount = tagAssignmentJobIds.length;
    const tagIds = $$("[data-assign-tag]:checked").map(
      (input) => input.dataset.assignTag,
    );
    await api.invoke("set_job_user_tags", {
      jobIds: tagAssignmentJobIds,
      tagIds,
    });
    closeTagDialog();
    await refresh();
    showToast(`已更新 ${assignmentCount} 个任务的标签。`);
  } catch (error) {
    showToast(friendlyError(error), "error");
  }
});

$("#pick-files").addEventListener("click", async () => {
  const added = await api.chooseFiles();
  addPendingFiles(added);
  $("#drop-scan-summary").classList.remove("warning");
  $("#drop-scan-summary").textContent = added.length
    ? `已从文件选择器添加；当前清单共 ${selectedFiles.length} 个文件，已全部选中。`
    : "没有添加文件。";
  updateSelectedFileTypeNotice();
});

async function removePendingFiles(filePaths) {
  const removalKeys = new Set(filePaths.map(selectedFileKey));
  if (!removalKeys.size) return;
  const removing = selectedFiles.filter((item) =>
    removalKeys.has(selectedFileKey(item)),
  );
  if (!removing.length) return;
  if (removing.length === 1) {
    await api.removeSelectedFile(removing[0]).catch(() => false);
  } else {
    await api.removeSelectedFiles(removing).catch(() => 0);
  }
  selectedFiles = selectedFiles.filter(
    (item) => !removalKeys.has(selectedFileKey(item)),
  );
  for (const key of removalKeys) selectedPendingFileKeys.delete(key);
  renderSelectedFiles();
  updateSelectedFileTypeNotice();
  $("#task-result").textContent = selectedFiles.length
    ? `已从本次清单移除 ${removing.length} 个文件；磁盘上的原文件没有删除。`
    : "已清空本次清单；磁盘上的原文件没有删除。";
}

$("#selected-files").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-remove-selected-file]");
  if (!button) return;
  await removePendingFiles([button.dataset.removeSelectedFile]);
});

$("#selected-files").addEventListener("change", (event) => {
  const checkbox = event.target.closest("[data-select-pending-file]");
  if (!checkbox) return;
  const key = selectedFileKey(checkbox.dataset.selectPendingFile);
  if (checkbox.checked) selectedPendingFileKeys.add(key);
  else selectedPendingFileKeys.delete(key);
  renderSelectedFiles();
  updateSelectedFileTypeNotice();
});

$("#select-all-pending-files").addEventListener("change", (event) => {
  selectedPendingFileKeys = event.target.checked
    ? new Set(selectedFiles.map(selectedFileKey))
    : new Set();
  renderSelectedFiles();
  updateSelectedFileTypeNotice();
});

$("#clear-pending-selection").addEventListener("click", () => {
  selectedPendingFileKeys.clear();
  renderSelectedFiles();
  updateSelectedFileTypeNotice();
});

$("#remove-selected-files").addEventListener("click", async () => {
  await removePendingFiles(
    selectedFiles.filter((item) =>
      selectedPendingFileKeys.has(selectedFileKey(item)),
    ),
  );
});

let pendingContextPaths = [];

function closePendingFileMenu() {
  $("#pending-file-menu").classList.add("hidden");
  pendingContextPaths = [];
}

function openPendingFileMenu(event, filePath) {
  const key = selectedFileKey(filePath);
  if (!selectedPendingFileKeys.has(key)) {
    selectedPendingFileKeys = new Set([key]);
    renderSelectedFiles();
  }
  pendingContextPaths = selectedFiles.filter((item) =>
    selectedPendingFileKeys.has(selectedFileKey(item)),
  );
  const menu = $("#pending-file-menu");
  $("#remove-pending-menu-item").textContent =
    pendingContextPaths.length > 1
      ? `从待处理清单移除所选 ${pendingContextPaths.length} 项`
      : "从待处理清单移除";
  menu.classList.remove("hidden");
  const menuRect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - menuRect.width - 8, event.clientX))}px`;
  menu.style.top = `${Math.max(8, Math.min(window.innerHeight - menuRect.height - 8, event.clientY))}px`;
}

$("#selected-files").addEventListener("contextmenu", (event) => {
  const row = event.target.closest("[data-pending-file-row]");
  if (!row) return;
  event.preventDefault();
  openPendingFileMenu(event, row.dataset.pendingFileRow);
});

$("#remove-pending-menu-item").addEventListener("click", async () => {
  const removing = [...pendingContextPaths];
  closePendingFileMenu();
  await removePendingFiles(removing);
});

document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest("#pending-file-menu")) closePendingFileMenu();
});

document.addEventListener("keydown", async (event) => {
  if (event.key === "Escape") {
    closePendingFileMenu();
    if (!$("#task-options-drawer").classList.contains("hidden")) {
      setTaskOptionsDrawer(false);
    }
  }
  if (
    event.key !== "Delete" ||
    !$("#view-new-task").classList.contains("active") ||
    event.target.closest("input,textarea,select,button") ||
    !selectedPendingFileKeys.size
  ) {
    return;
  }
  event.preventDefault();
  await removePendingFiles(
    selectedFiles.filter((item) =>
      selectedPendingFileKeys.has(selectedFileKey(item)),
    ),
  );
});

const fileDropZone = $("#file-drop-zone");
fileDropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  fileDropZone.classList.add("drag-active");
});
fileDropZone.addEventListener("dragleave", (event) => {
  if (!fileDropZone.contains(event.relatedTarget)) {
    fileDropZone.classList.remove("drag-active");
  }
});
fileDropZone.addEventListener("drop", async (event) => {
  event.preventDefault();
  fileDropZone.classList.remove("drag-active");
  const droppedFiles = event.dataTransfer?.files;
  if (!droppedFiles?.length) return;
  const summaryElement = $("#drop-scan-summary");
  summaryElement.classList.remove("warning");
  summaryElement.textContent = "正在扫描拖入内容，请稍候…";
  try {
    const droppedPaths = Array.from(droppedFiles, (file) =>
      api.pathForDroppedFile(file),
    );
    const result = await api.addDroppedPaths(droppedPaths);
    const addedCount = addPendingFiles(result.files);
    const summary = result.summary;
    const skipped =
      summary.unsupportedFiles +
      summary.inaccessibleEntries +
      summary.skippedLinks +
      summary.skippedDeniedEntries;
    summaryElement.classList.toggle("warning", skipped > 0);
    summaryElement.textContent = `扫描了 ${summary.scannedDirectories} 个文件夹，找到 ${summary.acceptedFiles} 个 PSD/PSB，新添加 ${addedCount} 个；跳过 ${skipped} 项（非 PSD/PSB ${summary.unsupportedFiles}、无法访问 ${summary.inaccessibleEntries}、链接 ${summary.skippedLinks}、排除目录 ${summary.skippedDeniedEntries}）。新增后的清单已全部选中。`;
    updateSelectedFileTypeNotice();
  } catch (error) {
    summaryElement.classList.add("warning");
    summaryElement.textContent = friendlyError(error);
    showToast(friendlyError(error), "error");
  }
});

function updateExecutionModeUi(prefix = "") {
  const watcher = prefix === "watcher-";
  const execution = $(`#${prefix}execution-mode`).value;
  const inPlace = execution === "in_place";
  $(`#${prefix}backup-source-field`).classList.toggle("hidden", !inPlace);
  $(`#${prefix}in-place-warning`).classList.toggle("hidden", !inPlace);
  $(`#${prefix}validation-options`)?.classList.toggle("hidden", inPlace);
  $(`#${prefix}output-mode-field`).classList.toggle("hidden", inPlace);
  $(`#${prefix}output-picker`).classList.toggle(
    "hidden",
    inPlace || $(`#${prefix}output-mode`).value === "source_subfolder",
  );
  if (!watcher && inPlace && $("#run-mode").value === "inspect_only") {
    $("#task-result").textContent =
      "“只检查”不会覆盖原文件；只有检查后实际执行时才使用直接保存模式。";
  }
  if (!watcher) {
    $("#content-cleanup-options").classList.toggle("is-disabled", inPlace);
    for (const input of [$("#delete-hidden-layers"), $("#delete-empty-layers")]) {
      input.disabled = inPlace;
      if (inPlace) input.checked = false;
    }
    updateContentCleanupUi(false);
  }
}

function updateContentCleanupUi(markCustom = true) {
  const enabled =
    $("#delete-hidden-layers").checked || $("#delete-empty-layers").checked;
  if (enabled && $("#execution-mode").value === "in_place") {
    $("#execution-mode").value = "safe_copy";
    updateExecutionModeUi();
  }
  $("#content-cleanup-warning").classList.toggle("hidden", !enabled);
  const structureCheck = $('[data-validation="task"][value="structure_topology"]');
  if (structureCheck) {
    if (enabled) structureCheck.checked = false;
    structureCheck.disabled = enabled;
    structureCheck.closest("label")?.classList.toggle("is-disabled", enabled);
  }
  updateTaskProfileSummary(markCustom);
}

$("#execution-mode").addEventListener("change", () => {
  updateExecutionModeUi();
  updateTaskProfileSummary(true);
});
$("#output-mode").addEventListener("change", () => {
  updateExecutionModeUi();
  updateTaskProfileSummary(true);
});
$("#profile").addEventListener("change", () => updateTaskProfileSummary(true));
$("#run-mode").addEventListener("change", () => updateTaskProfileSummary(true));
$("#backup-source").addEventListener("change", () => updateTaskProfileSummary(true));
$("#delete-hidden-layers").addEventListener("change", () =>
  updateContentCleanupUi(true),
);
$("#delete-empty-layers").addEventListener("change", () =>
  updateContentCleanupUi(true),
);
$$('[data-validation="task"]').forEach((checkbox) =>
  checkbox.addEventListener("change", () => updateTaskProfileSummary(true)),
);
$("#task-preset").addEventListener("change", (event) => {
  if (event.target.value === "custom") {
    localStorage.setItem("psmetac.taskPreset", "custom");
    updateTaskProfileSummary(false);
    return;
  }
  applyTaskPreset(event.target.value);
});
$("#open-task-options").addEventListener("click", () => setTaskOptionsDrawer(true));
$("#close-task-options").addEventListener("click", () => setTaskOptionsDrawer(false));
$("#apply-task-options").addEventListener("click", () => setTaskOptionsDrawer(false));
$("#task-options-backdrop").addEventListener("click", () => setTaskOptionsDrawer(false));
$("#watcher-execution-mode").addEventListener("change", () =>
  updateExecutionModeUi("watcher-"),
);
$("#watcher-output-mode").addEventListener("change", () =>
  {
    updateExecutionModeUi("watcher-");
    void previewWatcher();
  },
);
$("#watcher-recursive").addEventListener("change", () => void previewWatcher());
$("#watcher-execution-mode").addEventListener("change", () =>
  void previewWatcher(),
);
$("#task-coverage-policy").addEventListener("change", (event) => {
  $("#task-coverage-threshold-field").classList.toggle(
    "hidden",
    event.target.value !== "threshold",
  );
  updateTaskProfileSummary(true);
});
$("#watcher-coverage-policy").addEventListener("change", (event) => {
  $("#watcher-coverage-threshold-field").classList.toggle(
    "hidden",
    event.target.value !== "threshold",
  );
});

$("#task-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const filesToSubmit = selectedFilesForTask();
  if (!filesToSubmit.length) {
    $("#task-result").textContent = "请至少勾选一个要处理的 PSD 或 PSB 文件。";
    return;
  }
  try {
    const hasPsd = filesToSubmit.some((item) =>
      item.toLowerCase().endsWith(".psd"),
    );
    if (hasPsd && !settings?.experimentalPsd) {
      throw new Error("请先进入“设置 → 文件类型”开启 PSD 实验功能。");
    }
    if (
      hasPsd &&
      $("#run-mode").value === "auto_if_eligible" &&
      !settings?.experimentalPsdUnattended
    ) {
      throw new Error(
        "尚未开启 PSD 无人值守。请在“设置 → 文件类型”开启，或选择“只检查/检查后等我确认”。",
      );
    }
    const executionMode = $("#execution-mode").value;
    const backupSource = $("#backup-source").checked;
    const taskInputs = filesToSubmit.map((sourcePath, index) => ({
      sourcePath,
      profile: $("#profile").value,
      runMode: $("#run-mode").value,
      executionMode,
      backupSource,
      deleteHiddenLayers: $("#delete-hidden-layers").checked,
      deleteEmptyLayers: $("#delete-empty-layers").checked,
      coveragePolicy: $("#task-coverage-policy").value,
      coverageThresholdPercent: Number(
        $("#task-coverage-threshold").value || 5,
      ),
      requiredValidationChecks: selectedValidationChecks("task"),
      outputMode: $("#output-mode").value,
      outputDir:
        executionMode === "safe_copy" &&
        $("#output-mode").value === "specified_directory"
          ? $("#task-output").value
          : undefined,
      clientRequestId: `ui:${Date.now()}:${index}`,
      source: "ui",
    }));
    const capacity = await api.invoke("preview_batch_capacity", {
      jobs: taskInputs,
    });
    renderBatchCapacity(capacity);
    if (!capacity.eligible) {
      $("#task-result").textContent =
        "这批任务不会只创建一半：请根据上方提示释放空间或更换成品目录。";
      return;
    }
    if (
      executionMode === "in_place" &&
      $("#run-mode").value !== "inspect_only" &&
      !(await confirmDanger(
        `你将为 ${filesToSubmit.length} 个文件创建“直接保存原文件”任务。\n\n文件会由 Photoshop 直接覆盖，且不进行保存后重新打开、结构或像素校对。${backupSource ? "\n\n已选择：保存前备份原文件。" : "\n\n警告：没有备份，执行后无法靠 PSMetaC 恢复原文件。"}`,
      ))
    ) {
      return;
    }
    const result = await api.invoke("submit_jobs", {
      jobs: taskInputs,
    });
    $("#task-result").textContent = `已创建 ${result.length} 个独立任务。`;
    const submittedKeys = new Set(filesToSubmit.map(selectedFileKey));
    selectedFiles = selectedFiles.filter(
      (filePath) => !submittedKeys.has(selectedFileKey(filePath)),
    );
    selectedPendingFileKeys.clear();
    renderSelectedFiles();
    await refresh();
  } catch (error) {
    $("#task-result").textContent = friendlyError(error);
  }
});

$("#watcher-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const executionMode = $("#watcher-execution-mode").value;
    const backupSource = $("#watcher-backup-source").checked;
    if (
      executionMode === "in_place" &&
      !(await confirmDanger(
        `这会开启无人值守的“直接保存原文件”。符合条件的文件将由 Photoshop 直接覆盖，并跳过保存后校对。${backupSource ? "\n\n已选择：保存前备份原文件。" : "\n\n警告：没有备份，无法靠 PSMetaC 恢复原文件。"}`,
      ))
    ) {
      return;
    }
    const preview = await previewWatcher();
    if (!preview) return;
    await api.invoke("add_watcher", {
      path: $("#watcher-path").value,
      profile: $("#watcher-profile").value,
      runMode: "auto_if_eligible",
      executionMode,
      backupSource,
      coveragePolicy: $("#watcher-coverage-policy").value,
      coverageThresholdPercent: Number(
        $("#watcher-coverage-threshold").value || 5,
      ),
      requiredValidationChecks: selectedValidationChecks("watcher"),
      recursive: $("#watcher-recursive").checked,
      outputMode: $("#watcher-output-mode").value,
      outputDir:
        executionMode === "safe_copy" &&
        $("#watcher-output-mode").value === "specified_directory"
          ? $("#watcher-output").value
          : undefined,
      enabled: true,
    });
    $("#watcher-result").textContent = "已经开始监控这个文件夹。";
    $("#watcher-editor").classList.add("hidden");
    await refresh();
  } catch (error) {
    $("#watcher-result").textContent = friendlyError(error);
  }
});

$("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const specifiedPhotoshopConnection =
      $("#photoshop-connection-mode").value === "specified";
    const photoshopProgId = specifiedPhotoshopConnection
      ? $("#photoshop-progid").value.trim()
      : "";
    if (specifiedPhotoshopConnection && !photoshopProgId) {
      throw new Error("请先选择或输入 Photoshop 连接接口。");
    }
    const connectionChanged =
      selectedFileKey($("#photoshop-executable").value) !==
        selectedFileKey(settings?.photoshopExecutable || "") ||
      photoshopProgId.toLowerCase() !==
        String(settings?.photoshopProgId || "").toLowerCase();
    if (
      specifiedPhotoshopConnection &&
      connectionChanged &&
      photoshopConnectionTestKey !==
        photoshopConnectionKey(
          $("#photoshop-executable").value,
          photoshopProgId,
        )
    ) {
      throw new Error("指定连接方式发生变化，请先点击“测试当前连接”。");
    }
    await api.invoke("update_settings", {
      retentionPolicy: $("#retention").value,
      quarantineCleanupEnabled:
        $("#quarantine-cleanup-enabled").checked,
      quarantineRetentionDays: Number(
        $("#quarantine-retention-days").value,
      ),
      quarantineMaxBytes: Math.round(
        Number($("#quarantine-max-gb").value) * 1024 ** 3,
      ),
      quarantineCleanupTrigger:
        $("#quarantine-cleanup-trigger").value,
      stabilitySeconds: Number($("#stability").value),
      experimentalPsd: $("#experimental-psd").checked,
      experimentalPsdUnattended:
        $("#experimental-psd").checked &&
        $("#experimental-psd-unattended").checked,
      photoshopExecutable:
        $("#photoshop-executable").value || undefined,
      photoshopProgId: photoshopProgId || undefined,
      pipelinePreflight: $("#pipeline-preflight").checked,
      allowedInputRoots: parseRootList($("#allowed-input-roots").value),
      allowedOutputRoots: parseRootList($("#allowed-output-roots").value),
      deniedRoots: parseRootList($("#denied-roots").value),
    });
    $("#settings-result").textContent = "设置已保存。";
    await refresh();
  } catch (error) {
    $("#settings-result").textContent = friendlyError(error);
  }
});

$("#experimental-psd").addEventListener("change", () => {
  const unattended = $("#experimental-psd-unattended");
  unattended.disabled = !$("#experimental-psd").checked;
  if (unattended.disabled) unattended.checked = false;
});

function renderQuarantineCleanupPreview(result) {
  quarantineCleanupPreview = result;
  $("#quarantine-cleanup-summary").textContent =
    `隔离区共 ${result.totalDirectories} 项、${formatBytes(result.totalBytes)}；` +
    `当前条件命中 ${result.candidates.length} 项、${formatBytes(result.candidateBytes)}`;
  const parts = [
    `预计清理后剩余 ${formatBytes(result.projectedBytes)}`,
    `${result.lockedDirectories} 项已锁定`,
  ];
  if (result.scanErrors?.length) {
    parts.push(`${result.scanErrors.length} 项无法读取，将跳过`);
  }
  $("#quarantine-cleanup-detail").textContent = parts.join("；");
  $("#clean-quarantine-now").disabled = result.candidates.length === 0;
  renderQuarantineView();
}

async function refreshQuarantineOverview() {
  try {
    const result = await api.invoke("preview_quarantine_cleanup");
    renderQuarantineCleanupPreview(result);
  } catch (error) {
    $("#quarantine-summary").innerHTML = `<strong>无法读取隔离区</strong><span>${escapeHtml(
      friendlyError(error),
    )}</span>`;
  }
}

async function previewQuarantineCleanup() {
  $("#quarantine-cleanup-summary").textContent = "正在读取隔离区…";
  const result = await api.invoke("preview_quarantine_cleanup");
  renderQuarantineCleanupPreview(result);
  return result;
}

$("#preview-quarantine-cleanup").addEventListener("click", async () => {
  try {
    await previewQuarantineCleanup();
  } catch (error) {
    $("#quarantine-cleanup-summary").textContent = friendlyError(error);
  }
});

async function runQuarantineCleanupNow() {
  try {
    const preview = await previewQuarantineCleanup();
    if (!preview.candidates.length) {
      showToast("当前没有达到清理条件且未锁定的隔离文件。");
      return;
    }
    const sample = preview.candidates
      .slice(0, 5)
      .map((item) => `• ${item.jobId}（${formatBytes(item.bytes)}）`)
      .join("\n");
    const extra = Math.max(0, preview.candidates.length - 5);
    const confirmed = await confirmDanger(
      `准备把 ${preview.candidates.length} 个隔离目录（${formatBytes(
        preview.candidateBytes,
      )}）移入 Windows 回收站。\n\n${sample}${
        extra ? `\n• 另有 ${extra} 项` : ""
      }\n\n源文件、成品、备份、报告和日志不会删除。确定立即清理吗？`,
      { alwaysConfirm: true, allowNeverRemind: false },
    );
    if (!confirmed) return;
    const result = await api.invoke("clean_quarantine_now", {
      confirmedDirectories: preview.candidates.map((item) => item.directory),
    });
    showToast(
      `已把 ${result.recycled.length} 项、${formatBytes(
        result.recycledBytes,
      )} 移入回收站${
        result.failures.length ? `；${result.failures.length} 项失败` : ""
      }。`,
      result.failures.length ? "error" : "info",
    );
    await previewQuarantineCleanup();
    await refresh();
  } catch (error) {
    showToast(friendlyError(error), "error");
  }
}

$("#clean-quarantine-now").addEventListener(
  "click",
  runQuarantineCleanupNow,
);
$("#quarantine-clean-now").addEventListener(
  "click",
  runQuarantineCleanupNow,
);

$("#export-settings").addEventListener("click", async () => {
  const target = await api.chooseSettingsExport();
  if (!target) return;
  try {
    const written = await api.invoke("export_settings", { target });
    $("#settings-result").textContent = `设置已导出：${written}`;
  } catch (error) {
    $("#settings-result").textContent = friendlyError(error);
  }
});

$("#import-settings").addEventListener("click", async () => {
  const source = await api.chooseSettingsImport();
  if (!source) return;
  try {
    const result = await api.invoke("import_settings", { source });
    $("#settings-result").textContent =
      `已导入 ${result.importedSettings.length} 项设置和 ${result.importedWatchers} 个自动处理文件夹。`;
    await refresh();
  } catch (error) {
    $("#settings-result").textContent = friendlyError(error);
  }
});

$("#queue-toggle").addEventListener("click", toggleQueue);
$("#sidebar-queue-toggle").addEventListener("click", toggleQueue);
$("#queue-stop").addEventListener("click", stopQueueAfterCurrent);
$("#sidebar-queue-stop").addEventListener("click", stopQueueAfterCurrent);
$("#global-task-toggle").addEventListener("click", toggleQueue);
$("#global-task-stop").addEventListener("click", stopQueueAfterCurrent);
$("#global-task-primary").addEventListener("click", async (event) => {
  const action = event.currentTarget.dataset.dockAction;
  if (action === "resume") {
    await toggleQueue();
    return;
  }
  showView(action === "review" ? "quarantine" : action === "diagnostics" ? "diagnostics" : "new-task");
});
$("#global-task-open").addEventListener("click", () => showView("jobs"));
$("#sidebar-toggle").addEventListener("click", () => {
  const shell = document.querySelector(".app-shell");
  const collapsed = shell.classList.toggle("sidebar-collapsed");
  localStorage.setItem("psmetac.sidebarCollapsed", String(collapsed));
  $("#sidebar-toggle").setAttribute(
    "aria-label",
    collapsed ? "展开导航" : "收起导航",
  );
  $("#sidebar-toggle").title = collapsed ? "展开导航" : "收起导航";
});
$$('[data-theme-choice]').forEach((button) => {
  button.addEventListener("click", () => applyTheme(button.dataset.themeChoice));
});

function updateWindowState(state = {}) {
  const button = $("#window-maximize");
  const maximized = Boolean(state.maximized);
  button.title = maximized ? "还原" : "最大化";
  button.setAttribute("aria-label", maximized ? "还原" : "最大化");
  button
    .querySelector("use")
    .setAttribute("href", maximized ? "#i-restore" : "#i-maximize");
  document.body.classList.toggle("window-maximized", maximized);
}

$$('[data-window-action]').forEach((button) => {
  button.addEventListener("click", async () => {
    const state = await api.windowControl(button.dataset.windowAction);
    if (button.dataset.windowAction === "toggle-maximize") {
      updateWindowState(state);
    }
  });
});

api.onWindowState(updateWindowState);
void api.windowControl("state").then(updateWindowState);
$("#refresh-jobs").addEventListener("click", refresh);
$("#run-diagnostics").addEventListener("click", runDiagnostics);
$("#refresh-photoshop-installations").addEventListener(
  "click",
  refreshPhotoshopInstallations,
);
$("#test-photoshop-connection").addEventListener("click", async () => {
  try {
    await testCurrentPhotoshopConnection();
  } catch (error) {
    photoshopConnectionTestKey = null;
    renderConnectionResult($("#photoshop-connection-result"), {
      ok: false,
      reasonCode: "CONNECTION_TEST_FAILED",
      errorDescription: friendlyError(error),
      progId: $("#photoshop-progid").value.trim() || null,
    });
  }
});
$("#photoshop-executable").addEventListener("change", () => {
  photoshopConnectionTestKey = null;
  renderPhotoshopVersionCards(
    lastPhotoshopDiagnosis,
    $("#photoshop-executable").value,
  );
  $("#photoshop-progid").value = "";
  renderProgIdChoices(
    lastPhotoshopDiagnosis,
    "photoshop-executable",
    "photoshop-progid",
    "photoshop-progid-options",
  );
  $("#photoshop-selection-status").textContent =
    "请先保存设置，再重新检测；PSMetaC 会核对 COM/JSX 实际连接到的版本。";
});
$("#photoshop-connection-mode").addEventListener("change", () => {
  photoshopConnectionTestKey = null;
  updatePhotoshopConnectionUi("photoshop-");
});
$("#photoshop-progid").addEventListener("input", () => {
  photoshopConnectionTestKey = null;
  $("#photoshop-connection-result").className =
    "connection-result neutral";
  $("#photoshop-connection-result").innerHTML =
    "<strong>连接已更改</strong><span>请重新测试后再保存。</span>";
});
$("#export-diagnostic-logs").addEventListener(
  "click",
  exportDiagnosticLogs,
);
$("#open-watcher-editor").addEventListener("click", () => {
  $("#watcher-editor").classList.remove("hidden");
  $("#watcher-path").focus();
});
$("#close-watcher-editor").addEventListener("click", () => {
  $("#watcher-editor").classList.add("hidden");
});
$("#open-quarantine-settings").addEventListener("click", () => {
  setSettingsCategory("storage");
  showView("settings");
  requestAnimationFrame(() => $("#quarantine-cleanup-enabled").focus());
});
$("#open-diagnostics-from-settings").addEventListener("click", () => {
  showView("diagnostics");
});
$("#copy-version-info").addEventListener("click", async () => {
  const version = capabilities?.version || "版本未知";
  const text = `PaceSpace Metadata Cleaner (PSMetaC)\n版本：${version}\n机器编号：${capabilities?.machineId || "未知"}`;
  try {
    await navigator.clipboard.writeText(text);
    showToast("版本信息已复制。");
  } catch {
    showToast(`当前版本：${version}`);
  }
});
$("#show-release-details").addEventListener("click", () => {
  $("#about-release").scrollIntoView({ behavior: "smooth", block: "start" });
});
$("#scan-watchers-now").addEventListener("click", async () => {
  try {
    $("#watcher-result").textContent = "正在重新扫描所有自动处理文件夹…";
    await api.invoke("scan_watchers");
    $("#watcher-result").textContent =
      "扫描完成。新文件会先等待稳定，再按顺序创建任务。";
    await refresh();
  } catch (error) {
    $("#watcher-result").textContent = friendlyError(error);
  }
});
$("#restore-danger-warning").addEventListener("click", async () => {
  try {
    await api.invoke("update_settings", {
      suppressDangerousOperationWarning: false,
    });
    await refresh();
    showToast("危险操作提醒已恢复。");
  } catch (error) {
    showToast(friendlyError(error), "error");
  }
});
$("#clear-recent-directories").addEventListener("click", async () => {
  try {
    await api.invoke("update_settings", { recentDirectories: {} });
    await refresh();
    showToast("最近使用目录已清除；下次会从允许目录或桌面开始。");
  } catch (error) {
    showToast(friendlyError(error), "error");
  }
});
$("#danger-cancel").addEventListener("click", () =>
  settleDangerDialog(false),
);
$("#danger-overlay").addEventListener("click", (event) => {
  if (event.target.id === "danger-overlay") settleDangerDialog(false);
});
$("#danger-confirm").addEventListener("click", async () => {
  if ($("#danger-never-remind").checked) {
    try {
      await api.invoke("update_settings", {
        suppressDangerousOperationWarning: true,
      });
      settings = {
        ...settings,
        suppressDangerousOperationWarning: true,
      };
    } catch (error) {
      showToast(
        `任务仍可继续，但“以后不再提醒”没有保存：${friendlyError(error)}`,
        "error",
      );
    }
  }
  settleDangerDialog(true);
});

async function inspectBootstrap() {
  $("#bootstrap-diagnostics").className = "diagnosis empty-diagnosis";
  $("#bootstrap-diagnostics").textContent = "正在检查 Photoshop 和磁盘空间…";
  try {
    const specified =
      $("#bootstrap-connection-mode").value === "specified";
    const progId = specified ? $("#bootstrap-progid").value.trim() : "";
    if (specified && !progId) {
      throw new Error("请先选择或输入 Photoshop 连接接口。");
    }
    const result = await api.inspectBootstrap({
      dataRoot: $("#data-root").value,
      allowedInputRoots: parseRootList($("#input-root").value),
      allowedOutputRoots: parseRootList($("#output-root").value),
      photoshopExecutable: $("#bootstrap-photoshop").value || undefined,
      photoshopProgId: progId || undefined,
    });
    lastPhotoshopDiagnosis = result;
    renderDiagnosis(result, $("#bootstrap-diagnostics"));
    renderPhotoshopChoices(
      result,
      "bootstrap-photoshop",
      $("#bootstrap-photoshop").value,
    );
    renderProgIdChoices(
      result,
      "bootstrap-photoshop",
      "bootstrap-progid",
      "bootstrap-progid-options",
    );
    if (result.automationBridge?.ok) {
      bootstrapConnectionTestKey = photoshopConnectionKey(
        $("#bootstrap-photoshop").value,
        progId,
      );
    } else {
      bootstrapConnectionTestKey = null;
    }
    $("#bootstrap-technical").textContent = JSON.stringify(result, null, 2);
    $("#bootstrap-technical-wrap").classList.remove("hidden");
    return result;
  } catch (error) {
    $("#bootstrap-diagnostics").className = "diagnosis bad";
    $("#bootstrap-diagnostics").innerHTML =
      `<div class="diagnosis-head"><span class="diagnosis-icon">×</span><div><h3>检查没有完成</h3><p>${escapeHtml(
        friendlyError(error),
      )}</p></div></div>`;
    throw error;
  }
}

$("#inspect-bootstrap").addEventListener("click", () => {
  void inspectBootstrap().catch(() => {});
});

$("#bootstrap-connection-mode").addEventListener("change", () => {
  bootstrapConnectionTestKey = null;
  updatePhotoshopConnectionUi("bootstrap-");
});
$("#bootstrap-progid").addEventListener("input", () => {
  bootstrapConnectionTestKey = null;
});
$("#bootstrap-photoshop").addEventListener("change", () => {
  bootstrapConnectionTestKey = null;
  $("#bootstrap-progid").value = "";
  renderProgIdChoices(
    lastPhotoshopDiagnosis,
    "bootstrap-photoshop",
    "bootstrap-progid",
    "bootstrap-progid-options",
  );
});

$("#onboarding-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const inspected = await inspectBootstrap();
    const specified =
      $("#bootstrap-connection-mode").value === "specified";
    const progId = specified ? $("#bootstrap-progid").value.trim() : "";
    if (
      specified &&
      (!inspected.automationBridge?.ok ||
        bootstrapConnectionTestKey !==
          photoshopConnectionKey(
            $("#bootstrap-photoshop").value,
            progId,
          ))
    ) {
      throw new Error("指定的 Photoshop 连接没有通过测试，不能保存。");
    }
    await api.initialize({
      dataRoot: $("#data-root").value,
      allowedInputRoots: parseRootList($("#input-root").value),
      allowedOutputRoots: parseRootList($("#output-root").value),
      photoshopExecutable: $("#bootstrap-photoshop").value || undefined,
      photoshopProgId: progId || undefined,
    });
    $("#onboarding").classList.add("hidden");
    await refresh();
  } catch (error) {
    $("#onboarding-error").textContent = friendlyError(error);
  }
});

api.onJobChanged(() => void refresh());
api.onNavigate((view) => showView(view));
setInterval(() => {
  const byId = new Map(jobs.map((job) => [job.id, job]));
  $$("[data-job-duration]").forEach((element) => {
    const job = byId.get(element.dataset.jobDuration);
    if (job) element.textContent = durationText(job);
  });
}, 1000);

(async () => {
  applyTheme(localStorage.getItem("psmetac.theme") || "system");
  if (localStorage.getItem("psmetac.sidebarCollapsed") === "true") {
    document.querySelector(".app-shell").classList.add("sidebar-collapsed");
    $("#sidebar-toggle").setAttribute("aria-label", "展开导航");
    $("#sidebar-toggle").title = "展开导航";
  }
  const rememberedTaskPreset = localStorage.getItem("psmetac.taskPreset") || "safe-standard";
  if (TASK_PRESETS[rememberedTaskPreset]) {
    applyTaskPreset(rememberedTaskPreset, { remember: false });
  } else {
    $("#task-preset").value = "custom";
    updateExecutionModeUi();
    updateTaskProfileSummary(false);
  }
  updateExecutionModeUi("watcher-");
  updatePhotoshopConnectionUi("bootstrap-");
  updatePhotoshopConnectionUi("photoshop-");
  const bootstrap = await api.bootstrapStatus();
  $("#onboarding").classList.toggle("hidden", bootstrap.initialized);
  if (bootstrap.initialized) await refresh();
})();
