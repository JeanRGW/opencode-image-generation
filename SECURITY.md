# Security

Do not post API keys, authorization headers, signed image URLs, prompts, or private
configuration in issues. Use GitHub's private vulnerability reporting when enabled;
otherwise contact the repository owner before disclosing a vulnerability publicly.

The plugin runs with the OpenCode server user's privileges. Treat both plugins and
configured API endpoints as trusted code/services. API calls send your prompt to
the configured endpoint; image downloads never forward your API credential.

Downloads are limited to the API origin and explicit `imageDownloadOrigins`.
Origins are exact scheme/host/port matches, not wildcards. Only allow trusted CDNs;
this is an origin allowlist, not DNS pinning or a network sandbox. A trusted host
can resolve to a private address. API endpoints may deliberately be local.

Output paths stay inside the session directory by default, including checks of
existing parent links. The checks cannot prevent a concurrent process from swapping
directory links; do not use untrusted writable output directories. Setting
`allowExternalPaths` gives the tool permission to create files outside the session.
The custom `generate_image` action does not separately invoke built-in `edit` or
`external_directory` permission checks. Configure it to `ask` when generation or
file creation requires approval.

Responses and decoded images have configurable byte limits. The limits do not
provide a process-wide memory budget: concurrent calls and base64 decoding can use
several times the response size. Dimension detection validates supported headers,
not full image decoding or integrity. Saved files should still be treated as
untrusted input when opened by another application.

Errors deliberately exclude provider response bodies and low-level network causes.
Generation is never automatically retried: failure, timeout, or cancellation does
not prove that the upstream job stopped or that no charge occurred. A failed write
may leave an incomplete newly created file; it is reported rather than overwritten
or silently deleted. Completed files from a partial batch are preserved.
