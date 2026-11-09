import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  expectedPhotoshopDocumentFormat,
  readPhotoshopDocumentFormat,
} from "../src/files.ts";
import { listTaskOutputCandidates } from "../src/worker.ts";

test("Photoshop output header distinguishes PSD and PSB", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "psmetac-format-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  const psd = path.join(directory, "result.psd");
  const psb = path.join(directory, "result.psb");
  await fs.writeFile(psd, Buffer.from([0x38, 0x42, 0x50, 0x53, 0x00, 0x01]));
  await fs.writeFile(psb, Buffer.from([0x38, 0x42, 0x50, 0x53, 0x00, 0x02]));

  assert.equal(await readPhotoshopDocumentFormat(psd), "psd");
  assert.equal(await readPhotoshopDocumentFormat(psb), "psb");
  assert.equal(expectedPhotoshopDocumentFormat(psd), "psd");
  assert.equal(expectedPhotoshopDocumentFormat(psb), "psb");
});

test("Photoshop output header rejects mismatched or unknown data", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "psmetac-format-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  const invalid = path.join(directory, "result.psd");
  await fs.writeFile(invalid, "not-a-photoshop-file");
  await assert.rejects(
    readPhotoshopDocumentFormat(invalid),
    /PHOTOSHOP_OUTPUT_INVALID_SIGNATURE/u,
  );
  assert.throws(
    () => expectedPhotoshopDocumentFormat(path.join(directory, "result.png")),
    /PHOTOSHOP_OUTPUT_UNSUPPORTED_EXTENSION/u,
  );
});

test("cleanup JSX routes PSD and PSB through matching save implementations", async () => {
  const source = await fs.readFile(
    new URL("../vendor/psb_batch_tool/psb_metadata_cleanup.jsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /function executePsdSave\(/u);
  assert.match(source, /new PhotoshopSaveOptions\(\)/u);
  assert.match(source, /function executePsbSave\(/u);
  assert.match(source, /function saveDocumentCopy\(/u);
  assert.match(source, /OUTPUT_FILE_CONFIRMED/u);
  assert.doesNotMatch(source, /saveAsPsb\(sourceDocument/u);
});

test("failed tasks recover only task-local cleaned outputs", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "psmetac-recovery-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  const expected = path.join(directory, "cleaned-output.psd");
  const alternate = path.join(directory, "cleaned-output.psb");
  await fs.writeFile(path.join(directory, "working-source.psd"), "source");
  await fs.writeFile(path.join(directory, "preview-after.png"), "preview");
  await fs.writeFile(expected, "expected");
  await fs.writeFile(alternate, "alternate");

  assert.deepEqual(
    await listTaskOutputCandidates({
      workDirectory: directory,
      expectedOutput: expected,
    }),
    [expected, alternate],
  );
});
