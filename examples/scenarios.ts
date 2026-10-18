/** Proposed contract usage. Provider names are illustrative, not deployed services. */
import type {
  AnnotationDraft, BlobRef, ContentDraft, Json, LibraryAPI, Processor,
  SearchPart, Submission, TaskResult,
} from "../src/contracts.js";

export const VIDEO_SCHEMA = { id: "example.video", version: 1 };

export interface VideoFrame {
  blob: BlobRef;
  seconds: number;
  description: string;
}

export interface ArchivedVideo {
  title: string;
  video: BlobRef;
  /** UTF-8 JSON array of {startSeconds, endSeconds, text, speaker?}. */
  transcript: BlobRef;
  /** SearchPart NDJSON: transcript and frame descriptions, anchored to video time. */
  searchIndex: BlobRef;
  frames: VideoFrame[];
}

export function videoDraft(input: ArchivedVideo): ContentDraft {
  return {
    schema: VIDEO_SCHEMA,
    data: {
      video: input.video.id,
      transcript: input.transcript.id,
      frames: input.frames.map((frame) => ({
        blob: frame.blob.id, seconds: frame.seconds, description: frame.description,
      })),
    },
    assets: [
      { key: "playable", role: "video", blob: input.video },
      { key: "transcript", role: "transcript", blob: input.transcript },
      { key: "search", role: "search-index", blob: input.searchIndex },
      ...input.frames.map((frame, index) => ({
        key: `frame/${index}`, role: "frame", blob: frame.blob,
        derivedFrom: {
          blob: input.video.id,
          selector: { type: "time" as const, startSeconds: frame.seconds },
        },
      })),
    ],
    summary: {
      title: input.title,
      ...(input.frames[0] ? { thumbnail: input.frames[0].blob.id } : {}),
    },
    search: { ndjson: input.searchIndex },
    preferredView: "example.video",
  };
}

export function cadDraft(file: BlobRef, title: string, metadata: Json): ContentDraft {
  return {
    schema: { id: "example.cad", version: 1 },
    data: { model: file.id, metadata },
    assets: [{ key: "original", role: "model", blob: file }],
    summary: { title },
    search: { parts: [{ key: "metadata", text: `${title}\n${JSON.stringify(metadata)}` }] },
    preferredView: "example.cad",
  };
}

export function cadAnnotation(file: BlobRef, objectId: string, position: [number, number, number]): AnnotationDraft {
  return {
    at: {
      blob: file.id,
      selector: {
        type: "custom", schema: { id: "example.cad-location", version: 1 },
        value: { objectId, position },
      },
    },
    quote: `Model object ${objectId}`,
    body: "Check this clearance before manufacturing.",
  };
}

export function parquetDraft(file: BlobRef, title: string, columns: string[], rowCount: number): ContentDraft {
  return {
    schema: { id: "example.parquet", version: 1 },
    data: { file: file.id, columns, rowCount },
    assets: [{ key: "original", role: "dataset", blob: file }],
    summary: { title, facts: [{ label: "Rows", value: String(rowCount) }] },
    // The viewer can query file ranges with DuckDB/WASM; rows are not indexed.
    search: { parts: [{ key: "schema", text: `${title}\nColumns: ${columns.join(", ")}` }] },
    preferredView: "example.parquet",
  };
}

export function recipeDraft(input: {
  title: string; snapshot: BlobRef; readable: BlobRef; ingredients: string[]; steps: string[];
}): ContentDraft {
  return {
    schema: { id: "example.recipe", version: 1 },
    data: { ingredients: input.ingredients, steps: input.steps, readable: input.readable.id },
    assets: [
      { key: "original", role: "source", blob: input.snapshot },
      { key: "readable", role: "article", blob: input.readable },
    ],
    summary: { title: input.title },
    search: { parts: [{ key: "recipe", text: [...input.ingredients, ...input.steps].join("\n") }] },
    preferredView: "example.recipe",
  };
}

export function documentDraft(file: BlobRef, title: string, searchIndex: BlobRef): ContentDraft {
  return {
    schema: { id: "example.document", version: 1 },
    data: { document: file.id },
    assets: [
      { key: "document", role: "document", blob: file },
      { key: "search", role: "search-index", blob: searchIndex },
    ],
    summary: { title },
    search: { ndjson: searchIndex },
    preferredView: "example.document",
  };
}

/** All bytes have already crossed the upload boundary and are durable references. */
export function submissions(blobs: { snapshot: BlobRef; cad: BlobRef; parquet: BlobRef; document: BlobRef }): Record<string, Submission> {
  return {
    video: { sources: [{ key: "source", uri: "https://www.youtube.com/watch?v=example" }], idempotencyKey: "video-1" },
    cad: { sources: [{ key: "source", blob: blobs.cad, name: "bracket.step" }], idempotencyKey: "cad-1" },
    parquet: { sources: [{ key: "source", blob: blobs.parquet, name: "observations.parquet" }], idempotencyKey: "parquet-1" },
    recipe: {
      sources: [
        { key: "origin", uri: "https://recipes.example/soup" },
        { key: "snapshot", blob: blobs.snapshot, role: "browser-snapshot" },
      ],
      idempotencyKey: "recipe-1",
    },
    document: {
      sources: [{ key: "source", blob: blobs.document, name: "research.md" }],
      title: "Plugin research", idempotencyKey: "research-1", processor: "example.document",
    },
  };
}

/** MCP is an adapter over the same host API; authentication records agent identity. */
export async function saveAgentDocument(api: LibraryAPI, text: string, idempotencyKey: string) {
  let blob = await api.upload(new Blob([text]).stream(), "text/markdown");
  return api.submit({
    sources: [{ key: "source", blob, name: "research.md" }],
    title: "Plugin research", processor: "example.document", idempotencyKey,
  });
}

