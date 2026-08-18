import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchMediaBytes, MediaBytesError } from "../../src/telegram/fetchMediaBytes";
import { BinaryMediaSourceCaptureAdapter } from "../../src/telegram/capture/BinaryMediaSourceCaptureAdapter";
import { CaptureAdapterError } from "../../src/telegram/capture/SourceCaptureAdapter";
import {
  createSourceChatDescriptor,
  createSourceMessageDescriptor,
} from "../../src/domain/SourceMessageDescriptor";
import { SourceCaptureService } from "../../src/telegram/SourceCaptureService";
import { TelegramDomAdapter } from "../../src/telegram/TelegramDomAdapter";
import { createLogger } from "../helpers";
import type { TelegramMessageSnapshot } from "../../src/telegram/TelegramSourceSnapshot";

const STREAM_URL = "https://web.telegram.org/k/stream/fixture";
const MIME = "video/mp4";

function snapshot(overrides: Partial<TelegramMessageSnapshot> = {}): TelegramMessageSnapshot {
  return {
    identityResolution: "dom-fallback",
    sourcePeerKey: "20",
    mid: 7,
    date: 1_700_000_000,
    group: { kind: "none" },
    text: null,
    imageUrl: null,
    imageCount: 0,
    video: { url: STREAM_URL, width: 1280, height: 720, durationSeconds: 12.5 },
    videoCount: 1,
    hasUnsupportedAttachment: false,
    ...overrides,
  };
}

function context(snap: TelegramMessageSnapshot) {
  return {
    snapshot: snap,
    descriptor: createSourceMessageDescriptor({
      resolution: "dom-fallback",
      sourcePeerKey: snap.sourcePeerKey,
      mid: snap.mid,
      date: snap.date,
      order: 0,
    }),
  };
}

/** Serves `total` bytes the way Telegram's service worker does: always 206, one chunk per call. */
function installStreamServer(total: number, chunk = 4): void {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    const header = (init?.headers as Record<string, string> | undefined)?.Range ?? "";
    const [, rawOffset = "0", rawEnd = ""] = /bytes=(\d*)-(\d*)/.exec(header) ?? [];
    const offset = Number(rawOffset) || 0;
    const requestedEnd = rawEnd ? Number(rawEnd) : offset + chunk - 1;
    const end = Math.min(requestedEnd, total - 1);
    const size = end - offset + 1;
    return {
      ok: true,
      status: 206,
      headers: new Headers({
        "Content-Range": `bytes ${offset}-${end}/${total}`,
        "Content-Type": MIME,
      }),
      arrayBuffer: async () => new ArrayBuffer(size),
    } as unknown as Response;
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("media byte acquisition", () => {
  it("assembles the whole file from the chunks the service worker returns", async () => {
    installStreamServer(10, 4);
    const bytes = await fetchMediaBytes(STREAM_URL, 1024);

    expect(bytes.blob.size).toBe(10);
    expect(bytes.mimeType).toBe(MIME);
    // The first response carries only the worker's own chunk; the rest needs explicit ranges.
    // A single unranged fetch would have produced a 4-byte "video" that still plays.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("refuses a stream that will not state its total size", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 206,
      headers: new Headers({ "Content-Range": "bytes 0-3/*", "Content-Type": MIME }),
      arrayBuffer: async () => new ArrayBuffer(4),
    } as unknown as Response)));

    await expect(fetchMediaBytes(STREAM_URL, 1024)).rejects.toBeInstanceOf(MediaBytesError);
  });

  it("refuses a stream that stops before the declared end", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 206,
      headers: new Headers({ "Content-Range": "bytes 0-3/64", "Content-Type": MIME }),
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response)));

    await expect(fetchMediaBytes(STREAM_URL, 1024)).rejects.toThrow(/stopped returning bytes/);
  });

  it("refuses media larger than the capture limit before downloading it", async () => {
    installStreamServer(4096);
    await expect(fetchMediaBytes(STREAM_URL, 1024)).rejects.toThrow(/capture limit/);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
});

describe("DOM video capture", () => {
  it("captures one ordinary bubble video as a full-byte video unit", async () => {
    installStreamServer(12, 5);
    const unit = await new BinaryMediaSourceCaptureAdapter().capture(context(snapshot()));

    expect(unit.kind).toBe("file");
    if (unit.kind !== "file") return;
    expect(unit.role).toBe("video");
    expect(unit.item.media.blob.size).toBe(12);
    expect(unit.item.media.mimeType).toBe(MIME);
    expect(unit.item.media.fileName).toBe("telegram-video.mp4");
    expect(unit.item.media.metadata).toEqual({
      kind: "video",
      width: 1280,
      height: 720,
      durationSeconds: 12.5,
      supportsStreaming: true,
    });
    // A video goes through "Photo or Video", never the document path.
    expect(unit.delivery.prepareCapability).toBe("media-upload");
    expect(unit.delivery.outgoing.expectedCount).toBe(1);
  });

  it("keeps a caption attached to the captured video", async () => {
    installStreamServer(8, 8);
    const unit = await new BinaryMediaSourceCaptureAdapter().capture(
      context(snapshot({ text: "fixture-caption" })),
    );

    expect(unit.kind).toBe("file");
    if (unit.kind !== "file") return;
    expect(unit.item.caption?.text).toBe("fixture-caption");
  });

  it("rejects anything that is not served as a video", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 206,
      headers: new Headers({ "Content-Range": "bytes 0-3/4", "Content-Type": "text/html" }),
      arrayBuffer: async () => new ArrayBuffer(4),
    } as unknown as Response)));

    await expect(new BinaryMediaSourceCaptureAdapter().capture(context(snapshot())))
      .rejects.toBeInstanceOf(CaptureAdapterError);
  });

  it("rejects a video mixed with a photo or living inside a group", async () => {
    installStreamServer(8, 8);
    const adapter = new BinaryMediaSourceCaptureAdapter();

    await expect(adapter.capture(context(snapshot({ imageCount: 1, imageUrl: "blob:x" }))))
      .rejects.toThrow(/exactly one ordinary ungrouped video/);
    await expect(adapter.capture(context(snapshot({ group: { kind: "ambiguous-dom" } }))))
      .rejects.toThrow(/exactly one ordinary ungrouped video/);
  });
});

describe("video through the whole capture service", () => {
  it("produces one video unit from an ordinary bubble video", async () => {
    installStreamServer(16, 16);
    const service = new SourceCaptureService(
      new TelegramDomAdapter(createLogger()),
      createLogger(),
    );

    const result = await service.captureSnapshots(
      [snapshot({ text: "fixture-caption" })],
      createSourceChatDescriptor("20", "fixture-chat"),
    );

    expect(result.kind).toBe("captured");
    if (result.kind !== "captured") return;
    expect(result.payload.units).toHaveLength(1);
    expect(result.payload.units[0]).toMatchObject({ kind: "file", role: "video" });
  });

  it("refuses a video whose metadata the browser has not reported yet", async () => {
    installStreamServer(16, 16);
    const service = new SourceCaptureService(
      new TelegramDomAdapter(createLogger()),
      createLogger(),
    );

    const result = await service.captureSnapshots(
      [snapshot({ video: null })],
      createSourceChatDescriptor("20", "fixture-chat"),
    );

    expect(result).toMatchObject({
      kind: "unsupported-source",
      reason: { code: "unsupported-type" },
    });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
