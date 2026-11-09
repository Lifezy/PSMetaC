import fs from "node:fs/promises";
import path from "node:path";

function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const port = Number(argument("port", "9229"));
const output = path.resolve(argument("output", "ui-screenshot.png"));
const width = Number(argument("width", "1280"));
const height = Number(argument("height", "800"));
const view = argument("view", "jobs");
const theme = argument("theme", "system");

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find((item) => item.type === "page");
if (!target?.webSocketDebuggerUrl) {
  throw new Error(`No Electron page target found on port ${port}.`);
}

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let sequence = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const payload = JSON.parse(String(event.data));
  if (!payload.id || !pending.has(payload.id)) return;
  const { resolve, reject } = pending.get(payload.id);
  pending.delete(payload.id);
  if (payload.error) reject(new Error(JSON.stringify(payload.error)));
  else resolve(payload.result);
});

function call(method, params = {}) {
  const id = ++sequence;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

await call("Emulation.setDeviceMetricsOverride", {
  width,
  height,
  deviceScaleFactor: 1,
  mobile: false,
});
await call("Runtime.evaluate", {
  expression: `localStorage.setItem("psmetac.theme", ${JSON.stringify(theme)}); location.reload();`,
  awaitPromise: true,
});
await new Promise((resolve) => setTimeout(resolve, 900));
await call("Runtime.evaluate", {
  expression: `typeof showView === "function" && showView(${JSON.stringify(view)});`,
  awaitPromise: true,
});
await new Promise((resolve) => setTimeout(resolve, 450));
const result = await call("Page.captureScreenshot", {
  format: "png",
  fromSurface: true,
});
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, Buffer.from(result.data, "base64"));
socket.close();

process.stdout.write(
  `${JSON.stringify({ status: "captured", output, width, height, view, theme })}\n`,
);
