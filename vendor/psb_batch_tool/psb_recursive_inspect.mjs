import fs from "node:fs/promises";

const target = process.argv[2];
const cleanupPlanOutput = process.argv[3] || "";
if (!target) {
  throw new Error(
    "Usage: node psb_recursive_embedded_inspect.mjs <psb-path> [cleanup-plan.tsv]",
  );
}

const handle = await fs.open(target, "r");
const stat = await handle.stat();
const MAX_DEPTH = 6;
const MAX_RECORDS = 2000;
const SKIP_XMP_PATTERN_SCAN = process.env.PSB_SKIP_XMP_PATTERN_SCAN === "1";
const COMPACT_OUTPUT = process.env.PSB_COMPACT_OUTPUT === "1";
const containers = [];
const linkedRecords = [];
const warnings = [];

async function readAt(position, length) {
  if (length === 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) {
    throw new Error(`Short read at ${position}: expected ${length}, got ${bytesRead}`);
  }
  return buffer;
}

function u64(buffer, offset = 0) {
  const value = buffer.readBigUInt64BE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`64-bit value exceeds JS safe integer: ${value}`);
  }
  return Number(value);
}

function giB(bytes) {
  return Number((bytes / (1024 ** 3)).toFixed(6));
}

function miB(bytes) {
  return Number((bytes / (1024 ** 2)).toFixed(3));
}

function decodeUtf16Be(buffer) {
  const evenLength = buffer.length - (buffer.length % 2);
  const swapped = Buffer.alloc(evenLength);
  for (let i = 0; i < evenLength; i += 2) {
    swapped[i] = buffer[i + 1];
    swapped[i + 1] = buffer[i];
  }
  return swapped.toString("utf16le").replace(/\0+$/g, "");
}

async function readPascalString(position) {
  const length = (await readAt(position, 1)).readUInt8(0);
  const data = await readAt(position + 1, length);
  return {
    value: data.toString("utf8"),
    next: position + 1 + length,
  };
}

async function readUnicodeString(position) {
  const count = (await readAt(position, 4)).readUInt32BE(0);
  if (count > 10_000_000) throw new Error(`Unreasonable Unicode length ${count} at ${position}`);
  const data = await readAt(position + 4, count * 2);
  return {
    value: decodeUtf16Be(data),
    next: position + 4 + count * 2,
  };
}

async function countPatterns(start, length) {
  const patternNames = {
    documentAncestors: "photoshop:DocumentAncestors",
    documentAncestorsElement: "<photoshop:DocumentAncestors",
    rdfListItems: "<rdf:li",
    xmpHistory: "xmpMM:History",
    historyActions: "stEvt:action",
  };
  const entries = Object.entries(patternNames).map(([key, value]) => ({
    key,
    needle: Buffer.from(value, "utf8"),
  }));
  const maxPatternLength = Math.max(...entries.map((x) => x.needle.length));
  const counts = Object.fromEntries(entries.map((x) => [x.key, 0]));
  const chunkSize = 8 * 1024 * 1024;
  let tail = Buffer.alloc(0);
  let processed = 0;

  while (processed < length) {
    const toRead = Math.min(chunkSize, length - processed);
    const chunk = await readAt(start + processed, toRead);
    const combined = Buffer.concat([tail, chunk]);
    for (const { key, needle } of entries) {
      let from = 0;
      while (from <= combined.length - needle.length) {
        const index = combined.indexOf(needle, from);
        if (index === -1) break;
        if (index + needle.length > tail.length) counts[key]++;
        from = index + needle.length;
      }
    }
    tail = combined.subarray(Math.max(0, combined.length - maxPatternLength + 1));
    processed += toRead;
  }
  return counts;
}

