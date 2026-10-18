# Host runtime semantics

The TypeScript interfaces describe the proposed authoring API. The host must enforce the following behavior; TypeScript annotations alone provide neither validation nor isolation.

## Durable publication and retries

Treat a processing run as a durable state machine. Persist the input first, then allocate a host-owned run ID, input revision, producer identity, bundle digest, grant set, and generation. Pin the input and contribution snapshot for that run.

Every invocation has a stable step number. `blobs.write` and `tasks.start` deduplicate on `(runId, operationKey)`. Reuse the same key on retry; reject the same key with different arguments. For streamed writes, validate the final digest before returning a previous result. These operations may be called more than once, even if the processor believes it is completing only once.

For a result that publishes content, the host:

1. Validates the result envelope and bounded JSON data, unique asset/search keys, schemas, and selector fields.
2. Checks that every referenced blob exists and is authorized for this item/run; includes references inside schema-defined plugin data and streamed search records. Require plugin schemas to declare asset-reference fields, or treat unknown strings as plain data and never dereference them automatically.
3. Seals the staged assets used by the contribution and records its provenance.
4. In one metadata transaction, checks the active run/generation/input revision, inserts the immutable contribution, updates the producer's current pointer and any selected primary pointer, persists checkpoint/job state, and appends an indexing event to an outbox.
5. Builds the new search generation from that outbox, then atomically swaps that producer's visible search entries. Queries check item access and visible revision; they never mix an old excerpt with a new location.

Object storage, metadata storage, and a search service are not one distributed transaction. Staging plus a committed manifest and idempotent outbox make this explicit. Keep the prior successful output until the replacement is valid. Report indexing state independently if indexing lags publication.

`waiting.task` must identify a task started under this run's authority. The host persists its association and checkpoint together. A task that completed before the checkpoint commit is still found on replay. Deliver its terminal result only from the host task ledger, not from plugin-supplied checkpoint values. A task may return staged blobs, which become readable by that run without minting broader storage authority.

`continue` resumes immediately through the scheduler with a bounded total step count. A future sleep or event result can be added when a concrete workflow needs it. Never busy-loop in a Worker while waiting for an external job.

Cap task starts, bytes, wall time, CPU, retries, total steps, model spend, and progress/log volume. Charge and authorize service operations at the host boundary. A timeout or cancellation revokes the invocation lease so late mutations cannot publish. Cancel external work when the provider supports it; preserve an honest “cancellation requested” state otherwise. A timed-out Promise is not evidence that external work stopped.

Neither idempotent RPC nor durable steps provide universal exactly-once external effects. Use provider idempotency keys or reconcile operation receipts. An ambiguous paid or destructive operation should not be blindly repeated. The initial content services should mostly acquire, transform, and store data; unrelated mutations require separately granted actions.

## Selection and version retention

Probe candidates sequentially or in bounded parallelism, with a per-candidate byte/time budget. A probe failure is visible diagnostic information, not a match. The configured fallback remains available. Once an interpreter is selected, a failure is surfaced rather than quietly bypassing its archival requirements. `declined` explicitly permits trying the next automatic candidate.

Enrichers receive a pinned authorized snapshot. Their output belongs to their producer namespace; it does not modify annotations, user title overrides, read state, tags, another producer's output, or another run's state. Select the primary list summary/view explicitly. Search includes enabled contributions with provenance and may group their hits by item.

Keep three versions separate: extension protocol (`apiVersion`), executable release/bundle digest, and content `schema.version`. A content schema is not owned by a particular executable version. Installation checks supported protocol and requested capabilities; view selection checks supported schema versions. Unknown schemas fall back to summary, downloads, search, and notes.

Disabling a plugin revokes capabilities and stops future execution, while keeping stored assets, search projections, and annotations available. Updating a plugin does not silently increase grants. Uninstall and delete-data are distinct operations. Item deletion revokes asset leases and removes search visibility before asynchronous cleanup. Garbage collection respects retained input/output revisions, annotation anchors, active jobs, and export requirements; annotations cannot keep another tenant's blob alive.

Reprocessing and migrations produce new immutable contributions. Preserve exact target blobs and selector schemas for historical annotations. Text selectors use UTF-16 offsets in a defined text asset plus quote/prefix/suffix for verification; offsets alone are insufficient after transformations. Time selectors use seconds in the specified media asset. Region coordinates are normalized to `[0,1]` within that image, with positive dimensions and bounds checks. Custom selector schemas define their coordinate system, stable object identity, and versioning. Never claim an old selection resolved merely because a new asset happens to share a local filename.

## Backend capability boundary

Do not pass Magpie's complete environment to a plugin. Bind authority to the installation, authenticated principal, item, input revision, run, generation, and current policy outside plugin-controlled arguments. An opaque ID is a lookup key, not permission. Every read/write checks the host's grant ledger. Checkpoints and `data` cannot introduce new authority by naming an arbitrary blob, account, or task ID.

The input payload is itself a grant of information. A plugin seeing one item's capture already has its text even if it has no `read` method. Do not pass the whole library, unrelated account configuration, or other tenants' records to a hook.

Dynamic Workers' `globalOutbound` defaults to inherited network access; explicitly set it to `null` for this design. Supply scoped service bindings instead. Loader cache IDs must incorporate every code/config change; never cache different per-user bindings under one shared code-only ID. Per-invocation RPC capabilities can carry narrower run authority without changing the code. [Cloudflare API reference](https://developers.cloudflare.com/dynamic-workers/api-reference/)

