import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import {
  parseLayerCleanup,
  parsePhotoshopProgress,
  parsePhotoshopRuntimeEnvironment,
  parsePhotoshopTerminalStatus,
} from "../src/worker.ts";

test("Photoshop terminal parser preserves the original save error", () => {
  const parsed = parsePhotoshopTerminalStatus(
    [
      "SAVE_ATTEMPT PRIMARY copy=true",
      '2026-07-28T12:00:00\tSTATUS=ERROR\t发生了常规 Photoshop 错误。命令"存储"的参数当前是无效的。\tline=646',
    ].join("\n"),
  );
  assert.equal(parsed.status, "error");
  assert.match(parsed.detail || "", /存储/u);
  assert.doesNotMatch(parsed.detail || "", /PHOTOSHOP_OUTPUT_MISSING/u);
});

test("Photoshop terminal parser recognizes successful and cancelled runs", () => {
  assert.equal(
    parsePhotoshopTerminalStatus("STATUS=DONE\n").status,
    "done",
  );
  assert.equal(
    parsePhotoshopTerminalStatus("STATUS=CANCELLED\n").status,
    "cancelled",
  );
  assert.equal(
    parsePhotoshopTerminalStatus(
      "STATUS=PARTIAL\tprocessed=18\tplanned=20\n",
    ).status,
    "partial",
  );
  assert.equal(
    parsePhotoshopTerminalStatus(
      "STATUS=CANCELLED_SAVED\tcompleted work kept\n",
    ).status,
    "cancelled_saved",
  );
});

test("Photoshop runtime parser records the actual unverified version", () => {
  const parsed = parsePhotoshopRuntimeEnvironment(
    "Tue, 28 Jul 2026 12:00:00 GMT\tPHOTOSHOP_ENV\tversion=25.12.4\tpath=D%3A%5CAdobe%5CPhotoshop%202024",
  );
  assert.equal(parsed.productVersion, "25.12.4");
  assert.equal(parsed.executableDirectory, "D:\\Adobe\\Photoshop 2024");
});

test("Photoshop log progress exposes smart-object counts and the uninterruptible save stage", () => {
  const objects = parsePhotoshopProgress(
    [
      "Tue, 28 Jul 2026 12:00:00 GMT\tROOT_OPENED\tname=test.psb",
      "Tue, 28 Jul 2026 12:00:01 GMT\tDOCUMENT\tnested.psb\tdepth=1",
      "Tue, 28 Jul 2026 12:00:02 GMT\tSMART_OBJECT\tSAVED\tlayer-1",
    ].join("\n"),
    3,
  );
  assert.equal(objects.stage, "photoshop_objects");
  assert.equal(objects.current, 1);
  assert.equal(objects.total, 3);
  assert.match(objects.detail, /1\/3/u);

  const saving = parsePhotoshopProgress(
    "Tue, 28 Jul 2026 12:00:03 GMT\tOUTPUT_SAVE_COMMAND_STARTED\tformat=PSB",
    3,
  );
  assert.equal(saving.stage, "photoshop_save");
  assert.match(saving.detail, /不能安全强制中断/u);

  const reopening = parsePhotoshopProgress(
    [
      "Tue, 28 Jul 2026 12:00:03 GMT\tOUTPUT_SAVE_ATTEMPT\tmethod=ACTION_DESCRIPTOR",
      "Tue, 28 Jul 2026 12:00:04 GMT\tOUTPUT_SAVE_COMPLETE\toutput.psb",
      "Tue, 28 Jul 2026 12:00:05 GMT\tSTATE_REOPEN\tOK\tlayers=4",
    ].join("\n"),
    3,
  );
  assert.equal(reopening.stage, "photoshop_reopen");
});

test("Photoshop progress counts only planned terminal events, not preflight skips", () => {
  const parsed = parsePhotoshopProgress(
    [
      "Tue, 28 Jul 2026 12:00:00 GMT\tROOT_OPENED\tname=test.psb",
      ...Array.from(
        { length: 40 },
        (_, index) =>
          `Tue, 28 Jul 2026 12:00:01 GMT\tSMART_OBJECT\tSKIP_PREFLIGHT_CLEAN\tunplanned-${index}`,
      ),
      "Tue, 28 Jul 2026 12:00:02 GMT\tPLAN_PROGRESS\tcompleted=2\ttotal=5\tfailed=0\tscanned=42\tskipped=40\tcurrentId=root/lnk2\tassetId=asset-2\toutcome=SAVED",
    ].join("\n"),
    5,
  );
  assert.equal(parsed.current, 2);
  assert.equal(parsed.total, 5);
  assert.match(parsed.detail, /计划目标 2\/5/u);
  assert.match(parsed.detail, /已扫描 42/u);
  assert.match(parsed.detail, /跳过 40/u);
});

test("Photoshop progress moves to root metadata after the real plan total", () => {
  const parsed = parsePhotoshopProgress(
    [
      "Tue, 28 Jul 2026 12:00:02 GMT\tPLAN_PROGRESS\tcompleted=5\ttotal=5\tfailed=0\tscanned=45\tskipped=40\tcurrentId=root/lnk5\tassetId=asset-5\toutcome=UNCHANGED",
      "Tue, 28 Jul 2026 12:00:03 GMT\tROOT_XMP\tSTART",
    ].join("\n"),
    5,
  );
  assert.equal(parsed.stage, "photoshop_root_xmp");
  assert.equal(parsed.current, 5);
  assert.match(parsed.detail, /正在清理根文档元数据/u);
});

