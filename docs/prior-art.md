# EmDash extension prior art

This proposal draws on the source study in [Stacks PR 270][pr]. That PR is documentation, not an implemented Magpie plugin system. Its EmDash snapshot is `30604dcb0538df477ea0d8bde894ecdb57388bad` (15 October 2026); implementation claims below refer to that snapshot. This was static source inspection, not a live security audit.

## The important frontend distinction

EmDash's sandboxed plugins return **Block Kit JSON rendered by trusted host components**. Their browser code does not execute inside a frontend sandbox. Arbitrary React admin components and Astro public renderers belong to a separate native installation path with application-level trust. The reviewed implementation has no iframe or browser-worker plugin UI runtime. [Renderer][renderer], [native restrictions][native-restrictions]

This is useful prior art for summaries, settings, and host actions. It is insufficient by itself for the requested CAD viewer, DuckDB/WASM interface, or tightly synchronized video/transcript experience. Our `View` runs executable code inside a separate frontend isolation boundary; that is a proposed additional mechanism, not something borrowed from EmDash. Our plain `Summary` keeps list/search rendering cheap and usable when a custom view is unavailable.

## Extension families

EmDash has many named hooks because it is a CMS. These are useful questions to ask, not a checklist to reproduce. [Hook gates][hook-gates], [manifest][manifest]

| Family | EmDash contributions | Implication here |
| --- | --- | --- |
| Processing and policy | Save/delete transforms, publication vetoes, media hooks | Separate transformation from permission to mutate arbitrary library records. |
| Notifications | Committed content transitions, comments, bylines, email events | Input/event payloads themselves disclose data; receiving a hook needs authorization. |
| Lifecycle and background work | Install, activate, deactivate, uninstall, durable cron | Define disable, retention, retries, and refresh behavior before adding callbacks. |
| Commands and agent tools | Named HTTP routes and explicitly exported MCP tools | Shared operations can serve UI and agents without automatically exporting every route. |
| Presentation | Pages, widgets, saved-entry panels/actions, field widgets | Placement and rendering authority are separate; native list columns are not sandboxed UI. |
| Host services | Namespaced storage/KV, settings, secrets, network/media APIs | These are capabilities consumed by extensions, not more extension callbacks. |

That distinction supports the two extension interfaces in [contracts.ts](../src/contracts.ts): `Processor` and `View`. Submission, search, annotations, storage, and durable execution remain shared host operations. More capabilities need not mean more plugin entry points.

## Actual reduced signatures

The following excerpts reduce the existing types for comparison; referenced types and optional metadata are omitted. They are not this repository's API. Sandboxed routes take two arguments, unlike native EmDash routes. [Author-facing definitions][plugin-types], [UI definitions][ui-types]

```ts
interface SandboxedPlugin {
  hooks?: { [K in keyof HookHandlers]?: HookEntry<K> };
  routes?: Record<string, RouteEntry>;
  mcp?: { tools: Record<string, SandboxedMcpTool> };
}

type SandboxedContentBeforeSaveHandler = (
  event: ContentHookEvent,
  ctx: PluginContext,
) => Promise<Record<string, unknown> | SandboxHookErrorEnvelope | void>;

type RouteHandler<T = unknown> = (
  routeCtx: Omit<SandboxedRouteContext, "input"> & { input: T },
  ctx: PluginContext,
) => Promise<unknown>;

interface SandboxedRouteContext {
  input: unknown;
  request: SandboxedRequest;
  ui?: PluginUiContext; // Host-attested surface and saved-entry identity.
  user?: UserInfo;     // Host-authenticated caller on private routes.
}

type BlockInteraction =
  | { type: "page_load"; page: string }
  | { type: "block_action"; action_id: string; value?: unknown; page?: string }
  | { type: "form_submit"; action_id: string; values: Record<string, unknown>; page?: string };

interface BlockResponse {
  blocks: Block[];
  toast?: { message: string; type: "success" | "error" | "info" };
  patch?: EditorDraftPatchEffect;
  refresh?: true;
  navigate?: LinkTarget;
}
```

