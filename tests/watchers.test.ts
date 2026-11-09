import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createDefaultConfig,
  ensureDataDirectories,
} from "../src/config.ts";
import { JobStore } from "../src/database.ts";
import { WatcherManager } from "../src/watchers.ts";
import { DEFAULT_VALIDATION_CHECKS } from "../src/types.ts";

test("watcher scans existing files recursively and submits each stable signature once", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "psmetac-watcher-"));
  const watchRoot = path.join(root, "inbox");
  const nested = path.join(watchRoot, "nested");
  const output = path.join(watchRoot, "out");
  const dataRoot = path.join(root, "data");
  await fs.mkdir(nested, { recursive: true });
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(watchRoot, "one.psb"), "one");
  await fs.writeFile(path.join(watchRoot, "notes.txt"), "skip");
  await fs.writeFile(path.join(nested, "two.psd"), "two");
  await fs.writeFile(path.join(output, "published.psb"), "skip-output");
  const config = createDefaultConfig(dataRoot, {
    allowedInputRoots: [watchRoot],
    allowedOutputRoots: [output],
    stabilitySeconds: 10,
  });
  await ensureDataDirectories(config);
  const store = new JobStore(config);
  context.after(async () => {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  store.upsertWatcher({
    id: "watcher-test",
    path: watchRoot,
    profile: "standard",
    runMode: "auto_if_eligible",
    executionMode: "safe_copy",
    backupSource: true,
    outputMode: "specified_directory",
    outputDir: output,
    requiredValidationChecks: [...DEFAULT_VALIDATION_CHECKS],
    recursive: true,
    enabled: true,
    createdAt: new Date().toISOString(),
    lastScanAt: null,
    scanStatus: "idle",
    scannedFiles: 0,
    supportedFiles: 0,
    waitingStableFiles: 0,
    submittedJobs: 0,
    skippedFiles: 0,
    lastError: null,
  });
  const manager = new WatcherManager(config, store);
  const preview = await manager.preview(watchRoot, true, output);
  assert.equal(preview.supportedFiles, 1);
  assert.equal(preview.psbFiles, 1);
  assert.equal(preview.psdFiles, 1);

  const submitted: string[] = [];
  manager.onStableFile = async (_watcher, sourcePath) => {
    submitted.push(sourcePath);
    return { jobId: `job-${submitted.length}` };
  };
  await manager.scanOnce();
  assert.equal(store.listWatchers()[0].waitingStableFiles, 1);
  store.db
    .prepare("UPDATE watcher_files SET unchanged_since = ?")
    .run(Date.now() - 11_000);
  await manager.scanOnce();
  assert.equal(submitted.length, 1);
  await manager.scanOnce();
  assert.equal(submitted.length, 1);
  assert.equal(store.listWatchers()[0].submittedJobs, 1);
});
