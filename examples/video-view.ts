/** Illustrative browser module, loaded only inside the host's isolated viewer. */
import type { Anchor, View, ViewContext, ViewSession } from "../src/contracts.js";
import { VIDEO_SCHEMA } from "./scenarios.js";

interface Line {
  startSeconds: number;
  endSeconds: number;
  text: string;
  speaker?: string;
}

export const videoView: View = {
  async mount(root, context, host): Promise<ViewSession> {
    if (context.contribution.schema.id !== VIDEO_SCHEMA.id || context.contribution.schema.version !== 1) {
      throw new Error("Unsupported video schema");
    }
    let data = record(context.contribution.data);
    let videoId = text(data.video);
    let transcriptId = text(data.transcript);
    function asset(id: string) {
      let found = context.contribution.assets.find((entry) => entry.blob.id === id);
      if (!found) throw new Error("Asset is not part of this contribution");
      return found.blob;
    }
    asset(videoId);
    let transcriptAsset = asset(transcriptId);
    // Keep this example bounded. A large-transcript viewer would load paged segments.
    if (transcriptAsset.size > 2 * 1024 * 1024) throw new Error("Example viewer supports transcripts up to 2 MiB");
    let bytes = await host.assets.read(transcriptId, { offset: 0, length: transcriptAsset.size });
    let lines = decodeTranscript(JSON.parse(new TextDecoder().decode(bytes)));
    if (!Array.isArray(data.frames)) throw new Error("Invalid video frames");
    let frames = data.frames.map((value) => {
      let frame = record(value);
      let blob = text(frame.blob);
      asset(blob);
      return { blob, seconds: seconds(frame.seconds), description: text(frame.description) };
    });
    let controller = new AbortController();
    let signal = controller.signal;
    let disposed = false;
    let timers = new Set<ReturnType<typeof setTimeout>>();
    let stopAt: number | undefined;
    let pendingSeek: number | undefined;
    let current = context;

    let style = document.createElement("style");
    style.textContent = `
      .video-example{font:16px/1.5 system-ui;color:#202322;background:#fafaf7;padding:12px}
      .video-example[data-theme=dark]{color:#eee;background:#181c1b}
      .video-example .player{position:sticky;top:0;z-index:1;background:inherit;padding-bottom:12px}
      .video-example video{display:block;width:100%;max-height:45vh;background:#000}
      .video-example .content{display:grid;grid-template-columns:minmax(100px,22%) 1fr;gap:20px}
      .video-example .filmstrip button{display:block;width:100%;margin:0 0 12px}
      .video-example img{display:block;width:100%;height:auto}
      .video-example button{font:inherit;cursor:pointer}
      .video-example .line{padding:8px;border-radius:6px;margin:0 0 8px}
      .video-example .line[aria-current=true]{background:#dbecc0;color:#172510}
      .video-example .line[data-annotated=true]{border-left:3px solid #b89422}
      .video-example .timestamp{margin-right:8px;font-size:13px}
      .video-example textarea{display:block;width:100%;box-sizing:border-box;min-height:70px}
      .video-example output{display:block;min-height:1.5em}
      @media(max-width:480px){.video-example .content{gap:8px;grid-template-columns:80px 1fr}}
    `;
    let shell = document.createElement("section");
    shell.className = "video-example";
    let player = document.createElement("div");
    player.className = "player";
    let video = document.createElement("video");
    video.controls = true;
    video.playsInline = true;
    video.preload = "metadata";
    let saveSelection = button("Save selected transcript");
    let status = document.createElement("output");
    status.setAttribute("role", "status");
    player.append(video, saveSelection, status);
    let content = document.createElement("div");
    content.className = "content";
    let filmstrip = document.createElement("aside");
    filmstrip.className = "filmstrip";
    filmstrip.setAttribute("aria-label", "Video frames");
    let transcript = document.createElement("div");
    transcript.setAttribute("aria-label", "Transcript");
    content.append(filmstrip, transcript);
    let note = document.createElement("textarea");
    note.setAttribute("aria-label", "Note on this video");
    let saveNote = button("Save note");
    shell.append(player, content, note, saveNote);
    root.replaceChildren(style, shell);

    let rows = lines.map((line) => {
      let row = document.createElement("p");
      row.className = "line";
      let jump = button(formatTime(line.startSeconds));
      jump.className = "timestamp";
      jump.setAttribute("aria-label", `Jump to ${formatTime(line.startSeconds)}`);
      jump.addEventListener("click", () => seek(line.startSeconds), { signal });
      let words = document.createElement("span");
      words.textContent = `${line.speaker ? `${line.speaker}: ` : ""}${line.text}`;
      row.append(jump, words);
      transcript.append(row);
      return { row, words, line };
    });

    function sync() {
      for (let { row, line } of rows) {
        row.setAttribute("aria-current", String(video.currentTime >= line.startSeconds && video.currentTime < line.endSeconds));
      }
      if (stopAt !== undefined && video.currentTime >= stopAt) {
        video.pause();
        stopAt = undefined;
      }
    }
    function seek(start: number, end?: number) {
      stopAt = end;
      if (video.readyState >= 1) video.currentTime = start;
      else pendingSeek = start;
      sync();
    }
    video.addEventListener("timeupdate", sync, { signal });
    video.addEventListener("loadedmetadata", () => {
      if (pendingSeek !== undefined) { video.currentTime = pendingSeek; pendingSeek = undefined; }
      sync();
    }, { signal });

    function refreshAnnotations(next: ViewContext) {
      shell.dataset.theme = next.theme;
      for (let { row, line } of rows) {
        row.dataset.annotated = String(next.annotations.some(({ at }) =>
          at?.blob === videoId && at.selector.type === "time" &&
          at.selector.startSeconds < line.endSeconds &&
          (at.selector.endSeconds ?? at.selector.startSeconds) >= line.startSeconds,
        ));
      }
    }
    refreshAnnotations(context);

    // Preserves the text selection while activating the toolbar with a pointer.
    saveSelection.addEventListener("pointerdown", (event) => event.preventDefault(), { signal });
    saveSelection.addEventListener("click", async () => {
      let selection = root.ownerDocument.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) {
        status.textContent = "Select transcript text first.";
        return;
      }
      let range = selection.getRangeAt(0);
      let selected = rows.filter(({ words }) => range.intersectsNode(words));
      let first = selected[0];
      if (!transcript.contains(range.commonAncestorContainer) || !first) {
        status.textContent = "Select text within the transcript.";
        return;
      }
      let quote = selection.toString();
      saveSelection.disabled = true;
      try {
        let annotation = await host.annotations.create({
          at: {
            blob: videoId,
            selector: {
              type: "time", startSeconds: first.line.startSeconds,
              endSeconds: Math.max(...selected.map(({ line }) => line.endSeconds)),
            },
          },
          quote,
        }, crypto.randomUUID());
        if (disposed) return;
        current = { ...current, annotations: [...current.annotations, annotation] };
        refreshAnnotations(current);
        status.textContent = "Transcript selection saved.";
      } catch { if (!disposed) status.textContent = "Could not save the selection. Try again."; }
      finally { saveSelection.disabled = false; }
    }, { signal });
    saveNote.addEventListener("click", async () => {
      if (!note.value.trim()) return;
      saveNote.disabled = true;
      let body = note.value;
      try {
        await host.annotations.create({ body }, crypto.randomUUID());
        if (!disposed) { note.value = ""; status.textContent = "Note saved."; }
      } catch { if (!disposed) status.textContent = "Could not save the note. Your text is still here."; }
      finally { saveNote.disabled = false; }
    }, { signal });

    /** Renew leases without persisting them in plugin data or granting storage paths. */
    async function attachAsset(element: HTMLVideoElement | HTMLImageElement, blob: string) {
      let lease = await host.assets.url(blob);
      if (disposed) return;
      let resume = element === video && Boolean(video.getAttribute("src"));
      let wasPlaying = resume && !video.paused;
      if (resume) pendingSeek = video.currentTime;
      element.src = lease.url;
      if (wasPlaying) video.addEventListener("loadedmetadata", () => { void video.play().catch(() => {}); }, { once: true, signal });
      let expiry = Date.parse(lease.expiresAt);
      if (!Number.isFinite(expiry)) throw new Error("Invalid asset lease expiration");
      let timer = setTimeout(() => {
        timers.delete(timer);
        void attachAsset(element, blob).catch(() => {
          if (!disposed) status.textContent = "Asset access expired. Reopen the item to reconnect.";
        });
      }, Math.min(2_147_000_000, Math.max(1000, expiry - Date.now() - 30_000)));
      timers.add(timer);
    }

    let session: ViewSession = {
      async update(next) {
        if (disposed) return;
        if (next.contribution.revisionId !== context.contribution.revisionId) throw new Error("Remount required for a new revision");
        current = next;
        refreshAnnotations(next);
      },
      async navigate(target: Anchor) {
        if (disposed || target.blob !== videoId || target.selector.type !== "time") return false;
        let { startSeconds, endSeconds } = target.selector;
        if (!Number.isFinite(startSeconds) || startSeconds < 0 ||
          (endSeconds !== undefined && (!Number.isFinite(endSeconds) || endSeconds <= startSeconds))) return false;
        seek(startSeconds, endSeconds);
        rows.find(({ line }) => startSeconds >= line.startSeconds && startSeconds < line.endSeconds)
          ?.row.scrollIntoView({ block: "nearest" });
        return true;
      },
      async dispose() {
        disposed = true;
        controller.abort();
        for (let timer of timers) clearTimeout(timer);
        timers.clear();
        video.pause();
        video.removeAttribute("src");
        video.load();
        root.replaceChildren();
      },
    };
    try {
      await attachAsset(video, videoId);
      await Promise.all(frames.map(async (frame) => {
        let jump = button(formatTime(frame.seconds));
        let image = document.createElement("img");
        image.alt = frame.description;
        image.loading = "lazy";
        jump.prepend(image);
        jump.addEventListener("click", () => seek(frame.seconds), { signal });
        filmstrip.append(jump);
        await attachAsset(image, frame.blob);
      }));
      if (context.target) await session.navigate(context.target);
      return session;
    } catch (error) { await session.dispose(); throw error; }
  },
};

function button(label: string): HTMLButtonElement {
  let element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  return element;
}

function formatTime(value: number): string {
  return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected text");
  return value;
}

function seconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Invalid timestamp");
  return value;
}

function decodeTranscript(value: unknown): Line[] {
  if (!Array.isArray(value)) throw new Error("Expected transcript lines");
  let lines = value.map((entry): Line => {
    let row = record(entry);
    let startSeconds = seconds(row.startSeconds);
    let endSeconds = seconds(row.endSeconds);
    if (endSeconds <= startSeconds) throw new Error("Invalid transcript interval");
    return { startSeconds, endSeconds, text: text(row.text), ...(row.speaker === undefined ? {} : { speaker: text(row.speaker) }) };
  });
  return lines.sort((a, b) => a.startSeconds - b.startSeconds);
}