The mapped `hooks` type above omits the actual special case for `content:beforeSave`, whose sandbox-specific return type is shown separately. Block/form actions also accept an optional `block_id`. The host renderer uses a fixed component switch; a block cannot name a module to import or supply a JavaScript event handler.

## Boundaries worth retaining

**Attest the invocation.** EmDash checks the selected panel/action and loads the saved entry before constructing its identity and version. Browser-provided context is not authority. Draft read and patch grants are separate. Revision, invocation, and editor-generation checks discard late results after navigation or editing. Our view bridge should similarly bind the installation, item, contribution, and approved operations. [Dispatch][dispatch], [stale results][stale]

**Bind capabilities in the host.** The Cloudflare runner passes only plugin metadata and a bridge, with `globalOutbound: null`. Bridge properties carry plugin identity, capabilities, hosts, and storage collections. A plugin cannot widen authority by passing another plugin ID. Our host must additionally scope access to tenant, item, and run; hiding methods in TypeScript is not enforcement. [Worker construction][worker]

**Validate downstream effects.** EmDash checks resource URLs, navigation, patches, and structural budgets, not only JSON shape. Its Block Kit limits are 256 KiB, depth 20, 2,000 nodes, 1,000 array entries, and 64 KiB per string. Our larger artifacts belong in streamed blobs, with bounded manifests. Returning a URL that trusted code later fetches is also a network request requiring policy. [Limits][limits], [URL policy][urls]

**Preserve host ownership of user data.** Annotations and indexed text are shared library features in this proposal, not demonstrated EmDash equivalents. A view supplies a selection/anchor; the host stores, authorizes, indexes, and displays the annotation. Search projections use those same anchors so a result can navigate to a subtitle, image, or CAD selection. A missing view must not erase annotations or original bytes.

**Separate caller rights from installed grants.** Permission to invoke a route does not automatically attenuate a plugin's broad content access to the caller's selected item. Our invocation authority must be the intersection of installed grants, caller rights, and the current operation/resource. Host-attested identities must never be accepted from arbitrary message payloads.

## Limits and omissions to consider explicitly

- **Declared constraints are not necessarily enforced.** EmDash explicitly marks unknown `declaredAccess` constraints advisory; only `network.request.allowedHosts` is normative at this snapshot. Do not infer item-level restrictions from a plausible-looking manifest field. [Constraint semantics][constraints]
- **Secrets at rest differ from secrets hidden from code.** EmDash encrypts secret settings with AES-GCM, binding ciphertext to the plugin/key, but the plugin can receive plaintext. This proposal's host connector/account handles intentionally keep credentials out of processor and view code. Connector configuration and consent still need implementation. [Secret storage][secrets]
- **Timeout does not mean termination.** The runner's wall-time limit uses `Promise.race`; it does not cancel all bridge effects. The reviewed default 50 ms CPU/10 subrequests reflects CMS hooks, not video processing. Our durable tasks/checkpoints and operation keys must handle retries and late completion explicitly. [Runner limits][runner-limits], [timeout][timeout]
- **Lifecycle is partly a data-retention contract.** Disable should revoke future execution while preserving bytes, summaries, search material, and notes. Uninstall should not silently delete library content. Outstanding runs need pinned releases and a defined revocation outcome. These are requirements for our host, not claims about current Magpie behavior.
- **Migration has multiple meanings.** Keep host API compatibility, extension release, and stored schema version separate. Prefer new immutable contributions when reprocessing retained input. A future state-migration callback needs its own necessity, atomicity, and rollback story; it is not implied by `schema.version`.
- **Commands may become a third interface.** Refresh, export, or “send this selection elsewhere” can require named extension operations beyond processing and viewing. Add a schema-validated, scoped command only when a concrete action needs it; do not expose a generic host RPC proxy to views.
- **MCP export is explicit in EmDash.** Descriptors identify a private JSON route, permission, description, input/output schemas, and destructive hint, with additional operator/token checks. Our agent notes use ordinary `LibraryAPI` submit/search/read/annotate adapters; these do not require plugin-defined MCP tools. [MCP descriptor][mcp], [MCP dispatch][mcp-dispatch]
- **Check the complete installation path.** PR 270 found accepted field-widget declarations not forwarded through the registry admin path and Portable Text declarations omitted there. It also found update consent comparing capability names without equivalent host-widening checks. These are pinned findings, not assertions about every later EmDash release. [Research details][frontend-report], [capability report][capability-report]

