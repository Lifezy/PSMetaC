import assert from "node:assert/strict";
import test from "node:test";
import { planExecutionStorage } from "../src/storage-plan.ts";

test("safe-copy capacity is planned on the selected output volume", () => {
  const gib = 1024 ** 3;
  const plan = planExecutionStorage({
    executionMode: "safe_copy",
    backupSource: true,
    sourceBytes: 10 * gib,
    minimumSpaceMultiplier: 3,
    minimumSpaceReserveBytes: 10 * gib,
    dataRoot: "G:\\PSMetaCData",
    dataFree: 2 * gib,
    outputRoot: "E:\\Design\\PSMetaC_成品",
    outputFree: 50 * gib,
  });
  assert.equal(plan.workRoot, "E:\\Design\\PSMetaC_成品");
  assert.equal(plan.requiredWorkBytes, 40 * gib);
  assert.equal(plan.workFree, 50 * gib);
  assert.equal(plan.eligible, true);
  assert.match(plan.explanation, /数据目录只保存报告和日志/u);
});

test("safe-copy capacity reports the output-volume shortfall only once", () => {
  const gib = 1024 ** 3;
  const plan = planExecutionStorage({
    executionMode: "safe_copy",
    backupSource: false,
    sourceBytes: 10 * gib,
    minimumSpaceMultiplier: 3,
    minimumSpaceReserveBytes: 10 * gib,
    dataRoot: "G:\\data",
    dataFree: 100 * gib,
    outputRoot: "E:\\output",
    outputFree: 35 * gib,
  });
  assert.equal(plan.eligible, false);
  assert.equal(plan.workShortfallBytes, 5 * gib);
  assert.equal(plan.outputShortfallBytes, 0);
});
