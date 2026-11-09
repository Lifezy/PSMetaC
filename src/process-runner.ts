import { spawn } from "node:child_process";

export interface ProcessResult {
  code: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
}

export async function runProcess(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    inactivityTimeoutMs?: number;
    isCancelled?: () => boolean | Promise<boolean>;
    cancellationPollMs?: number;
    onPoll?: () => boolean | void | Promise<boolean | void>;
    progressPollMs?: number;
    stdoutEncoding?: BufferEncoding;
    stderrEncoding?: BufferEncoding;
  } = {},
): Promise<ProcessResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let pollRunning = false;
    let lastActivityAt = Date.now();
    child.stdout.setEncoding(options.stdoutEncoding || "utf8");
    child.stderr.setEncoding(options.stderrEncoding || "utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      lastActivityAt = Date.now();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      lastActivityAt = Date.now();
    });
    child.on("error", reject);
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      clearInterval(cancelPoll);
      clearInterval(progressPoll);
      if (inactivityPoll) clearInterval(inactivityPoll);
      resolve({
        code: code ?? -1,
        signal,
        stdout,
        stderr,
        timedOut,
        cancelled,
      });
    };
    child.on("close", finish);

    const timeout = options.timeoutMs === 0
      ? null
      : setTimeout(() => {
          timedOut = true;
          child.kill();
        }, options.timeoutMs || 24 * 60 * 60 * 1000);
    const cancelPoll = setInterval(async () => {
      if (!options.isCancelled || settled) return;
      try {
        if (await options.isCancelled()) {
          cancelled = true;
          child.kill();
        }
      } catch {
        // The worker handles cancellation-state read errors after the child exits.
      }
    }, options.cancellationPollMs || 500);
    const progressPoll = setInterval(async () => {
      if (!options.onPoll || settled || pollRunning) return;
      pollRunning = true;
      try {
        const active = await options.onPoll();
        if (active === true) lastActivityAt = Date.now();
      } catch {
        // Progress observation must never terminate the child process.
      } finally {
        pollRunning = false;
      }
    }, options.progressPollMs || 1_000);
    const inactivityPoll = options.inactivityTimeoutMs
      ? setInterval(() => {
          if (
            !settled &&
            Date.now() - lastActivityAt >= options.inactivityTimeoutMs!
          ) {
            timedOut = true;
            child.kill();
          }
        }, Math.min(30_000, Math.max(1_000, options.progressPollMs || 1_000)))
      : null;
  });
}
