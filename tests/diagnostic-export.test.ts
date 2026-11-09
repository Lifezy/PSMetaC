import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createDefaultConfig, ensureDataDirectories } from "../src/config.ts";
import { exportDiagnosticBundle } from "../src/diagnostic-export.ts";
import type { JobRecord } from "../src/types.ts";

const execFileAsync = promisify(execFile);

test("diagnostic export creates a redacted ZIP without Photoshop files or previews", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "psmetac-diagnostics-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "data");
  const config = createDefaultConfig(dataRoot);
  await ensureDataDirectories(config);
  const jobId = "diagnostic-job";
  const reportDirectory = path.join(dataRoot, "reports", jobId);
  const artifactDirectory = path.join(reportDirectory, "artifacts");
  await fs.mkdir(artifactDirectory, { recursive: true });
  await fs.writeFile(
    path.join(dataRoot, "logs", "audit.jsonl"),
    '{"event":"test"}\n',
  );
  await fs.writeFile(
    path.join(dataRoot, "logs", "jobs", `${jobId}.events.jsonl`),
    '{"job":"diagnostic-job"}\n',
  );
  await fs.writeFile(
    path.join(reportDirectory, "report.json"),
    '{"status":"failed"}\n',
  );
  await fs.writeFile(
    path.join(artifactDirectory, "photoshop.log"),
    "STATUS=ERROR\n",
  );
  await fs.writeFile(path.join(artifactDirectory, "before.png"), "preview");
  await fs.writeFile(path.join(root, "source.psb"), "must-not-export");

  const archive = path.join(root, "diagnostics.zip");
  const result = await exportDiagnosticBundle({
    config,
    jobs: [{ id: jobId, sourcePath: path.join(root, "source.psb") } as JobRecord],
    diagnostics: { appVersion: "0.1.0-alpha.9" },
    queue: { paused: false },
    database: { path: path.join(dataRoot, "db", "jobs.sqlite"), integrity: "ok" },
    target: archive,
  });
  assert.equal(result.selectedJobCount, 1);
  assert.ok(result.includedFileCount >= 6);
  assert.equal((await fs.readFile(archive)).subarray(0, 2).toString(), "PK");

  const expanded = path.join(root, "expanded");
  await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "& { param($archive, $expanded) Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($archive, $expanded) }",
    archive,
    expanded,
  ]);
  const bundle = path.join(expanded, "PSMetaC_Diagnostics");
  const redacted = await fs.readFile(
    path.join(bundle, "configuration.redacted.json"),
    "utf8",
  );
  assert.match(redacted, /\[REDACTED\]/u);
  assert.doesNotMatch(redacted, new RegExp(config.pipeToken, "u"));
  const exportedFiles = await fs.readdir(
    path.join(bundle, "jobs", jobId, "artifacts"),
  );
  assert.deepEqual(exportedFiles, ["photoshop.log"]);
  const allExported = (
    await fs.readdir(bundle, { recursive: true })
  ).map(String);
  assert.equal(allExported.some((name) => /\.(?:psb|psd|png)$/iu.test(name)), false);
});
