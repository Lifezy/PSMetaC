import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { runProcess } from "./process-runner.ts";

export interface PhotoshopComRegistration {
  progId: string;
  clsid: string;
  executable: string;
  command: string;
}

export interface PhotoshopInstallation {
  executable: string;
  productVersion: string;
  verified: boolean;
  progId: string | null;
  comRegistered: boolean;
  comExecutable: string | null;
  comCandidates: PhotoshopComRegistration[];
}

function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function pathKey(value: string): string {
  const resolved = path.resolve(value).replace(/[\\/]+$/u, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function normalizePhotoshopVersion(value: string): string {
  const numeric = String(value || "")
    .trim()
    .match(/^\d+(?:\.\d+)*/u)?.[0];
  if (!numeric) return String(value || "").trim().toLowerCase();
  const parts = numeric.split(".").map((item) => Number(item));
  while (parts.length > 2 && parts.at(-1) === 0) parts.pop();
  return parts.join(".");
}

export function photoshopVersionMatches(
  actual: string,
  verifiedVersions: string[],
): boolean {
  const normalized = normalizePhotoshopVersion(actual);
  return verifiedVersions.some(
    (candidate) => normalizePhotoshopVersion(candidate) === normalized,
  );
}

export function photoshopProgIdPreference(progId: string): number {
  if (/^Photoshop\.Application\.\d+$/iu.test(progId)) return 0;
  if (progId.toLowerCase() === "photoshop.application") return 1;
  if (/^Photoshop\.Application\.\d+\.\d+$/iu.test(progId)) return 2;
  return 3;
}

export async function runningPhotoshopExecutables(): Promise<string[]> {
  if (process.platform !== "win32") return [];
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "Get-Process -Name Photoshop | ForEach-Object { if ($_.Path) { [Console]::Out.WriteLine($_.Path) } }",
  ].join("; ");
  const result = await runProcess(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(script)],
    { timeoutMs: 15_000 },
  );
  if (result.code !== 0) return [];
  return [
    ...new Set(
      result.stdout
        .split(/\r?\n/u)
        .map((item) => item.trim())
        .filter((item) => /Photoshop\.exe$/iu.test(item))
        .map((item) => path.resolve(item)),
    ),
  ];
}

async function readProductVersion(executable: string): Promise<string> {
  if (process.platform !== "win32") return "";
  const escaped = executable.replace(/'/g, "''");
  const script = `(Get-Item -LiteralPath '${escaped}').VersionInfo.ProductVersion`;
  const result = await runProcess(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(script)],
    { timeoutMs: 15_000 },
  );
  return result.code === 0 ? result.stdout.trim() : "";
}

function registryExecutable(command: string): string | null {
  const quoted = command.match(/"([^"]*Photoshop\.exe)"/iu)?.[1];
  if (quoted) return path.resolve(quoted);
  const plain = command
    .replace(/\s+\/Automation.*$/iu, "")
    .trim()
    .replace(/^"|"$/gu, "");
  return /Photoshop\.exe$/iu.test(plain) ? path.resolve(plain) : null;
}

async function registryDefaultValue(key: string): Promise<string | null> {
  const result = await runProcess(
    path.join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe"),
    ["query", key, "/ve"],
    { timeoutMs: 15_000 },
  );
  if (result.code !== 0) return null;
  return result.stdout.match(/REG_\w+\s+(.+)$/imu)?.[1]?.trim() || null;
}

export async function registryPhotoshopComRegistrations(): Promise<
  PhotoshopComRegistration[]
