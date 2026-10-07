import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { imageInfo } from "./image-info.ts";

export async function readReferences(paths: unknown, directory: string, limit: number, signal: AbortSignal) {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 4 ||
      paths.some(path => typeof path !== "string" || !path.trim())) {
    throw new Error("imagePaths must contain 1 to 4 non-empty local image paths.");
  }
  const images: Array<{ image_url: string }> = [];
  for (const path of paths) {
    signal.throwIfAborted();
    let canonical: string;
    try {
      const root = await realpath(directory);
      canonical = await realpath(resolve(directory, path));
      // Uploads stay inside the session even when external output writes are enabled.
      const difference = relative(root, canonical);
      if (!difference || difference === ".." || difference.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(difference)) {
        throw new Error("outside");
      }
    } catch {
      throw new Error("Reference image must exist inside the session directory, without links escaping it.");
    }
    const file = await open(canonical, "r").catch(() => { throw new Error("Reference image could not be opened."); });
    let bytes: Buffer;
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new Error("Reference image must be a regular file.");
      if (info.size > limit) throw new Error("Reference image exceeds maxImageBytes.");
      const chunks: Buffer[] = [];
      let size = 0;
      while (true) {
        signal.throwIfAborted();
        const chunk = Buffer.alloc(64 * 1024);
        const { bytesRead } = await file.read(chunk);
        if (!bytesRead) break;
        size += bytesRead;
        if (size > limit) throw new Error("Reference image exceeds maxImageBytes.");
        chunks.push(chunk.subarray(0, bytesRead));
      }
      bytes = Buffer.concat(chunks, size);
    } finally {
      await file.close();
    }
    const info = imageInfo(bytes);
    images.push({ image_url: `data:${info.mime};base64,${bytes.toString("base64")}` });
  }
  return images;
}