test("root layer cleanup exposes progress and a per-layer audit summary", () => {
  const log = [
    "Tue, 28 Jul 2026 12:00:03 GMT\tLAYER_CLEANUP\tSTART\thidden=true\tempty=true",
    "Tue, 28 Jul 2026 12:00:04 GMT\tLAYER_CLEANUP\tDELETED\tkind=hidden\tpath=%E7%BB%84%201%2F%E5%9B%BE%E5%B1%82%201\ttype=ArtLayer\tsubtreeLayers=1",
    "Tue, 28 Jul 2026 12:00:05 GMT\tLAYER_CLEANUP\tDELETED\tkind=empty\tpath=%E7%A9%BA%E5%9B%BE%E5%B1%82\ttype=ArtLayer\tsubtreeLayers=1",
    "Tue, 28 Jul 2026 12:00:06 GMT\tLAYER_CLEANUP\tSKIPPED\tkind=empty\tpath=%E7%89%B9%E6%AE%8A%E5%9B%BE%E5%B1%82\treason=HAS%20MASK",
    "Tue, 28 Jul 2026 12:00:07 GMT\tLAYER_CLEANUP\tSUMMARY\tdeletedHidden=1\tdeletedEmpty=1\tskippedHidden=0\tskippedEmpty=1",
  ].join("\n");
  const progress = parsePhotoshopProgress(log, 0);
  assert.equal(progress.stage, "photoshop_layers");
  assert.match(progress.detail, /隐藏图层 1 个/u);
  assert.match(progress.detail, /空图层 1 个/u);

  const audit = parseLayerCleanup(log);
  assert.deepEqual(audit.requested, { hidden: true, empty: true });
  assert.equal(audit.deletedCount, 2);
  assert.equal(audit.deletedHidden[0].path, "组 1/图层 1");
  assert.equal(audit.skippedEmpty[0].reason, "HAS MASK");
});

test("cleanup plan V2 distinguishes duplicate asset IDs by document path", async () => {
  const [inspector, cleanup] = await Promise.all([
    fs.readFile("vendor/psb_batch_tool/psb_recursive_inspect.mjs", "utf8"),
    fs.readFile("vendor/psb_batch_tool/psb_metadata_cleanup.jsx", "utf8"),
  ]);
  assert.match(inspector, /#PSB_CLEANUP_PLAN_V2/u);
  assert.match(inspector, /parentContainerId/u);
  assert.match(inspector, /duplicateAssetGroups/u);
  assert.match(cleanup, /#PSB_CLEANUP_PLAN_V2/u);
  assert.match(cleanup, /choosePlanRecord/u);
  assert.match(cleanup, /parentContainerId/u);
  assert.match(cleanup, /processedSharedIdsByScope/u);
  assert.match(cleanup, /PLAN_PROGRESS/u);
});

test("smart-object opening uses a bounded handshake and one safe retry", async () => {
  const cleanup = await fs.readFile(
    "vendor/psb_batch_tool/psb_metadata_cleanup.jsx",
    "utf8",
  );
  assert.match(cleanup, /function waitForNewChildDocument/u);
  assert.match(cleanup, /function openSmartObjectWithHandshake/u);
  assert.match(cleanup, /var timeouts = \[15000, 30000\]/u);
  assert.match(cleanup, /SMART_OBJECT_OPEN_ATTEMPT/u);
  assert.match(cleanup, /SMART_OBJECT_OPEN_RESULT/u);
  assert.match(cleanup, /beforeIds\[String\(active\.id\)\] !== true/u);
  assert.match(
    cleanup,
    /childDocument = openedDocument;[\s\S]*?childDocument\.close/u,
  );
});

test("cleanup uses scoped lightweight restoration and durable progress markers", async () => {
  const cleanup = await fs.readFile(
    "vendor/psb_batch_tool/psb_metadata_cleanup.jsx",
    "utf8",
  );
  assert.match(cleanup, /function snapshotTargetAndAncestors/u);
  assert.match(cleanup, /function restoreTargetAndAncestors/u);
  assert.match(
    cleanup,
    /restoreTargetAndAncestors\(\s*documentRef,\s*localStateSnapshot,/u,
  );
  assert.match(cleanup, /PLAN_PROGRESS/u);
  assert.match(cleanup, /CANCELLED_SAVED/u);
  assert.match(cleanup, /REOPEN_REQUIRED/u);
  assert.match(cleanup, /"PERF\\t/u);
  assert.match(cleanup, /processedSharedIdsByScope/u);
});

test("optional layer cleanup remains root-only, audited, and conservative", async () => {
  const cleanup = await fs.readFile(
    "vendor/psb_batch_tool/psb_metadata_cleanup.jsx",
    "utf8",
  );
  assert.match(cleanup, /DELETE_HIDDEN_LAYERS/u);
  assert.match(cleanup, /DELETE_EMPTY_LAYERS/u);
  assert.match(cleanup, /cleanupRootDocumentLayers\(sourceDocument\)/u);
  assert.match(cleanup, /LAYER_CLEANUP/u);
  assert.match(cleanup, /layer\.kind !== LayerKind\.NORMAL/u);
  assert.match(cleanup, /hasUserMask/u);
  assert.match(cleanup, /hasVectorMask/u);
  assert.match(cleanup, /layerEffects/u);
});
