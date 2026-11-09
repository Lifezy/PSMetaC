import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const runtimeRoot = path.join(appRoot, ".runtime-app");

function assertSafeRuntimeRoot() {
  const expected = path.resolve(appRoot, ".runtime-app");
  if (path.resolve(runtimeRoot) !== expected || runtimeRoot === appRoot) {
    throw new Error(`Unsafe runtime staging path: ${runtimeRoot}`);
  }
}

export async function prepareRuntime() {
  assertSafeRuntimeRoot();
  const sourcePackage = JSON.parse(
    await fs.readFile(path.join(appRoot, "package.json"), "utf8"),
  );
  const runtimePackage = {
    name: sourcePackage.name,
    version: sourcePackage.version,
    private: true,
    type: sourcePackage.type,
    description: sourcePackage.description,
    author: sourcePackage.author,
    license: sourcePackage.license,
    repository: sourcePackage.repository,
    main: sourcePackage.main,
    engines: sourcePackage.engines,
  };

  await fs.rm(runtimeRoot, { recursive: true, force: true });
  await fs.mkdir(runtimeRoot, { recursive: true });
  await fs.cp(path.join(appRoot, "src"), path.join(runtimeRoot, "src"), {
    recursive: true,
    force: true,
  });
  await fs.writeFile(
    path.join(runtimeRoot, "package.json"),
    `${JSON.stringify(runtimePackage, null, 2)}\n`,
    "utf8",
  );
  const payloadRoot = path.join(runtimeRoot, "payload");
  await fs.mkdir(payloadRoot, { recursive: true });
  await fs.cp(path.join(appRoot, "src"), path.join(payloadRoot, "src"), {
    recursive: true,
    force: true,
  });
  await fs.writeFile(
    path.join(payloadRoot, "package.json"),
    `${JSON.stringify(runtimePackage, null, 2)}\n`,
    "utf8",
  );
  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    await fs.copyFile(path.join(appRoot, name), path.join(runtimeRoot, name));
    await fs.copyFile(path.join(appRoot, name), path.join(payloadRoot, name));
  }

  return {
    runtimeRoot,
    packagePath: path.join(runtimeRoot, "package.json"),
    payloadRoot,
    packagedManifestPath: path.join(payloadRoot, "package.json"),
    version: runtimePackage.version,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  const result = await prepareRuntime();
  process.stdout.write(
    `${JSON.stringify({ status: "runtime-prepared", ...result }, null, 2)}\n`,
  );
}
