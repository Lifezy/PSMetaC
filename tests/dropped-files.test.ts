import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DroppedFileScanError,
  scanDroppedDesignFiles,
} from "../src/dropped-files.ts";

test("folder drop recursively finds PSD and PSB without following excluded content", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "psmetac-drop-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const nested = path.join(root, "nested");
  const denied = path.join(root, "excluded");
  await Promise.all([fs.mkdir(nested), fs.mkdir(denied)]);
  const psb = path.join(root, "first.PSB");
  const psd = path.join(nested, "second.psd");
  await Promise.all([
    fs.writeFile(psb, "synthetic"),
    fs.writeFile(psd, "synthetic"),
    fs.writeFile(path.join(root, "notes.txt"), "ignore"),
    fs.writeFile(path.join(denied, "private.psb"), "ignore"),
  ]);

  const result = await scanDroppedDesignFiles([root, psb], {
    deniedRoots: [denied],
  });

  assert.deepEqual(
    result.files.map((item) => path.basename(item)).sort(),
    ["first.PSB", "second.psd"],
  );
  assert.equal(result.summary.acceptedFiles, 2);
  assert.equal(result.summary.duplicateFiles, 1);
  assert.equal(result.summary.unsupportedFiles, 1);
  assert.equal(result.summary.skippedDeniedEntries, 1);
  assert.equal(result.summary.scannedDirectories, 2);
});

test("folder drop stops before creating an unbounded pending list", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "psmetac-drop-limit-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await Promise.all([
    fs.writeFile(path.join(root, "one.psb"), "synthetic"),
    fs.writeFile(path.join(root, "two.psd"), "synthetic"),
  ]);

  await assert.rejects(
    scanDroppedDesignFiles([root], { maxAcceptedFiles: 1 }),
    (error: unknown) =>
      error instanceof DroppedFileScanError &&
      error.code === "DROPPED_SCAN_FILE_LIMIT",
  );
});
