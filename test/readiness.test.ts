import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configuration, generate, listImageModels } from "../generate.ts";
import { readBytes } from "../http.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGZkAAAAASUVORK5CYII=", "base64");
const image = { data: [{ b64_json: png.toString("base64") }] };

test("configuration guards do not disclose invalid URLs or credentials", () => {
  for (const baseURL of ["not-a-url-secret", "https://name:secret@example.com/v1", "https://example.com/v1?secret=123", "https://example.com/v1#secret"]) {
    assert.throws(() => configuration({ baseURL }), error => error instanceof Error && !error.message.includes("secret"));
  }
  assert.throws(() => configuration({ timeoutMs: 2 ** 32 }), /timeoutMs/);
  assert.throws(() => configuration({ apiKey: "secret\r\nkey" }), /line breaks/);
  assert.equal(configuration({}, { OPENAI_API_KEY: " " }).apiKey, "");
  for (const name of ["maxImageBytes", "maxResponseBytes"]) {
    for (const value of [0, -1, 1.5, "10", 536870913]) assert.throws(() => configuration({ [name]: value }), new RegExp(name));
  }
  assert.throws(() => configuration({ allowExternalPaths: "true" }), /boolean/);
  for (const imageDownloadOrigins of ["https://cdn.example", [123], ["https://cdn.example/images"], ["https://cdn.example?key=secret"]]) {
    assert.throws(() => configuration({ imageDownloadOrigins }));
  }
  assert.ok(configuration({ imageDownloadOrigins: ["https://cdn.example:8443/"] }).imageDownloadOrigins.has("https://cdn.example:8443"));
});

test("streamed response limits work without Content-Length and release the reader", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(5)); controller.enqueue(new Uint8Array(5)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(readBytes(new Response(body), 8, "Test response"), /byte limit/);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
  await assert.rejects(readBytes(new Response("abc", { headers: { "Content-Length": "1000" } }), 10, "Test response"), /byte limit/);
});

test("release guards: untrusted responses, downloads, filesystem boundaries, and discovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-ready-"));
  const external = await mkdtemp(join(tmpdir(), "opencode-external-"));
  let handler: (res: ServerResponse) => void = res => { res.end(JSON.stringify(image)); };
  let calls = 0;
  let downloadCalls = 0;
  let downloadAuth: string | undefined;
  const download = createServer((req, res) => {
    downloadCalls++;
    downloadAuth = req.headers.authorization;
    res.end(png);
  });
  const server = createServer((_req, res) => { calls++; handler(res); });
  await new Promise<void>(resolve => download.listen(0, "127.0.0.1", resolve));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const downloadAddress = download.address();
  assert.ok(address && typeof address !== "string");
  assert.ok(downloadAddress && typeof downloadAddress !== "string");
  const downloadOrigin = `http://127.0.0.1:${downloadAddress.port}`;
  const options = { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "secret" };
  const signal = new AbortController().signal;
  const call = (extra = {}, input: Record<string, unknown> = {}) => generate({ ...options, ...extra }, { prompt: "test", ...input }, directory, signal);
  try {
    await assert.rejects(call({}, { outputPath: join(external, "blocked.png") }), /inside the session/);
    await assert.rejects(call({}, { outputPath: "../escaped.png" }), /inside the session/);
    assert.equal(calls, 0);
    await symlink(external, join(directory, "outside"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(call({}, { outputPath: "outside/linked.png" }), /link outside/);
    assert.equal(calls, 0);
    const externalResult = await call({ allowExternalPaths: true }, { outputPath: join(external, "allowed.png") });
    assert.deepEqual(await readFile(externalResult.path), png);

    handler = res => res.end('{"secret": "this-would-leak-to-json-errors"');
    await assert.rejects(call(), error => error instanceof Error && error.message === "API response is not valid JSON.");
    handler = res => { res.writeHead(500); res.end('secret-provider-body'); };
    await assert.rejects(call(), error => error instanceof Error && /HTTP 500/.test(error.message) && !error.message.includes("secret"));
    handler = res => { res.writeHead(302, { Location: `${downloadOrigin}/secret` }); res.end(); };
    await assert.rejects(call(), /network, TLS, or redirect/);
    assert.equal(downloadCalls, 0);

    handler = res => res.end(JSON.stringify(image));
    await assert.rejects(call({ maxResponseBytes: 10 }), /byte limit/);
    await assert.rejects(call({ maxImageBytes: png.length - 1 }), /maxImageBytes/);
    for (const b64_json of ["A===", "AAAA=AAA", "AAA", "AA\n="]) {
      handler = res => res.end(JSON.stringify({ data: [{ b64_json }] }));
      await assert.rejects(call(), /Invalid base64/);
    }
    const large = Buffer.concat([png, Buffer.alloc(3 * 1024 * 1024)]);
    handler = res => res.end(JSON.stringify({ data: [{ b64_json: large.toString("base64") }] }));
    const largeResult = await call();
    assert.equal((await readFile(largeResult.path)).length, large.length);
    handler = res => res.end(JSON.stringify({ data: [{ b64_json: Buffer.from("not an image").toString("base64") }] }));
    await assert.rejects(call(), /not a supported/);
    handler = res => res.end(JSON.stringify({ data: [{ url: "invalid-secret-url" }] }));
    await assert.rejects(call(), /^Error: Invalid image URL\.$/);
    handler = res => res.end(JSON.stringify({ data: [{ url: "file:///private" }] }));
    await assert.rejects(call(), /Invalid image URL/);
    handler = res => res.end(JSON.stringify({ data: [{ url: `${downloadOrigin}/image?signature=secret` }] }));
    await assert.rejects(call(), /origin is not allowed/);
    assert.equal(downloadCalls, 0);
    const downloaded = await call({ imageDownloadOrigins: [downloadOrigin] });
    assert.deepEqual(await readFile(downloaded.path), png);
    assert.equal(downloadCalls, 1);
    assert.equal(downloadAuth, undefined);
    await assert.rejects(call({ imageDownloadOrigins: [downloadOrigin], maxImageBytes: 10 }), /byte limit/);

    handler = res => res.end(JSON.stringify({ data: [null, [], "junk", {}, { id: "vision-chat", input_modalities: ["image"] }, { id: "custom", output_modalities: ["image"] }, { id: "flux-1-schnell" }, { id: "dall-e-3" }, { id: "stable-diffusion-xl" }] }));
    const catalog = await listImageModels(options, signal);
    assert.deepEqual(catalog.models.map(model => model.id), ["custom", "flux-1-schnell", "dall-e-3", "stable-diffusion-xl"]);

    handler = res => res.end(JSON.stringify(image));
    const beforeLinkedDefault = calls;
    await rm(join(directory, "generated-images"), { recursive: true, force: true });
    await symlink(external, join(directory, "generated-images"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(call(), /link outside/);
    assert.equal(calls, beforeLinkedDefault);
    await writeFile(join(directory, "not-a-directory"), "keep");
    await assert.rejects(call({}, { outputPath: "not-a-directory/image.png" }), /parent must be a directory|ENOTDIR/);
    assert.equal(await readFile(join(directory, "not-a-directory"), "utf8"), "keep");
    assert.deepEqual(await readdir(external), ["allowed.png"]);
    await assert.rejects(generate(options, { prompt: "cancel" }, directory, AbortSignal.abort()), /abort/i);
  } finally {
    await Promise.all([server, download].map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
    await rm(directory, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});
