import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveLegacyAssets } from "./legacy-assets.ts";
import type {
  InspectionResult,
  PixelComparison,
  ValidationCheck,
} from "./types.ts";
import { DEFAULT_VALIDATION_CHECKS } from "./types.ts";
import { collectParserWarnings } from "./policies.ts";

const VALIDATION_ERROR_CHECKS: Record<string, ValidationCheck> = {
  PLAN_COVERAGE_FAILED: "smart_object_success",
  REOPEN_STATE_MISMATCH: "reopen_success",
  SMART_OBJECT_FAILURES: "smart_object_success",
  STRICT_ID_NAME_FALLBACK: "smart_object_asset_ids",
  STRICT_ID_MISSING_DIRECT_PLAN_IDS: "smart_object_asset_ids",
  STRICT_ID_AUDIT_NAME_FALLBACK: "smart_object_asset_ids",
  POSTFLIGHT_PARSER_WARNINGS: "parser_clean",
  DOCUMENT_ANCESTORS_REMAIN: "target_xmp_removed",
  STRUCTURE_TOPOLOGY_MISMATCH: "structure_topology",
  SMART_OBJECT_ASSET_IDS_CHANGED: "smart_object_asset_ids",
  PIXEL_COMPARISON_UNAVAILABLE: "pixel_exact",
  PIXEL_NOT_EXACT: "pixel_exact",
  SAVE_RENDER_NOT_EXACT: "render_consistency",
  REOPEN_RENDER_NOT_EXACT: "render_consistency",
};

const HARD_VALIDATION_ERRORS = new Set([
  "SOURCE_CHANGED",
  "PHOTOSHOP_NOT_DONE",
]);

export function selectedBlockingErrors(
  errors: string[],
  requiredValidationChecks: ValidationCheck[] =
    DEFAULT_VALIDATION_CHECKS,
): string[] {
  const required = new Set(requiredValidationChecks);
  return [...new Set(errors)].filter((error) => {
    if (HARD_VALIDATION_ERRORS.has(error)) return true;
    const check = VALIDATION_ERROR_CHECKS[error];
    return check ? required.has(check) : true;
  });
}

export function strictPixelGate(comparison: PixelComparison): {
  passed: boolean;
  reasonCode: "PIXEL_EXACT" | "PIXEL_NOT_EXACT" | "PIXEL_UNAVAILABLE";
} {
  if (!comparison.comparable) {
    return { passed: false, reasonCode: "PIXEL_UNAVAILABLE" };
  }
  return comparison.exact
    ? { passed: true, reasonCode: "PIXEL_EXACT" }
    : { passed: false, reasonCode: "PIXEL_NOT_EXACT" };
}

function lastLogLine(logText: string, marker: string): string {
  return (
    logText
      .split(/\r?\n/)
      .filter((line) => line.includes(marker))
      .at(-1) || ""
  );
}

function parseFields(line: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const field of line.split("\t")) {
    const index = field.indexOf("=");
    if (index > 0) {
      result[field.slice(0, index)] = field.slice(index + 1);
    }
  }
  return result;
}

export function structureFingerprint(inspection: InspectionResult): string {
  return JSON.stringify({
    containers: (inspection.containers || []).map((item) => ({
      id: item.id,
      parentId: item.parentId,
      depth: item.depth,
      format: item.format,
      channels: item.channels,
      width: item.width,
      height: item.height,
      depthBits: item.depthBits,
      colorMode: item.colorMode,
      layerCount: item.layerCount,
      linkedBlocks: item.linkedBlocks,
    })),
    records: (inspection.linkedRecords || []).map((item) => ({
      id: item.id,
      parentId: item.parentId,
      depth: item.depth,
      type: item.type,
      uniqueId: item.uniqueId,
      originalName: item.originalName,
      fileType: item.fileType,
      fileCreator: item.fileCreator,
      nestedPsdFound: item.nestedPsdFound,
    })),
  });
}

