import { Plugin } from "@opencode/plugin";
import { configuration, generate, listImageModels } from "./generate.ts";

export default Plugin.define({
  id: "opencode.image-generation",
  async setup(ctx) {
    const config = configuration(ctx.options);
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "generate_image",
        description: "Generate images from a text prompt using the configured image API. May incur API charges; n increases cost/quota usage and is capped by configuration (default 4). Use list_image_models first for model choices and provider-specific guidance. Antigravity uses aspect_ratio and image_size; Codex uses model-supported size and quality. Arbitrary pixel dimensions are not guaranteed. Saves PNG/JPEG/WebP locally (never overwrites), returns actual dimensions and text-only paths. Relative outputPath uses the session directory; batches add -1, -2, etc. Omit optional parameters for model defaults. Use read to inspect results.",
        input: {
          type: "object",
          properties: {
            prompt: { type: "string", minLength: 1 },
            model: { type: "string", minLength: 1, description: "Optional per-call model override; use list_image_models for available catalog IDs." },
            n: { type: "integer", minimum: 1, maximum: config.maxImages, description: "Number of images, default 1. Capped by maxImages; increases cost/quota usage." },
            aspect_ratio: { type: "string", pattern: "^[1-9][0-9]*:[1-9][0-9]*$", description: "Antigravity aspect ratio, e.g. 16:9. Upstream may restrict supported ratios." },
            image_size: { type: "string", enum: ["1K", "2K", "4K"], description: "Antigravity output-resolution tier, separate from aspect_ratio." },
            outputPath: { type: "string", description: "Optional local destination; must not already exist." },
            size: { type: "string", description: "Model-supported size, e.g. 1024x1024 or auto." },
            quality: { type: "string", description: "Model-supported quality." },
            background: { type: "string", description: "Model-supported background, e.g. transparent." },
            output_format: { type: "string", enum: ["png", "jpeg", "webp"] },
            response_format: { type: "string", enum: ["url", "b64_json"], description: "Only set if supported by the selected model." },
          },
          required: ["prompt"],
          additionalProperties: false,
        },
        options: { codemode: false, permission: "generate_image" },
        async execute(input, context) {
          const session = await ctx.session.get({ sessionID: context.sessionID });
          const image = await generate(ctx.options, input, session.location.directory, context.signal);
          // Local file URIs are not valid image inputs for OpenAI Responses.
          return { content: JSON.stringify(image) };
        },
      });
      editor.add({
        name: "list_image_models",
        description: "List image model candidates from the configured API /models endpoint, default model, batch limit, and provider-specific parameter guidance. No generation charges. Catalog entries and name heuristics do not guarantee account access or actual parameter support.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: false },
        async execute(_input, context) {
          return { content: JSON.stringify(await listImageModels(ctx.options, context.signal)) };
        },
      });
    });
  },
});
