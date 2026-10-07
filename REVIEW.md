# Release review: 0.2.0

## Added in 0.2.0

- `edit_image` calls the JSON `/images/edits` route, reusing the generation
  configuration, byte limits, download allowlist, cancellation, no-retry policy,
  and exclusive no-overwrite writes.
- Local reference uploads accept 1–4 PNG/JPEG/WebP files, resolve and read them
  with bounded streaming, and require them to stay inside the session directory
  even when external output writes are enabled.
- Reject masks, batches, and generation-only controls instead of silently
  dropping them; register a dedicated `edit_image` permission.
- Add mock coverage for reference uploads, multi-reference bodies, path
  confinement, symlink escapes, request-size limits, and tool registration.

## Live verification

Twenty billed calls against the deployed OmniRoute endpoint passed: headline edits
on Sol/Terra/Luna, PNG and JPEG references, 1–4 reference compositions, recolors,
relative/absolute/nested/automatic destinations, and `size`, `response_format`,
`quality`, `background`, and `output_format`. Sources were byte-identical after the
run and every output differed from its input. Antigravity still rejects edits.

Observed provider behavior: requested `size` is not always honored (`1024x1024`
returned `1024x1536`), and `quality`/`background` had no reliable effect, so those
remain advisory.

# Release review: 0.1.0

## Fixed before publication

- Follow OpenCode V2's default `Plugin.define` export and tool transforms. Validate
  options on load; pass the invocation cancellation signal to all API/download work.
- Move `@opencode/plugin` from dev-only to pinned runtime dependencies. Declare
  version, engines, license, repository, and a restricted package file list.
- Bound streamed API responses and images, including missing/misleading
  Content-Length and base64 responses. Reject malformed JSON without quoting it.
- Avoid repeated-group base64 validation regexes that can overflow V8's regex
  stack on real multi-megabyte image payloads; cover a large response in tests.
- Sanitize network errors and exclude provider error bodies. Do not retry a paid
  generation automatically, and do not send API credentials to downloads.
- Restrict returned download URLs to the API origin or an explicit trusted-origin
  allowlist; reject redirects, embedded credentials, and non-HTTP(S) schemes.
- Keep output paths inside the session directory by default, check existing parent
  links before generation and saving, and retain exclusive no-overwrite writes.
- Make model discovery tolerate malformed catalog entries and recognize image
  output modalities plus common image-model names. Discovery remains advisory.
- Add malformed/oversized-response, redirect, download-origin, timeout/cancellation,
  filesystem, and packaged-install regression tests; add Linux/Windows CI.
- Publish documented, version-pinned GitHub installation without requiring npm
  publication or provider-specific credentials in the repository.

## Readiness and limitations

Suitable for a **0.1.0 release for trusted local OpenCode V2 use**, not a multi-tenant
image proxy or hardened network/filesystem sandbox. See [SECURITY.md](SECURITY.md).

The API integration is generic OpenAI-compatible; OmniRoute parameter guidance is
advisory, not a provider guarantee. Some catalog entries cannot use the image route,
and providers can ignore requested size/quality or return fewer images. Actual
dimensions are returned. Explicit output filenames are preserved even if their
extension differs from the provider's actual image format; use the returned MIME
type as authoritative.

Verification uses mock endpoints and synthetic headers, not billed generations.
The package is tested against `@opencode/plugin` 2.0.24. The packaged-install test
installs the tarball in an isolated directory and checks the runtime entrypoint and
tool registrations, with a scoped TypeScript loader because plain Node does not
strip types inside `node_modules`. OpenCode 2.0.23 also loaded the local package as
active through its real plugin loader. Compatibility with later APIs must be rechecked.
No lint toolchain was present; strict TypeScript and Node's built-in tests are used.
GitHub Actions supplies the platform matrix; local success alone does not establish
Linux compatibility or a passing remote CI run.
