import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePolicy } from "../src/policies.ts";
import type { InspectionResult } from "../src/types.ts";

function inspection(
  affectedBytes: number,
  fileBytes = 1024 ** 3,
  ancestors = 1,
): InspectionResult {
  return {
    target: "C:\\input\\sample.psb",
    fileBytes,
    summary: {
      containersInspected: 1,
      embeddedContainers: 0,
      linkedRecords: 0,
      maxDepthSeen: 0,
      allXmpBytes: affectedBytes,
      allDocumentAncestors: ancestors,
      xmpPercentOfOuterFile: (affectedBytes / fileBytes) * 100,
    },
    cleanupPlan: {
      sourceBytes: fileBytes,
      sourceMtimeMs: 1,
      rootCleanSelf: ancestors > 0,
      anomalousContainers: ancestors > 0 ? 1 : 0,
      anomalousEmbeddedContainers: 0,
      recordsRequiredToOpen: 0,
      targetRecords: 0,
      ancestorOnlyRecords: 0,
      crossBitDepthRecords: 0,
      records: [],
    },
    containers: [
      {
        id: "root",
        depth: 0,
        bytes: fileBytes,
        xmp: {
          bytes: affectedBytes,
          documentAncestors: ancestors,
        },
      },
    ],
    linkedRecords: [],
    warnings: [],
  };
}

test("standard profile accepts 64 MiB", () => {
  assert.equal(evaluatePolicy(inspection(64 * 1024 ** 2), "standard").eligible, true);
});

test("standard profile accepts 5 percent even below 64 MiB", () => {
  assert.equal(
    evaluatePolicy(inspection(5 * 1024 ** 2, 100 * 1024 ** 2), "standard")
      .eligible,
    true,
  );
});

test("deep profile accepts any DocumentAncestors", () => {
  assert.equal(evaluatePolicy(inspection(1), "deep").eligible, true);
});

test("conservative profile rejects a small anomaly", () => {
  const decision = evaluatePolicy(inspection(32 * 1024 ** 2), "conservative");
  assert.equal(decision.eligible, false);
  assert.equal(decision.reasonCode, "BELOW_PROFILE_THRESHOLD");
});

test("all profiles skip when no DocumentAncestors exist", () => {
  for (const profile of ["standard", "deep", "conservative"] as const) {
    assert.equal(
      evaluatePolicy(inspection(0, 1024 ** 3, 0), profile).reasonCode,
      "NO_DOCUMENT_ANCESTORS",
    );
  }
});