async function parseImageResources(start, length) {
  const end = start + length;
  const resources = [];
  let cursor = start;
  let warning = null;

  while (cursor < end) {
    if (end - cursor < 12) {
      warning = `Trailing ${end - cursor} image-resource bytes`;
      break;
    }
    const prefix = await readAt(cursor, Math.min(32, end - cursor));
    const signature = prefix.toString("ascii", 0, 4);
    if (!["8BIM", "MeSa", "PHUT", "AgHg", "DCSR"].includes(signature)) {
      warning = `Unexpected image-resource signature ${JSON.stringify(signature)} at ${cursor}`;
      break;
    }
    const id = prefix.readUInt16BE(4);
    const nameLength = prefix.readUInt8(6);
    const pascalBytes = 1 + nameLength;
    const paddedNameBytes = pascalBytes + (pascalBytes % 2);
    const sizeOffset = cursor + 6 + paddedNameBytes;
    const dataLength = (await readAt(sizeOffset, 4)).readUInt32BE(0);
    const dataOffset = sizeOffset + 4;
    const paddedDataLength = dataLength + (dataLength % 2);
    const next = dataOffset + paddedDataLength;
    if (next > end) {
      warning = `Image resource ${id} extends beyond section`;
      break;
    }
    resources.push({ id, dataOffset, bytes: dataLength });
    cursor = next;
  }
  return { resources, warning };
}

const psbEightByteKeys = new Set([
  "LMsk", "Lr16", "Lr32", "Layr", "Mt16", "Mt32", "Mtrn",
  "Alph", "FMsk", "lnk2", "FEid", "FXid", "PxSD",
]);

async function locateGlobalAdditionalInfo(layerMaskStart, layerMaskLength, version) {
  const lengthBytes = version === 2 ? 8 : 4;
  const sectionEnd = layerMaskStart + layerMaskLength;
  if (layerMaskLength < lengthBytes) {
    return { layerCount: 0, channelDataBytes: 0, start: sectionEnd, length: 0, warning: null };
  }
  const layerInfoLengthBuffer = await readAt(layerMaskStart, lengthBytes);
  const layerInfoLength = version === 2
    ? u64(layerInfoLengthBuffer)
    : layerInfoLengthBuffer.readUInt32BE(0);
  const layerInfoStart = layerMaskStart + lengthBytes;
  const layerInfoEnd = layerInfoStart + layerInfoLength;
  if (layerInfoEnd > sectionEnd) {
    return {
      layerCount: 0,
      channelDataBytes: 0,
      start: sectionEnd,
      length: 0,
      warning: "Layer-info section extends beyond layer/mask section",
    };
  }

  let layerCount = 0;
  let channelDataBytes = 0;
  if (layerInfoLength >= 2) {
    const signedCount = (await readAt(layerInfoStart, 2)).readInt16BE(0);
    layerCount = Math.abs(signedCount);
    let cursor = layerInfoStart + 2;
    for (let i = 0; i < layerCount; i++) {
      const fixed = await readAt(cursor, 18);
      const channelCount = fixed.readUInt16BE(16);
      const descriptorBytes = channelCount * (2 + lengthBytes);
      const channelDescriptors = await readAt(cursor + 18, descriptorBytes);
      for (let c = 0; c < channelCount; c++) {
        const lengthOffset = c * (2 + lengthBytes) + 2;
        channelDataBytes += version === 2
          ? u64(channelDescriptors, lengthOffset)
          : channelDescriptors.readUInt32BE(lengthOffset);
      }
      const blendOffset = cursor + 18 + descriptorBytes;
      const blendAndExtra = await readAt(blendOffset, 16);
      const extraLength = blendAndExtra.readUInt32BE(12);
      cursor = blendOffset + 16 + extraLength;
      if (cursor > layerInfoEnd) {
        return {
          layerCount,
          channelDataBytes,
          start: sectionEnd,
          length: 0,
          warning: `Layer record ${i} extends beyond layer-info section`,
        };
      }
    }
  }

  if (layerInfoEnd + 4 > sectionEnd) {
    return { layerCount, channelDataBytes, start: sectionEnd, length: 0, warning: null };
  }
  const globalMaskLength = (await readAt(layerInfoEnd, 4)).readUInt32BE(0);
  const additionalStart = layerInfoEnd + 4 + globalMaskLength;
  if (additionalStart > sectionEnd) {
    return {
      layerCount,
      channelDataBytes,
      start: sectionEnd,
      length: 0,
      warning: "Global layer mask extends beyond section",
    };
  }
  return {
    layerCount,
    channelDataBytes,
    start: additionalStart,
    length: sectionEnd - additionalStart,
    warning: null,
  };
}

