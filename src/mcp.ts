import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBootstrap, loadConfig } from "./config.ts";
import { callLocalService } from "./pipe-server.ts";
import { MCP_TOOLS } from "./mcp-tools.ts";
import type { AppConfig } from "./types.ts";
import { APP_VERSION } from "./version.ts";

const MCP_PROTOCOL_VERSION = "2025-11-25";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function resolveConfig(): Promise<AppConfig> {
  const explicit =
    argument("--data-dir") ||
    process.env.PSMETAC_DATA_DIR ||
    process.env.PSB_CLEANER_DATA_DIR;
  if (explicit) return await loadConfig(explicit);
  const bootstrap = await loadBootstrap();
  if (!bootstrap) {
    throw new Error(
      "No PSB cleaner data directory is configured. Start the desktop app or pass --data-dir.",
    );
  }
  return await loadConfig(bootstrap.dataRoot);
}

function success(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function failure(
  id: unknown,
  code: number,
  message: string,
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolResult(result: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent:
      result && typeof result === "object" ? result : { value: result },
    isError,
  };
}

export async function handleMcpRequest(
  message: Record<string, any>,
  config: AppConfig,
): Promise<Record<string, unknown> | null> {
  if (!Object.prototype.hasOwnProperty.call(message, "id")) {
    return null;
  }
  switch (message.method) {
    case "initialize":
      return success(message.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: "psmetac",
          title: "PaceSpace Metadata Cleaner (PSMetaC)",
          version: APP_VERSION,
        },
        instructions:
          "safe_copy is the default. in_place is destructive, skips post-save validation, and must explicitly set backupSource. Submit only explicit files inside configured allowed roots and always use stable idempotency keys.",
      });
    case "ping":
      return success(message.id, {});
    case "tools/list":
      return success(message.id, { tools: MCP_TOOLS });
    case "tools/call": {
      const name = String(message.params?.name || "");
      if (!MCP_TOOLS.some((tool) => tool.name === name)) {
        return success(
          message.id,
          toolResult({ error: `Unknown tool: ${name}` }, true),
        );
      }
      try {
        const args = { ...(message.params?.arguments || {}) };
        if (name === "submit_jobs") {
          args.jobs = (args.jobs || []).map(
            (job: Record<string, unknown>) => ({
              ...job,
              source: "mcp",
            }),
          );
        }
        const result = await callLocalService({
          config,
          method: name,
          params: args,
          timeoutMs: name === "get_report" ? 60_000 : 30_000,
        });
        return success(message.id, toolResult(result));
      } catch (error) {
        return success(
          message.id,
          toolResult({ error: (error as Error).message }, true),
        );
      }
    }
    default:
      return failure(message.id, -32601, `Method not found: ${message.method}`);
  }
}

async function main(): Promise<void> {
  const config = await resolveConfig();
  const input = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });
  for await (const line of input) {
    if (!line.trim()) continue;
    let response: Record<string, unknown> | null;
    try {
      const message = JSON.parse(line);
      response = await handleMcpRequest(message, config);
    } catch (error) {
      response = failure(null, -32700, (error as Error).message);
    }
    if (response) {
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  }
}

if (
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
) {
  main().catch((error) => {
    process.stderr.write(`PSMetaC MCP server failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
