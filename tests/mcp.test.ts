import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultConfig } from "../src/config.ts";
import { handleMcpRequest } from "../src/mcp.ts";

const config = createDefaultConfig("C:\\PSBTestData", {
  allowedInputRoots: ["C:\\PSBInput"],
  allowedOutputRoots: ["C:\\PSBOutput"],
});

test("MCP initialize advertises tools capability", async () => {
  const response = await handleMcpRequest(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {} },
    },
    config,
  );
  assert.equal((response?.result as any).protocolVersion, "2025-11-25");
  assert.deepEqual((response?.result as any).capabilities, {
    tools: { listChanged: false },
  });
});

test("MCP tool list contains only controlled operations", async () => {
  const response = await handleMcpRequest(
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    config,
  );
  const names = (response?.result as any).tools.map((tool: any) => tool.name);
  assert.ok(names.includes("submit_jobs"));
  assert.ok(names.includes("cancel_job"));
  assert.ok(names.includes("get_report"));
  assert.ok(names.includes("stop_queue_after_current"));
  assert.ok(!names.includes("delete_file"));
  assert.ok(!names.includes("run_script"));
  assert.ok(!names.includes("update_settings"));
});