async function parseAdditionalBlocks(start, length, version) {
  const end = start + length;
  const blocks = [];
  let cursor = start;
  let warning = null;
  while (cursor < end) {
    if (end - cursor < 12) {
      warning = `Trailing ${end - cursor} additional-info bytes`;
      break;
    }
    const prefix = await readAt(cursor, Math.min(20, end - cursor));
    const signature = prefix.toString("ascii", 0, 4);
    const key = prefix.toString("ascii", 4, 8);
    if (!["8BIM", "8B64"].includes(signature)) {
      warning = `Unexpected additional-info signature ${JSON.stringify(signature)} at ${cursor}`;
      break;
    }
    const lengthBytes = signature === "8B64" ||
      (version === 2 && psbEightByteKeys.has(key))
      ? 8
      : 4;
    const lengthBuffer = await readAt(cursor + 8, lengthBytes);
    const dataLength = lengthBytes === 8 ? u64(lengthBuffer) : lengthBuffer.readUInt32BE(0);
    const dataOffset = cursor + 8 + lengthBytes;
    const paddedLength = dataLength + ((4 - (dataLength % 4)) % 4);
    const next = dataOffset + paddedLength;
    if (next > end) {
      warning = `Additional block ${key} extends beyond section`;
      break;
    }
    blocks.push({ signature, key, dataOffset, bytes: dataLength });
    cursor = next;
  }
  return { blocks, warning };
}

async function findNestedPsd(start, end) {
  const pattern = Buffer.from("8BPS", "ascii");
  const maxEnd = Math.min(end, start + 32 * 1024 * 1024);
  const chunkSize = 2 * 1024 * 1024;
  let cursor = start;
  let tail = Buffer.alloc(0);
  while (cursor < maxEnd) {
    const toRead = Math.min(chunkSize, maxEnd - cursor);
    const chunk = await readAt(cursor, toRead);
    const combined = Buffer.concat([tail, chunk]);
    let from = 0;
    while (from <= combined.length - 26) {
      const index = combined.indexOf(pattern, from);
      if (index === -1) break;
      const absolute = cursor - tail.length + index;
      if (absolute >= start && absolute + 26 <= end) {
        const candidate = await readAt(absolute, 26);
        const version = candidate.readUInt16BE(4);
        const reservedZero = candidate.subarray(6, 12).every((x) => x === 0);
        const channels = candidate.readUInt16BE(12);
        const height = candidate.readUInt32BE(14);
        const width = candidate.readUInt32BE(18);
        if ([1, 2].includes(version) && reservedZero &&
            channels >= 1 && channels <= 56 && height > 0 && width > 0) {
          return absolute;
        }
      }
      from = index + 4;
    }
    tail = combined.subarray(Math.max(0, combined.length - 25));
    cursor += toRead;
  }
  return null;
}

