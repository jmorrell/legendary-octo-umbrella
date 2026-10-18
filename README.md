# Content extension interface experiment

Start with **two extension points: a processor and a detail view**. Give them host capabilities for the things that must work consistently across the library: archived bytes, durable jobs, search, annotations, and authorized access to external services.

The useful abstraction is:

```text
saved input -> versioned contributions -> views
                    |                  |
                search targets <-> annotation targets
```

A contribution is a small manifest over stored assets, with plugin-defined data and an explicit search projection. An item has stable identity independent of its URL, its current renderer, and its latest processing attempt. This accommodates a video with many supporting files as naturally as a generated Markdown document.

This repository contains a proposed API and typechecked examples. It does not implement a storage service, scheduler, Dynamic Worker host, or browser isolation runtime.

## The two extension points

| Contract | Methods | Responsibility |
| --- | --- | --- |
| `Processor` | `probe(item, host) -> Promise<Match \| null>`; `process(request, host) -> Promise<ProcessResult>` | Recognize inputs, acquire or transform bytes, emit structured data and search material |
| `View` | `mount(root, context, host) -> Promise<ViewSession>` | Render an isolated detail view; return `update`, `navigate`, and `dispose` methods |

The full definitions are in [src/contracts.ts](src/contracts.ts). `ExtensionManifest` registers zero or more of each. A renderer can accept a schema produced by a different extension: a user can replace the video player without downloading and transcribing the archive again.

Submission is a **host API**, not a plugin callback. Storage, search, annotations, settings, and external services are **capabilities**, not additional callbacks. List rows are **data**, not a third executable UI surface. This count describes the initial content extension API; it does not pretend the host or its service integrations have only two interfaces.

```ts
interface Processor {
  probe(item: ItemSnapshot, host: ProbeHost): Promise<Match | null>;
  process(request: ProcessRequest, host: ProcessingHost): Promise<ProcessResult>;
}

interface View {
  mount(root: HTMLElement, context: ViewContext, host: ViewHost): Promise<ViewSession>;
}
```

Keep the two contracts independently installable. For example, an accessibility-focused viewer should not need write access to archived content or a transcription account.

## Submission is a collection of sources

Normalize the user's three input forms into one nonempty `sources` list:

```ts
// Link
{ sources: [{ key: "origin", uri: "https://example.com/article" }], idempotencyKey: "save-1" }

// Link and captured page
{
  sources: [
    { key: "origin", uri: "https://example.com/article" },
    { key: "capture", blob: uploadedHTML, role: "snapshot" }
  ],
  idempotencyKey: "save-2"
}

// File, including an agent-authored document
{
  sources: [{ key: "original", blob: uploadedFile, name: "notes.md" }],
  idempotencyKey: "save-3"
}
```

`upload(stream, mediaType)` produces the opaque `BlobRef` used here. Byte streams cross the upload boundary; the durable submission contains references. This keeps multi-gigabyte files out of JSON, RPC payloads, and workflow checkpoints. Small-file and text convenience functions can wrap this without creating new input kinds.

The host validates ownership and persists the input before invoking an extension. A URL-only submission durably preserves the locator; the UI must distinguish that from successfully archiving the remote bytes. Failed processing leaves an accessible saved input and a retryable job, rather than losing the submission.

`uri` expresses provenance or a place from which content can be acquired. In v0, only approved HTTP(S) locators are fetched; it does not authorize arbitrary URI schemes. Source keys are unique within an input. `role` is a hint, not authority or proof of MIME type.

Do not use URL or content hash as item identity. Saving the same page twice may be intentional. `idempotencyKey` deduplicates a retried request; host policy may separately suggest duplicate items. `replace` uses an expected input revision to edit a document while keeping its item identity. The host, rather than an agent-supplied field, records the authenticated author.

## Processing publishes a manifest

The essential output is:

```ts
interface ContentDraft {
  schema: { id: string; version: number };
  data: Json;
  assets: Asset[];
  summary: Summary;
  search: SearchProjection;
  preferredView?: string;
}
```

`data` is structured, versioned JSON, not a JSON string inside JSON. The extension owns its schema. A video can store duration, subtitle tracks, speakers, frame locations, and model provenance; a CAD processor can store assembly metadata; a recipe can store ingredients and steps. Large transcripts, tables, or manifests belong in assets referenced by this data.

