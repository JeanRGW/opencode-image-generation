# OpenCode Image Generation

Generate images directly from **OpenCode V2** through an OpenAI-compatible API.
Works with direct APIs and gateways such as OmniRoute. This is a plugin, not MCP.

- `generate_image`: per-call model selection, batch generation, provider-specific
  controls, and PNG/JPEG/WebP saved locally with actual dimensions.
- `list_image_models`: authenticated model discovery with advisory tuning guidance.
- `edit_image`: edit existing local images or use reference images through the
  JSON `/images/edits` endpoint; saves one new image without overwriting the source.
- No overwrites, no automatic paid retries, bounded responses, text-only results,
  and no API credentials forwarded to image downloads.

Requires OpenCode V2; SDK contract tested with `@opencode/plugin` **2.0.24**.
For development/tests, use Node **22.18+** (22.x or 24.x) and pnpm **12.6.0**.
Not compatible with the OpenCode V1 plugin API.

## Quick install

### 1. Install from GitHub

```sh
opencode plugin add github:JeanRGW/opencode-image-generation#v0.2.0
```

This follows OpenCode's [Git package installation](https://opencode.ai/v2/docs/plugins)
and installs the SDK dependency automatically. No clone, build, npm publication,
or MCP configuration is required. The version tag pins the release; a complete
commit hash is preferable when you need an immutable pin.

### 2. Configure your API

In `~/.config/opencode/opencode.jsonc`, **replace the entry added by the command**
with the object below. Merge it into existing settings; do not add a second copy.
On Windows the usual path is `%USERPROFILE%\.config\opencode\opencode.jsonc`.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:JeanRGW/opencode-image-generation#v0.2.0",
      "options": {
        "baseURL": "https://your-provider.example/v1",
        "model": "your-image-model",
        "apiKeyEnv": "OPENAI_API_KEY"
      }
    }
  ],
  "permissions": [
    { "action": "generate_image", "resource": "*", "effect": "ask" },
    { "action": "edit_image", "resource": "*", "effect": "ask" }
  ]
}
```

Set `OPENAI_API_KEY` in the **OpenCode background server's environment**. An
environment variable visible only to the terminal client is not sufficient.
Alternatively add `"apiKey": "YOUR_API_KEY"` in `options`; a non-empty raw key
takes precedence. Keep that configuration private and never commit it.

The default endpoint is `https://api.openai.com/v1`; default model is `gpt-image-1`.
For OmniRoute, keep `/v1` in `baseURL` and use its full model ID, for example
`antigravity/gemini-3.1-flash-image` or a supported `codex/...` image model.

### 3. Reload and use

```sh
opencode service restart
opencode plugin list
```

Ask OpenCode:

> List the image models, then generate a mountain lake at sunrise and save it to
> assets/lake.png.

Approve the generation when prompted. Calls may consume paid credits or subscription
quota. Images are returned as text paths; ask the agent to inspect the file with
`read` when you want to view it. Installing the plugin does not make any API calls.

If another local copy is already installed, remove its plugin entry/directory before
installing this version; both register the same tool names.

## Configuration reference

| Option | Default / behavior |
| --- | --- |
| `baseURL` | `OPENCODE_IMAGE_BASE_URL`, then `https://api.openai.com/v1`; HTTP(S), no embedded credentials/query/fragment |
| `model` | `OPENCODE_IMAGE_MODEL`, then `gpt-image-1` |
| `apiKey` | Optional raw key; non-empty value takes precedence over environment |
| `apiKeyEnv` | `OPENAI_API_KEY`; name of the environment variable holding the key |
| `timeoutMs` | `300000`; single deadline across generation, downloads, and saving; discovery gets its own deadline |
| `maxImages` | `4`; integer 1–16, hard per-call batch cap |
| `maxImageBytes` | `26214400` (25 MiB); per decoded/downloaded image |
| `maxResponseBytes` | `67108864` (64 MiB); entire API response, including base64 expansion |
| `imageDownloadOrigins` | `[]`; additional exact trusted HTTP(S) origins; API origin is always allowed |
| `allowExternalPaths` | `false`; opt in to writing outside the session directory |

Large batches/high resolutions may need larger byte limits. Each byte limit accepts
1–536870912. Concurrent calls can use more memory than these per-call bounds.

### APIs that return URLs

Base64 responses work without a download allowlist. If your provider returns images
on a different CDN origin, allow it explicitly **before generating**:

```jsonc
"imageDownloadOrigins": ["https://your-provider-cdn.example"]
```

Only allow trusted origins; do not use wildcards or copy untrusted hosts into this
setting. No redirects are followed and no API key is sent to downloads. A rejected
download may occur after a billable generation; prefer `response_format: "b64_json"`
when your model supports it. See [SECURITY.md](SECURITY.md) for trust boundaries.

## Tool inputs and outputs

`generate_image` accepts `prompt`, plus optional `model`, `n`, `outputPath`, `size`,
`aspect_ratio`, `image_size`, `quality`, `background`, `output_format`, and
`response_format`. `n` defaults to 1. Optional API fields are sent only when supplied;
unsupported parameters are not silently translated.

- `aspect_ratio`: positive `W:H`, for example `16:9`.
- `image_size`: `1K`, `2K`, or `4K`.
- `output_format`: `png`, `jpeg`, or `webp`.
- `response_format`: `url` or `b64_json` (model-dependent).
- `size`, `quality`, and `background`: provider/model-dependent strings.

Paths are relative to the invoking session directory. The default is
`generated-images/<uuid>.<detected-format>`. For `n: 2`, `assets/lake.png` becomes
`assets/lake-1.png` and `assets/lake-2.png`. Existing paths are checked before the
request, and exclusive writes prevent overwrite races. External paths/parent links
are blocked by default. Explicit filename extensions are not rewritten: the
returned MIME and dimensions describe the actual bytes, even if a provider ignored
your requested output format or resolution.

