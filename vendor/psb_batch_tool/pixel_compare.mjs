import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function paethPredictor(left, up, upperLeft) {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) {
    return left;
  }
  if (upDistance <= upperLeftDistance) {
    return up;
  }
  return upperLeft;
}

function decodePng(buffer) {
  if (
    buffer.length < PNG_SIGNATURE.length ||
    !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    throw new Error("Not a PNG file.");
  }

  let offset = PNG_SIGNATURE.length;
  let header = null;
  const compressedParts = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const next = dataEnd + 4;
    if (next > buffer.length) {
      throw new Error(`PNG chunk ${type} extends beyond the file.`);
    }
    const data = buffer.subarray(dataStart, dataEnd);
    if (type === "IHDR") {
      if (length !== 13) {
        throw new Error("Invalid PNG IHDR length.");
      }
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data.readUInt8(8),
        colorType: data.readUInt8(9),
        compression: data.readUInt8(10),
        filter: data.readUInt8(11),
        interlace: data.readUInt8(12),
      };
    } else if (type === "IDAT") {
      compressedParts.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset = next;
  }

  if (!header) {
    throw new Error("PNG does not contain an IHDR chunk.");
  }
  if (header.width === 0 || header.height === 0) {
    throw new Error("PNG has invalid zero dimensions.");
  }
  if (
    ![8, 16].includes(header.bitDepth) ||
    header.compression !== 0 ||
    header.filter !== 0 ||
    header.interlace !== 0
  ) {
    throw new Error(
      "Pixel validation supports non-interlaced 8-bit or 16-bit PNG previews only.",
    );
  }

  const channelsByColorType = new Map([
    [0, 1],
    [2, 3],
    [4, 2],
    [6, 4],
  ]);
  const channels = channelsByColorType.get(header.colorType);
  if (!channels) {
    throw new Error(`Unsupported PNG color type ${header.colorType}.`);
  }
  const bytesPerSample = header.bitDepth / 8;
  const bytesPerPixel = channels * bytesPerSample;
  const rowBytes = header.width * bytesPerPixel;
  const inflated = zlib.inflateSync(Buffer.concat(compressedParts));
  const expectedBytes = (rowBytes + 1) * header.height;
  if (inflated.length !== expectedBytes) {
    throw new Error(
      `Unexpected PNG image data length: expected ${expectedBytes}, got ${inflated.length}.`,
    );
  }

  const decoded = Buffer.alloc(rowBytes * header.height);
  let inputOffset = 0;
  for (let y = 0; y < header.height; y++) {
    const filterType = inflated[inputOffset++];
    const rowOffset = y * rowBytes;
    const previousRowOffset = rowOffset - rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const raw = inflated[inputOffset++];
      const left =
        x >= bytesPerPixel
          ? decoded[rowOffset + x - bytesPerPixel]
          : 0;
      const up = y > 0 ? decoded[previousRowOffset + x] : 0;
      const upperLeft =
        y > 0 && x >= bytesPerPixel
          ? decoded[previousRowOffset + x - bytesPerPixel]
          : 0;
      let value;
      if (filterType === 0) {
        value = raw;
      } else if (filterType === 1) {
        value = raw + left;
      } else if (filterType === 2) {
        value = raw + up;
      } else if (filterType === 3) {
        value = raw + Math.floor((left + up) / 2);
      } else if (filterType === 4) {
        value = raw + paethPredictor(left, up, upperLeft);
      } else {
        throw new Error(`Unsupported PNG row filter ${filterType}.`);
      }
      decoded[rowOffset + x] = value & 0xff;
    }
  }

  const rgba =
    header.bitDepth === 8
      ? new Uint8Array(header.width * header.height * 4)
      : new Uint16Array(header.width * header.height * 4);
  const sampleAt = (sampleIndex) =>
    header.bitDepth === 8
      ? decoded[sampleIndex]
      : decoded.readUInt16BE(sampleIndex * 2);
  const sampleMax = header.bitDepth === 8 ? 255 : 65535;
  for (let pixel = 0; pixel < header.width * header.height; pixel++) {
    const sourceOffset = pixel * channels;
    const targetOffset = pixel * 4;
    if (header.colorType === 0) {
      const gray = sampleAt(sourceOffset);
      rgba[targetOffset] = gray;
      rgba[targetOffset + 1] = gray;
      rgba[targetOffset + 2] = gray;
      rgba[targetOffset + 3] = sampleMax;
    } else if (header.colorType === 2) {
      rgba[targetOffset] = sampleAt(sourceOffset);
      rgba[targetOffset + 1] = sampleAt(sourceOffset + 1);
      rgba[targetOffset + 2] = sampleAt(sourceOffset + 2);
      rgba[targetOffset + 3] = sampleMax;
    } else if (header.colorType === 4) {
      const gray = sampleAt(sourceOffset);
      rgba[targetOffset] = gray;
      rgba[targetOffset + 1] = gray;
      rgba[targetOffset + 2] = gray;
      rgba[targetOffset + 3] = sampleAt(sourceOffset + 1);
    } else {
      rgba[targetOffset] = sampleAt(sourceOffset);
      rgba[targetOffset + 1] = sampleAt(sourceOffset + 1);
      rgba[targetOffset + 2] = sampleAt(sourceOffset + 2);
      rgba[targetOffset + 3] = sampleAt(sourceOffset + 3);
    }
  }
  return {
    width: header.width,
    height: header.height,
    bitDepth: header.bitDepth,
    sampleMax,
    rgba,
  };
}

