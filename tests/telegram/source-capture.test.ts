import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSourceChatDescriptor } from "../../src/domain/SourceMessageDescriptor";
import { SourceCaptureService } from "../../src/telegram/SourceCaptureService";
import { TelegramDomAdapter } from "../../src/telegram/TelegramDomAdapter";
import type {
  TelegramMessageSnapshot,
  TelegramModelMessageSnapshot,
} from "../../src/telegram/TelegramSourceSnapshot";
import { createLogger } from "../helpers";

function snapshot(
  mid: number,
  overrides: Partial<TelegramMessageSnapshot> = {},
): TelegramMessageSnapshot {
  return {
    identityResolution: "dom-fallback",
    sourcePeerKey: "20",
    mid,
    date: 1_700_000_000 + mid,
    group: { kind: "none" },
    text: `text-${mid}`,
    imageUrl: null,
    imageCount: 0,
    hasUnsupportedAttachment: false,
    ...overrides,
  };
}

function modelPhoto(
  mid: number,
  groupedId: string,
  expectedItemCount: number,
  caption: string | null = null,
): TelegramModelMessageSnapshot {
  const blob = new Blob([`photo-${mid}`], { type: "image/jpeg" });
  return {
    identityResolution: "telegram-model",
    sourcePeerKey: "20",
    mid,
    date: 1_700_000_000 + mid,
    group: { kind: "complete-model", groupedId, expectedItemCount },
    restrictions: {
      noForwards: false,
      ephemeral: false,
      paid: false,
      mediaAvailable: true,
    },
    provenance: { forwarded: false, reply: false },
    content: {
      kind: "binary",
      role: "photo",
      binary: {
        blob,
        fileName: `photo-${mid}.jpg`,
        mimeType: "image/jpeg",
        declaredSize: blob.size,
        metadata: { kind: "photo", width: 100, height: 100 },
      },
      caption: caption ? { text: caption, entities: [] } : null,
      spoiler: false,
      invertMedia: false,
    },
  };
}

describe("SourceCaptureService", () => {
  const logger = createLogger();
  const dom = new TelegramDomAdapter(logger);
  const capture = new SourceCaptureService(dom, logger);

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Blob(["photo"], { type: "image/jpeg" }), { status: 200 })),
    );
  });

  it("creates one immutable text bundle from one selected message", async () => {
    const result = await capture.captureSnapshots([snapshot(10)]);
    expect(result.kind).toBe("captured");
    if (result.kind !== "captured") return;
    expect(result.payload.messages.map(({ mid }) => mid)).toEqual([10]);
    expect(result.payload.units[0]).toMatchObject({
      kind: "text",
      content: { text: "text-10" },
    });
    expect(Object.isFrozen(result.payload)).toBe(true);
  });

  it("keeps the synchronously captured source title and exact search locator", async () => {
    const target = createSourceChatDescriptor("20", "Original source", "@original_source");
    const result = await capture.captureSnapshots([snapshot(10)], target);
    expect(result.kind).toBe("captured");
    if (result.kind !== "captured") return;
    expect(result.payload.source).toEqual({
      peerKey: "20",
      title: "Original source",
      searchQuery: "@original_source",
    });
    expect(result.payload.source).not.toBe(target);
    expect(Object.isFrozen(result.payload.source)).toBe(true);
  });

  it("rejects a source target that does not own the selected messages", async () => {
    const result = await capture.captureSnapshots(
      [snapshot(10)],
      createSourceChatDescriptor("99", "Wrong source", "Wrong source"),
    );
    expect(result).toMatchObject({
      kind: "capture-failed",
      reason: { code: "mixed-peer" },
    });
  });

  it("normalizes several selected messages by mid rather than click order", async () => {
    const result = await capture.captureSnapshots([snapshot(30), snapshot(10), snapshot(20)]);
    expect(result.kind).toBe("captured");
    if (result.kind !== "captured") return;
    expect(result.payload.messages.map(({ mid }) => mid)).toEqual([10, 20, 30]);
    expect(result.payload.units.map((unit) => unit.source[0]?.mid)).toEqual([10, 20, 30]);
  });

  it("captures a mixed supported text and photo sequence atomically", async () => {
    const result = await capture.captureSnapshots([
      snapshot(10),
      snapshot(11, {
        text: "caption",
        imageUrl: "blob:mixed-photo",
        imageCount: 1,
      }),
    ]);
    expect(result.kind).toBe("captured");
    if (result.kind !== "captured") return;
    expect(result.payload.units.map(({ kind }) => kind)).toEqual(["text", "file"]);
    expect(result.payload.units[1]).toMatchObject({
      kind: "file",
      role: "photo",
      item: { caption: { text: "caption" } },
    });
  });

  it("preserves a verified complete album as one ordered atomic group", async () => {
    const result = await capture.captureSnapshots([
      modelPhoto(42, "group-77", 2),
      modelPhoto(41, "group-77", 2, "album caption"),
    ]);
    expect(result.kind).toBe("captured");
    if (result.kind !== "captured") return;
    expect(result.payload.messages.map(({ mid }) => mid)).toEqual([41, 42]);
    expect(result.payload.units).toHaveLength(1);
    expect(result.payload.units[0]).toMatchObject({
      kind: "media-group",
      groupedId: "group-77",
      items: [
        { order: 0, caption: { text: "album caption" } },
        { order: 1 },
      ],
      delivery: { atomicity: "album" },
    });
  });

  it("rejects an incomplete verified album before loading bytes", async () => {
    const result = await capture.captureSnapshots([
      modelPhoto(50, "group-incomplete", 2),
    ]);
    expect(result).toMatchObject({
      kind: "unsupported-source",
      reason: { code: "incomplete-selection" },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects the whole mixed selection when one member is unsupported", async () => {
    const result = await capture.captureSnapshots([
      snapshot(60, { text: null, imageUrl: "blob:supported-photo", imageCount: 1 }),
      snapshot(61, { hasUnsupportedAttachment: true }),
    ]);
    expect(result).toMatchObject({
      kind: "unsupported-source",
      reason: { code: "unsupported-type" },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not depend on source DOM remaining mounted after its snapshot", async () => {
    document.body.innerHTML = '<div class="bubble" data-mid="70" data-peer-id="20"><div class="message">detached</div></div>';
    const bubble = document.querySelector<HTMLElement>(".bubble")!;
    const detachedSnapshot = dom.readMessageSnapshot(bubble);
    bubble.remove();
    expect(detachedSnapshot).not.toBeNull();
    const result = await capture.captureSnapshots([detachedSnapshot!]);
    expect(result.kind).toBe("captured");
    if (result.kind !== "captured") return;
    expect(result.payload.units[0]).toMatchObject({
      kind: "text",
      content: { text: "detached" },
    });
  });

  it("aborts media capture without producing a partial bundle", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        );
      }),
    ));
    const controller = new AbortController();
    const capturing = capture.captureSnapshots([
      snapshot(80, { text: null, imageUrl: "blob:cancel", imageCount: 1 }),
    ], controller.signal);
    controller.abort();
    await expect(capturing).rejects.toMatchObject({ name: "AbortError" });
  });
});
