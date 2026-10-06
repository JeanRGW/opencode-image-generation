import { randomUUID } from "node:crypto";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { imageInfo } from "./image-info.ts";
import { readBytes, readJSON, request } from "./http.ts";
import { validateOutputPath } from "./output-path.ts";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object.");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value.trim()) throw new Error("Configuration values must be non-empty strings.");
  return value.trim();
}

function apiURL(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("baseURL must be a valid HTTP(S) API base URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("baseURL must be an HTTP(S) API base URL without credentials, query, or fragment.");
  }
  return url;
}

function byteLimit(value: unknown, fallback: number, name: string) {
  const limit = value ?? fallback;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 512 * 1024 * 1024) {
    throw new Error(`${name} must be an integer between 1 and 536870912 bytes.`);
  }
  return limit;
}

export function configuration(options: unknown, env = process.env) {
  const config = record(options);
  const baseURL = text(config.baseURL ?? env.OPENCODE_IMAGE_BASE_URL, "https://api.openai.com/v1");
  const base = apiURL(baseURL);
  const url = new URL(`${base.href.replace(/\/+$/, "")}/images/generations`);
  const apiKeyEnv = text(config.apiKeyEnv, "OPENAI_API_KEY");
  if (config.apiKey !== undefined && typeof config.apiKey !== "string") {
    throw new Error("apiKey must be a string.");
  }
  const apiKey = (typeof config.apiKey === "string" && config.apiKey.trim() ? config.apiKey : env[apiKeyEnv])?.trim();
  if (apiKey && /[\r\n]/.test(apiKey)) throw new Error("API key must not contain line breaks.");
  const model = text(config.model ?? env.OPENCODE_IMAGE_MODEL, "gpt-image-1");
  const timeoutMs = config.timeoutMs ?? 300_000;
  if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error("timeoutMs must be an integer between 1 and 2147483647.");
  }
  const maxImages = config.maxImages ?? 4;
  if (typeof maxImages !== "number" || !Number.isSafeInteger(maxImages) || maxImages < 1 || maxImages > 16) {
    throw new Error("maxImages must be an integer between 1 and 16.");
  }
  const maxImageBytes = byteLimit(config.maxImageBytes, 25 * 1024 * 1024, "maxImageBytes");
  const maxResponseBytes = byteLimit(config.maxResponseBytes, 64 * 1024 * 1024, "maxResponseBytes");
  const allowExternalPaths = config.allowExternalPaths ?? false;
  if (typeof allowExternalPaths !== "boolean") throw new Error("allowExternalPaths must be a boolean.");
  const origins = config.imageDownloadOrigins ?? [];
  if (!Array.isArray(origins) || origins.some(origin => typeof origin !== "string")) {
    throw new Error("imageDownloadOrigins must be an array of HTTP(S) origins.");
  }
  const imageDownloadOrigins = new Set([url.origin]);
  for (const origin of origins) {
    const parsed = apiURL(origin);
    if (parsed.pathname !== "/") throw new Error("imageDownloadOrigins must contain origins without paths.");
    imageDownloadOrigins.add(parsed.origin);
  }
  return { url, model, apiKeyEnv, apiKey, timeoutMs, maxImages, maxImageBytes, maxResponseBytes, allowExternalPaths, imageDownloadOrigins };
}

export function modelGuidance(model: string) {
  if (/^(agy|antigravity)\//.test(model)) {
    return {
      source: "OmniRoute provider adapter guidance (not a live capability guarantee)",
      parameters: { aspect_ratio: "Positive W:H ratio, e.g. 1:1, 16:9, 9:16; upstream may constrain values", image_size: ["1K", "2K", "4K"], size: "Mapped to aspect ratio, not guaranteed exact pixels", n: "Candidate count; provider may return fewer images" },
      caveats: "quality/background/output_format are not forwarded by the current Antigravity adapter. Deployed versions may differ.",
    };
  }
  if (/^(cx|codex)\//.test(model)) {
    return {
      source: "OmniRoute provider adapter guidance (not a live capability guarantee)",
      parameters: { size: "Use model-supported dimensions or auto; arbitrary pixels are not guaranteed", quality: ["auto", "low", "medium", "high"], n: "OmniRoute performs multiple generation calls; increases cost/quota usage" },
      caveats: "aspect_ratio/image_size are Antigravity controls. Other parameters may be ignored. Deployed versions may differ.",
    };
  }
  return { source: "Generic OpenAI-compatible guidance", parameters: { size: "Model-supported WIDTHxHEIGHT or auto", n: "Model-dependent" }, caveats: "Discovering a model does not prove account access or parameter support; consult the provider." };
}