`assets` contains the archived original and any useful derivatives: playable video, audio, transcript, captions, frames, previews, CAD geometry, or Parquet. An asset has a role and an immutable blob reference. There is no distinguished `images: string[]` storage channel. A frame is an image asset to which the same image-processing capability used by articles can be applied. The host can preserve dimensions, LQIP, original bytes, and transformed delivery without baking them into every content schema.

`summary` is the small host-rendered representation used in lists and search: title, description, thumbnail, and labelled facts. Start with this common shape rather than a growing menu of recipe/video/file templates or an iframe per search result. If real use later demands a special list visualization, add a bounded declarative surface then. Keep a summary even when a custom detail view exists, so search, export, and disabled-plugin fallback still work.

`search` contains only what the processor chooses to offer for indexing. Small results use `parts`; large results use an archived NDJSON stream of the same records. Each record has a stable key, plain text, and an optional location. The host indexes common item metadata and user annotations separately. `parts: []` deliberately opts out of extracted-content indexing.

The host validates references and sizes, publishes the contribution atomically, and updates search through a durable outbox. It returns stored bytes by authorized reference, never by trusting a plugin-supplied object-store key. Host-assigned contribution metadata records input revision, producer identity, bundle digest, and publication time.

## Selection and composition

`probe` is a cheap, bounded decision about whether a processor is worth trying. It can inspect source metadata and a small prefix of saved blobs. It has no browser, model, or arbitrary network capability. A captured page can be inspected for recipe JSON-LD; an unknown-domain URL can still receive a generic web offer.

The host chooses one interpreter by default: explicit user selection first; otherwise specific matches before fallback matches, then the user's configured processor order, with ID as a stable tie-break. Avoid uncalibrated numeric confidence scores and races between processors. An explicit processor selection bypasses automatic ranking; if it declines, report that result instead of silently changing the user's choice.

After acquisition, `process` may return `declined` if the content is not applicable. Automatic routing then tries the next offer. Thus a recipe extension can inspect an unfamiliar page and defer to the ordinary article handler. Host acquisition services may cache a capture within the same input and credential grant; do not share private captures across authorization contexts. A processing error is not a decline: show the error and retain the input, especially when an archival or authentication requirement failed.

Optional enrichers run against a pinned snapshot after interpretation. Each publishes its own contribution under host-attested producer identity. One might add screenshot descriptions or an alternate transcript; it cannot overwrite another processor's metadata or search records. In v0 these are explicitly enabled jobs, not recursive “every publication triggers everything” rules. Do not run every installed plugin against every saved item.

One interpreter plus optional enrichers keeps basic ownership understandable while leaving room for emergence. A future dependency graph can build on revision-addressed contributions if experiments demonstrate a need.

## Long work belongs to durable jobs

`process` is a bounded invocation that returns one of:

| Result | Host behavior |
| --- | --- |
| `complete` | Validate and publish final output |
| `waiting` | Persist checkpoint; wait for a host task, then invoke again with its result |
| `continue` | Persist checkpoint and schedule another bounded invocation |
| `declined` | Try the next interpreter offer, or skip this enricher |
| `failed` | Record failure; apply bounded retry policy if retryable |

`waiting` and `continue` may also publish a usable intermediate contribution. A downloaded video can be available while subtitles and frame descriptions are still running. The host shows archival and enrichment status separately. Later optional failure leaves the last successfully published contribution accessible.

`tasks.start(service, input, operationKey)` invokes an approved service operation. An installation can be granted browser acquisition, a credentialed API, transcription, image description, image transforms, or a media/CAD compute adapter. These operations are illustrative host integrations, not built-in Dynamic Worker methods. Give each integration its own validated input/output schema and typed SDK wrapper; the common task envelope does not require every API to devolve into untyped JSON in author code.

Downloading a video with a native tool, running FFmpeg, or handling a demanding CAD format may require a container or other external service. The Dynamic Worker coordinates that work; it does not imply arbitrary native executables can run inside its isolate. Durable execution, polling, cancellation, budgets, and credentials belong to the host. See [runtime semantics](docs/runtime.md) for retries and the RPC boundary.

## Search and annotations share locations

An `Anchor` identifies immutable bytes and a selector. Standard selectors cover text quotes/offsets, time intervals, and normalized image regions. A versioned custom selector covers CAD face IDs plus camera/coordinates, Parquet query selections, or future formats.

```ts
const location: Anchor = {
  blob: archivedVideo.id,
  selector: { type: "time", startSeconds: 120, endSeconds: 126 }
};

const searchPart: SearchPart = {
  key: "frame/120",
  text: "A small dog jumps onto the sofa",
  at: location
};

const highlight: AnnotationDraft = {
  at: location,
  quote: "The selected transcript words",
  body: "Use this example in the demo"
};
```