## Sources

[pr]: https://github.com/jmorrell/stacks/pull/270
[renderer]: https://github.com/emdash-cms/emdash/blob/30604dcb0538df477ea0d8bde894ecdb57388bad/packages/blocks/src/renderer.tsx#L21-L125
[native-restrictions]: https://github.com/emdash-cms/emdash/blob/30604dcb0538df477ea0d8bde894ecdb57388bad/packages/core/src/astro/integration/index.ts#L552-L585
[hook-gates]: https://github.com/emdash-cms/emdash/blob/30604dcb0538df477ea0d8bde894ecdb57388bad/packages/core/src/plugins/hooks.ts#L325-L393
[manifest]: https://github.com/emdash-cms/emdash/blob/30604dcb0538df477ea0d8bde894ecdb57388bad/packages/plugin-types/src/index.ts#L486-L591
[plugin-types]: https://github.com/emdash-cms/emdash/blob/30604dcb0538df477ea0d8bde894ecdb57388bad/packages/core/src/plugin-types.ts#L247-L340
[ui-types]: https://github.com/emdash-cms/emdash/blob/30604dcb0538df477ea0d8bde894ecdb57388bad/packages/blocks/src/types.ts#L417-L536
[dispatch]: https://github.com/emdash-cms/emdash/blob/30604dcb0538df477ea0d8bde894ecdb57388bad/packages/core/src/plugins/http-route-dispatch.ts#L199-L390
[stale]: https://github.com/emdash-cms/emdash/blob/30604dcb0538df477ea0d8bde894ecdb57388bad/packages/admin/src/components/ContentEditor.tsx#L1005-L1064
[worker]: https://github.com/emdash-cms/emdash/blob/30604dcb0538df477ea0d8bde894ecdb57388bad/packages/cloudflare/src/sandbox/runner.ts#L339-L405
[limits]: https://github.com/emdash-cms/emdash/blob/30604dcb0538df477ea0d8bde894ecdb57388bad/packages/blocks/src/validation.ts#L60-L72
[urls]: https://github.com/emdash-cms/emdash/blob/30604dcb0538df477ea0d8bde894ecdb57388bad/packages/blocks/src/validation.ts#L318-L449
[constraints]: https://github.com/emdash-cms/emdash/blob/30604dcb0538df477ea0d8bde894ecdb57388bad/packages/plugin-types/src/index.ts#L182-L227
[secrets]: https://github.com/emdash-cms/emdash/blob/30604dcb0538df477ea0d8bde894ecdb57388bad/packages/core/src/plugins/settings.ts#L65-L118
[runner-limits]: https://github.com/emdash-cms/emdash/blob/30604dcb0538df477ea0d8bde894ecdb57388bad/packages/cloudflare/src/sandbox/runner.ts#L51-L65
[timeout]: https://github.com/emdash-cms/emdash/blob/30604dcb0538df477ea0d8bde894ecdb57388bad/packages/cloudflare/src/sandbox/runner.ts#L408-L460
[mcp]: https://github.com/emdash-cms/emdash/blob/30604dcb0538df477ea0d8bde894ecdb57388bad/packages/plugin-types/src/index.ts#L439-L454
[mcp-dispatch]: https://github.com/emdash-cms/emdash/blob/30604dcb0538df477ea0d8bde894ecdb57388bad/packages/core/src/mcp/server.ts#L923-L988
[frontend-report]: https://github.com/jmorrell/stacks/blob/61d4232dfe27bb91a43d523c6cab7965327d07b5/docs/research/emdash/03-frontend-security.md
[capability-report]: https://github.com/jmorrell/stacks/blob/61d4232dfe27bb91a43d523c6cab7965327d07b5/docs/research/emdash/01-extension-points-and-capabilities.md