/** A complete processor using only stream storage, with bounded indexing memory. */
export const documentProcessor: Processor = {
  async probe(item) {
    return item.input.sources.some((source) => "blob" in source && isDocument(source.blob))
      ? { specificity: "fallback", reason: "Plain text or Markdown document" } : null;
  },
  async process(request, host) {
    let source = request.item.input.sources.find((entry) => "blob" in entry && isDocument(entry.blob));
    if (!source || !("blob" in source)) {
      return { status: "failed", code: "unsupported-source", message: "Choose a text or Markdown file.", retryable: false };
    }
    let document = await host.blobs.write(await host.blobs.read(source.blob.id), {
      mediaType: source.blob.mediaType, operationKey: `${request.runId}:document`,
    });
    let index = await host.blobs.write(indexDocument(await host.blobs.read(document.id), document.id), {
      mediaType: "application/x-ndjson", operationKey: `${request.runId}:search`,
    });
    return { status: "complete", publish: documentDraft(document, request.item.input.title ?? source.name ?? "Document", index) };
  },
};

function isDocument(blob: BlobRef): boolean {
  return ["text/plain", "text/markdown"].includes(blob.mediaType.split(";")[0]?.trim() ?? "");
}

/** Offsets address UTF-16 characters of the immutable UTF-8 document, including whitespace. */
function indexDocument(body: ReadableStream<Uint8Array>, blob: string): ReadableStream<Uint8Array> {
  let pending = "";
  let offset = 0;
  let encoder = new TextEncoder();
  let decoder = new TextDecoder("utf-8", { fatal: true });
  function emit(text: string, controller: TransformStreamDefaultController<Uint8Array>) {
    let start = offset;
    offset += text.length;
    if (!text.trim()) return;
    let part: SearchPart = {
      key: `text/${start}`, text,
      at: { blob, selector: { type: "text", exact: text, start, end: offset } },
    };
    controller.enqueue(encoder.encode(`${JSON.stringify(part)}\n`));
  }
  let decoded = body.pipeThrough(new TransformStream<Uint8Array, string>({
    transform(chunk, controller) { controller.enqueue(decoder.decode(chunk, { stream: true })); },
    flush(controller) { controller.enqueue(decoder.decode()); },
  }));
  return decoded.pipeThrough(new TransformStream<string, Uint8Array>({
    transform(chunk, controller) {
      pending += chunk;
      while (pending.length >= 4096 || pending.includes("\n")) {
        let newline = pending.indexOf("\n");
        let end = newline >= 0 && newline < 4096 ? newline + 1 : 4096;
        // Keep a Unicode character intact across the indexing chunk boundary.
        if (end < pending.length && /[\uD800-\uDBFF]/.test(pending[end - 1] ?? "") &&
          /[\uDC00-\uDFFF]/.test(pending[end] ?? "")) end--;
        emit(pending.slice(0, end), controller);
        pending = pending.slice(end);
      }
    },
    flush(controller) { if (pending) emit(pending, controller); },
  }));
}

/** Archive/transcribe/frame-caption work runs in a granted external provider task. */
export const videoProcessor: Processor = {
  async probe(item) {
    let matches = item.input.sources.some((source) => {
      if (!("uri" in source)) return false;
      try { return ["youtube.com", "www.youtube.com", "youtu.be"].includes(new URL(source.uri).hostname); }
      catch { return false; }
    });
    return matches ? { specificity: "specific", reason: "YouTube archive" } : null;
  },
  async process(request, host) {
    if (request.checkpoint === undefined) {
      let source = request.item.input.sources.find((entry) => "uri" in entry);
      if (!source || !("uri" in source)) {
        return { status: "failed", code: "missing-url", message: "Provide the video URL.", retryable: false };
      }
      let task = await host.tasks.start("example.media.archive-transcribe-caption", { url: source.uri }, `${request.runId}:video`);
      return { status: "waiting", task, checkpoint: { task } };
    }
    let checkpoint = object(request.checkpoint);
    let task = string(checkpoint.task);
    let result = request.completedTask;
    if (!result) return { status: "waiting", task, checkpoint: { task } };
    if (result.id !== task) throw new Error("Unexpected media task result");
    if (result.status === "failed") {
      return { status: "failed", code: result.code, message: result.message, retryable: false };
    }
    return { status: "complete", publish: videoDraft(decodeVideoTask(result)) };
  },
};

/** Decoder rejects IDs not returned as task assets; the host separately checks ownership and bytes. */
function decodeVideoTask(result: Extract<TaskResult, { status: "succeeded" }>): ArchivedVideo {
  let value = object(result.value);
  function asset(id: Json | undefined, mediaPrefix: string): BlobRef {
    let found = result.assets.find((candidate) => candidate.id === string(id));
    if (!found || !found.mediaType.startsWith(mediaPrefix)) throw new Error("Invalid media task asset");
    return found;
  }
  if (!Array.isArray(value.frames)) throw new Error("Missing video frames");
  return {
    title: string(value.title), video: asset(value.video, "video/"),
    transcript: asset(value.transcript, "application/json"),
    searchIndex: asset(value.searchIndex, "application/x-ndjson"),
    frames: value.frames.map((entry) => {
      let frame = object(entry);
      if (typeof frame.seconds !== "number" || !Number.isFinite(frame.seconds) || frame.seconds < 0) throw new Error("Invalid frame time");
      return { blob: asset(frame.blob, "image/"), seconds: frame.seconds, description: string(frame.description) };
    }),
  };
}

function object(value: Json | undefined): { [key: string]: Json } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value;
}

function string(value: Json | undefined): string {
  if (typeof value !== "string" || !value) throw new Error("Expected a nonempty string");
  return value;
}
