import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const {
  createPackage,
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
const payloadRoot = path.join(appRoot, ".runtime-app", "payload");

function assertInside(candidate, root, label) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Unsafe ${label} path: ${candidate}`);
  }
}

function verifyArchive(archivePath) {
  const entries = listPackage(archivePath, { isPack: false }).map((entry) =>
    entry.replaceAll("\\", "/"),
  );
  if (!entries.includes("/package.json")) {
    throw new Error("Rebuilt ASAR does not contain /package.json.");
  }
  const runtimePackage = JSON.parse(
    extractFile(archivePath, "package.json").toString("utf8"),
  );
  if (!runtimePackage.main) {
    throw new Error("Rebuilt ASAR package.json has no main entry.");
  }
  const mainPath = runtimePackage.main.split("/").join(path.sep);
  statFile(archivePath, mainPath);
  return runtimePackage;
}

async function replaceIntegrityResource(executablePath, asarPath, version) {
  const { headerString } = getRawHeader(asarPath);
  const hash = crypto
    .createHash("sha256")
    .update(headerString)
    .digest("hex");
  const executable = NtExecutable.from(await fs.readFile(executablePath));
  const resource = NtExecutableResource.from(executable);
  const versionInfo = Resource.VersionInfo.fromEntries(resource.entries);
  if (versionInfo.length !== 1) {
    throw new Error(`Expected one version resource in ${executablePath}.`);
  }
  const languages = versionInfo[0].getAllLanguagesForStringValues();
  if (languages.length !== 1) {
    throw new Error(`Expected one version language in ${executablePath}.`);
  }
  for (let index = resource.entries.length - 1; index >= 0; index--) {
    const entry = resource.entries[index];
    if (
      String(entry.type).toUpperCase() === "INTEGRITY" &&
      String(entry.id).toUpperCase() === "ELECTRONASAR"
    ) {
      resource.entries.splice(index, 1);
    }
  }
  resource.entries.push({
    type: "INTEGRITY",
    id: "ELECTRONASAR",
    bin: Buffer.from(
      JSON.stringify([
        {
          file: "app.asar",
          alg: "SHA256",
          value: hash,
        },
      ]),
    ),
    lang: languages[0].lang,
    codepage: languages[0].codepage,
  });
  const match = String(version).match(
    /^(\d+)\.(\d+)\.(\d+)(?:-[^.]+\.(\d+))?/u,
  );
  const numericVersion = match
    ? match.slice(1, 5).map((value) => Number(value || 0))
    : [0, 0, 0, 0];
  versionInfo[0].setFileVersion(...numericVersion, languages[0].lang);
  versionInfo[0].setProductVersion(...numericVersion, languages[0].lang);
  versionInfo[0].setStringValues(languages[0], {
    FileDescription: "PaceSpace Metadata Cleaner",
    FileVersion: String(version),
    InternalName: "psmetac",
    OriginalFilename: "psmetac.exe",
    ProductName: "PaceSpace Metadata Cleaner",
    ProductVersion: String(version),
    LegalCopyright: "Copyright © PaceSpace. All Rights Reserved.",
  });
  versionInfo[0].outputToResourceEntries(resource.entries);
  resource.outputResource(executable);
  await fs.writeFile(executablePath, Buffer.from(executable.generate()));
  return hash;
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;
  assertInside(context.appOutDir, distRoot, "pack output");
  const resourcesPath = path.join(context.appOutDir, "resources");
  const asarPath = path.join(resourcesPath, "app.asar");
  const temporaryAsar = path.join(resourcesPath, "app.asar.rebuilt");
  assertInside(asarPath, distRoot, "ASAR output");
  assertInside(temporaryAsar, distRoot, "temporary ASAR");

  await fs.rm(temporaryAsar, { force: true });
  await createPackage(payloadRoot, temporaryAsar);
  const runtimePackage = verifyArchive(temporaryAsar);
  await fs.rm(asarPath, { force: true });
  await fs.rename(temporaryAsar, asarPath);

  const executablePath = path.join(
    context.appOutDir,
    "psmetac.exe",
  );
  const asarHeaderSha256 = await replaceIntegrityResource(
    executablePath,
    asarPath,
    runtimePackage.version,
  );
  process.stdout.write(
    `${JSON.stringify({
      status: "rebuilt-asar-verified",
      main: runtimePackage.main,
      asarHeaderSha256,
    })}\n`,
  );
}
