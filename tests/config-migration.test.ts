import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CONFIG_FILE_NAME,
  createDefaultConfig,
  loadConfig,
} from "../src/config.ts";

test("legacy mandatory E Work exclusion migrates to an empty optional list", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "psb-config-migrate-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const legacy = {
    ...createDefaultConfig(root, {
      deniedRoots: ["E:\\Work"],
    }),
    schemaVersion: 1,
  };
  await fs.writeFile(
    path.join(root, CONFIG_FILE_NAME),
    `${JSON.stringify(legacy, null, 2)}\n`,
    "utf8",
  );
  const migrated = await loadConfig(root);
  assert.equal(migrated.schemaVersion, 5);
  assert.deepEqual(migrated.deniedRoots, []);
  assert.equal(migrated.pipelinePreflight, false);
  assert.equal(migrated.suppressDangerousOperationWarning, false);
  assert.deepEqual(migrated.recentDirectories, {});
  assert.equal(migrated.experimentalPsdUnattended, false);
  assert.equal(migrated.quarantineCleanupEnabled, false);
  assert.equal(migrated.quarantineRetentionDays, 30);
  assert.equal(migrated.quarantineCleanupTrigger, "any");
  assert.equal(migrated.photoshopProgId, undefined);
  const persisted = JSON.parse(
    await fs.readFile(path.join(root, CONFIG_FILE_NAME), "utf8"),
  );
  assert.deepEqual(persisted.deniedRoots, []);
  const backups = await fs.readdir(path.join(root, "config-backups"));
  assert.equal(backups.length, 1);
  assert.match(backups[0], /before-schema-5/u);
  const backup = JSON.parse(
    await fs.readFile(path.join(root, "config-backups", backups[0]), "utf8"),
  );
  assert.equal(backup.schemaVersion, 1);
  assert.deepEqual(backup.deniedRoots, ["E:\\Work"]);
});

test("older configuration gains current safety and cleanup defaults", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "psmetac-config-v2-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const previous = createDefaultConfig(root) as Record<string, unknown>;
  previous.schemaVersion = 2;
  delete previous.pipelinePreflight;
  delete previous.suppressDangerousOperationWarning;
  delete previous.recentDirectories;
  await fs.writeFile(
    path.join(root, CONFIG_FILE_NAME),
    `${JSON.stringify(previous, null, 2)}\n`,
    "utf8",
  );
  const migrated = await loadConfig(root);
  assert.equal(migrated.schemaVersion, 5);
  assert.equal(migrated.pipelinePreflight, false);
  assert.equal(migrated.suppressDangerousOperationWarning, false);
  assert.deepEqual(migrated.recentDirectories, {});
  assert.equal(migrated.experimentalPsdUnattended, false);
  assert.equal(migrated.quarantineCleanupEnabled, false);
  assert.equal(migrated.quarantineRetentionDays, 30);
  assert.equal(migrated.quarantineCleanupTrigger, "any");
  assert.equal(migrated.photoshopProgId, undefined);
});

test("Alpha.10 configuration gains automatic Photoshop connection selection", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "psmetac-config-v4-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const previous = createDefaultConfig(root) as Record<string, unknown>;
  previous.schemaVersion = 4;
  previous.photoshopProgId = "Photoshop.Application.190.1";
  await fs.writeFile(
    path.join(root, CONFIG_FILE_NAME),
    `${JSON.stringify(previous, null, 2)}\n`,
    "utf8",
  );
  const migrated = await loadConfig(root);
  assert.equal(migrated.schemaVersion, 5);
  assert.equal(migrated.photoshopProgId, undefined);
});