export function compareStructure(
  before: InspectionResult,
  after: InspectionResult,
): {
  passed: boolean;
  topologyMatch: boolean;
  assetIdsMatch: boolean;
  assetIdChanges: Array<{
    recordId: string;
    beforeUniqueId: string | null;
    afterUniqueId: string | null;
  }>;
} {
  const containerTopology = (inspection: InspectionResult) =>
    (inspection.containers || []).map((item) => ({
      id: item.id,
      parentId: item.parentId,
      depth: item.depth,
      format: item.format,
      channels: item.channels,
      width: item.width,
      height: item.height,
      depthBits: item.depthBits,
      colorMode: item.colorMode,
      layerCount: item.layerCount,
      linkedBlocks: item.linkedBlocks,
    }));
  const recordTopology = (inspection: InspectionResult) =>
    (inspection.linkedRecords || []).map((item) => ({
      id: item.id,
      parentId: item.parentId,
      depth: item.depth,
      type: item.type,
      originalName: item.originalName,
      fileType: item.fileType,
      fileCreator: item.fileCreator,
      nestedPsdFound: item.nestedPsdFound,
    }));
  const topologyMatch =
    JSON.stringify({
      containers: containerTopology(before),
      records: recordTopology(before),
    }) ===
    JSON.stringify({
      containers: containerTopology(after),
      records: recordTopology(after),
    });
  const afterById = new Map(
    (after.linkedRecords || []).map((item) => [String(item.id), item]),
  );
  const assetIdChanges = (before.linkedRecords || []).flatMap((item) => {
    const matching = afterById.get(String(item.id));
    if (!matching || item.uniqueId === matching.uniqueId) return [];
    return [
      {
        recordId: String(item.id),
        beforeUniqueId: item.uniqueId ? String(item.uniqueId) : null,
        afterUniqueId: matching.uniqueId
          ? String(matching.uniqueId)
          : null,
      },
    ];
  });
  const assetIdsMatch =
    topologyMatch &&
    assetIdChanges.length === 0 &&
    (before.linkedRecords || []).length ===
      (after.linkedRecords || []).length;
  return {
    passed: topologyMatch && assetIdsMatch,
    topologyMatch,
    assetIdsMatch,
    assetIdChanges,
  };
}

export async function collectPixelComparisons(
  artifactDirectory: string,
): Promise<{
  beforeVsAfterProcessing: PixelComparison;
  beforeVsAfterReopen: PixelComparison;
  afterProcessingVsAfterSave: PixelComparison;
  afterProcessingVsAfterReopen: PixelComparison;
}> {
  const assets = resolveLegacyAssets();
  const module = await import(pathToFileURL(assets.pixelCompare).href);
  const compare = async (left: string, right: string): Promise<PixelComparison> => {
    try {
      return await module.comparePngFiles(
        path.join(artifactDirectory, left),
        path.join(artifactDirectory, right),
      );
    } catch (error) {
      return {
        comparable: false,
        exact: false,
        reason: (error as Error).message,
      };
    }
  };
  return {
    beforeVsAfterProcessing: await compare("before.png", "after_processing.png"),
    beforeVsAfterReopen: await compare("before.png", "after_reopen.png"),
    afterProcessingVsAfterSave: await compare(
      "after_processing.png",
      "after_save.png",
    ),
    afterProcessingVsAfterReopen: await compare(
      "after_processing.png",
      "after_reopen.png",
    ),
  };
}

