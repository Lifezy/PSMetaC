import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { assertPathWithinDataRoot } from "./paths.ts";

export interface FileSnapshot {
  path: string;
  bytes: number;
  mtimeMs: number;
  mtimeIso: string;
  sha256: string;
}

export async function sha256File(target: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(target, { highWaterMark: 8 * 1024 * 1024 });
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function snapshotFile(target: string): Promise<FileSnapshot> {
  const stat = await fsp.stat(target);
  return {
    path: path.resolve(target),
    bytes: stat.size,
    mtimeMs: stat.mtimeMs,
    mtimeIso: stat.mtime.toISOString(),
    sha256: await sha256File(target),
  };
}

export type PhotoshopDocumentFormat = "psd" | "psb";

/**
 * Read only the six-byte Photoshop document header. Both formats start with
 * `8BPS`; the following big-endian version is 1 for PSD and 2 for PSB.
 */
export async function readPhotoshopDocumentFormat(
  target: string,
): Promise<PhotoshopDocumentFormat> {
  const handle = await fsp.open(target, "r");
  try {
    const header = Buffer.alloc(6);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== header.length || header.toString("ascii", 0, 4) !== "8BPS") {
      throw new Error("PHOTOSHOP_OUTPUT_INVALID_SIGNATURE");
    }
    const version = header.readUInt16BE(4);
    if (version === 1) return "psd";
    if (version === 2) return "psb";
    throw new Error(`PHOTOSHOP_OUTPUT_UNSUPPORTED_VERSION:${version}`);
  } finally {
    await handle.close();
  }
}

export function expectedPhotoshopDocumentFormat(
  target: string,
): PhotoshopDocumentFormat {
  const extension = path.extname(target).toLowerCase();
  if (extension === ".psd") return "psd";
  if (extension === ".psb") return "psb";
  throw new Error(
    `PHOTOSHOP_OUTPUT_UNSUPPORTED_EXTENSION:${extension || "none"}`,
  );
}

export function snapshotsEqual(
  left: FileSnapshot,
  right: FileSnapshot,
): boolean {
  return (
    left.bytes === right.bytes &&
    Math.abs(left.mtimeMs - right.mtimeMs) <= 1 &&
    left.sha256 === right.sha256
  );
}

export async function copyFileVerified(input: {
  source: string;
  destination: string;
  expectedSha256?: string | null;
  isCancelled?: () => boolean | Promise<boolean>;
  onProgress?: (copiedBytes: number, totalBytes: number) => void | Promise<void>;
}): Promise<{ bytes: number; sha256: string }> {
  const sourceStat = await fsp.stat(input.source);
  await fsp.mkdir(path.dirname(input.destination), { recursive: true });
  let copied = 0;
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      copied += chunk.length;
      Promise.resolve(input.isCancelled?.())
        .then((cancelled) => {
          if (cancelled) {
            callback(new Error("__JOB_CANCELLED__"));
            return;
          }
          Promise.resolve(input.onProgress?.(copied, sourceStat.size))
            .then(() => callback(null, chunk))
            .catch(callback);
        })
        .catch(callback);
    },
  });
  try {
    await pipeline(
      fs.createReadStream(input.source, {
        highWaterMark: 8 * 1024 * 1024,
      }),
      progress,
      fs.createWriteStream(input.destination, { flags: "wx" }),
    );
  } catch (error) {
    await fsp.rm(input.destination, { force: true }).catch(() => {});
    throw error;
  }
  const sha256 = await sha256File(input.destination);
  if (input.expectedSha256 && sha256 !== input.expectedSha256) {
    await fsp.rm(input.destination, { force: true }).catch(() => {});
    throw new Error("WORK_COPY_HASH_MISMATCH");
  }
  return { bytes: sourceStat.size, sha256 };
}

async function nearestExistingParent(candidate: string): Promise<string> {
  let current = path.resolve(candidate);
  for (;;) {
    try {
      await fsp.access(current);
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

export async function availableBytes(candidate: string): Promise<number> {
  const parent = await nearestExistingParent(candidate);
  const stats = await fsp.statfs(parent);
  return Number(stats.bavail) * Number(stats.bsize);
}

export async function safeRemoveWorkDirectory(
  workDirectory: string,
  dataRoot: string,
): Promise<void> {
  assertPathWithinDataRoot(workDirectory, dataRoot);
  await fsp.rm(workDirectory, { recursive: true, force: true });
}

export async function moveWithoutOverwrite(
  source: string,
  destination: string,
): Promise<void> {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fsp.access(destination);
    throw new Error(`Destination already exists: ${destination}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await fsp.rename(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await copyFileVerified({ source, destination });
    await fsp.rm(source, { force: true });
  }
}

export async function atomicWriteJson(
  target: string,
  value: unknown,
): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.partial-${process.pid}`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsp.rename(temporary, target);
}
