import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packageJson = JSON.parse(
  await fs.readFile(path.join(appRoot, "package.json"), "utf8"),
);
const versionSource = await fs.readFile(
  path.join(appRoot, "src", "version.ts"),
  "utf8",
);
const sourceVersion = versionSource.match(
  /APP_VERSION\s*=\s*"([^"]+)"/u,
)?.[1];
assert.equal(
  sourceVersion,
  packageJson.version,
  "src/version.ts must match package.json version.",
);
const requiredFiles = [
  "src/desktop/main.ts",
  "src/dropped-files.ts",
  "src/desktop/preload.cjs",
  "src/desktop/renderer/index.html",
  "src/desktop/renderer/assets/psmetac-logo.svg",
  "src/desktop/renderer/assets/psmetac-icon-256.png",
  "src/desktop/renderer/assets/psmetac-tray-idle.png",
  "src/desktop/renderer/assets/psmetac-tray-running.png",
  "src/desktop/renderer/assets/psmetac-tray-paused.png",
  "src/desktop/renderer/assets/psmetac-tray-attention.png",
  "build/psmetac.ico",
  "build/installer-alpha4.nsh",
  "build/installerHeader.bmp",
  "build/installerSidebar.bmp",
  "scripts/generate-installer-assets.ps1",
  "src/mcp.ts",
  "src/version.ts",
  "scripts/photoshop_idle_probe.vbs",
  "scripts/photoshop_bridge_probe.vbs",
  "scripts/psmetac-mcp.cmd",
  "scripts/prepare-runtime.mjs",
  "scripts/before-build.mjs",
  "scripts/build-win.mjs",
  "scripts/after-pack.mjs",
  "scripts/verify-dist.mjs",
  "scripts/smoke-installed-mcp.mjs",
  "vendor/psb_batch_tool/VENDOR_MANIFEST.json",
  "vendor/psb_batch_tool/psb_recursive_inspect.mjs",
  "vendor/psb_batch_tool/psb_metadata_cleanup.jsx",
  "vendor/psb_batch_tool/pixel_compare.mjs",
  "vendor/psb_batch_tool/run_photoshop_jsx.vbs",
];

for (const relative of requiredFiles) {
  const target = path.resolve(appRoot, relative);
  const stat = await fs.stat(target);
  assert.equal(stat.isFile(), true, `Required package file is missing: ${target}`);
}

const vendorManifest = JSON.parse(
  await fs.readFile(
    path.join(appRoot, "vendor", "psb_batch_tool", "VENDOR_MANIFEST.json"),
    "utf8",
  ),
);
for (const entry of vendorManifest.files) {
  const bytes = await fs.readFile(
    path.join(appRoot, "vendor", "psb_batch_tool", entry.name),
  );
  assert.equal(bytes.byteLength, entry.bytes, `Vendor size mismatch: ${entry.name}`);
  assert.equal(
    crypto.createHash("sha256").update(bytes).digest("hex"),
    entry.sha256,
    `Vendor SHA-256 mismatch: ${entry.name}`,
  );
}

assert.equal(packageJson.main, "src/desktop/main.ts");
assert.equal(packageJson.build.asar, true);
assert.equal(packageJson.build.beforeBuild, "scripts/before-build.mjs");
assert.equal("npmRebuild" in packageJson.build, false);
assert.equal(packageJson.build.directories.app, ".runtime-app");
assert.equal(packageJson.build.directories.output, "dist");
assert.equal(packageJson.build.afterPack, "scripts/after-pack.mjs");
assert.deepEqual(packageJson.build.files, ["src/**/*"]);
assert.equal(packageJson.build.nsis.perMachine, false);
assert.equal(packageJson.build.nsis.oneClick, false);
assert.equal(packageJson.build.nsis.allowToChangeInstallationDirectory, false);
assert.equal(packageJson.build.nsis.include, "build/installer-alpha4.nsh");
assert.equal("installerHeader" in packageJson.build.nsis, false);
assert.equal(packageJson.build.nsis.installerSidebar, "build/installerSidebar.bmp");
assert.equal(packageJson.build.nsis.uninstallerSidebar, "build/installerSidebar.bmp");
assert.equal(
  packageJson.build.nsis.uninstallDisplayName,
  "PaceSpace Metadata Cleaner ${version}",
);
assert.equal(packageJson.build.win.target, "nsis");
assert.equal(packageJson.build.win.executableName, "psmetac");
assert.equal(packageJson.build.win.icon, "build/psmetac.ico");
assert.equal(
  packageJson.build.win.artifactName,
  "PSMetaC_Setup_v${version}.${ext}",
);
assert.equal("dependencies" in packageJson, false);

const installerSource = await fs.readFile(
  path.join(appRoot, "build", "installer-alpha4.nsh"),
  "utf8",
);
assert.match(
  installerSource,
  /MUI_WELCOMEPAGE_TITLE[^\r\n]*\$\{VERSION\}/u,
  "Installer welcome page must display the package version.",
);
assert.match(
  installerSource,
  /MUI_FINISHPAGE_TITLE[^\r\n]*\$\{VERSION\}/u,
  "Installer finish page must display the package version.",
);
assert.match(
  installerSource,
  /!macro customInstallMode[\s\S]*?isForceCurrentInstall\s+"1"/u,
  "Installer must default to current-user scope without showing a redundant scope choice.",
);

const resources = packageJson.build.extraResources;
assert.ok(
  resources.some(
    (item) =>
      item.to === "scripts" &&
      item.filter.includes("photoshop_idle_probe.vbs") &&
      item.filter.includes("psmetac-mcp.cmd"),
  ),
  "External Windows scripts are not packaged outside app.asar.",
);
assert.ok(
  resources.some((item) => item.to === "mcp-runtime/src"),
  "The installed stdio MCP runtime source is missing.",
);
assert.ok(
  resources.some((item) => item.to === "psb_batch_tool"),
  "Validated Photoshop assets are missing from extraResources.",
);

process.stdout.write(
  `${JSON.stringify(
    {
      status: "package-layout-valid",
      appId: packageJson.build.appId,
      productName: packageJson.build.productName,
      version: packageJson.version,
      perMachine: packageJson.build.nsis.perMachine,
      mcpLauncher: "resources/scripts/psmetac-mcp.cmd",
      checkedFiles: requiredFiles.length,
      verifiedVendorFiles: vendorManifest.files.length,
    },
    null,
    2,
  )}\n`,
);
