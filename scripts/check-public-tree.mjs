import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = execFileSync("git", ["ls-files", "--cached", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0").filter(Boolean);
if (!files.length) throw new Error("No tracked files to inspect; stage the public snapshot first.");
const forbidden = /(?:^|\/)(?:node_modules|dist[^/]*|\.runtime-app|\.test-artifacts|\.ui-test[^/]*|\.local|app_data|desktop_smoke|\.env(?:\.[^/]*)?)(?:\/|$)|\.(?:psd|psb|sqlite(?:-[^/]*)?|db|pfx|p12|pem|exe|zip|log|blockmap)$/i;
const secretPatterns = [
  /gh[pousr]_[A-Za-z0-9_]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /AKIA[A-Z0-9]{16}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];
const binary = new Set([".png", ".bmp", ".ico"]);
const findings = [];
for (const file of files) {
  if (forbidden.test(file)) findings.push(`${file}: runtime/private file`);
  const stat = await fs.lstat(path.join(root, file));
  if (!stat.isFile() || stat.isSymbolicLink()) {
    findings.push(`${file}: not a regular file`);
    continue;
  }
  if (stat.size > 2 * 1024 * 1024) findings.push(`${file}: unexpectedly large source file`);
  if (binary.has(path.extname(file))) continue;
  const content = await fs.readFile(path.join(root, file), "utf8");
  if (secretPatterns.some((pattern) => pattern.test(content))) findings.push(`${file}: possible secret`);
  if (/C:[\\/]+Users[\\/]+(?!<|Public\b|Default\b)[^\\/\s"']+/i.test(content)) {
    findings.push(`${file}: personal user profile path`);
  }
}
if (findings.length) throw new Error(`Public tree inspection failed:\n${findings.join("\n")}`);
process.stdout.write(`${JSON.stringify({ status: "public-tree-checked", files: files.length, findings: 0 })}\n`);
