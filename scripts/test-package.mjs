import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = process.env.npm_execpath;
assert.ok(cli, "Run this test through pnpm test:package.");
const directory = await mkdtemp(join(tmpdir(), "opencode-image-package-"));
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: process.env });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
function pnpm(args, cwd) {
  return cli.endsWith(".exe") ? run(cli, args, cwd) : run(process.execPath, [cli, ...args], cwd);
}

try {
  pnpm(["pack", "--out", join(directory, "plugin.tgz")], process.cwd());
  await writeFile(join(directory, "package.json"), JSON.stringify({
    private: true,
    type: "module",
    dependencies: { "opencode-image-generation": "file:./plugin.tgz" },
  }));
  pnpm(["install", "--prod", "--ignore-scripts", "--no-frozen-lockfile"], directory);
  const installed = join(directory, "node_modules", "opencode-image-generation");
  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  assert.equal(manifest.dependencies["@opencode/plugin"], "2.0.24");
  const files = await readdir(installed);
  for (const forbidden of ["test", "scripts", "opencode.jsonc", ".env", "generated-images"]) {
    assert.ok(!files.includes(forbidden), `Unexpected packaged file: ${forbidden}`);
  }
  run(process.execPath, ["--input-type=module", "--eval", `
    // OpenCode supports TypeScript plugin entrypoints; Node normally refuses to
    // strip types under node_modules, so use a scoped loader for the packed plugin.
    import { registerHooks, stripTypeScriptTypes } from 'node:module';
    import { readFileSync } from 'node:fs';
    import { fileURLToPath } from 'node:url';
    registerHooks({ load(url, context, next) {
      if (url.endsWith('.ts') && url.includes('/opencode-image-generation/')) {
        return { format: 'module', shortCircuit: true,
          source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8')) };
      }
      return next(url, context);
    } });
    import assert from 'node:assert/strict';
    const { default: plugin } = await import('opencode-image-generation');
    assert.equal(plugin.id, 'opencode.image-generation');
    const tools = new Map();
    await plugin.setup({ options: {},
      tool: { transform: async callback => callback({ add: tool => tools.set(tool.name, tool) }) },
      session: { get: async () => ({ location: { directory: process.cwd() } }) },
    });
    assert.deepEqual([...tools.keys()], ['generate_image', 'list_image_models']);
    assert.equal(tools.get('generate_image').options.permission, 'generate_image');
    await assert.rejects(tools.get('generate_image').execute({prompt: ''},
      { signal: new AbortController().signal, sessionID: 'package-test' }), /non-empty prompt/);
  `], directory);
  console.log("Packed production install and plugin/tool entrypoint checks passed.");
} finally {
  await rm(directory, { recursive: true, force: true });
}