export async function validateCleanup(input: {
  preflight: InspectionResult;
  postflight: InspectionResult;
  artifactDirectory: string;
  sourceUnchanged: boolean;
  requiredValidationChecks?: ValidationCheck[];
}): Promise<{
  passed: boolean;
  errors: string[];
  blockingErrors: string[];
  warnings: string[];
  requiredValidationChecks: ValidationCheck[];
  checkResults: Record<ValidationCheck, boolean>;
  photoshopSummary: Record<string, string>;
  smartObjectFailures: string[];
  structureMatch: boolean;
  pixel: Awaited<ReturnType<typeof collectPixelComparisons>>;
}> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const logPath = path.join(input.artifactDirectory, "photoshop.log");
  const logText = await fs.readFile(logPath, "utf8").catch(() => "");
  const summary = parseFields(lastLogLine(logText, "\tSUMMARY\t"));
  const idAudit = parseFields(lastLogLine(logText, "\tID_AUDIT\tSUMMARY\t"));
  const smartObjectFailures = logText
    .split(/\r?\n/)
    .filter((line) => line.includes("\tSMART_OBJECT\tERROR\t"));
  if (!input.sourceUnchanged) errors.push("SOURCE_CHANGED");
  if (!logText.includes("\tSTATUS=DONE\t")) errors.push("PHOTOSHOP_NOT_DONE");
  if (!logText.includes("\tPREFLIGHT_PLAN\tCOVERAGE_OK\t")) {
    errors.push("PLAN_COVERAGE_FAILED");
  }
  if (!logText.includes("\tSTATE_REOPEN\tOK\t")) {
    errors.push("REOPEN_STATE_MISMATCH");
  }
  if (Number(summary.failedSmartObjects) !== 0 || smartObjectFailures.length) {
    errors.push("SMART_OBJECT_FAILURES");
  }
  if (Number(summary.planNameFallbackMatches) !== 0) {
    errors.push("STRICT_ID_NAME_FALLBACK");
  }
  if (Number(idAudit.missingDirectPlanIds) !== 0) {
    errors.push("STRICT_ID_MISSING_DIRECT_PLAN_IDS");
  }
  if (Number(idAudit.nameFallbackLayers) !== 0) {
    errors.push("STRICT_ID_AUDIT_NAME_FALLBACK");
  }
  const postWarnings = collectParserWarnings(input.postflight);
  if (postWarnings.length) errors.push("POSTFLIGHT_PARSER_WARNINGS");
  if (Number(input.postflight.summary.allDocumentAncestors) !== 0) {
    errors.push("DOCUMENT_ANCESTORS_REMAIN");
  }
  const structure = compareStructure(input.preflight, input.postflight);
  if (!structure.topologyMatch) {
    errors.push("STRUCTURE_TOPOLOGY_MISMATCH");
  } else if (!structure.assetIdsMatch) {
    errors.push("SMART_OBJECT_ASSET_IDS_CHANGED");
  }

  const pixel = await collectPixelComparisons(input.artifactDirectory);
  const pixelGate = strictPixelGate(pixel.beforeVsAfterProcessing);
  if (pixelGate.reasonCode === "PIXEL_UNAVAILABLE") {
    errors.push("PIXEL_COMPARISON_UNAVAILABLE");
  } else if (!pixelGate.passed) errors.push(pixelGate.reasonCode);
  if (!pixel.afterProcessingVsAfterSave.exact) {
    errors.push("SAVE_RENDER_NOT_EXACT");
  }
  if (!pixel.afterProcessingVsAfterReopen.exact) {
    errors.push("REOPEN_RENDER_NOT_EXACT");
  }
  if (
    Number(input.preflight.cleanupPlan.crossBitDepthRecords || 0) > 0
  ) {
    warnings.push("CROSS_BIT_DEPTH_PATHS_PRESENT");
  }
  const uniqueErrors = [...new Set(errors)];
  const requiredValidationChecks =
    input.requiredValidationChecks || DEFAULT_VALIDATION_CHECKS;
  const blockingErrors = selectedBlockingErrors(
    uniqueErrors,
    requiredValidationChecks,
  );
  const checkResults = Object.fromEntries(
    [
      "target_xmp_removed",
      "structure_topology",
      "smart_object_asset_ids",
      "smart_object_success",
      "reopen_success",
      "pixel_exact",
      "render_consistency",
      "parser_clean",
    ].map((check) => [
      check,
      !uniqueErrors.some(
        (error) => VALIDATION_ERROR_CHECKS[error] === check,
      ),
    ]),
  ) as Record<ValidationCheck, boolean>;
  return {
    passed: blockingErrors.length === 0,
    errors: uniqueErrors,
    blockingErrors,
    warnings,
    requiredValidationChecks,
    checkResults,
    photoshopSummary: summary,
    smartObjectFailures,
    structureMatch: structure.passed,
    structure,
    pixel,
  };
}
