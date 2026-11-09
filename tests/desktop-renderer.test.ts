import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("desktop renderer references existing elements and keeps navigation fixed", async () => {
  const [html, script, styles, foundation] = await Promise.all([
    fs.readFile("src/desktop/renderer/index.html", "utf8"),
    fs.readFile("src/desktop/renderer/app.js", "utf8"),
    fs.readFile("src/desktop/renderer/styles.css", "utf8"),
    fs.readFile("src/desktop/renderer/ui-foundation.css", "utf8"),
  ]);
  const ids = new Set(
    [...html.matchAll(/\bid="([^"]+)"/gu), ...script.matchAll(/\bid="([^"]+)"/gu)]
      .map((match) => match[1]),
  );
  const htmlIds = [...html.matchAll(/\bid="([^"]+)"/gu)].map(
    (match) => match[1],
  );
  const duplicateHtmlIds = htmlIds.filter(
    (id, index) => htmlIds.indexOf(id) !== index,
  );
  assert.deepEqual([...new Set(duplicateHtmlIds)], []);
  const referencedIds = [
    ...script.matchAll(/\$\("#([^"]+)"\)/gu),
  ].map((match) => match[1]);
  const missing = [...new Set(referencedIds.filter((id) => !ids.has(id)))];
  assert.deepEqual(missing, []);
  assert.match(styles, /html,body\{height:100%;overflow:hidden\}/u);
  assert.match(styles, /\.side-nav\{[^}]*overflow:auto/u);
  assert.match(styles, /\.side-nav::-webkit-scrollbar\{display:none\}/u);
  assert.match(styles, /\.view-scroll\{[^}]*overflow:auto/u);
  assert.match(styles, /\.wizard\{[^}]*max-height:[^}]*overflow:auto/u);
  assert.match(html, /PaceSpace Metadata Cleaner（PSMetaC）/u);
  assert.match(html, /元数据清理”不等于完全匿名/u);
  assert.match(html, /id="execution-mode"/u);
  assert.match(html, /id="watcher-execution-mode"/u);
  assert.match(html, /id="validation-options"/u);
  assert.match(html, /data-validation="task"/u);
  assert.match(html, /id="watcher-recursive"/u);
  assert.match(html, /id="watcher-preview"/u);
  assert.match(html, /id="open-watcher-editor"/u);
  assert.match(html, /id="watcher-editor"/u);
  assert.match(html, /发现文件/u);
  assert.match(html, /等待稳定/u);
  assert.match(html, /id="quarantine-clean-now"/u);
  assert.match(html, /data-quarantine-filter="pending"/u);
  assert.match(html, /data-settings-category="photoshop"/u);
  assert.match(html, /data-settings-category="storage"/u);
  assert.match(html, /id="photoshop-version-cards"/u);
  assert.match(html, /data-view-actions="settings"/u);
  assert.match(html, /data-view-actions="diagnostics"/u);
  assert.match(html, /diagnostics-panel/u);
  assert.match(html, /data-help-topic="intro"/u);
  assert.match(html, /data-help-topic="faq"/u);
  assert.match(html, /id="view-about"/u);
  assert.match(html, /id="about-version"/u);
  assert.match(html, /data-view-actions="about"/u);
  assert.match(html, /id="pipeline-preflight"/u);
  assert.match(html, /id="bootstrap-photoshop"/u);
  assert.match(html, /id="bootstrap-connection-mode"/u);
  assert.match(html, /id="photoshop-connection-mode"/u);
  assert.match(html, /id="test-photoshop-connection"/u);
  assert.match(html, /id="photoshop-executable"/u);
  assert.match(html, /id="experimental-psd-unattended"/u);
  assert.match(html, /id="clean-quarantine-now"/u);
  assert.match(html, /id="file-drop-zone"/u);
  assert.match(html, /id="select-all-pending-files"/u);
  assert.match(html, /id="remove-selected-files"/u);
  assert.match(html, /id="create-tasks-button"/u);
  assert.match(html, /id="task-preset"/u);
  assert.match(html, /id="task-options-drawer" class="task-options-drawer hidden"/u);
  assert.match(html, /id="open-task-options"/u);
  assert.match(html, /id="dashboard-attention-jobs"/u);
  assert.match(html, /id="dashboard-running-jobs"/u);
  assert.match(html, /勾选的文件会创建任务/u);
  assert.match(html, /id="pending-file-menu"/u);
  assert.match(html, /id="clear-recent-directories"/u);
  assert.match(html, /id="danger-overlay"/u);
  assert.match(html, /以后不再提醒/u);
  assert.match(html, /id="queue-stop"/u);
  assert.match(html, /任务栏右侧的“\^”/u);
  assert.match(script, /stop_queue_after_current/u);
  assert.match(script, /data-job-duration/u);
  assert.match(script, /class="action-icon/u);
  assert.match(script, /function primaryJobAction/u);
  assert.match(script, /data-review-job/u);
  assert.match(script, /function taskStageTimeline/u);
  assert.match(script, /再次复核/u);
  assert.match(script, /查看复核记录/u);
  assert.doesNotMatch(script, /class="review-entry"/u);
  assert.match(html, /id="active-job-count"/u);
  assert.match(html, /id="completed-job-count"/u);
  assert.match(html, /id="job-filter-chips"/u);
  assert.match(html, /id="toggle-job-filters"/u);
  assert.match(html, /id="job-filter-panel" class="job-filter-panel hidden"/u);
  assert.match(html, /id="clear-job-filters"/u);
  assert.match(script, /class="job-filter-group"/u);
  assert.match(script, /jobFilters\.clear\(\)/u);
  assert.match(html, /id="tag-overlay"/u);
  assert.match(html, /id="review-overlay"/u);
  assert.match(html, /data-review-compare-mode="difference"/u);
  assert.match(html, /开始复核/u);
  assert.match(html, /接受为成品（有风险）/u);
  assert.match(html, /id="review-discard"/u);
  assert.match(html, /扫描不会占用 Photoshop，实际处理会/u);
  assert.match(script, /function progressDisplay/u);
  assert.match(script, /function systemJobTags/u);
  assert.match(script, /job\.quarantinePath \|\| job\.outputPath/u);
  assert.match(script, /get_review_context/u);
  assert.match(script, /function setReviewCompareMode/u);
  assert.match(script, /function updateReviewCompareFromPointer/u);
  assert.match(script, /record_manual_review/u);
  assert.match(script, /discard_result/u);
  assert.match(script, /preview_watcher/u);
  assert.match(script, /scan_watchers/u);
  assert.match(script, /set_watcher_enabled/u);
  assert.match(script, /function watcherCards/u);
  assert.match(script, /function quarantineRows/u);
  assert.match(script, /function setSettingsCategory/u);
  assert.match(script, /function renderPhotoshopVersionCards/u);
  assert.match(script, /function diagnosticStatus/u);
  assert.match(script, /function setHelpTopic/u);
  assert.match(script, /removeSelectedFile/u);
  assert.match(script, /function selectedFilesForTask/u);
  assert.match(script, /const TASK_PRESETS/u);
  assert.match(script, /function applyTaskPreset/u);
  assert.match(script, /runMode: "await_approval"/u);
  assert.match(script, /function preflightDecisionSummary/u);
  assert.match(script, /data-keep-inspection/u);
  assert.match(script, /USER_KEPT_INSPECTION_RESULT/u);
  assert.match(script, /function effectiveJobStatus/u);
  assert.match(html, /只检查并结束，不启动 Photoshop/u);
  assert.match(script, /function setTaskOptionsDrawer/u);
  assert.match(
    script,
    /\$\$\('\[data-view-actions\]'\)\.forEach/u,
    "Every topbar action group must be updated when the active page changes.",
  );
  assert.match(script, /const attentionJobs = jobs\.filter/u);
  assert.match(script, /addDroppedPaths/u);
  assert.match(script, /pathForDroppedFile/u);
  assert.match(script, /addEventListener\("drop"/u);
  assert.match(script, /addEventListener\("contextmenu"/u);
  assert.match(script, /event\.key !== "Delete"/u);
  assert.match(script, /preview_quarantine_cleanup/u);
  assert.match(script, /clean_quarantine_now/u);
  assert.match(script, /尚未开始处理计时/u);
  assert.match(script, /openJobTarget/u);
  assert.match(script, /attribute: "open-job-target"/u);
  assert.match(script, /api\.revealExport/u);
  assert.match(script, /set_job_user_tags/u);
  assert.match(styles, /\.progress-track/u);
  assert.match(styles, /\.review-dialog/u);
  assert.match(html, /ui-foundation\.css/u);
  assert.match(html, /id="global-task-dock"/u);
  assert.match(html, /id="sidebar-toggle"/u);
  assert.match(html, /data-theme-choice="system"/u);
  assert.match(html, /data-theme-choice="light"/u);
  assert.match(html, /data-theme-choice="dark"/u);
  assert.match(html, /class="window-titlebar"/u);
  assert.match(html, /data-window-action="toggle-maximize"/u);
  assert.match(script, /api\.windowControl/u);
  assert.doesNotMatch(
    script,
    /if \(name === "diagnostics"\) void runDiagnostics\(\)/u,
  );
  assert.match(script, /list_photoshop_installations/u);
  assert.match(script, /function renderGlobalTaskDock/u);
  assert.match(script, /const JOB_PAGE_SIZE = 80/u);
  assert.match(script, /data-job-page="previous"/u);
  assert.match(script, /data-job-page="next"/u);
  assert.match(script, /function applyTheme/u);
  assert.match(foundation, /corner-shape:\s*superellipse\(1\.5\)/u);
  assert.match(foundation, /--psm-radius-xl:\s*15px/u);
  assert.match(foundation, /\.global-task-dock/u);
  assert.match(foundation, /input\[type="checkbox"\]::before/u);
  assert.match(foundation, /\.settings-layout\.form-grid/u);
  assert.match(foundation, /\.diagnostic-check-row/u);
  assert.match(foundation, /\.help-guide/u);
  assert.match(foundation, /\.about-identity/u);
  assert.match(foundation, /\.job-pagination/u);
  assert.match(foundation, /\.job-filter-panel/u);
  assert.match(foundation, /\.job-filter-group/u);
  assert.match(foundation, /\.task-profile-summary/u);
  assert.match(foundation, /\.task-options-drawer/u);
  assert.match(foundation, /\.empty-state/u);
  assert.match(foundation, /\.queue-card \.queue-stop/u);
  assert.doesNotMatch(
    html,
    /value="(?:reopen_success|render_consistency)" checked/u,
  );
  assert.doesNotMatch(script, /<summary>更多<\/summary>/u);
});

test("Photoshop mode defaults to process-frame validation without reopening", async () => {
  const [types, worker, validation, html] = await Promise.all([
    fs.readFile("src/types.ts", "utf8"),
    fs.readFile("src/worker.ts", "utf8"),
    fs.readFile("src/validation.ts", "utf8"),
    fs.readFile("src/desktop/renderer/index.html", "utf8"),
  ]);
  const defaultBlock = types.match(
    /DEFAULT_VALIDATION_CHECKS:[^=]*=\s*\[([\s\S]*?)\];/u,
  )?.[1] || "";
  assert.match(defaultBlock, /"pixel_exact"/u);
  assert.doesNotMatch(defaultBlock, /"reopen_success"/u);
  assert.doesNotMatch(defaultBlock, /"render_consistency"/u);
  assert.match(worker, /\["reopen_success", "render_consistency"\]\.includes/u);
  assert.match(validation, /pixel\.beforeVsAfterProcessing/u);
  assert.match(html, /Photoshop 模式默认不选/u);
});

test("desktop and worker launch paths enforce one instance and Node-only preflight", async () => {
  const [main, preload, inspector, worker, service] = await Promise.all([
    fs.readFile("src/desktop/main.ts", "utf8"),
    fs.readFile("src/desktop/preload.cjs", "utf8"),
    fs.readFile("src/inspector.ts", "utf8"),
    fs.readFile("src/worker.ts", "utf8"),
    fs.readFile("src/service.ts", "utf8"),
  ]);
  assert.match(main, /app\.requestSingleInstanceLock\(\)/u);
  assert.match(main, /app\.on\("second-instance"/u);
  assert.match(main, /psmetac-tray-\$\{state\}\.png/u);
  assert.match(main, /tray\.on\("click", showWindow\)/u);
  assert.match(main, /selection:add-dropped-paths/u);
  assert.match(main, /frame:\s*false/u);
  assert.match(main, /window:control/u);
  assert.match(main, /list_photoshop_installations/u);
  assert.match(main, /scanDroppedDesignFiles/u);
  assert.match(preload, /webUtils\.getPathForFile/u);
  assert.match(preload, /shell:reveal-export/u);
  assert.match(main, /explicitlySelectedExports/u);
  assert.match(main, /shell:open-job-target/u);
  assert.doesNotMatch(main, /createFromDataURL/u);
  assert.match(inspector, /ELECTRON_RUN_AS_NODE:\s*"1"/u);
  assert.doesNotMatch(worker, /if\s*\(\s*!environment\.selected\?\.verified/u);
  assert.match(worker, /!this\.config\.experimentalPsdUnattended/u);
  assert.match(service, /unadaptedVersionsCanExecute:\s*true/u);
  assert.match(service, /async photoshopInstallations\(\)/u);
});
