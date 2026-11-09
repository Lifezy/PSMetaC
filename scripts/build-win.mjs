import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { prepareRuntime } from "./prepare-runtime.mjs";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const builderCli = path.join(
  appRoot,
  "node_modules",
  "electron-builder",
  "out",
  "cli",
  "cli.js",
);
const target = process.argv.includes("--dir") ? "--dir" : null;

async function generateInstallerAssets() {
  const generator = path.join(
    appRoot,
    "scripts",
    "generate-installer-assets.ps1",
  );
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      generator,
      "-ProjectRoot",
      appRoot,
    ],
    {
      cwd: appRoot,
      stdio: "inherit",
      windowsHide: true,
    },
  );
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Installer asset generator stopped by ${signal}`));
      else resolve(code ?? 1);
    });
  });
  if (exitCode !== 0) {
    throw new Error(`Installer asset generator exited with code ${exitCode}.`);
  }
}

await generateInstallerAssets();
const runtime = await prepareRuntime();
const sourcePackage = JSON.parse(
  await fs.readFile(path.join(appRoot, "package.json"), "utf8"),
);
const electronVersion = sourcePackage.build.electronVersion;
const electronFilename =
  `electron-v${electronVersion}-win32-x64.zip`;
const electronPackageRoot = path.dirname(
  fileURLToPath(
    import.meta.resolve(`electron/package.json`),
  ),
);
const electronChecksums = JSON.parse(
  await fs.readFile(
    path.join(electronPackageRoot, "checksums.json"),
    "utf8",
  ),
);
const expectedElectronSha256 =
  electronChecksums[electronFilename];

async function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  const handle = await fs.open(filePath, "r");
  try {
    for await (const chunk of handle.createReadStream()) {
      hash.update(chunk);
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function findVerifiedElectronCache() {
  if (!expectedElectronSha256) return null;
  const cacheRoot =
    process.env.ELECTRON_CACHE ||
    (process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "electron", "Cache")
      : path.join(os.homedir(), ".cache", "electron"));
  let entries;
  try {
    entries = await fs.readdir(cacheRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(
      cacheRoot,
      entry.name,
      electronFilename,
    );
    try {
      if ((await sha256(candidate)) === expectedElectronSha256) {
        return candidate;
      }
    } catch {
      // Try the next cache directory.
    }
  }
  return null;
}

const verifiedElectronCache = await findVerifiedElectronCache();
if (verifiedElectronCache) {
  process.stdout.write(
    `${JSON.stringify({
      status: "verified-electron-cache",
      file: verifiedElectronCache,
      sha256: expectedElectronSha256,
    })}\n`,
  );
}

const argumentsForBuilder = [
  builderCli,
  "--projectDir",
  appRoot,
  "--win",
  "--x64",
];
if (target) argumentsForBuilder.push(target);
if (verifiedElectronCache) {
  argumentsForBuilder.push(
    `--config.electronDist=${verifiedElectronCache}`,
  );
}

const buildStartedAt = Date.now();
const child = spawn(process.execPath, argumentsForBuilder, {
  cwd: appRoot,
  env: {
    ...process.env,
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
  },
  stdio: "inherit",
  windowsHide: true,
});
const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) reject(new Error(`electron-builder stopped by ${signal}`));
    else resolve(code ?? 1);
  });
});
if (exitCode === 0) {
  const expectedArtifact = target
    ? path.join(appRoot, "dist", "win-unpacked", "psmetac.exe")
    : path.join(
        appRoot,
        "dist",
        `PSMetaC_Setup_v${sourcePackage.version}.exe`,
      );
  const artifact = await fs.stat(expectedArtifact).catch(() => null);
  if (!artifact?.isFile() || artifact.mtimeMs < buildStartedAt - 2_000) {
    throw new Error(
      `electron-builder returned success without producing a fresh artifact: ${expectedArtifact}`,
    );
  }
}
process.exitCode = exitCode;