async function parseLinkedRecords(block, parentId, depth) {
  const end = block.dataOffset + block.bytes;
  let cursor = block.dataOffset;
  let localIndex = 0;

  while (cursor + 8 <= end) {
    if (linkedRecords.length >= MAX_RECORDS) {
      warnings.push("Linked record limit reached");
      return;
    }
    const recordLength = u64(await readAt(cursor, 8));
    if (recordLength === 0) {
      if (end - cursor <= 8) return;
      warnings.push(`Zero linked-record length at ${cursor}`);
      return;
    }
    const bodyStart = cursor + 8;
    const recordEnd = bodyStart + recordLength;
    if (recordEnd > end) {
      warnings.push(`Linked record at ${cursor} extends beyond lnk2 block`);
      return;
    }
    let p = bodyStart;
    const type = (await readAt(p, 4)).toString("ascii"); p += 4;
    const recordVersion = (await readAt(p, 4)).readUInt32BE(0); p += 4;
    const unique = await readPascalString(p); p = unique.next;
    const originalName = await readUnicodeString(p); p = originalName.next;
    const fileType = (await readAt(p, 4)).toString("ascii"); p += 4;
    const fileCreator = (await readAt(p, 4)).toString("ascii"); p += 4;
    const payloadBytes = u64(await readAt(p, 8)); p += 8;
    const hasOpenDescriptor = (await readAt(p, 1)).readUInt8(0) !== 0; p += 1;
    const nestedOffset = await findNestedPsd(p, recordEnd);

    const record = {
      id: `${parentId}/lnk${localIndex}`,
      parentId,
      depth,
      type,
      recordVersion,
      uniqueId: unique.value,
      originalName: originalName.value,
      fileType,
      fileCreator,
      recordBytes: recordLength,
      recordGiB: giB(recordLength),
      payloadBytes,
      payloadGiB: giB(payloadBytes),
      hasOpenDescriptor,
      nestedPsdOffset: nestedOffset,
      nestedPsdFound: nestedOffset !== null,
      trailingBytesAfterPayload: nestedOffset === null
        ? null
        : recordEnd - (nestedOffset + payloadBytes),
    };
    linkedRecords.push(record);
    localIndex++;

    if (nestedOffset !== null && depth < MAX_DEPTH) {
      const available = recordEnd - nestedOffset;
      const nestedLength = Math.min(payloadBytes, available);
      await inspectContainer(
        nestedOffset,
        nestedLength,
        depth,
        record.id,
        originalName.value || `${type}-${localIndex}`,
      );
    }
    const relativeEnd = recordEnd - block.dataOffset;
    const padding = (4 - (relativeEnd % 4)) % 4;
    cursor = recordEnd + padding;
  }
  if (cursor !== end) warnings.push(`lnk2 parsing ended ${end - cursor} bytes before block end`);
}

