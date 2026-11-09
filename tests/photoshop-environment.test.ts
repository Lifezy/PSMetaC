import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import {
  normalizePhotoshopVersion,
  photoshopProgIdPreference,
  photoshopVersionMatches,
} from "../src/environment.ts";

test("Photoshop version matching ignores harmless trailing zero components", () => {
  assert.equal(normalizePhotoshopVersion("26.11.0"), "26.11");
  assert.equal(normalizePhotoshopVersion("26.11.0.0"), "26.11");
  assert.equal(photoshopVersionMatches("26.11.0", ["26.11"]), true);
  assert.equal(photoshopVersionMatches("25.12.4", ["26.11"]), false);
});

test("Photoshop connection candidates prefer the version interface over aliases", () => {
  assert.ok(
    photoshopProgIdPreference("Photoshop.Application.190") <
      photoshopProgIdPreference("Photoshop.Application"),
  );
  assert.ok(
    photoshopProgIdPreference("Photoshop.Application") <
      photoshopProgIdPreference("Photoshop.Application.190.1"),
  );
});

test("Photoshop bridges emit structured Unicode diagnostics", async () => {
  const [probe, runner, adapter] = await Promise.all([
    fs.readFile("scripts/photoshop_bridge_probe.vbs", "utf8"),
    fs.readFile("vendor/psb_batch_tool/run_photoshop_jsx.vbs", "utf8"),
    fs.readFile("src/photoshop.ts", "utf8"),
  ]);
  assert.match(probe, /STATUS.*COM_CREATE_FAILED/u);
  assert.match(probe, /DoJavaScriptFile/u);
  assert.match(probe, /JAVASCRIPT_FILE_FAILED/u);
  assert.match(probe, /JAVASCRIPT_INLINE_FAILED/u);
  assert.match(probe, /photoshop\.DoJavaScript scriptText/u);
  assert.match(probe, /WriteStatus "ERROR_DESCRIPTION"/u);
  assert.match(runner, /STATUS=JAVASCRIPT_FAILED/u);
  assert.match(runner, /photoshop\.DoJavaScript scriptText/u);
  assert.match(adapter, /"\/\/U"/u);
  assert.match(adapter, /stdoutEncoding:\s*"utf16le"/u);
  assert.match(adapter, /PHOTOSHOP_PROCESS_NOT_AUTOMATION_READY/u);
  assert.match(adapter, /PHOTOSHOP_SELECTED_INSTANCE_BUSY/u);
  assert.match(adapter, /\["\/\/Nologo", probePath/u);
  assert.match(adapter, /PHOTOSHOP_EXECUTABLE_MISMATCH/u);
  assert.match(adapter, /app\.path\.fsName/u);
  assert.match(adapter, /for \(let index = 0; index < 3/u);
});