The JSON text result includes `model`, `requestedCount`, `images`, and `warnings`.
Each image has `path`, `mime`, `width`, `height`, and optional `revisedPrompt`.
Top-level image fields refer to the first image for compatibility.

### OmniRoute tuning

Antigravity uses aspect ratio and resolution tier:

```json
{
  "prompt": "A mountain lake at sunrise, cinematic landscape photography",
  "model": "antigravity/gemini-3.1-flash-image",
  "aspect_ratio": "16:9",
  "image_size": "2K",
  "n": 2
}
```

Codex image models use model-supported `size` and `quality` (often
`auto`/`low`/`medium`/`high`). Requested pixels are not guaranteed. These are
[adapter hints](https://github.com/diegosouzapw/OmniRoute/blob/main/open-sse/handlers/imageGeneration.ts),
not negotiated capabilities, and deployed gateway versions can differ.

`list_image_models` calls `GET <baseURL>/models`. Candidates are found via image type,
image output modalities, or name heuristics. Catalog visibility does **not** prove
image-route support, connected credentials, entitlement, or parameter support.

## Editing images

`edit_image` accepts a `prompt` and `imagePaths` (1–4 local PNG/JPEG/WebP paths).
Optional inputs are `model`, `outputPath`, `size`, `quality`, `background`,
`output_format`, and `response_format`. It uses the configured default model,
uploads image bytes as base64 data URLs in `images`, and requests one output.

```json
{
  "prompt": "Replace ALPINE DAWN with ALPINE DUSK; preserve the rest",
  "imagePaths": ["assets/poster.png"],
  "model": "codex/gpt-5.6-sol-image",
  "outputPath": "assets/poster-edited.png"
}
```

### Generating from reference images

`/images/generations` is text-only, so there is no separate "generate with
references" tool. To create a new image guided by existing ones, use `edit_image`
with up to 4 `imagePaths` and describe the new image in the prompt, for example
"Create a new poster in the style of these two images, featuring a desert canyon".
This relies on the provider honoring multiple references on `/images/edits`. Codex
models on OmniRoute accept up to 8 (the plugin caps at 4); most other providers
accept only one, and Antigravity rejects edits. Live verification confirmed 1, 2, 3,
and 4 references across the Codex Sol, Terra, and Luna models on OmniRoute.

Paths must resolve inside the invoking session directory, including symlink targets;
`allowExternalPaths` only enables external **output** writes, not input uploads.
Original files are not modified. Each input is bounded by `maxImageBytes`, and the
serialized request is bounded by `maxResponseBytes` (including base64 expansion).
The existing output byte limits, download-origin allowlist, cancellation, no-retry
policy, and text-only result shape apply to edits too.

**Only use references you intend to share with the configured provider.** Set the
`edit_image` permission to `ask`; it controls both local reading/upload and generation.
The tool does not invoke built-in `read` permission rules separately.

The deployed OmniRoute endpoint was verified with 20 live calls covering headline
edits on all three Codex image models, PNG and JPEG references, 1–4 reference
compositions, recolors, relative/absolute/nested/automatic destinations, `size`,
`response_format`, `quality`, `background`, and `output_format`. Antigravity
returned an explicit unsupported-provider error. Providers may ignore optional
controls and return unexpected dimensions, so limits vary by provider. No masks,
edit batches, remote reference URLs, file IDs, multipart-only APIs, or
conversational state are supported in this implementation.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Plugin fails to load | OpenCode V2, valid options, and package dependency installation; check `opencode plugin list` |
| Missing API key | Set `apiKey` or the configured variable in the server environment, then restart |
| HTTP 401/403 | API key and provider/model access |
| HTTP 404 | Base URL usually needs `/v1` |
| HTTP 400 | Valid image route/model/parameters; a model listed by `/models` can still be unroutable |
| Download origin rejected | Configure the provider's trusted CDN origin, or request supported `b64_json` |
| Byte limit exceeded | Reduce batch/resolution or explicitly raise the appropriate limit |
| Output path rejected | Use an in-session path; only opt into external writes if needed |
| Reference rejected | `edit_image` reads only files that resolve inside the session directory, and accepts 1–4 PNG/JPEG/WebP paths |
| Timeout or abort | Generation may already be billed; check the provider before retrying |

Provider response bodies and low-level network causes are intentionally not exposed
because they may contain secrets. Inspect gateway diagnostics privately and redact
them before sharing. No automatic retries are made. A short batch returns a warning;
a malformed batch is rejected before any image is written. A save failure preserves
completed files, reports their paths, and may leave an incomplete new file at the
failed destination. Check that path before retrying.

## Local development / manual install

```sh
git clone https://github.com/JeanRGW/opencode-image-generation.git
cd opencode-image-generation
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm test:package
```

For a local installation, configure `plugins` with an absolute path to the clone
and the same `options` above. Use forward slashes in Windows JSON paths, for example
`C:/projects/opencode-image-generation`. Restart after changing unwatched local
dependencies. Do not also install the GitHub package.

Tests use local mock endpoints and do not consume image-generation quota. The
packaged-install test creates a temporary installation and downloads dependencies
from npm, but makes no image-provider calls. GitHub Actions checks Node 22/24 on
Linux and Windows, including the isolated package installation.

See [REVIEW.md](REVIEW.md) for release findings and remaining limitations, and
[OpenCode's publishing guidance](https://opencode.ai/v2/docs/build/plugins#publish)
for the plugin contract. Licensed under [MIT](LICENSE).
