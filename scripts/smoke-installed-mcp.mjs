import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createDefaultConfig,
  saveConfig,
} from "../src/config.ts";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const expectedVersion = JSON.parse(
  await fs.readFile(path.join(appRoot, "package.json"), "utf8"),
).version;
const launcherArgument = process.argv.indexOf("--launcher");
const launcherPath =
  launcherArgument >= 0
    ? path.resolve(process.argv[launcherArgument + 1])
    : path.join(
        appRoot,
        "dist",
        "win-unpacked",
        "resources",
        "scripts",
        "psmetac-mcp.cmd",
      );
const smokeArtifactsRoot = path.resolve(appRoot, ".test-artifacts");
const smokeDataRoot = path.join(
  smokeArtifactsRoot,
  `mcp-smoke-${process.pid}-${Date.now()}`,
);
assert.equal(
  path.dirname(smokeDataRoot),
  smokeArtifactsRoot,
  "Unsafe MCP smoke data path.",
);
await saveConfig(createDefaultConfig(smokeDataRoot));

const child = spawn(launcherPath, [], {
  cwd: path.dirname(launcherPath),
  env: {
    ...process.env,
    PSMETAC_DATA_DIR: smokeDataRoot,
  },
  shell: true,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
const stderr = [];
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => stderr.push(chunk));

const responses = [];
const lines = readline.createInterface({
  input: child.stdout,
  crlfDelay: Infinity,
  terminal: false,
});
lines.on("line", (line) => {
  if (!line.trim()) return;
  responses.push(JSON.parse(line));
  if (responses.length === 3) child.stdin.end();
});

const requests = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "packaged-smoke", version: "1" },
    },
  },
  { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  { jsonrpc: "2.0", id: 3, method: "ping", params: {} },
];
for (const request of requests) {
  child.stdin.write(`${JSON.stringify(request)}\n`);
}

const timeout = setTimeout(() => {
  child.kill();
}, 30_000);
const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) reject(new Error(`MCP smoke process stopped by ${signal}`));
    else resolve(code ?? 1);
  });
});
clearTimeout(timeout);
await fs.rm(smokeDataRoot, { recursive: true, force: true });

assert.equal(
  exitCode,
  0,
  `Installed MCP launcher failed: ${stderr.join("").trim()}`,
);
assert.equal(responses.length, 3);
assert.equal(
  responses[0].result.serverInfo.name,
  "psmetac",
);
assert.equal(
  responses[0].result.serverInfo.version,
  expectedVersion,
);
const toolNames = responses[1].result.tools.map((tool) => tool.name);
assert.ok(toolNames.includes("get_queue_status"));
assert.deepEqual(responses[2].result, {});

process.stdout.write(
  `${JSON.stringify(
    {
      status: "installed-mcp-smoke-passed",
      serverVersion: responses[0].result.serverInfo.version,
      listedTools: toolNames,
      ping: "passed",
      isolatedDataRoot: smokeDataRoot,
      stderr: stderr.join("").trim() || null,
    },
    null,
    2,
  )}\n`,
);