The logical `ProcessingHost` methods must be implemented with `WorkerEntrypoint` service bindings or `RpcTarget` capabilities. A plain JavaScript object with nested function values is not a Workers RPC implementation. Nested services such as `blobs`, `tasks`, and `annotations` need RPC targets/stubs or a flattening adapter. Persist IDs and JSON; reconstruct live capabilities for each invocation and dispose them when their session ends. Streams are transport values, not durable checkpoint values. [Workers RPC lifecycle](https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/)

Bundle extension TypeScript to JavaScript before loading it. The package digest pins the exact code; `apiVersion` negotiates the authoring contract. Keep the adapter that implements this proposal separate from Cloudflare's types so experiments can run against an in-process test host as well as a Worker host. Such a test host is trusted development machinery, not a sandbox for untrusted code.

Cloudflare now documents Dynamic Workflows for durable execution of dynamically loaded code. That is one possible implementation of this state machine; a host workflow/queue plus explicit checkpoints is another. The proposed API does not depend on keeping an isolate, closure, or RPC reference alive between steps. [Dynamic Workflows](https://developers.cloudflare.com/dynamic-workers/usage/dynamic-workflows/)

## Credentials and external services

`settings.get` exposes plugin-scoped nonsecret settings or opaque account handles. The host stores credentials separately under the user/installation/provider namespace and injects them only inside an authorized connector operation. A paywall plugin can request `publisher.capture` using a chosen account handle; it does not need a raw `getSecret()` operation.

Allowlisting a provider hostname is not sufficient by itself. A capture connector validates schemes, destinations and redirects; avoids private/link-local network access; partitions cookies and cache; bounds response size and time; and confines the operations available on that account. A browser connector must apply equivalent controls to subresources and navigation. Prevent arbitrary headers, redirects, or URLs from turning credential injection into secret disclosure. [Cloudflare egress control](https://developers.cloudflare.com/dynamic-workers/usage/egress-control/)

An extension that can read private content and send arbitrary payloads to an external service can disclose that content even without seeing credentials. Scope service inputs and outputs, make external processing grants visible, and track cost/provenance. The concrete capabilities for a particular plugin are a product/policy choice; the manifest's request strings alone do not enforce it.

## Frontend capability boundary

Use a host-owned iframe wrapper with an opaque origin, a minimal sandbox (initially `allow-scripts` only), and a restrictive CSP. Do not import plugin modules into the parent application's JavaScript realm or grant `allow-same-origin` on a same-origin frame. Do not allow popups, forms, top navigation, nested frames, or arbitrary downloads by default. If external navigation becomes necessary, add a host-mediated operation with destination validation and explicit user intent.

Use a MessageChannel bootstrap that checks the exact iframe window, expected opaque origin, and current mount generation before handing over a port. The string `"null"` alone is not identity. Accept one bootstrap for that generation; reject late/replayed handshakes, validate all messages, and revoke the port on unmount. Bind the session to a server-attested user/item/revision/installation, never a claimed ID in a message.

`View.mount` and its DOM root remain local inside the frame. A bundled bridge adapts `ViewHost` and `ViewSession` to browser RPC. The host can call `navigate` for a search hit and push `update` for annotations/theme. If the selected contribution changes schema or revision incompatibly, remount it. Use generation checks to discard stale async results after navigation. Cleanup removes listeners, releases asset leases/resources, and closes sessions. An opaque iframe isolates authority; it does not guarantee a separate CPU process or eliminate all browser resource exhaustion.

Start with `default-src 'none'`; grant only the script/style/media/worker sources required by the verified package and granted assets. Bundled package scripts must have a host-generated CSP policy; do not accept plugin-supplied CSP headers. A controlled asset origin may be permitted for specific media/range reads, with read-only leases bound to approved blobs and no ambient app cookies. Implement CORS for the opaque frame without treating `Origin: null` as authorization. Prevent the asset service from becoming an arbitrary proxy or an unrestricted endpoint with write side effects.

Lease URLs are short-lived bearer capabilities once issued. Do not log or persist them in content metadata; renew while needed and revoke on access changes where the lease mechanism permits. Support HTTP Range, known media types, cache partitioning, expiry, and item deletion. `assets.read` is an alternative for bounded chunks. Large data should not be base64-copied through message JSON. Bundle integrity-checked DuckDB JS/WASM/worker code; test the minimal WASM/worker CSP and use a single-thread build initially unless cross-origin isolation is deliberately configured.

Untrusted archived HTML is content, not executable viewer code. Render a sanitized readable representation or a separately sandboxed inert document. Keep trusted viewer code and hostile scraped bytes separate even when both are stored as assets.

Cloudflare OS demonstrates the iframe/CSP/MessageChannel architecture, including source checks and disposal. Its reviewed gadget allows popups and `data:` media; this proposal intentionally needs a stricter popup policy and a different large-asset path. [Pinned iframe implementation](https://github.com/cloudflare/cloudflare-os/blob/8060cd9fde6bdec1159df46054f0a559e93822a1/packages/workshop-frontend/src/GadgetUI.tsx)

## MCP transport

Expose the same authorization and item semantics through UI and MCP adapters. JSON MCP messages do not directly carry `ReadableStream`, DOM objects, or live `AnnotationHost` instances: adapters map streams to upload/download resources and flatten item-scoped annotation methods into explicit tools. Bound inline text sizes; use chunked or resource uploads for larger documents.

Agent identity comes from the authenticated connection. An agent can submit notes, find authorized documents, read assets, and create annotations with the same host checks as a person. Creation timestamps, author, processing provenance, and source citations remain distinct. A document's text may cite other work, but its assertions are not trusted instructions to the host or another extension.

Keep the proposed third command extension separate from these core tools. A plugin-specific remote query or reanalysis action needs an explicit schema, permission, side-effect classification, and UI/MCP exposure decision. Installing a content viewer must not automatically grant it access to every library tool or expose all of its backend methods to agents.