export async function listImageModels(options: unknown, signal: AbortSignal, env = process.env) {
  const config = configuration(options, env);
  if (!config.apiKey) throw new Error(`Set apiKey or ${config.apiKeyEnv}.`);
  const url = new URL(config.url.href.replace(/images\/generations$/, "models"));
  const response = await request(url, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
    signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
  }, "Image model discovery");
  if (!response.ok) throw new Error(`Image model discovery failed (HTTP ${response.status}).`);
  const result = record(await readJSON(response, config.maxResponseBytes));
  if (!Array.isArray(result.data)) throw new Error("Expected model list in response.data.");
  const models = new Map<string, { id: string; detection: string; guidance: ReturnType<typeof modelGuidance> }>();
  for (const item of result.data) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const model = record(item);
    if (typeof model.id !== "string" || !model.id.trim()) continue;
    const explicit = model.type === "image" || (Array.isArray(model.output_modalities) && model.output_modalities.includes("image"));
    const inferred = /(?:^|[\/-])(?:image|imagen|flux|dall-e|stable-diffusion|dreamshaper)(?:[\/.-]|$|\d)/i.test(model.id);
    if (!explicit && !inferred) continue;
    models.set(model.id, { id: model.id, detection: explicit ? "catalog image type/output modality" : "name heuristic; may not support generation", guidance: modelGuidance(model.id) });
  }
  return { defaultModel: config.model, maxImages: config.maxImages, models: [...models.values()], warning: "Catalog entries do not guarantee a connected account, model entitlement, or parameter support." };
}

function destination(directory: string, outputPath: string | undefined, count: number, index: number, format?: string) {
  if (!outputPath) return resolve(directory, `generated-images/${randomUUID()}.${format}`);
  if (count === 1) return resolve(directory, outputPath);
  const extension = extname(outputPath);
  const stem = extension ? outputPath.slice(0, -extension.length) : outputPath;
  return resolve(directory, `${stem}-${index + 1}${extension}`);
}