async function inspectContainer(baseOffset, containerLength, depth, id, label) {
  const header = await readAt(baseOffset, 30);
  const signature = header.toString("ascii", 0, 4);
  const version = header.readUInt16BE(4);
  if (signature !== "8BPS" || ![1, 2].includes(version)) {
    warnings.push(`${id}: invalid nested signature/version`);
    return;
  }
  const channels = header.readUInt16BE(12);
  const height = header.readUInt32BE(14);
  const width = header.readUInt32BE(18);
  const depthBits = header.readUInt16BE(22);
  const colorMode = header.readUInt16BE(24);
  const colorLength = header.readUInt32BE(26);
  const imageResourcesLengthOffset = baseOffset + 30 + colorLength;
  const imageResourcesLength = (await readAt(imageResourcesLengthOffset, 4)).readUInt32BE(0);
  const imageResourcesStart = imageResourcesLengthOffset + 4;
  const lengthBytes = version === 2 ? 8 : 4;
  const layerMaskLengthOffset = imageResourcesStart + imageResourcesLength;
  const layerMaskLengthBuffer = await readAt(layerMaskLengthOffset, lengthBytes);
  const layerMaskLength = version === 2
    ? u64(layerMaskLengthBuffer)
    : layerMaskLengthBuffer.readUInt32BE(0);
  const layerMaskStart = layerMaskLengthOffset + lengthBytes;
  const imageDataStart = layerMaskStart + layerMaskLength;
  const imageDataBytes = Math.max(0, baseOffset + containerLength - imageDataStart);

  const imageResources = await parseImageResources(imageResourcesStart, imageResourcesLength);
  const xmpResources = imageResources.resources.filter((r) => r.id === 1060);
  let xmpBytes = 0;
  const xmpCounts = {
    documentAncestors: 0,
    documentAncestorsElement: 0,
    rdfListItems: 0,
    xmpHistory: 0,
    historyActions: 0,
  };
  for (const xmp of xmpResources) {
    xmpBytes += xmp.bytes;
    if (!SKIP_XMP_PATTERN_SCAN) {
      if (!COMPACT_OUTPUT) console.error(`${id}: scanning XMP ${miB(xmp.bytes)} MiB`);
      const counts = await countPatterns(xmp.dataOffset, xmp.bytes);
      for (const key of Object.keys(xmpCounts)) xmpCounts[key] += counts[key];
    }
  }

  const globalInfo = await locateGlobalAdditionalInfo(layerMaskStart, layerMaskLength, version);
  const additional = await parseAdditionalBlocks(globalInfo.start, globalInfo.length, version);
  const lnkBlocks = additional.blocks.filter((b) => ["lnk2", "lnk3", "lnkD"].includes(b.key));
  const linkedBlockBytes = lnkBlocks.reduce((sum, b) => sum + b.bytes, 0);

  const container = {
    id,
    parentId: id.includes("/lnk") ? id.slice(0, id.lastIndexOf("/lnk")) : null,
    depth,
    label,
    baseOffset,
    bytes: containerLength,
    MiB: miB(containerLength),
    GiB: giB(containerLength),
    format: version === 2 ? "PSB" : "PSD",
    channels,
    width,
    height,
    depthBits,
    colorMode,
    sections: {
      imageResourcesBytes: imageResourcesLength,
      imageResourcesMiB: miB(imageResourcesLength),
      layerMaskBytes: layerMaskLength,
      layerMaskGiB: giB(layerMaskLength),
      layerChannelDataBytes: globalInfo.channelDataBytes,
      layerChannelDataMiB: miB(globalInfo.channelDataBytes),
      imageDataBytes,
      imageDataMiB: miB(imageDataBytes),
    },
    layerCount: globalInfo.layerCount,
    xmp: {
      blocks: xmpResources.length,
      bytes: xmpBytes,
      MiB: miB(xmpBytes),
      percentOfContainer: Number(((xmpBytes / containerLength) * 100).toFixed(4)),
      ...xmpCounts,
    },
    linkedBlocks: lnkBlocks.length,
    linkedBlockBytes,
    linkedBlockGiB: giB(linkedBlockBytes),
    warnings: [imageResources.warning, globalInfo.warning, additional.warning].filter(Boolean),
  };
  containers.push(container);
  if (!COMPACT_OUTPUT) {
    console.error(
      `${id}: ${label} ${giB(containerLength)} GiB, XMP ${miB(xmpBytes)} MiB, lnk ${giB(linkedBlockBytes)} GiB`,
    );
  }

  if (depth < MAX_DEPTH) {
    for (const block of lnkBlocks) {
      await parseLinkedRecords(block, id, depth + 1);
    }
  }
}

await inspectContainer(0, stat.size, 0, "root", target);

const nestedContainers = containers.filter((c) => c.depth > 0);
const totalNestedXmpBytes = nestedContainers.reduce((sum, c) => sum + c.xmp.bytes, 0);
const totalNestedRdfItems = nestedContainers.reduce((sum, c) => sum + c.xmp.rdfListItems, 0);
const totalNestedDocumentAncestors = nestedContainers.reduce(
  (sum, c) => sum + c.xmp.documentAncestors,
  0,
);
const totalAllXmpBytes = containers.reduce((sum, c) => sum + c.xmp.bytes, 0);
const totalAllRdfItems = containers.reduce((sum, c) => sum + c.xmp.rdfListItems, 0);
const totalAllDocumentAncestors = containers.reduce(
  (sum, c) => sum + c.xmp.documentAncestors,
  0,
);
const containerById = new Map(containers.map((container) => [container.id, container]));
const recordById = new Map(linkedRecords.map((record) => [record.id, record]));
const anomalousContainers = containers.filter(
  (container) => container.xmp.documentAncestors > 0,
);
const recordsRequiredToOpen = new Set();

