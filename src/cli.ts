import path from "node:path";
import {
  createDefaultConfig,
  defaultBootstrapDirectory,
  loadConfig,
  saveBootstrap,
  saveConfig,
} from "./config.ts";
import { CleanerService } from "./service.ts";
import {
  LocalPipeServer,
  callLocalService,
  localPipeIsListening,
} from "./pipe-server.ts";

function parseArgs(values: string[]): Record<string, string | string[] | boolean> {
  const parsed: Record<string, string | string[] | boolean> = { _: [] };
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (!value.startsWith("--")) {
      (parsed._ as string[]).push(value);
      continue;
    }
    const name = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[name] = true;
      continue;
    }
    index++;
    if (parsed[name] === undefined) parsed[name] = next;
    else if (Array.isArray(parsed[name])) (parsed[name] as string[]).push(next);
    else parsed[name] = [String(parsed[name]), next];
  }
  return parsed;
}

function values(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (value === undefined) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function required(args: Record<string, unknown>, name: string): string {
  const value = values(args, name)[0];
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [command] = args._ as string[];
  if (!command || command === "help") {
    process.stdout.write(`PaceSpace Metadata Cleaner (PSMetaC)

Commands:
  init --data-dir <dir> --input-root <dir> --output-root <dir>
  serve --data-dir <dir>
  diagnose --data-dir <dir>
  submit --data-dir <dir> --file <psb> --output-dir <dir>
  preflight --data-dir <dir> --file <psb>
  status --data-dir <dir> [--job-id <id>]
  cancel --data-dir <dir> --job-id <id>
  pause --data-dir <dir>
  resume --data-dir <dir>
`);
    return;
  }
  if (command === "init") {
    const dataRoot = path.resolve(required(args, "data-dir"));
    const config = createDefaultConfig(dataRoot, {
      allowedInputRoots: values(args, "input-root").map((item) =>
        path.resolve(item),
      ),
      allowedOutputRoots: values(args, "output-root").map((item) =>
        path.resolve(item),
      ),
      photoshopExecutable: values(args, "photoshop")[0],
    });
    const target = await saveConfig(config);
    const bootstrapPath = await saveBootstrap(
      defaultBootstrapDirectory(),
      dataRoot,
    );
    process.stdout.write(
      `${JSON.stringify(
        {
          status: "initialized",
          configPath: target,
          bootstrapPath,
          dataRoot,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  const config = await loadConfig(required(args, "data-dir"));
  if (command === "serve") {
    if (await localPipeIsListening(config)) {
      throw new Error(
        "PSMetaC 已在运行。请使用现有桌面程序或本地服务。",
      );
    }
    const service = await CleanerService.open(config);
    const pipe = new LocalPipeServer(config, service);
    const endpoint = await pipe.start();
    service.start();
    process.stdout.write(
      `${JSON.stringify({ status: "running", endpoint, dataRoot: config.dataRoot })}\n`,
    );
    const stop = async () => {
      await pipe.close();
      await service.close();
      process.exit(0);
    };
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
    await new Promise(() => {});
  }
  if (command === "diagnose") {
    const service = await CleanerService.open(config, {
      exclusive: false,
      recoverInterrupted: false,
    });
    try {
      process.stdout.write(`${JSON.stringify(await service.diagnostics(), null, 2)}\n`);
    } finally {
      await service.close();
    }
    return;
  }
  let action: { method: string; params: Record<string, unknown> };
  if (command === "preflight") {
    action = {
      method: "preflight",
      params: {
        sourcePath: required(args, "file"),
        profile: values(args, "profile")[0] || "standard",
        clientRequestId: values(args, "request-id")[0],
      },
    };
  } else if (command === "submit") {
    const files = values(args, "file");
    if (files.length === 0) required(args, "file");
    action = {
      method: "submit_jobs",
      params: {
        jobs: files.map((sourcePath) => ({
          sourcePath,
          profile: values(args, "profile")[0] || "standard",
          runMode: values(args, "run-mode")[0] || "auto_if_eligible",
          outputMode: values(args, "output-mode")[0] || "specified_directory",
          outputDir: values(args, "output-dir")[0],
          clientRequestId: values(args, "request-id")[0],
          source: "cli",
        })),
      },
    };
  } else if (command === "status") {
    action = values(args, "job-id")[0]
      ? {
          method: "get_job",
          params: { jobId: values(args, "job-id")[0] },
        }
      : { method: "get_queue_status", params: {} };
  } else if (command === "cancel") {
    action = {
      method: "cancel_job",
      params: { jobId: required(args, "job-id") },
    };
  } else if (command === "pause") {
    action = { method: "pause_queue", params: {} };
  } else if (command === "resume") {
    action = { method: "resume_queue", params: {} };
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
  const result = await callLocalService({ config, ...action });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
