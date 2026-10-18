/** Proposed v0 contracts. These describe authority boundaries, not a runtime. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ItemId = string;
export type BlobId = string;
export type RevisionId = string;
export type TaskId = string;

/** Opaque ID, not an object-store key or bearer credential. Host checks each use. */
export interface BlobRef {
  id: BlobId;
  sha256: string;
  size: number;
  mediaType: string;
}

export type Source =
  | { key: string; uri: string }
  | { key: string; blob: BlobRef; name?: string; role?: string };

/** URL, URL + snapshot, uploaded file, or generated document use one envelope. */
export interface Submission {
  sources: [Source, ...Source[]];
  title?: string;
  idempotencyKey: string;
  processor?: string;
  /** An edit preserves item identity and creates a new immutable input revision. */
  replace?: { itemId: ItemId; expectedInputRevision: RevisionId };
}

export interface SavedInput {
  itemId: ItemId;
  revisionId: RevisionId;
  sources: [Source, ...Source[]];
  title?: string;
  savedAt: string;
  /** Set by authentication, never accepted from the submitted JSON. */
  createdBy: { kind: "user" | "agent"; id: string };
}

export interface Schema {
  /** Namespaced identifier, independent of the producing extension's ID. */
  id: string;
  version: number;
}

export type Selector =
  /** start/end are half-open UTF-16 offsets in the specified text asset. */
  | { type: "text"; exact: string; prefix?: string; suffix?: string; start?: number; end?: number }
  | { type: "time"; startSeconds: number; endSeconds?: number }
  /** Normalized coordinates in [0, 1], with positive dimensions inside the image. */
  | { type: "region"; x: number; y: number; width: number; height: number }
  | { type: "custom"; schema: Schema; value: Json };

/** Pins immutable bytes; processor reruns cannot silently move an annotation. */
export interface Anchor {
  blob: BlobId;
  selector: Selector;
}

export interface Asset {
  /** Stable within a contribution: e.g. original, playable, transcript, frame/120. */
  key: string;
  blob: BlobRef;
  role: string;
  /** Optional provenance, e.g. frame -> time in the archived video. */
  derivedFrom?: Anchor;
}

/** Host-rendered plain data for lists, search, export, and unavailable plugins. */
export interface Summary {
  title: string;
  description?: string;
  thumbnail?: BlobId;
  facts?: { label: string; value: string }[];
}

export interface SearchPart {
  /** Stable key within this producer's contribution. */
  key: string;
  text: string;
  at?: Anchor;
}

/** Empty parts means intentionally index no extracted content. */
export type SearchProjection =
  | { parts: SearchPart[] }
  | { ndjson: BlobRef }; // UTF-8 lines conforming to SearchPart, streamed by host.

/** A bounded manifest referencing any number of immutable stored byte streams. */
export interface ContentDraft {
  schema: Schema;
  data: Json;
  assets: Asset[];
  summary: Summary;
  search: SearchProjection;
  preferredView?: string;
}

export interface Contribution extends ContentDraft {
  revisionId: RevisionId;
  inputRevision: RevisionId;
  producer: { extensionId: string; processorId: string; bundleDigest: string };
  createdAt: string;
}

export interface ItemSnapshot {
  input: SavedInput;
  /** Each producer owns its contribution; it cannot replace another's output. */
  contributions: Contribution[];
  primaryContribution?: RevisionId;
}

export interface ProbeHost {
  /** Item-scoped, bounded sniffing. No arbitrary fetch or costly jobs in probe. */
  readPrefix(blob: BlobId, maxBytes: number): Promise<Uint8Array>;
}

export interface Match {
  specificity: "specific" | "fallback";
  reason: string;
}

export interface ProcessRequest {
  item: ItemSnapshot;
  runId: string;
  /** Stable on retries; increments only after accepting a process result. */
  step: number;
  checkpoint?: Json;
  /** Host delivers the terminal result for the previously awaited task. */
  completedTask?: TaskResult;
}

export type TaskResult =
  | { id: TaskId; status: "succeeded"; value: Json; assets: BlobRef[] }
  | { id: TaskId; status: "failed"; code: string; message: string };