function compareDecoded(left, right) {
  if (
    left.width !== right.width ||
    left.height !== right.height ||
    left.bitDepth !== right.bitDepth
  ) {
    return {
      comparable: false,
      exact: false,
      left: {
        width: left.width,
        height: left.height,
        bitDepth: left.bitDepth,
      },
      right: {
        width: right.width,
        height: right.height,
        bitDepth: right.bitDepth,
      },
      reason: "Preview dimensions or bit depths differ.",
    };
  }

  let changedPixels = 0;
  let changedRgbPixels = 0;
  let changedRgbChannelSamples = 0;
  let alphaChangedPixels = 0;
  let maxRgbDelta = 0;
  let maxAlphaDelta = 0;
  let squaredError = 0;
  let minX = left.width;
  let minY = left.height;
  let maxX = -1;
  let maxY = -1;

  const pixelCount = left.width * left.height;
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const offset = pixel * 4;
    let rgbChanged = false;
    let pixelChanged = false;
    for (let channel = 0; channel < 3; channel++) {
      const delta = Math.abs(
        left.rgba[offset + channel] - right.rgba[offset + channel],
      );
      squaredError += delta * delta;
      if (delta > 0) {
        rgbChanged = true;
        pixelChanged = true;
        changedRgbChannelSamples++;
        if (delta > maxRgbDelta) {
          maxRgbDelta = delta;
        }
      }
    }
    const alphaDelta = Math.abs(
      left.rgba[offset + 3] - right.rgba[offset + 3],
    );
    squaredError += alphaDelta * alphaDelta;
    if (alphaDelta > 0) {
      pixelChanged = true;
      alphaChangedPixels++;
      if (alphaDelta > maxAlphaDelta) {
        maxAlphaDelta = alphaDelta;
      }
    }
    if (rgbChanged) {
      changedRgbPixels++;
    }
    if (pixelChanged) {
      changedPixels++;
      const x = pixel % left.width;
      const y = Math.floor(pixel / left.width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  const mse = squaredError / (pixelCount * 4);
  const psnrDb =
    mse === 0
      ? null
      : 10 * Math.log10((left.sampleMax * left.sampleMax) / mse);
  return {
    comparable: true,
    exact: changedPixels === 0,
    width: left.width,
    height: left.height,
    bitDepth: left.bitDepth,
    sampleMax: left.sampleMax,
    totalPixels: pixelCount,
    changedPixels,
    changedRgbPixels,
    changedRgbChannelSamples,
    alphaChangedPixels,
    maxRgbDelta,
    maxAlphaDelta,
    mse,
    psnrDb,
    changedBoundingBox:
      changedPixels === 0
        ? null
        : { left: minX, top: minY, right: maxX, bottom: maxY },
  };
}

export async function comparePngFiles(leftPath, rightPath) {
  const [leftBuffer, rightBuffer] = await Promise.all([
    fs.readFile(leftPath),
    fs.readFile(rightPath),
  ]);
  return compareDecoded(decodePng(leftBuffer), decodePng(rightBuffer));
}

async function main() {
  if (process.argv.length !== 4) {
    console.error("Usage: node pixel_compare.mjs <left.png> <right.png>");
    process.exitCode = 2;
    return;
  }
  const result = await comparePngFiles(process.argv[2], process.argv[3]);
  console.log(JSON.stringify(result, null, 2));
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(`ERROR=${error.message}`);
    process.exitCode = 1;
  });
}
