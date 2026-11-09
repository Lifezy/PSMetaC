import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface LegacyAssets {
  root: string;
  inspector: string;
  cleanupJsx: string;
  pixelCompare: string;
  bridgeVbs: string;
  idleProbeVbs: string;
  bridgeProbeVbs: string;
}

export function resolveLegacyAssets(): LegacyAssets {
  const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
  const resourcesPath = (
    process as NodeJS.Process & { resourcesPath?: string }
  ).resourcesPath;
  const candidates = [
    path.resolve(sourceDirectory, "..", "vendor", "psb_batch_tool"),
    path.resolve(sourceDirectory, "..", "..", "psb_batch_tool"),
    resourcesPath ? path.join(resourcesPath, "psb_batch_tool") : "",
  ].filter(Boolean);
  const root = candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, "psb_recursive_inspect.mjs")),
  );
  if (!root) {
    throw new Error(
      `Unable to locate validated PSB scripts. Checked: ${candidates.join(", ")}`,
    );
  }
  return {
    root,
    inspector: path.join(root, "psb_recursive_inspect.mjs"),
    cleanupJsx: path.join(root, "psb_metadata_cleanup.jsx"),
    pixelCompare: path.join(root, "pixel_compare.mjs"),
    bridgeVbs: path.join(root, "run_photoshop_jsx.vbs"),
    idleProbeVbs: resourcesPath
      ? path.join(resourcesPath, "scripts", "photoshop_idle_probe.vbs")
      : path.resolve(
          sourceDirectory,
          "..",
          "scripts",
          "photoshop_idle_probe.vbs",
        ),
    bridgeProbeVbs: resourcesPath
      ? path.join(resourcesPath, "scripts", "photoshop_bridge_probe.vbs")
      : path.resolve(
          sourceDirectory,
          "..",
          "scripts",
          "photoshop_bridge_probe.vbs",
        ),
  };
}
