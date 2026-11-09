import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const {
  extractFile,
  getRawHeader,
  listPackage,
  statFile,
} = require("@electron/asar");
const {
  NtExecutable,
  NtExecutableResource,
  Resource,
} = require("resedit");

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const distRoot = path.join(appRoot, "dist");
const unpackedRoot = path.join(distRoot, "win-unpacked");
const resourcesRoot = path.join(unpackedRoot, "resources");
const executablePath = path.join(
  unpackedRoot,
  "psmetac.exe",
);
const asarPath = path.join(resourcesRoot, "app.asar");

async function fileHash(target) {
  const bytes = await fs.readFile(target);
  return {
    bytes: bytes.byteLength,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
}

async function requireFile(target, label) {
  const stat = await fs.stat(target);
  assert.equal(stat.isFile(), true, `${label} is not a file: ${target}`);
}

function parseIntegrityResource(executableBytes) {
  const executable = NtExecutable.from(executableBytes);
  const resources = NtExecutableResource.from(executable);
  const matches = resources.entries.filter(
    (entry) =>
      String(entry.type).toUpperCase() === "INTEGRITY" &&
      String(entry.id).toUpperCase() === "ELECTRONASAR",
  );
  assert.equal(
    matches.length,
    1,
    "Packaged executable must contain one ELECTRONASAR integrity resource.",
  );
  const text = Buffer.from(matches[0].bin)
    .toString("utf8")
    .replace(/\0+$/u, "");
  const payload = JSON.parse(text);
  assert.equal(Array.isArray(payload), true);
  assert.equal(payload.length, 1);
  assert.equal(payload[0].file, "app.asar");
  assert.equal(payload[0].alg, "SHA256");
  return payload[0].value;
}

function parseExecutableVersion(executableBytes) {
  const executable = NtExecutable.from(executableBytes);
  const resources = NtExecutableResource.from(executable);
  const versions = Resource.VersionInfo.fromEntries(resources.entries);
  assert.equal(versions.length, 1, "Packaged executable must have one version resource.");
  const languages = versions[0].getAllLanguagesForStringValues();
  assert.equal(languages.length, 1, "Packaged executable must have one version language.");
  return versions[0].getStringValues(languages[0]);
}

await requireFile(executablePath, "Packaged executable");
await requireFile(asarPath, "Packaged ASAR");

const packageEntries = listPackage(asarPath, { isPack: false }).map((entry) =>
  entry.replaceAll("\\", "/"),
);
assert.ok(packageEntries.includes("/package.json"));
for (const trayAsset of ["idle", "running", "paused", "attention"]) {
  assert.ok(
    packageEntries.includes(
      `/src/desktop/renderer/assets/psmetac-tray-${trayAsset}.png`,
    ),
    `Packaged tray asset is missing: ${trayAsset}`,
  );
}
const runtimePackage = JSON.parse(
  extractFile(asarPath, "package.json").toString("utf8"),
);
assert.equal(runtimePackage.main, "src/desktop/main.ts");
statFile(asarPath, runtimePackage.main.split("/").join(path.sep));

const { headerString } = getRawHeader(asarPath);
const expectedAsarHeaderHash = crypto
  .createHash("sha256")
  .update(headerString)
  .digest("hex");
const executableBytes = await fs.readFile(executablePath);
const embeddedAsarHeaderHash = parseIntegrityResource(executableBytes);
assert.equal(
  embeddedAsarHeaderHash,
  expectedAsarHeaderHash,
  "Executable ASAR integrity resource does not match app.asar.",
);

const packagedVendorRoot = path.join(resourcesRoot, "psb_batch_tool");
const vendorManifest = JSON.parse(
  await fs.readFile(
    path.join(packagedVendorRoot, "VENDOR_MANIFEST.json"),
    "utf8",
  ),
);
const vendorFiles = [];
for (const entry of vendorManifest.files) {
  const verification = await fileHash(
    path.join(packagedVendorRoot, entry.name),
  );
  assert.equal(verification.bytes, entry.bytes);
  assert.equal(verification.sha256, entry.sha256);
  vendorFiles.push({
    name: entry.name,
    ...verification,
  });
}

const mcpLauncher = path.join(
  resourcesRoot,
  "scripts",
  "psmetac-mcp.cmd",
);
const mcpEntry = path.join(
  resourcesRoot,
  "mcp-runtime",
  "src",
  "mcp.ts",
);
const mcpPackagePath = path.join(
  resourcesRoot,
  "mcp-runtime",
  "package.json",
);
await requireFile(mcpLauncher, "Installed MCP launcher");
await requireFile(mcpEntry, "Installed MCP entry");
await requireFile(mcpPackagePath, "Installed MCP package manifest");
const mcpPackage = JSON.parse(await fs.readFile(mcpPackagePath, "utf8"));
assert.equal(mcpPackage.version, runtimePackage.version);

const packageJson = JSON.parse(
  await fs.readFile(path.join(appRoot, "package.json"), "utf8"),
);
const executableVersion = parseExecutableVersion(executableBytes);
const numericVersionMatch = runtimePackage.version.match(
  /^(\d+)\.(\d+)\.(\d+)/u,
);
assert.ok(numericVersionMatch, "Runtime version is not valid SemVer.");
const windowsProductVersion =
  `${numericVersionMatch[1]}.${numericVersionMatch[2]}.` +
  `${numericVersionMatch[3]}.0`;
assert.equal(executableVersion.FileVersion, runtimePackage.version);
assert.equal(executableVersion.ProductVersion, windowsProductVersion);
assert.equal(runtimePackage.version, packageJson.version);
const installerPath = path.join(
  distRoot,
  `PSMetaC_Setup_v${packageJson.version}.exe`,
);
let installer = null;
try {
  await requireFile(installerPath, "NSIS installer");
  installer = {
    path: installerPath,
    ...(await fileHash(installerPath)),
  };
} catch (error) {
  if (process.argv.includes("--require-installer")) throw error;
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  status: "distribution-valid",
  version: runtimePackage.version,
  executable: {
    path: executablePath,
    fileVersion: executableVersion.FileVersion,
    productVersion: executableVersion.ProductVersion,
    ...(await fileHash(executablePath)),
  },
  asar: {
    path: asarPath,
    ...(await fileHash(asarPath)),
    main: runtimePackage.main,
    entryCount: packageEntries.length,
    headerSha256: expectedAsarHeaderHash,
    executableIntegritySha256: embeddedAsarHeaderHash,
  },
  mcp: {
    launcher: mcpLauncher,
    entry: mcpEntry,
    version: mcpPackage.version,
  },
  vendorFiles,
  installer,
};

await fs.writeFile(
  path.join(distRoot, "build-verification.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
