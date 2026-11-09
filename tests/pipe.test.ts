import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createDefaultConfig,
  ensureDataDirectories,
} from "../src/config.ts";
import { CleanerService } from "../src/service.ts";
import {
  callLocalService,
  LocalPipeServer,
  localPipeIsListening,
} from "../src/pipe-server.ts";

test("local authenticated pipe exposes capabilities without network ports", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "psb-pipe-test-"));
  const config = createDefaultConfig(root, {
    allowedInputRoots: [root],
    allowedOutputRoots: [root],
  });
  await ensureDataDirectories(config);
  const service = await CleanerService.open(config);
  const pipe = new LocalPipeServer(config, service);
  await pipe.start();
  try {
    assert.equal(await localPipeIsListening(config), true);
    const result = (await callLocalService({
      config,
      method: "get_capabilities",
    })) as Record<string, any>;
    assert.deepEqual(result.overwriteSource, {
      supported: true,
      default: false,
      validation: "skipped",
      backupOptional: true,
      explicitSelectionRequired: true,
    });
    assert.equal(result.networkMcp, false);
    assert.deepEqual(result.deniedRoots, []);
    await callLocalService({ config, method: "pause_queue" });
    const source = path.join(root, "mcp-direct.psb");
    await fs.writeFile(source, "synthetic placeholder");
    const submitted = (await callLocalService({
      config,
      method: "submit_jobs",
      params: {
        jobs: [
          {
            sourcePath: source,
            runMode: "auto_if_eligible",
            executionMode: "in_place",
            backupSource: true,
            outputMode: "specified_directory",
            clientRequestId: "pipe-direct-1",
          },
        ],
      },
    })) as Array<Record<string, any>>;
    assert.equal(submitted[0].job.executionMode, "in_place");
    assert.equal(submitted[0].job.backupSource, true);
  } finally {
    await pipe.close();
    assert.equal(await localPipeIsListening(config), false);
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