for (const container of anomalousContainers) {
  let currentId = container.id;
  while (currentId && currentId !== "root") {
    recordsRequiredToOpen.add(currentId);
    currentId = containerById.get(currentId)?.parentId || null;
  }
}

const cleanupPlanRecords = [...recordsRequiredToOpen]
  .map((id) => {
    const record = recordById.get(id);
    const container = containerById.get(id);
    if (!record || !container) return null;
    const parentContainer = containerById.get(container.parentId);
    return {
      id,
      parentId: record.parentId,
      depth: record.depth,
      uniqueId: record.uniqueId,
      originalName: record.originalName,
      cleanSelf: container.xmp.documentAncestors > 0,
      documentAncestors: container.xmp.documentAncestors,
      depthBits: container.depthBits,
      parentDepthBits: parentContainer?.depthBits ?? null,
      colorMode: container.colorMode,
      payloadBytes: record.payloadBytes,
      nestedPsdFound: record.nestedPsdFound,
    };
  })
  .filter(Boolean)
  .sort((left, right) => left.depth - right.depth || left.id.localeCompare(right.id));
const cleanupRecordsByAssetId = new Map();
for (const record of cleanupPlanRecords) {
  const assetId = record.uniqueId.toLowerCase();
  const existing = cleanupRecordsByAssetId.get(assetId) || [];
  existing.push(record);
  cleanupRecordsByAssetId.set(assetId, existing);
}
const duplicateAssetGroups = [...cleanupRecordsByAssetId.entries()]
  .filter(([, records]) => records.length > 1)
  .map(([uniqueId, records]) => ({
    uniqueId,
    count: records.length,
    containerIds: records.map((record) => record.id),
    parentContainerIds: records.map((record) => record.parentId),
    originalNames: [...new Set(records.map((record) => record.originalName))],
  }));

const cleanupPlan = {
  version: 2,
  source: target,
  sourceBytes: stat.size,
  sourceMtimeMs: Math.round(stat.mtimeMs),
  rootCleanSelf: (containerById.get("root")?.xmp.documentAncestors || 0) > 0,
  rootDepthBits: containerById.get("root")?.depthBits || null,
  anomalousContainers: anomalousContainers.length,
  anomalousEmbeddedContainers: anomalousContainers.filter((container) => container.depth > 0).length,
  recordsRequiredToOpen: cleanupPlanRecords.length,
  uniqueAssetRecords: cleanupRecordsByAssetId.size,
  duplicateAssetGroups,
  targetRecords: cleanupPlanRecords.filter((record) => record.cleanSelf).length,
  ancestorOnlyRecords: cleanupPlanRecords.filter((record) => !record.cleanSelf).length,
  crossBitDepthRecords: cleanupPlanRecords.filter(
    (record) => record.parentDepthBits !== null && record.parentDepthBits !== record.depthBits,
  ).length,
  records: cleanupPlanRecords,
};

