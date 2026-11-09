import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetArgument = process.argv[2];
if (!targetArgument) throw new Error("Usage: node scripts/export-open-source.mjs <new-empty-directory>");
const targetRoot = path.resolve(targetArgument);
const relative = path.relative(sourceRoot, targetRoot);
if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
  throw new Error("The export must be outside the source tree.");
}
const targetStat = await fs.lstat(targetRoot).catch((error) => {
  if (error.code === "ENOENT") return null;
  throw error;
});
if (targetStat && (!targetStat.isDirectory() || targetStat.isSymbolicLink() || (await fs.readdir(targetRoot)).length)) {
  throw new Error("Refusing to overwrite a non-empty or unsafe export target.");
}

const rootFiles = [
  ".editorconfig", ".gitattributes", ".gitignore", "LICENSE", "README.md",
  "CONTRIBUTING.md", "SECURITY.md", "THIRD_PARTY_NOTICES.md", "package.json",
  "pnpm-lock.yaml", "pnpm-workspace.yaml",
];
const publicDocs = [
  "ARCHITECTURE.md", "MCP.md", "OPERATIONS.md", "REPORTS.md",
  "RELEASE-NOTES-0.2.0-alpha.6.md", "OPEN-SOURCE.md",
];
const buildFiles = [
  "installer-alpha4.nsh", "installerHeader.bmp", "installerSidebar.bmp", "psmetac.ico",
];
const copied = [];
async function copy(relativePath) {
  const source = path.join(sourceRoot, relativePath);
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) throw new Error(`Symlink excluded: ${relativePath}`);
  if (stat.isDirectory()) {
    for (const child of (await fs.readdir(source)).sort()) {
      await copy(path.join(relativePath, child));
    }
  } else if (stat.isFile()) {
    const target = path.join(targetRoot, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
    copied.push(relativePath.replaceAll("\\", "/"));
  }
}
await fs.mkdir(targetRoot, { recursive: true });
for (const name of rootFiles) await copy(name);
for (const name of ["src", "tests", "scripts", "fixtures", "vendor", ".github"]) await copy(name);
for (const name of publicDocs) await copy(path.join("docs", name));
for (const name of buildFiles) await copy(path.join("build", name));
process.stdout.write(`${JSON.stringify({ targetRoot, fileCount: copied.length, files: copied }, null, 2)}\n`);
