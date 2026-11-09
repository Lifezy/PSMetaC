import net from "node:net";
import os from "node:os";
import crypto from "node:crypto";
import type { CleanerService } from "./service.ts";
import type { AppConfig, SubmitJobInput } from "./types.ts";

export function pipePath(config: AppConfig): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\${config.pipeName}`
    : `${os.tmpdir()}/${config.pipeName}.sock`;
}

export class LocalPipeServer {
  readonly config: AppConfig;
  readonly service: CleanerService;
  private server: net.Server | null = null;

  constructor(config: AppConfig, service: CleanerService) {
    this.config = config;
    this.service = service;
  }

  async start(): Promise<string> {
    if (this.server) return pipePath(this.config);
    this.server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          void this.handleLine(socket, line);
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(
        {
          path: pipePath(this.config),
          readableAll: false,
          writableAll: false,
        },
        () => resolve(),
      );
    });
    return pipePath(this.config);
  }

  async close(): Promise<void> {
    if (!this.server) return;
    const current = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) =>
      current.close((error) => (error ? reject(error) : resolve())),
    );
  }

  private async handleLine(socket: net.Socket, line: string): Promise<void> {
    let request: Record<string, any>;
    try {
      request = JSON.parse(line);
      if (request.token !== this.config.pipeToken) {
        throw new Error("LOCAL_IPC_AUTHENTICATION_FAILED");
      }
      const result = await this.dispatch(request.method, request.params || {});
      socket.write(`${JSON.stringify({ id: request.id, result })}\n`);
    } catch (error) {
      socket.write(
        `${JSON.stringify({
          id: request?.id || null,
          error: { code: -32000, message: (error as Error).message },
        })}\n`,
      );
    }
  }

  private async dispatch(
    method: string,
    params: Record<string, any>,
  ): Promise<unknown> {
    switch (method) {
      case "get_capabilities":
        return this.service.capabilities();
      case "list_profiles":
        return this.service.listProfiles();
      case "submit_jobs":
        return await this.service.submitJobs(
          (params.jobs as Array<Omit<SubmitJobInput, "source">>).map(
            (job) => ({ ...job, source: "mcp" as const }),
          ),
        );
      case "preflight":
        return await this.service.submitJobs([
          {
            sourcePath: String(params.sourcePath),
            profile: params.profile || "standard",
            requiredValidationChecks: params.requiredValidationChecks,
            runMode: "inspect_only",
            outputMode: params.outputMode || "specified_directory",
            outputDir: params.outputDir,
            clientRequestId: params.clientRequestId,
            source: "mcp",
          },
        ]);
      case "get_job":
        return this.service.getJob(String(params.jobId));
      case "list_jobs":
        return this.service.listJobs(params);
      case "cancel_job":
        return await this.service.cancelJob(String(params.jobId));
      case "get_report":
        return await this.service.getReport(String(params.jobId));
      case "get_queue_status":
        return this.service.queueStatus();
      case "pause_queue":
        return this.service.pauseQueue();
      case "stop_queue_after_current":
        return await this.service.stopQueueAfterCurrent();
      case "resume_queue":
        return this.service.resumeQueue();
      default:
        throw new Error(`Unknown local IPC method: ${method}`);
    }
  }
}

export async function localPipeIsListening(
  config: AppConfig,
  timeoutMs = 1_000,
): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.createConnection(pipePath(config));
    let settled = false;
    const finish = (listening: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(listening);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export async function callLocalService(input: {
  config: AppConfig;
  method: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(pipePath(input.config));
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("LOCAL_IPC_TIMEOUT"));
    }, input.timeoutMs || 30_000);
    let buffer = "";
    const id = crypto.randomUUID();
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({
          id,
          token: input.config.pipeToken,
          method: input.method,
          params: input.params || {},
        })}\n`,
      );
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      socket.end();
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (response.error) {
          reject(new Error(response.error.message));
        } else {
          resolve(response.result);
        }
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}
