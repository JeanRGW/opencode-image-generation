import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { editImage } from "../generate.ts";
import plugin from "../index.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGZkAAAAASUVORK5CYII=", "base64");

test("image edits upload references as JSON, preserve sources, and register a text-only permissioned tool", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-edits-"));
  const outside = await mkdtemp(join(tmpdir(), "opencode-edit-external-"));
  const requests: Array<{ url: string | undefined; auth: string | undefined; body: Record<string, unknown> }> = [];
  let mode = "ok";
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
    if (mode === "error") { res.writeHead(400); res.end('{"error":{"message":"secret-provider-body"}}'); return; }
    if (mode === "invalid") { res.end('{"data":[{"b64_json":"!!!"}]}'); return; }
    if (mode === "slow") { setTimeout(() => res.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] })), 80); return; }
    res.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const options = { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "test-key", model: "codex/gpt-5.6-sol-image" };
  const signal = new AbortController().signal;
  const call = (input: Record<string, unknown> = {}, overrides = {}) => editImage({ ...options, ...overrides }, { prompt: "Change the title", imagePaths: ["source.png"], ...input }, directory, signal);
  try {
    await writeFile(join(directory, "source.png"), png);
    await writeFile(join(directory, "second.png"), png);
    await writeFile(join(outside, "private.png"), png);
    const result = await call({ outputPath: "edited.png", size: "1024x1024" });
    assert.equal(result.images.length, 1);
    assert.equal(result.model, options.model);
    assert.deepEqual(await readFile(result.path), png);
    assert.deepEqual(await readFile(join(directory, "source.png")), png);
    assert.deepEqual(requests[0], { url: "/v1/images/edits", auth: "Bearer test-key", body: {
      model: options.model, prompt: "Change the title", n: 1, size: "1024x1024",
      images: [{ image_url: `data:image/png;base64,${png.toString("base64")}` }],
    } });
    await call({ imagePaths: ["source.png", "second.png"], model: "custom/edit-model", quality: "high", background: "transparent", output_format: "png" });
    assert.equal((requests.at(-1)!.body.images as unknown[]).length, 2);
    assert.equal(requests.at(-1)!.body.model, "custom/edit-model");
    assert.equal(requests.at(-1)!.body.quality, "high");
    assert.equal(requests.at(-1)!.body.background, "transparent");
    assert.equal(requests.at(-1)!.body.output_format, "png");
    await call({ imagePaths: Array(4).fill("source.png"), response_format: "b64_json" });
    assert.equal((requests.at(-1)!.body.images as unknown[]).length, 4);
    assert.equal(requests.at(-1)!.body.response_format, "b64_json");
    const before = requests.length;
    for (const imagePaths of [undefined, [], [""], [123], Array(5).fill("source.png"), ["missing.png"], [join(outside, "private.png")]]) {
      await assert.rejects(call({ imagePaths }));
    }
    await assert.rejects(call({ imagePaths: [join(outside, "private.png")] }, { allowExternalPaths: true }), /inside the session/);
    await symlink(outside, join(directory, "escape"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(call({ imagePaths: ["escape/private.png"] }), /inside the session/);
    await mkdir(join(directory, "folder"));
    await assert.rejects(call({ imagePaths: ["folder"] }), /regular file|could not be opened/);
    await assert.rejects(call({ imagePaths: ["."] }), /inside the session/);
    await writeFile(join(directory, "invalid.png"), "private text, not an image");
    await assert.rejects(call({ imagePaths: ["invalid.png"] }), /not a supported/);
    await assert.rejects(call({}, { maxImageBytes: png.length - 1 }), /maxImageBytes/);
    await assert.rejects(call({}, { maxResponseBytes: 100 }), /edit request exceeds/);
    await assert.rejects(call({ outputPath: "source.png" }), /already exists/);
    await assert.rejects(call({ outputPath: "../external-edit.png" }), /inside the session/);
    for (const field of ["mask", "n", "aspect_ratio", "image_size"]) await assert.rejects(call({ [field]: "unsupported" }), /Unsupported edit parameter/);
    assert.equal(requests.length, before);
    mode = "error";
    await assert.rejects(call(), /^Error: Image edit failed \(HTTP 400\)\.$/);
    mode = "invalid";
    await assert.rejects(call(), /Invalid base64/);
    mode = "slow";
    await assert.rejects(call({}, { timeoutMs: 10 }), /timeout/i);
    await assert.rejects(editImage(options, { prompt: "test", imagePaths: ["source.png"] }, directory, AbortSignal.abort()), /abort/i);
    mode = "ok";
    type Context = Parameters<typeof plugin.setup>[0];
    type Editor = Parameters<Parameters<Context["tool"]["transform"]>[0]>[0];
    type Tool = Parameters<Editor["add"]>[0];
    const tools = new Map<string, Tool>();
    await plugin.setup({ options,
      tool: { transform: async (cb: (editor: Editor) => void) => cb({ add: (tool: Tool) => tools.set(tool.name, tool) } as unknown as Editor) },
      session: { get: async () => ({ location: { directory } }) },
    } as unknown as Context);
    const tool = tools.get("edit_image")!;
    assert.equal(tool.options?.permission, "edit_image");
    const resultText = await tool.execute({ prompt: "change", imagePaths: ["source.png"] }, { sessionID: "test", signal } as unknown as Parameters<Tool["execute"]>[1]);
    assert.equal(typeof resultText.content, "string");
    assert.ok(!String(resultText.content).includes("file://"));
    assert.deepEqual(await readFile(JSON.parse(resultText.content as string).path), png);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