The viewer implements `navigate(anchor)` once. Search results, the annotation sidebar, transcript lines, and frame thumbnails can then open the same position. Text selection over a transcript can preserve a quote while targeting the corresponding video time range. Exact word alignment remains plugin data; the core need not understand transcription formats.

An annotation is a host-owned record: item, optional anchor, optional quote, optional body, authenticated author, and timestamps. No anchor means a note on the whole item. A highlight can have a quote without a body; a CAD pin can have a custom selector and a body. Require at least an anchor, a nonempty quote, or a nonempty body. The host indexes notes and quotes, checks permissions, and uses optimistic versions for updates/deletes.

Anchor blobs must be reachable from the authorized item, and remain retained while annotations or searchable history reference them. A refresh creates new revisions rather than deleting the bytes under an old highlight. If a current viewer cannot resolve an old target, the host offers the old revision and a quote/body fallback. A migration may propose a remap, but should not silently rewrite the user's selection.

Screenshot descriptions need actual search entries. Merely saving an image description alongside a blob does not make it searchable. The host may combine lexical and semantic retrieval and interpret time filters such as “the other day”; that is independent of the extension API. Sampled screenshots can still miss a dog appearing between frames, so the pipeline must expose sampling choices and coverage rather than promise exhaustive visual recall.

## Detail views need executable isolation

The detail view runs in an isolated iframe and receives a narrow `ViewHost`: item-scoped asset reads, temporary asset URL leases, annotations, and its own view state. `root: HTMLElement` belongs to that iframe. It is not passed across Workers RPC or exposed from the application document.

Keep rich local interaction inside the frame: playback tracking, synchronized subtitle highlighting, selected transcript ranges, filmstrip scrolling, camera movement, DuckDB queries, and charts. Save durable user changes through the host annotation API. The host keeps list/search chrome, annotation sidebar, errors, and item identity available even if the viewer fails.

A video or Parquet viewer needs byte ranges. Asset URL leases must support seeking, expire, and be renewable; they are not public bucket URLs. DuckDB-WASM also needs a tested worker/WASM loading policy. These requirements mean the frontend isolation work is an experiment in its own right, not a consequence of sandboxing the backend Worker.

## How the requested examples fit

| Input | Stored assets and data | Search projection | View and annotations |
| --- | --- | --- | --- |
| YouTube URL | Original/downloaded media, playable copy if needed, transcript with timing/speakers, captions, sampled frames, model provenance | Transcript passages and frame descriptions, each with a time anchor | Sticky player, filmstrip, synchronized transcript; selected transcript becomes a shared annotation |
| CAD upload | Original file, assembly metadata, optional normalized geometry/preview | Names, part/assembly metadata and chosen descriptions | 3D viewer; custom selector stores stable object identity and view/position |
| Parquet upload | Original file, schema/statistics, optional previews or saved analysis | Schema and selected summary text; never automatic full-table indexing | DuckDB-WASM query/chart UI; annotation selector stores query plus stable result identity |
| Recipe URL or snapshot | Archived page, readable representation, structured ingredients/steps, archived images | Recipe plus chosen article text | Recipe-first presentation and readable page; ordinary text annotations |
| Agent document | Markdown/text/assets, source citations in content, host-attested author and revisions | Document sections and user annotations | Standard document viewer; same highlight/note behavior as articles |

[examples/scenarios.ts](examples/scenarios.ts) exercises these shapes; [examples/video-view.ts](examples/video-view.ts) shows the browser interaction contract. The examples do not download YouTube videos, implement a CAD renderer, or bundle DuckDB. They demonstrate where those implementations fit.

For the agent workflow, expose host `upload/submit/get/search/annotations` through an authenticated MCP adapter. A convenience `write_document` tool can upload UTF-8 text and submit it. Add a scoped read/download operation in the transport adapter when agents need source bytes; `get` itself returns a manifest. Agent documents are ordinary library items, so other authorized agents can find them. Per-agent/library access remains a host decision. Do not expose all installed plugin methods automatically as MCP tools.

## What the prior art changes

