import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  compareStructure,
  selectedBlockingErrors,
  strictPixelGate,
} from "../src/validation.ts";

test("V-L59 baseline is quarantined by strict v1 pixel policy", async () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const baseline = JSON.parse(
    await fs.readFile(
      path.join(directory, "..", "fixtures", "v-l59-baseline.json"),
      "utf8",
    ),
  );
  const gate = strictPixelGate(baseline.pixel);
  assert.equal(gate.passed, false);
  assert.equal(gate.reasonCode, "PIXEL_NOT_EXACT");
  assert.equal(baseline.expectedStrictV1Disposition, "quarantined");
});

test("exact comparable pixels pass strict gate", () => {
  assert.deepEqual(strictPixelGate({ comparable: true, exact: true }), {
    passed: true,
    reasonCode: "PIXEL_EXACT",
  });
});

test("missing comparison never passes", () => {
  assert.deepEqual(strictPixelGate({ comparable: false, exact: false }), {
    passed: false,
    reasonCode: "PIXEL_UNAVAILABLE",
  });
});

test("structure comparison separates topology from smart-object ID changes", () => {
  const base = {
    containers: [
      {
        id: "root",
        depth: 0,
        format: "PSB",
        channels: 3,
        width: 128,
        height: 128,
        depthBits: 8,
        colorMode: 3,
        layerCount: 1,
        linkedBlocks: 1,
      },
    ],
    linkedRecords: [
      {
        id: "root/lnk0",
        parentId: "root",
        depth: 1,
        type: "liFD",
        uniqueId: "before-id",
        originalName: "embedded.psb",
        fileType: "8BPB",
        fileCreator: "\0\0\0\0",
        nestedPsdFound: true,
      },
    ],
  } as any;
  const after = structuredClone(base);
  after.linkedRecords[0].uniqueId = "after-id";
  const comparison = compareStructure(base, after);
  assert.equal(comparison.passed, false);
  assert.equal(comparison.topologyMatch, true);
  assert.equal(comparison.assetIdsMatch, false);
  assert.deepEqual(comparison.assetIdChanges, [
    {
      recordId: "root/lnk0",
      beforeUniqueId: "before-id",
      afterUniqueId: "after-id",
    },
  ]);
});

test("only selected validation checks block publication while hard errors always block", () => {
  assert.deepEqual(
    selectedBlockingErrors(
      [
        "PIXEL_NOT_EXACT",
        "STRUCTURE_TOPOLOGY_MISMATCH",
        "SOURCE_CHANGED",
      ],
      ["structure_topology"],
    ),
    ["STRUCTURE_TOPOLOGY_MISMATCH", "SOURCE_CHANGED"],
  );
  assert.deepEqual(selectedBlockingErrors(["PIXEL_NOT_EXACT"], []), []);
});
