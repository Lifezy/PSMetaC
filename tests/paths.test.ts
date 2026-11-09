import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDefaultConfig } from "../src/config.ts";
import {
  assertNotDenied,
  buildOutputPath,
  isPathInside,
  PathPolicyError,
  validateSourcePath,
} from "../src/paths.ts";

test("path containment is segment-aware", () => {
  assert.equal(isPathInside("C:\\safe\\file.psb", "C:\\safe"), true);
  assert.equal(isPathInside("C:\\safety\\file.psb", "C:\\safe"), false);
});

test("a user-configured excluded root is denied", () => {
  assert.throws(
    () => assertNotDenied("C:\\Private\\original.psb", ["C:\\Private"]),
    (error: unknown) =>
      error instanceof PathPolicyError && error.code === "DENIED_PATH",
  );
});

test("directory aliases share allow and deny boundaries, including future outputs", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "psmetac-alias-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const realDirectory = path.join(root, "real-directory");
  const aliasDirectory = path.join(root, "alias-directory");
  await fs.mkdir(realDirectory);
  await fs.symlink(
    realDirectory,
    aliasDirectory,
    process.platform === "win32" ? "junction" : "dir",
  );
  const file = path.join(realDirectory, "source.psb");
  await fs.writeFile(file, "synthetic");
  const canonicalFile = await fs.realpath(file);
  assert.equal(isPathInside(canonicalFile, aliasDirectory), true);
  assert.equal(
    isPathInside(path.join(aliasDirectory, "future", "output.psb"), realDirectory),
    true,
  );
  assert.equal(
    isPathInside(path.join(root, "real-directory-sibling", "other.psb"), aliasDirectory),
    false,
  );
  assert.throws(
    () => assertNotDenied(canonicalFile, [aliasDirectory]),
    (error: unknown) => error instanceof PathPolicyError && error.code === "DENIED_PATH",
  );
  const config = createDefaultConfig(path.join(root, "data"), {
    allowedInputRoots: [aliasDirectory],
  });
  assert.equal((await validateSourcePath(file, config)).sourcePath, canonicalFile);
});

test("default configuration has no mandatory excluded root", () => {
  const config = createDefaultConfig("C:\\PSBCleanerData");
  assert.deepEqual(config.deniedRoots, []);
});

test("an exact desktop selection can be outside configured input roots", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "psb-explicit-test-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const configuredInput = path.join(root, "configured-input");
  const selectedDirectory = path.join(root, "manual-selection");
  await fs.mkdir(configuredInput);
  await fs.mkdir(selectedDirectory);
  const source = path.join(selectedDirectory, "selected.psb");
  await fs.writeFile(source, "test");
  const config = createDefaultConfig(path.join(root, "data"), {
    allowedInputRoots: [configuredInput],
  });
  await assert.rejects(
    validateSourcePath(source, config),
    (error: unknown) =>
      error instanceof PathPolicyError &&
      error.code === "INPUT_OUTSIDE_ALLOWED_ROOTS",
  );
  const validated = await validateSourcePath(source, config, {
    allowOutsideAllowedRoots: true,
  });
  assert.equal(validated.sourcePath, await fs.realpath(source));
  assert.equal(validated.experimental, false);
});

test("validated PSB gets a non-overwriting output name", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "psb-path-test-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const inputRoot = path.join(root, "input");
  const outputRoot = path.join(root, "output");
  await fs.mkdir(inputRoot);
  await fs.mkdir(outputRoot);
  const source = path.join(inputRoot, "sample.psb");
  await fs.writeFile(source, "test");
  const config = createDefaultConfig(path.join(root, "data"), {
    allowedInputRoots: [inputRoot],
    allowedOutputRoots: [outputRoot],
  });
  const validated = await validateSourcePath(source, config);
  assert.equal(validated.experimental, false);
  const result = await buildOutputPath({
    sourcePath: source,
    jobId: "12345678-0000-0000-0000-000000000000",
    outputMode: "specified_directory",
    outputDir: outputRoot,
    config,
    now: new Date(2026, 6, 24, 12, 34, 56),
  });
  assert.match(
    path.basename(result.outputPath),
    /^sample\.cleaned-20260724-123456-12345678\.psb$/,
  );
  assert.notEqual(path.resolve(result.outputPath), path.resolve(source));
});

test("an explicitly selected desktop output can be outside allowed output roots", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "psb-output-selection-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const inputRoot = path.join(root, "input");
  const configuredOutput = path.join(root, "configured-output");
  const selectedOutput = path.join(root, "selected-output");
  await Promise.all([
    fs.mkdir(inputRoot),
    fs.mkdir(configuredOutput),
    fs.mkdir(selectedOutput),
  ]);
  const source = path.join(inputRoot, "sample.psb");
  await fs.writeFile(source, "test");
  const config = createDefaultConfig(path.join(root, "data"), {
    allowedInputRoots: [inputRoot],
    allowedOutputRoots: [configuredOutput],
  });
  await assert.rejects(
    buildOutputPath({
      sourcePath: source,
      jobId: "12345678-0000-0000-0000-000000000000",
      outputMode: "specified_directory",
      outputDir: selectedOutput,
      config,
    }),
    (error: unknown) =>
      error instanceof PathPolicyError &&
      error.code === "OUTPUT_OUTSIDE_ALLOWED_ROOTS",
  );
  const result = await buildOutputPath({
    sourcePath: source,
    jobId: "12345678-0000-0000-0000-000000000000",
    outputMode: "specified_directory",
    outputDir: selectedOutput,
    config,
    allowOutsideAllowedRoots: true,
  });
  assert.equal(result.outputDir, await fs.realpath(selectedOutput));
});