> {
  if (process.platform !== "win32") return [];
  const reg = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "reg.exe",
  );
  const search = await runProcess(
    reg,
    ["query", "HKCR", "/f", "Photoshop.Application.", "/k"],
    { timeoutMs: 30_000 },
  );
  const versionedProgIds = [
    ...new Set(
      search.stdout
        .split(/\r?\n/u)
        .map((line) =>
          line.match(
            /HKEY_CLASSES_ROOT\\(Photoshop\.Application\.\d+(?:\.\d+)*)/iu,
          )?.[1],
        )
        .filter((item): item is string => Boolean(item)),
    ),
  ];
  const progIds = [...versionedProgIds, "Photoshop.Application"];
  const registrations: PhotoshopComRegistration[] = [];
  for (const progId of progIds) {
    const clsid = await registryDefaultValue(`HKCR\\${progId}\\CLSID`);
    if (!clsid || !/^\{[0-9a-f-]+\}$/iu.test(clsid)) continue;
    const command = await registryDefaultValue(
      `HKCR\\CLSID\\${clsid}\\LocalServer32`,
    );
    if (!command) continue;
    const executable = registryExecutable(command);
    if (!executable) continue;
    registrations.push({ progId, clsid, executable, command });
  }
  return registrations.sort((left, right) => {
    const preference =
      photoshopProgIdPreference(left.progId) -
      photoshopProgIdPreference(right.progId);
    if (preference !== 0) return preference;
    return right.progId.localeCompare(left.progId, undefined, {
      numeric: true,
    });
  });
}

async function registryPhotoshopPaths(): Promise<string[]> {
  if (process.platform !== "win32") return [];
  const roots = [
    "HKLM\\SOFTWARE\\Adobe\\Photoshop",
    "HKLM\\SOFTWARE\\WOW6432Node\\Adobe\\Photoshop",
  ];
  const found: string[] = [];
  for (const root of roots) {
    const result = await runProcess(
      path.join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe"),
      ["query", root, "/s", "/v", "ApplicationPath"],
      { timeoutMs: 15_000 },
    );
    if (result.code !== 0) continue;
    for (const line of result.stdout.split(/\r?\n/u)) {
      const match = line.match(/ApplicationPath\s+REG_\w+\s+(.+)$/iu);
      if (match) found.push(path.join(match[1].trim(), "Photoshop.exe"));
    }
  }
  return [...new Set(found.map((item) => path.resolve(item)))];
}

export async function diagnosePhotoshop(input: {
  configuredExecutable?: string;
  verifiedVersions: string[];
}): Promise<{
  installations: PhotoshopInstallation[];
  selected: PhotoshopInstallation | null;
  comRegistrations: PhotoshopComRegistration[];
}> {
  const comRegistrations = await registryPhotoshopComRegistrations();
  const candidates = [
    ...(input.configuredExecutable ? [input.configuredExecutable] : []),
    ...(await registryPhotoshopPaths()),
    ...comRegistrations.map((item) => item.executable),
  ];
  const configuredExecutable = input.configuredExecutable
    ? path.resolve(input.configuredExecutable)
    : null;
  const installations: PhotoshopInstallation[] = [];
  for (const executable of [
    ...new Set(candidates.map((item) => path.resolve(item))),
  ]) {
    try {
      const stat = await fs.stat(executable);
      if (!stat.isFile()) continue;
      const productVersion = await readProductVersion(executable);
      const matchingRegistrations = comRegistrations.filter(
        (item) => pathKey(item.executable) === pathKey(executable),
      );
      const registration = matchingRegistrations[0];
      installations.push({
        executable,
        productVersion,
        verified: photoshopVersionMatches(
          productVersion,
          input.verifiedVersions,
        ),
        progId: registration?.progId || null,
        comRegistered: Boolean(registration),
        comExecutable: registration?.executable || null,
        comCandidates: matchingRegistrations,
      });
    } catch {
      // A stale registry entry is diagnostic information, not a fatal error.
    }
  }
  installations.sort((left, right) =>
    right.productVersion.localeCompare(left.productVersion, undefined, {
      numeric: true,
    }),
  );
  return {
    installations,
    selected:
      installations.find(
        (item) =>
          configuredExecutable !== null &&
          pathKey(item.executable) === pathKey(configuredExecutable),
      ) ||
      installations[0] ||
      null,
    comRegistrations,
  };
}

export function systemInformation(): Record<string, unknown> {
  return {
    platform: process.platform,
    release: os.release(),
    architecture: os.arch(),
    hostname: os.hostname(),
    node: process.version,
  };
}