export async function generate(
  options: unknown,
  value: unknown,
  directory: string,
  signal: AbortSignal,
  env = process.env,
) {
  if (signal.aborted) throw new Error("Image generation was aborted.");
  const input = record(value);
  if (typeof input.prompt !== "string" || !input.prompt.trim()) throw new Error("A non-empty prompt is required.");
  for (const key of ["outputPath", "model", "size", "aspect_ratio", "image_size", "quality", "background", "output_format", "response_format"]) {
    if (input[key] !== undefined && (typeof input[key] !== "string" || !input[key].trim())) {
      throw new Error(`${key} must be a non-empty string.`);
    }
  }
  if (input.output_format !== undefined && !["png", "jpeg", "webp"].includes(String(input.output_format))) {
    throw new Error("Unsupported output_format.");
  }
  if (input.response_format !== undefined && !["url", "b64_json"].includes(String(input.response_format))) {
    throw new Error("Unsupported response_format.");
  }
  const config = configuration(options, env);
  const count = input.n ?? 1;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1 || count > config.maxImages) {
    throw new Error(`n must be an integer between 1 and ${config.maxImages}.`);
  }
  if (input.aspect_ratio !== undefined && !/^[1-9]\d*:[1-9]\d*$/.test(String(input.aspect_ratio))) {
    throw new Error("aspect_ratio must be a positive W:H ratio, e.g. 16:9.");
  }
  if (input.image_size !== undefined && !["1K", "2K", "4K"].includes(String(input.image_size))) {
    throw new Error("image_size must be 1K, 2K, or 4K.");
  }
  if (!config.apiKey) throw new Error(`Set the plugin apiKey option or the ${config.apiKeyEnv} environment variable in the OpenCode server environment.`);
  if (typeof input.outputPath === "string") {
    for (let index = 0; index < count; index++) {
      await validateOutputPath(directory, destination(directory, input.outputPath, count, index), config.allowExternalPaths);
      try {
        await lstat(destination(directory, input.outputPath, count, index));
        throw new Error("outputPath already exists; choose a new path.");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
  } else {
    await validateOutputPath(directory, destination(directory, undefined, count, 0, "png"), config.allowExternalPaths);
  }
  const combinedSignal = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]);
  const model = typeof input.model === "string" ? input.model : config.model;
  const body: Record<string, unknown> = { model, prompt: input.prompt, n: count };
  for (const key of ["size", "aspect_ratio", "image_size", "quality", "background", "output_format", "response_format"]) {
    if (input[key] !== undefined) body[key] = input[key];
  }
  const response = await request(config.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: combinedSignal,
  }, "Image generation");
  // Do not echo provider error bodies: they may contain credentials or prompts.
  if (!response.ok) throw new Error(`Image generation failed (HTTP ${response.status}).`);
  const result = record(await readJSON(response, config.maxResponseBytes));
  if (!Array.isArray(result.data) || result.data.length < 1 || result.data.length > count) {
    throw new Error(`Expected one image or up to ${count} images in response.data.`);
  }
  const pending = [];
  for (let index = 0; index < result.data.length; index++) {
    const image = record(result.data[index]);
    let bytes: Buffer;
    if (typeof image.b64_json === "string" && image.b64_json.length > 0) {
      if (image.b64_json.length > 4 * Math.ceil(config.maxImageBytes / 3)) throw new Error("Image exceeds maxImageBytes.");
      // Avoid a repeated-group regex: multi-megabyte images can overflow V8's regex stack.
      const encoded = image.b64_json;
      const padding = encoded.indexOf("=");
      if (encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded) ||
          (padding !== -1 && encoded.slice(padding) !== "=" && encoded.slice(padding) !== "==")) {
        throw new Error("Invalid base64 image response.");
      }
      bytes = Buffer.from(image.b64_json, "base64");
    } else if (typeof image.url === "string") {
      let url: URL;
      try { url = new URL(image.url); } catch { throw new Error("Invalid image URL."); }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid image URL.");
      if (!config.imageDownloadOrigins.has(url.origin)) throw new Error("Image download origin is not allowed; configure imageDownloadOrigins for the provider's trusted CDN, or request b64_json.");
      // Signed image URLs do not need the API credential; never forward it.
      const download = await request(url, { signal: combinedSignal }, "Image download");
      if (!download.ok) throw new Error(`Image download failed (HTTP ${download.status}).`);
      bytes = await readBytes(download, config.maxImageBytes, "Image download");
    } else {
      throw new Error("Image response contains neither b64_json nor url.");
    }
    if (bytes.length > config.maxImageBytes) throw new Error("Image exceeds maxImageBytes.");
    const info = imageInfo(bytes);
    const path = destination(directory, typeof input.outputPath === "string" ? input.outputPath : undefined, count, index, info.format);
    pending.push({ bytes, image: { path, mime: info.mime, width: info.width, height: info.height, revisedPrompt: typeof image.revised_prompt === "string" ? image.revised_prompt : undefined } });
  }
  const images = [];
  for (const entry of pending) {
    try {
      combinedSignal.throwIfAborted();
      await validateOutputPath(directory, entry.image.path, config.allowExternalPaths);
      await mkdir(dirname(entry.image.path), { recursive: true });
      await validateOutputPath(directory, entry.image.path, config.allowExternalPaths);
      await writeFile(entry.image.path, entry.bytes, { flag: "wx", signal: combinedSignal });
      images.push(entry.image);
    } catch (error) {
      const saved = images.length ? ` Already saved: ${images.map(image => image.path).join(", ")}` : "";
      throw new Error(`Saving batch failed (disk error, path restriction, collision, or cancellation).${saved} Failed destination may contain an incomplete file: ${entry.image.path}`);
    }
  }
  return { ...images[0]!, model, requestedCount: count, images, warnings: images.length < count ? [`Requested ${count} images; provider returned ${images.length}. No automatic retry was made.`] : [] };
}