Magpie already separates library items, captures, and R2 artifacts, but the current API requires URLs and its handler result uses `html | pdf`. Refresh deletes the previous capture, and image descriptions are separate from capture full-text search. Preserve the storage separation; replace the input/output assumptions and make retention explicit. The current HTML reader already sanitizes its input, so the new isolation requirement is about safely supporting executable extension UI. See the pinned [handler](https://github.com/jmorrell/stacks/blob/ba2c100d4cca0164cd1752cebaec72b11ba4a016/app/src/server/lib/content-fetch/index.ts), [schema](https://github.com/jmorrell/stacks/blob/ba2c100d4cca0164cd1752cebaec72b11ba4a016/app/src/server/lib/durable-objects/tenant-library/tenant-library.sql), and [persistence implementation](https://github.com/jmorrell/stacks/blob/ba2c100d4cca0164cd1752cebaec72b11ba4a016/app/src/server/lib/durable-objects/tenant-library/tenant-library.ts).

EmDash's reviewed sandboxed UI is validated Block Kit JSON rendered by the host; arbitrary native React/Astro UI has application-level trust. Borrow its declarative UI for summaries, its explicit capability grants, and its host-attested invocation context. The CAD and DuckDB examples need a richer isolated detail surface. [Prior-art notes](docs/prior-art.md) cover its additional hooks, routes, lifecycle, settings, and MCP surfaces, with links to the sources underlying [PR 270](https://github.com/jmorrell/stacks/pull/270).

Cloudflare OS supplies the closer frontend precedent: an opaque-origin iframe, restrictive CSP, a checked MessageChannel handshake, and scoped RPC. Its backend also denies ambient network access. Borrow those boundaries and the idea that agents and UI share application APIs. Its current gadget popup permissions and data-URL media policy need changes for this library; a JavaScript `window.open` patch is not a security boundary. See its [iframe host](https://github.com/cloudflare/cloudflare-os/blob/8060cd9fde6bdec1159df46054f0a559e93822a1/packages/workshop-frontend/src/GadgetUI.tsx) and [backend loader](https://github.com/cloudflare/cloudflare-os/blob/8060cd9fde6bdec1159df46054f0a559e93822a1/packages/workshop-backend/src/overseer.ts#L4494).

This follows the central capability argument in [Extensible Software in the age of LLMs](https://jeremymorrell.dev/blog/extensible-software-in-the-age-of-llms/): give extensions the specific operations they need, with authority supplied by the host.

## What to defer and when to add it

| Candidate seam | Add it when | Starting decision |
| --- | --- | --- |
| Commands | A viewer or agent needs plugin-specific server work after ingestion, such as a remote query or explicit reanalysis | Likely third extension point: `invoke(command, input, scopedHost) -> Promise<Json>`; separately declare UI/MCP exposure |
| Events and schedules | “On star, send to my reader” or recurring imports are in scope | Separate committed notifications from pre-commit validation; include event ID, causation, retries, and loop limits |
| Export | Users need generated conversions beyond downloading original/derived assets and a portable manifest | An explicit format listing plus streamed export, as Cloudflare OS does |
| Migration hook | Reprocessing plus version-aware readers cannot evolve persisted data economically | Start with reprocessing to a new contribution; keep old data and annotations |
| Custom list rendering | Summaries measurably fail a real list/search task | Prefer a bounded declarative extension before executable rows |
| Plugin storage | Long-lived extension state exceeds item data, checkpoints, and view state | Add namespaced state with quotas/lifecycle; keep annotations and library identity in the host |

These are deliberately deferred, not ruled out. The supplied five scenarios work with the two initial extension points and appropriately granted host services. Custom post-ingestion server actions are the clearest reason to add a third.

## Experiments that should decide the API

1. **File and agent document:** save original bytes, show a generic fallback, search sections, and create a note through the same API from UI and MCP. This tests whether submission actually escapes URL identity.
2. **Video:** archive a short fixture, publish before enrichment finishes, resume after failure, navigate a frame search hit, and retain a transcript highlight through reprocessing. This tests the manifest, durable work, and anchor design together.
3. **Parquet and CAD:** read a large file in ranges from an isolated viewer; exercise WASM/workers, an opaque custom selector, and plugin removal. This tests the richest frontend boundary before finalizing the SDK.
4. **Recipe fork:** let two processors claim one URL, choose precedence, decline after inspection, fork metadata schema/renderer, and run with a credentialed capture capability. This tests routing and authoring friction.

Judge these by how little special host code they need, how much authority they require, whether failures preserve the archive and user annotations, and whether an agent can write the extension from its types. Resist adding hooks until an experiment identifies a concrete missing behavior.

## Typechecking

```sh
npm install
npm run typecheck
```

The contracts and examples have no runtime dependencies. TypeScript checks API consistency; runtime validation, isolation, and cross-boundary behavior still require the host implementation and integration experiments above.
