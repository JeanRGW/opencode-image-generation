import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configuration, generate, listImageModels } from "../generate.ts";
import plugin from "../index.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGZkAAAAASUVORK5CYII=", "base64");

test("configurable settings and environment fallbacks", () => {
  const config = configuration({}, { OPENCODE_IMAGE_BASE_URL: "http://localhost:1234/v1/", OPENCODE_IMAGE_MODEL: "custom" });
  assert.equal(config.url.href, "http://localhost:1234/v1/images/generations");
  assert.equal(config.model, "custom");
  assert.equal(configuration({ apiKeyEnv: "CUSTOM_KEY" }, { CUSTOM_KEY: "secret" }).apiKey, "secret");
  assert.equal(configuration({ apiKey: "raw-key" }, { OPENAI_API_KEY: "env-key" }).apiKey, "raw-key");
  assert.equal(configuration({ apiKey: "" }, { OPENAI_API_KEY: "env-key" }).apiKey, "env-key");
  assert.throws(() => configuration({ apiKey: 123 }), /apiKey must be a string/);
  assert.throws(() => configuration({ baseURL: "file:///test" }), /HTTP/);
  assert.throws(() => configuration({ timeoutMs: 0 }), /timeoutMs/);
  assert.equal(configuration({}).maxImages, 4);
  for (const maxImages of [0, 17, 1.5, "4"]) {
    assert.throws(() => configuration({ maxImages }), /maxImages/);
  }
});

