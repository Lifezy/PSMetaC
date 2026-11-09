import type {
  CleanupEstimate,
  CleanupProfile,
  InspectionResult,
  PolicyDecision,
} from "./types.ts";

const MIB = 1024 ** 2;
const ACTIVE_MS_PER_OBJECT = 8_640;

export const PROFILE_DEFINITIONS: Record<
  CleanupProfile,
  {
    title: string;
    description: string;
    minimumBytes: number;
    minimumPercent: number;
    anyDocumentAncestors: boolean;
  }
> = {
  standard: {
    title: "标准",
    description: "预计可清理量达到 64 MB（按 Windows 常用方式）或源文件的 5%。",
    minimumBytes: 64 * MIB,
    minimumPercent: 5,
    anyDocumentAncestors: false,
  },
  deep: {
    title: "深度",
    description: "只要发现 DocumentAncestors 就执行。",
    minimumBytes: 0,
    minimumPercent: 0,
    anyDocumentAncestors: true,
  },
  conservative: {
    title: "保守",
    description: "预计可清理量达到 256 MB（按 Windows 常用方式）或源文件的 10%。",
    minimumBytes: 256 * MIB,
    minimumPercent: 10,
    anyDocumentAncestors: false,
  },
};

export function collectParserWarnings(
  inspection: InspectionResult,
): string[] {
  const warnings = [...(inspection.warnings || [])];
  for (const container of inspection.containers || []) {
    for (const warning of container.warnings || []) {
      warnings.push(`${container.id}: ${warning}`);
    }
  }
  return [...new Set(warnings)];
}

export function estimateCleanup(
  inspection: InspectionResult,
): CleanupEstimate {
  const affected = (inspection.containers || []).filter(
    (container) => (container.xmp?.documentAncestors || 0) > 0,
  );
  const affectedXmpBytes = affected.reduce(
    (sum, container) => sum + Number(container.xmp?.bytes || 0),
    0,
  );
  const fileBytes = Number(inspection.fileBytes || 0);
  const plannedObjects = Number(
    inspection.cleanupPlan?.recordsRequiredToOpen || 0,
  );
  const center = plannedObjects * ACTIVE_MS_PER_OBJECT;
  return {
    affectedContainers: affected.length,
    affectedXmpBytes,
    affectedPercentOfSource:
      fileBytes > 0 ? (affectedXmpBytes / fileBytes) * 100 : 0,
    plannedObjects,
    estimatedPhotoshopActiveMs: center,
    estimatedPhotoshopRangeMs: {
      low: Math.round(center * 0.55),
      high: Math.round(center * 1.75),
    },
  };
}

export function evaluatePolicy(
  inspection: InspectionResult,
  profile: CleanupProfile,
): PolicyDecision {
  const definition = PROFILE_DEFINITIONS[profile];
  const estimate = estimateCleanup(inspection);
  const hasAncestors =
    Number(inspection.summary?.allDocumentAncestors || 0) > 0 &&
    Number(inspection.cleanupPlan?.anomalousContainers || 0) > 0;
  if (!hasAncestors) {
    return {
      eligible: false,
      profile,
      reasonCode: "NO_DOCUMENT_ANCESTORS",
      explanation: "预检未发现需要清理的 DocumentAncestors。",
      estimate,
    };
  }
  const eligible =
    definition.anyDocumentAncestors ||
    estimate.affectedXmpBytes >= definition.minimumBytes ||
    estimate.affectedPercentOfSource >= definition.minimumPercent;
  return {
    eligible,
    profile,
    reasonCode: eligible ? "ELIGIBLE" : "BELOW_PROFILE_THRESHOLD",
    explanation: eligible
      ? `符合“${definition.title}”策略。`
      : `未达到“${definition.title}”策略门槛。`,
    estimate,
  };
}
