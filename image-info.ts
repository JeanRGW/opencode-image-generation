export function imageInfo(bytes: Buffer) {
  let format: "png" | "jpeg" | "webp";
  let width: number | undefined;
  let height: number | undefined;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    format = "png";
    if (bytes.length >= 24 && bytes.toString("ascii", 12, 16) === "IHDR") {
      width = bytes.readUInt32BE(16);
      height = bytes.readUInt32BE(20);
    }
  } else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    format = "jpeg";
    let offset = 2;
    const frames = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    while (offset < bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === undefined || marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (frames.has(marker) && length >= 8) {
        height = bytes.readUInt16BE(offset + 3);
        width = bytes.readUInt16BE(offset + 5);
        break;
      }
      offset += length;
    }
  } else if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    format = "webp";
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const kind = bytes.toString("ascii", offset, offset + 4);
      const length = bytes.readUInt32LE(offset + 4);
      const start = offset + 8;
      if (start + length > bytes.length) break;
      if (kind === "VP8X" && length >= 10) {
        width = bytes.readUIntLE(start + 4, 3) + 1;
        height = bytes.readUIntLE(start + 7, 3) + 1;
        break;
      }
      if (kind === "VP8L" && length >= 5 && bytes[start] === 0x2f) {
        const bits = bytes.readUInt32LE(start + 1);
        width = (bits & 0x3fff) + 1;
        height = ((bits >>> 14) & 0x3fff) + 1;
        break;
      }
      if (kind === "VP8 " && length >= 10 && bytes.subarray(start + 3, start + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
        width = bytes.readUInt16LE(start + 6) & 0x3fff;
        height = bytes.readUInt16LE(start + 8) & 0x3fff;
        break;
      }
      offset = start + length + (length % 2);
    }
  } else {
    throw new Error("Response is not a supported PNG, JPEG, or WebP image.");
  }
  if (!width || !height) throw new Error("Image response has missing or invalid dimensions.");
  return { format, mime: `image/${format}`, width, height };
}