test("mock API: base64, URL, errors, cancellation, and no overwrites", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-images-test-"));
  const requests: Array<{ path: string; auth: string | undefined; body: Record<string, unknown> }> = [];
  let mode = "base64";
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ path: req.url!, auth: req.headers.authorization, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {} });
    if (req.url === "/image.png") { res.end(png); return; }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/models") {
      if (mode === "error") { res.writeHead(403); res.end('{}'); return; }
      if (mode === "missing") { res.end('{}'); return; }
      res.end(JSON.stringify({ data: [
        { id: "antigravity/gemini-3.1-flash-image", type: "image" },
        { id: "codex/gpt-5.6-sol-image", type: "image" },
        { id: "gpt-image-1" }, { id: "plain-chat" },
        { id: "gpt-image-1" }, { name: "no-id" },
      ] }));
      return;
    }
    if (mode === "error") { res.writeHead(401); res.end('{"secret":"sensitive"}'); return; }
    if (mode === "invalid") { res.end('{"data":[{"b64_json":"!!!!"}]}'); return; }
    if (mode === "missing") { res.end('{"data":[]}'); return; }
    if (mode === "slow") {
      setTimeout(() => res.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] })), 80);
      return;
    }
    if (mode === "race") {
      await writeFile(join(directory, "race-2.png"), "do not overwrite");
      res.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }, { b64_json: png.toString("base64") }] }));
      return;
    }
    if (mode === "batch" || mode === "short" || mode === "bad-batch" || mode === "too-many") {
      const count = mode === "short" ? 1 : mode === "too-many" ? 3 : Number(requests.at(-1)!.body.n);
      const data = Array.from({ length: count }, (_, index) => ({ b64_json: mode === "bad-batch" && index === 1 ? "!!!!" : png.toString("base64") }));
      res.end(JSON.stringify({ data }));
      return;
    }
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    res.end(JSON.stringify({ data: [mode === "url" ? { url: `http://127.0.0.1:${address.port}/image.png` } : { b64_json: png.toString("base64"), revised_prompt: "revised" }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const options = { baseURL: `http://127.0.0.1:${address.port}/v1`, model: "test-model", apiKeyEnv: "TEST_IMAGE_KEY" };
  const env = { TEST_IMAGE_KEY: "test-key" };
  const call = (input: unknown, signal = new AbortController().signal) => generate(options, input, directory, signal, env);
  try {
    const result = await call({ prompt: "draw a square", outputPath: "nested/image.png", size: "1024x1024" });
    assert.deepEqual(await readFile(result.path), png);
    assert.equal(result.revisedPrompt, "revised");
    assert.equal(result.width, 1);
    assert.equal(result.height, 1);
    assert.equal(result.images.length, 1);
    assert.deepEqual(requests[0], { path: "/v1/images/generations", auth: "Bearer test-key", body: { model: "test-model", prompt: "draw a square", n: 1, size: "1024x1024" } });
    await assert.rejects(call({ prompt: "again", outputPath: "nested/image.png" }), /already exists/);
    assert.equal(requests.length, 1);
    mode = "batch";
    const batch = await call({ prompt: "variants", model: "antigravity/gemini-3.1-flash-image", n: 2, aspect_ratio: "16:9", image_size: "2K", outputPath: "batch.png" });
    assert.equal(batch.images.length, 2);
    assert.deepEqual(batch.warnings, []);
    assert.deepEqual(batch.images.map(image => image.path), [join(directory, "batch-1.png"), join(directory, "batch-2.png")]);
    assert.deepEqual(requests.at(-1)?.body, { prompt: "variants", model: "antigravity/gemini-3.1-flash-image", n: 2, aspect_ratio: "16:9", image_size: "2K" });
    for (const image of batch.images) assert.deepEqual(await readFile(image.path), png);
    const before = requests.length;
    for (const n of [0, 5, 1.5, "2"]) await assert.rejects(call({ prompt: "bad", n }), /n must/);
    await assert.rejects(generate({ ...options, maxImages: 1 }, { prompt: "cap", n: 2 }, directory, new AbortController().signal, env), /between 1 and 1/);
    await assert.rejects(call({ prompt: "bad", aspect_ratio: "0:9" }), /aspect_ratio/);
    await assert.rejects(call({ prompt: "bad", image_size: "8K" }), /image_size/);
    await assert.rejects(call({ prompt: "bad", model: " " }), /model must/);
    await writeFile(join(directory, "collision-2.png"), "existing");
    await assert.rejects(call({ prompt: "collision", n: 2, outputPath: "collision.png" }), /already exists/);
    assert.equal(requests.length, before);
    mode = "short";
    const short = await call({ prompt: "short", n: 2, outputPath: "short.png" });
    assert.equal(short.images.length, 1);
    assert.match(short.warnings[0], /provider returned 1/);
    const files = await readdir(directory);
    mode = "bad-batch";
    await assert.rejects(call({ prompt: "bad batch", n: 2, outputPath: "invalid.png" }), /Invalid base64/);
    assert.deepEqual(await readdir(directory), files);
    mode = "too-many";
    await assert.rejects(call({ prompt: "too many", n: 2 }), /up to 2 images/);
    mode = "base64";
    const catalog = await listImageModels(options, new AbortController().signal, env);
    assert.equal(requests.at(-1)?.path, "/v1/models");
    assert.equal(requests.at(-1)?.auth, "Bearer test-key");
    assert.deepEqual(catalog.models.map(model => model.id), ["antigravity/gemini-3.1-flash-image", "codex/gpt-5.6-sol-image", "gpt-image-1"]);
    assert.equal(catalog.maxImages, 4);
    assert.deepEqual(catalog.models[0].guidance.parameters.image_size, ["1K", "2K", "4K"]);
    assert.deepEqual(catalog.models[1].guidance.parameters.quality, ["auto", "low", "medium", "high"]);
    assert.match(catalog.models[2].detection, /heuristic/);
    mode = "error";
    await assert.rejects(listImageModels(options, new AbortController().signal, env), /HTTP 403/);
    mode = "missing";
    await assert.rejects(listImageModels(options, new AbortController().signal, env), /Expected model list/);
    mode = "base64";
    type Context = Parameters<typeof plugin.setup>[0];
    type Editor = Parameters<Parameters<Context["tool"]["transform"]>[0]>[0];
    type Tool = Parameters<Editor["add"]>[0];
    const tools = new Map<string, Tool>();
    const context = {
      options: { ...options, apiKey: "test-key" },
      tool: { transform: async (callback: (editor: Editor) => void) => callback({ add: (tool: Tool) => tools.set(tool.name, tool) } as unknown as Editor) },
      session: { get: async () => ({ location: { directory } }) },
    } as unknown as Context;
    await plugin.setup(context);
    const registered = tools.get("generate_image")!;
    const executionContext = { signal: new AbortController().signal, sessionID: "test" } as unknown as Parameters<Tool["execute"]>[1];
    const output = await registered.execute({ prompt: "plugin regression" }, executionContext);
    assert.equal(typeof output.content, "string");
    assert.ok(!String(output.content).includes("file://"));
    const saved = JSON.parse(output.content as string);
    assert.equal(saved.width, 1);
    assert.deepEqual(await readFile(saved.path), png);
    assert.equal(typeof (await tools.get("list_image_models")!.execute({}, executionContext)).content, "string");
    mode = "race";
    await assert.rejects(call({ prompt: "race", n: 2, outputPath: "race.png" }), /Already saved:.*race-1.png/);
    assert.equal(await readFile(join(directory, "race-2.png"), "utf8"), "do not overwrite");
    assert.deepEqual(await readFile(join(directory, "race-1.png")), png);
    mode = "slow";
    await assert.rejects(generate({ ...options, timeoutMs: 10 }, { prompt: "timeout" }, directory, new AbortController().signal, env), /timeout/i);
    const controller = new AbortController();
    const cancelled = call({ prompt: "cancel in flight" }, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(cancelled, /abort/i);
    mode = "url";
    const downloaded = await call({ prompt: "download" });
    assert.deepEqual(await readFile(downloaded.path), png);
    assert.equal(requests.at(-1)?.auth, undefined);
    mode = "error";
    await assert.rejects(call({ prompt: "error" }), /^Error: Image generation failed \(HTTP 401\)\.$/);
    mode = "invalid";
    await assert.rejects(call({ prompt: "invalid" }), /Invalid base64/);
    mode = "missing";
    await assert.rejects(call({ prompt: "missing" }), /Expected one image/);
    await assert.rejects(call({ prompt: " " }), /non-empty prompt/);
    await assert.rejects(generate(options, { prompt: "test" }, directory, new AbortController().signal, {}), /TEST_IMAGE_KEY/);
    await assert.rejects(call({ prompt: "cancel" }, AbortSignal.abort()), /abort/i);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
