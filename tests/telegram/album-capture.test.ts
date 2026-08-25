import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SourceCaptureService } from "../../src/telegram/SourceCaptureService";
import { TelegramDomAdapter } from "../../src/telegram/TelegramDomAdapter";
import type { TelegramMessageSnapshot } from "../../src/telegram/TelegramSourceSnapshot";
import { createLogger } from "../helpers";

const PEER = "20";
const GROUPED_ID = "9001";

/**
 * One album as Web K paints it: a grouped container plus one `.grouped-item` per photo, each
 * carrying its own identity and its own image.
 */
function installAlbum(mids: readonly number[], options: { video?: number } = {}): HTMLElement[] {
  const bubble = document.createElement("div");
  bubble.className = "bubble is-grouped";
  bubble.dataset.mid = String(mids[0]);
  bubble.dataset.peerId = PEER;
  const items = mids.map((mid) => {
    const item = document.createElement("div");
    item.className = "grouped-item";
    item.dataset.mid = String(mid);
    item.dataset.peerId = PEER;
    const attachment = document.createElement("div");
    attachment.className = "attachment";
    if (options.video === mid) {
      const video = document.createElement("video");
      video.className = "media-video";
      Object.defineProperties(video, {
        videoWidth: { value: 640, configurable: true },
        videoHeight: { value: 480, configurable: true },
        duration: { value: 5, configurable: true },
        currentSrc: { value: "blob:video", configurable: true },
      });
      attachment.append(video);
    } else {
      const image = document.createElement("img");
      image.className = "media-photo";
      Object.defineProperty(image, "currentSrc", { value: `blob:photo-${mid}`, configurable: true });
      attachment.append(image);
    }
    item.append(attachment);
    bubble.append(item);
    return item;
  });
  document.body.append(bubble);
  return items;
}

/** Proves the album through the model, the way the live bridge does. */
function installBridge(mids: readonly number[], groupedId = GROUPED_ID): void {
  vi.stubGlobal("apiManagerProxy", {
    getMessageByPeer: (_peerId: number, mid: number) =>
      mids.includes(mid) ? { mid, peerId: Number(PEER), grouped_id: groupedId } : undefined,
    getMessagesByGroupedId: () =>
      mids.map((mid) => ({ mid, peerId: Number(PEER), grouped_id: groupedId })),
  });
}

describe("album capture through the model bridge", () => {
  const logger = createLogger();
  const dom = new TelegramDomAdapter(logger);
  const capture = new SourceCaptureService(dom, logger);

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Blob(["photo"], { type: "image/jpeg" }), { status: 200 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  function snapshots(items: readonly HTMLElement[]): TelegramMessageSnapshot[] {
    return items.map((item) => {
      const snapshot = dom.readMessageSnapshot(item, PEER);
      if (!snapshot) throw new Error("Fixture produced no snapshot.");
      return snapshot;
    });
  }

  it("marks a grouped message complete once the bridge proves its album", () => {
    const items = installAlbum([70, 71, 72]);
    installBridge([70, 71, 72]);

    expect(snapshots(items)[0]?.group).toEqual({
      kind: "complete-model",
      groupedId: GROUPED_ID,
      expectedItemCount: 3,
    });
  });

  it("still reports an unprovable group exactly as it did before the bridge existed", () => {
    const items = installAlbum([70, 71, 72]);
    // No proxy on the page at all: the regression this whole feature must degrade into.
    expect(snapshots(items)[0]?.group).toEqual({ kind: "ambiguous-dom" });
  });

  it("captures a proven photo album as one atomic media-group", async () => {
    const items = installAlbum([70, 71, 72]);
    installBridge([70, 71, 72]);

    const result = await capture.captureSnapshots(snapshots(items));

    expect(result.kind).toBe("captured");
    if (result.kind !== "captured") return;
    expect(result.payload.units).toHaveLength(1);
    const unit = result.payload.units[0]!;
    expect(unit.kind).toBe("media-group");
    if (unit.kind !== "media-group") return;
    expect(unit.groupedId).toBe(GROUPED_ID);
    expect(unit.items.map(({ order }) => order)).toEqual([0, 1, 2]);
    // One album is one native Send, and its receipt is the whole group.
    expect(unit.delivery.sendClickCount).toBe(1);
    expect(unit.delivery.outgoing.expectedCount).toBe(3);
  });

  it("refuses an album whose members the bridge cannot all prove", async () => {
    const items = installAlbum([70, 71, 72]);
    installBridge([70, 71]);

    const result = await capture.captureSnapshots(snapshots(items));

    expect(result).toMatchObject({ kind: "unsupported-source" });
  });

  it("refuses part of an album instead of quietly sending the whole thing", async () => {
    const items = installAlbum([70, 71, 72]);
    installBridge([70, 71, 72]);

    // What a context menu on one photo, and a partial selection, both produce.
    const result = await capture.captureSnapshots([snapshots(items)[0]!]);

    expect(result).toMatchObject({
      kind: "unsupported-source",
      reason: { code: "incomplete-selection" },
    });
    if (result.kind !== "unsupported-source") return;
    expect(result.reason.message).toContain("3 parts");
    expect(result.reason.message).toContain("selection mode");
  });

  it("names video as the reason an album is refused, not the album machinery", async () => {
    const items = installAlbum([70, 71, 72], { video: 71 });
    installBridge([70, 71, 72]);

    const result = await capture.captureSnapshots(snapshots(items));

    expect(result).toMatchObject({
      kind: "unsupported-source",
      reason: { code: "unsupported-type" },
    });
    if (result.kind !== "unsupported-source") return;
    expect(result.reason.message).toContain("video");
  });

  it("leaves a standalone photo on exactly the path it already had", async () => {
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.dataset.mid = "90";
    bubble.dataset.peerId = PEER;
    const attachment = document.createElement("div");
    attachment.className = "attachment";
    const image = document.createElement("img");
    image.className = "media-photo";
    Object.defineProperty(image, "currentSrc", { value: "blob:single", configurable: true });
    attachment.append(image);
    bubble.append(attachment);
    document.body.append(bubble);
    installBridge([70, 71, 72]);

    const snapshot = dom.readMessageSnapshot(bubble, PEER)!;
    expect(snapshot.group).toEqual({ kind: "none" });

    const result = await capture.captureSnapshots([snapshot]);
    expect(result.kind).toBe("captured");
    if (result.kind !== "captured") return;
    expect(result.payload.units[0]).toMatchObject({ kind: "file", role: "photo" });
  });
});
