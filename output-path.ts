import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative } from "node:path";

function inside(root: string, path: string) {
  const difference = relative(root, path);
  return difference !== ".." && !difference.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(difference);
}

export async function validateOutputPath(directory: string, path: string, allowExternalPaths: boolean) {
  if (path.includes("\0")) throw new Error("outputPath contains a null byte.");
  if (process.platform === "win32" && /[:<>"|?*]/.test(path.slice(2))) {
    throw new Error("outputPath contains unsupported Windows path characters.");
  }
  if (allowExternalPaths) return;
  if (!inside(directory, path)) throw new Error("outputPath must stay inside the session directory; allowExternalPaths is disabled.");
  const root = await realpath(directory);
  let parent = dirname(path);
  while (true) {
    try {
      const resolved = await realpath(parent);
      if (!inside(root, resolved)) throw new Error("outputPath traverses a link outside the session directory.");
      if (!(await stat(resolved)).isDirectory()) throw new Error("outputPath parent must be a directory.");
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const next = dirname(parent);
      if (next === parent) throw new Error("outputPath has no accessible parent directory.");
      parent = next;
    }
  }
}
