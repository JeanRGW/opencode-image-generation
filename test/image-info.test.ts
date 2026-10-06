import assert from "node:assert/strict";
import { test } from "node:test";
import { imageInfo } from "../image-info.ts";

test("PNG and JPEG dimensions, including progressive JPEG", () => {
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.write("IHDR", 12);
  png.writeUInt32BE(2048, 16);
  png.writeUInt32BE(1152, 20);
  assert.deepEqual(imageInfo(png), { format: "png", mime: "image/png", width: 2048, height: 1152 });
  for (const marker of [0xc0, 0xc2]) {
    const jpeg = Buffer.from([255, 216, 255, 224, 0, 4, 0, 0, 255, marker, 0, 8, 8, 4, 0, 6, 0, 0]);
    assert.deepEqual(imageInfo(jpeg), { format: "jpeg", mime: "image/jpeg", width: 1536, height: 1024 });
  }
});

test("WebP VP8X, VP8L, and VP8 dimension headers", () => {
  function webp(kind: string, data: Buffer) {
    const bytes = Buffer.alloc(20 + data.length + data.length % 2);
    bytes.write("RIFF", 0);
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.write("WEBP", 8);
    bytes.write(kind, 12);
    bytes.writeUInt32LE(data.length, 16);
    data.copy(bytes, 20);
    return bytes;
  }
  const extended = Buffer.alloc(10);
  extended.writeUIntLE(1919, 4, 3);
  extended.writeUIntLE(1079, 7, 3);
  const lossless = Buffer.alloc(5);
  lossless[0] = 0x2f;
  lossless.writeUInt32LE((1919 | (1079 << 14)) >>> 0, 1);
  const lossy = Buffer.from([0, 0, 0, 0x9d, 0x01, 0x2a, 0x80, 0x07, 0x38, 0x04]);
  for (const bytes of [webp("VP8X", extended), webp("VP8L", lossless), webp("VP8 ", lossy)]) {
    assert.deepEqual(imageInfo(bytes), { format: "webp", mime: "image/webp", width: 1920, height: 1080 });
  }
});

test("malformed or truncated images fail without out-of-bounds reads", () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from("not an image"), Buffer.from([255, 216, 255, 192, 255, 255]), Buffer.from("RIFF0000WEBPVP8X")]) {
    assert.throws(() => imageInfo(bytes), /supported|dimensions/);
  }
});