if (cleanupPlanOutput) {
  const lines = [
    "#PSB_CLEANUP_PLAN_V2",
    `SOURCE_PATH\t${encodeURIComponent(target)}`,
    `SOURCE_BYTES\t${stat.size}`,
    `SOURCE_MTIME_MS\t${Math.round(stat.mtimeMs)}`,
    `ROOT_CLEAN_SELF\t${cleanupPlan.rootCleanSelf ? 1 : 0}`,
    `ROOT_DEPTH_BITS\t${cleanupPlan.rootDepthBits}`,
    `ANOMALOUS_CONTAINERS\t${cleanupPlan.anomalousContainers}`,
    `ANOMALOUS_EMBEDDED_CONTAINERS\t${cleanupPlan.anomalousEmbeddedContainers}`,
    `RECORDS_REQUIRED_TO_OPEN\t${cleanupPlan.recordsRequiredToOpen}`,
    `TARGET_RECORDS\t${cleanupPlan.targetRecords}`,
    `ANCESTOR_ONLY_RECORDS\t${cleanupPlan.ancestorOnlyRecords}`,
    `CROSS_BIT_DEPTH_RECORDS\t${cleanupPlan.crossBitDepthRecords}`,
    "COLUMNS\tuniqueId\tcleanSelf\tdepth\tdepthBits\tparentDepthBits\tcolorMode\tpayloadBytes\toriginalName\tcontainerId\tparentContainerId",
  ];
  for (const record of cleanupPlanRecords) {
    lines.push([
      "OPEN",
      record.uniqueId.toLowerCase(),
      record.cleanSelf ? "1" : "0",
      String(record.depth),
      String(record.depthBits),
      record.parentDepthBits === null ? "" : String(record.parentDepthBits),
      String(record.colorMode),
      String(record.payloadBytes),
      encodeURIComponent(record.originalName),
      record.id,
      record.parentId,
    ].join("\t"));
  }
  await fs.writeFile(cleanupPlanOutput, `${lines.join("\n")}\n`, "utf8");
}

const topEmbeddedBySize = [...nestedContainers]
  .sort((a, b) => b.bytes - a.bytes)
  .slice(0, 100);
const topEmbeddedByXmp = [...nestedContainers]
  .sort((a, b) => b.xmp.bytes - a.xmp.bytes)
  .slice(0, 100);

const result = {
  target,
  fileBytes: stat.size,
  fileGiB: giB(stat.size),
  summary: {
    containersInspected: containers.length,
    embeddedContainers: nestedContainers.length,
    linkedRecords: linkedRecords.length,
    maxDepthSeen: Math.max(...containers.map((c) => c.depth)),
    rootXmpBytes: containers.find((c) => c.id === "root")?.xmp.bytes || 0,
    rootXmpMiB: containers.find((c) => c.id === "root")?.xmp.MiB || 0,
    nestedXmpBytes: totalNestedXmpBytes,
    nestedXmpMiB: miB(totalNestedXmpBytes),
    nestedXmpGiB: giB(totalNestedXmpBytes),
    nestedRdfListItems: totalNestedRdfItems,
    nestedDocumentAncestors: totalNestedDocumentAncestors,
    allXmpBytes: totalAllXmpBytes,
    allXmpMiB: miB(totalAllXmpBytes),
    allXmpGiB: giB(totalAllXmpBytes),
    allRdfListItems: totalAllRdfItems,
    allDocumentAncestors: totalAllDocumentAncestors,
    xmpPercentOfOuterFile: Number(((totalAllXmpBytes / stat.size) * 100).toFixed(4)),
  },
  cleanupPlan,
  containers,
  topEmbeddedBySize,
  topEmbeddedByXmp,
  linkedRecords,
  warnings,
};

if (COMPACT_OUTPUT) {
  const countBy = (items, keyFn) => {
    const map = new Map();
    for (const item of items) {
      const key = String(keyFn(item));
      map.set(key, (map.get(key) || 0) + 1);
    }
    return Object.fromEntries([...map.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh-CN")));
  };
  const compact = {
    target,
    fileGiB: giB(stat.size),
    summary: result.summary,
    containersByDepth: countBy(containers, (c) => c.depth),
    recordsByDepth: countBy(linkedRecords, (r) => r.depth),
    recordsByType: countBy(linkedRecords, (r) => r.type),
    embeddedNames: Object.entries(countBy(linkedRecords, (r) => r.originalName))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN")),
    firstLevelRecords: linkedRecords
      .filter((r) => r.depth === 1)
      .map((r) => ({
        name: r.originalName,
        type: r.type,
        payloadGiB: r.payloadGiB,
        nestedPsdFound: r.nestedPsdFound,
      })),
    warnings,
  };
  console.log(JSON.stringify(compact, null, 2));
} else {
  console.log(JSON.stringify(result, null, 2));
}
await handle.close();
