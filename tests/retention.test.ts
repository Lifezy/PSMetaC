import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDefaultConfig } from "../src/config.ts";
import {
  previewRetentionMaintenance,
  recycleManualReviewArtifacts,
} from "../src/retention.ts";

test("quarantine preview combines age and capacity while preserving locked reviews", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "psmetac-retention-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const quarantine = path.join(root, "quarantine");
  const now = Date.UTC(2026, 6, 31, 12, 0, 0);
  const entries = [
    { id: "locked-old", bytes: 6, ageDays: 20 },
    { id: "eligible-old", bytes: 5, ageDays: 10 },
    { id: "capacity-only", bytes: 4, ageDays: 1 },
  ];
  for (const entry of entries) {
    const directory = path.join(quarantine, entry.id);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "result.psb"), "x".repeat(entry.bytes));
    const modified = new Date(now - entry.ageDays * 24 * 60 * 60 * 1000);
    await fs.utimes(directory, modified, modified);
  }
  const config = createDefaultConfig(root, {
    quarantineCleanupEnabled: true,
    quarantineRetentionDays: 7,
    quarantineMaxBytes: 8,
    quarantineCleanupTrigger: "any",
  });
  const plan = await previewRetentionMaintenance(config, {
    now,
    lockedJobIds: ["locked-old"],
  });
  assert.equal(plan.totalDirectories, 3);
  assert.equal(plan.totalBytes, 15);
  assert.equal(plan.lockedDirectories, 1);
  assert.deepEqual(
    plan.candidates.map((item) => item.jobId),
    ["eligible-old", "capacity-only"],
  );
  assert.deepEqual(plan.candidates[0].reasons, ["age", "capacity"]);
  assert.deepEqual(plan.candidates[1].reasons, ["capacity"]);
  assert.equal(plan.projectedBytes, 6);
});

test("manual review cleanup recycles only exact derived directories", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "psmetac-discard-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = createDefaultConfig(root);
  const jobId = "job-123";
  const quarantine = path.join(root, "quarantine", jobId);
  const work = path.join(root, "work", jobId);
  const report = path.join(root, "reports", jobId);
  const artifacts = path.join(report, "artifacts");
  await Promise.all([
    fs.mkdir(quarantine, { recursive: true }),
    fs.mkdir(work, { recursive: true }),
    fs.mkdir(artifacts, { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(quarantine, "result.psb"), "result"),
    fs.writeFile(path.join(work, "working.psb"), "working"),
    fs.writeFile(path.join(artifacts, "before.png"), "preview"),
    fs.writeFile(path.join(report, "report.json"), "{}"),
  ]);
  const recycled: string[] = [];
  const result = await recycleManualReviewArtifacts(config, jobId, {
    recycleDirectory: async (target) => {
      recycled.push(target);
      await fs.rm(target, { recursive: true });
    },
  });
  assert.deepEqual(recycled, [work, artifacts, quarantine]);
  assert.deepEqual(
    result.directories.map((item) => item.kind),
    ["work", "preview", "quarantine"],
  );
  assert.equal(result.recycledBytes, 20);
  assert.equal(await fs.readFile(path.join(report, "report.json"), "utf8"), "{}");
  await assert.rejects(
    recycleManualReviewArtifacts(config, path.join("..", "outside"), {
      recycleDirectory: async () => {
        throw new Error("不应执行到回收动作");
      },
    }),
    /任务编号无效/u,
  );
});

test("output-volume review directories remain visible and safely recyclable", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "psmetac-review-root-"));
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "psmetac-review-output-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  context.after(() => fs.rm(outputRoot, { recursive: true, force: true }));
  const config = createDefaultConfig(root, {
    quarantineCleanupEnabled: true,
    quarantineRetentionDays: 1,
  });
  const jobId = "external-review-job";
  const reviewDirectory = path.join(
    outputRoot,
    ".psmetac-review",
    jobId,
  );
  await fs.mkdir(reviewDirectory, { recursive: true });
  await fs.writeFile(path.join(reviewDirectory, "result.psb"), "review");
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  await fs.utimes(reviewDirectory, old, old);

  const plan = await previewRetentionMaintenance(config, {
    quarantineDirectories: [{ jobId, directory: reviewDirectory }],
  });
  assert.equal(plan.totalDirectories, 1);
  assert.deepEqual(plan.candidates.map((item) => item.jobId), [jobId]);

  const recycled: string[] = [];
  const result = await recycleManualReviewArtifacts(config, jobId, {
    quarantineDirectory: reviewDirectory,
    recycleDirectory: async (target) => {
      recycled.push(target);
      await fs.rm(target, { recursive: true });
    },
  });
  assert.deepEqual(recycled, [reviewDirectory]);
  assert.deepEqual(result.directories.map((item) => item.kind), ["quarantine"]);
  await assert.rejects(
    recycleManualReviewArtifacts(config, jobId, {
      quarantineDirectory: path.join(outputRoot, "unrelated", jobId),
      recycleDirectory: async () => {},
    }),
    /受控目录/u,
  );
});