/** Services are explicitly granted per installation and invocation. */
export interface ProcessingHost {
  blobs: {
    read(id: BlobId, range?: { offset: number; length: number }): Promise<ReadableStream<Uint8Array>>;
    /** Streaming storage; host calculates digest/size, enforces quota, stages output. */
    write(body: ReadableStream<Uint8Array>, options: {
      mediaType: string;
      operationKey: string;
    }): Promise<BlobRef>;
  };
  tasks: {
    /** service is a granted provider operation, not a URL or arbitrary command. */
    start(service: string, input: Json, operationKey: string): Promise<TaskId>;
  };
  /** Opaque account handles/settings only. Credentials stay in host connectors. */
  settings: { get(key: string): Promise<Json> };
  progress(update: { message: string; fraction?: number }): Promise<void>;
}

export type ProcessResult =
  | { status: "complete"; publish: ContentDraft }
  /** Inspection found no applicable format. Interpreter routing tries next offer. */
  | { status: "declined"; reason: string }
  | { status: "continue"; checkpoint: Json; publish?: ContentDraft }
  | { status: "waiting"; task: TaskId; checkpoint: Json; publish?: ContentDraft }
  | { status: "failed"; code: string; message: string; retryable: boolean };

/** Extension point 1. Bounded invocations; the host owns scheduling and commits. */
export interface Processor {
  probe(item: ItemSnapshot, host: ProbeHost): Promise<Match | null>;
  process(request: ProcessRequest, host: ProcessingHost): Promise<ProcessResult>;
}

export interface AnnotationDraft {
  /** Omit for a note on the item as a whole. */
  at?: Anchor;
  quote?: string;
  body?: string;
}

export interface Annotation extends AnnotationDraft {
  id: string;
  itemId: ItemId;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: { kind: "user" | "agent"; id: string };
}

/** Bound to one authorized item. The host indexes annotation quote/body. */
export interface AnnotationHost {
  list(): Promise<Annotation[]>;
  create(draft: AnnotationDraft, idempotencyKey: string): Promise<Annotation>;
  update(id: string, draft: AnnotationDraft, expectedVersion: number): Promise<Annotation>;
  remove(id: string, expectedVersion: number): Promise<void>;
}

export interface ViewContext {
  item: ItemSnapshot;
  contribution: Contribution;
  annotations: Annotation[];
  target?: Anchor;
  theme: "light" | "dark";
}

export interface ViewHost {
  assets: {
    /** Bounded range reads for WASM/CAD/Parquet, checked against this view's grant. */
    read(blob: BlobId, range: { offset: number; length: number }): Promise<Uint8Array>;
    /** Short-lived, read-only lease for this blob; endpoint supports HTTP Range. */
    url(blob: BlobId): Promise<{ url: string; expiresAt: string }>;
  };
  annotations: AnnotationHost;
  /** Store only this extension's view state; never credentials. */
  state: {
    get(): Promise<Json>;
    set(value: Json): Promise<void>;
  };
}

export interface ViewSession {
  /** Host pushes annotation/theme changes; incompatible revisions cause remount. */
  update(context: ViewContext): Promise<void>;
  /** Used by search hits and the host annotation sidebar; false -> host fallback. */
  navigate(target: Anchor): Promise<boolean>;
  dispose(): Promise<void>;
}

/** Extension point 2. This module runs INSIDE an isolated frontend, not the app. */
export interface View {
  mount(root: HTMLElement, context: ViewContext, host: ViewHost): Promise<ViewSession>;
}

export interface ExtensionManifest {
  apiVersion: 1;
  id: string;
  version: string;
  /** Integrity-pinned entry modules are in the installed package. */
  processors: { id: string; entry: string; mode: "interpret" | "enrich" }[];
  views: {
    id: string;
    entry: string;
    accepts: { schema: string; versions: number[] }[];
  }[];
  /** Requests are not grants. Installation policy and invocation narrow them. */
  requests: { capability: string; reason: string }[];
}

export interface SearchHit {
  itemId: ItemId;
  contributionRevision?: RevisionId;
  annotationId?: string;
  title: string;
  snippet: string;
  at?: Anchor;
}

/** Shared host API for the web UI, browser capture, upload, and MCP adapters. */
export interface LibraryAPI {
  upload(body: ReadableStream<Uint8Array>, mediaType: string): Promise<BlobRef>;
  submit(input: Submission): Promise<{ itemId: ItemId; inputRevision: RevisionId; jobId: string }>;
  get(itemId: ItemId): Promise<ItemSnapshot>;
  search(query: { text: string; cursor?: string }): Promise<{ hits: SearchHit[]; cursor?: string }>;
  annotations(itemId: ItemId): Promise<AnnotationHost>;
}
