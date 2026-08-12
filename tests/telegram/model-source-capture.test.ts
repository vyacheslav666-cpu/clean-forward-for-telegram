import { describe, expect, it } from "vitest";
import type { BinaryMediaMetadata } from "../../src/domain/TransferableContent";
import type { FileTransferUnit } from "../../src/domain/TransferUnit";
import { SourceCaptureService } from "../../src/telegram/SourceCaptureService";
import { toTelegramDeliveryPayload } from "../../src/domain/MessagePayload";
import { TelegramDomAdapter } from "../../src/telegram/TelegramDomAdapter";
import type {
  TelegramModelContentSnapshot,
  TelegramModelMessageSnapshot,
} from "../../src/telegram/TelegramSourceSnapshot";
import { createLogger } from "../helpers";

const SOURCE_PEER = "model-peer";

function modelSnapshot(
  mid: number,
  content: TelegramModelContentSnapshot,
  overrides: Partial<TelegramModelMessageSnapshot> = {},
): TelegramModelMessageSnapshot {
  return {
    identityResolution: "telegram-model",
    sourcePeerKey: SOURCE_PEER,
    mid,
    date: 1_700_000_000 + mid,
    group: { kind: "none" },
    restrictions: {
      noForwards: false,
      ephemeral: false,
      paid: false,
      mediaAvailable: true,
    },
    provenance: { forwarded: false, reply: false },
    content,
    ...overrides,
  };
}

function binaryContent(
  role: FileTransferUnit["role"],
  metadata: BinaryMediaMetadata,
  overrides: Partial<Extract<TelegramModelContentSnapshot, { kind: "binary" }>> = {},
): Extract<TelegramModelContentSnapshot, { kind: "binary" }> {
  const mimeType = role === "photo"
    ? "image/jpeg"
    : role === "audio"
      ? "audio/mpeg"
      : role === "document"
        ? "application/pdf"
        : "video/mp4";
  const blob = new Blob([`full-${role}-bytes`], { type: mimeType });
  return {
    kind: "binary",
    role,
    binary: {
      blob,
      fileName: `source-${role}.bin`,
      mimeType,
      declaredSize: blob.size,
      metadata,
    },
    caption: { text: `caption-${role}`, entities: [] },
    spoiler: false,
    invertMedia: false,
    ...overrides,
  };
}

const binaryFamilies: readonly [FileTransferUnit["role"], BinaryMediaMetadata][] = [
  ["photo", { kind: "photo", width: 1280, height: 720 }],
  ["video", {
    kind: "video",
    width: 1280,
    height: 720,
    durationSeconds: 12,
    supportsStreaming: true,
  }],
  ["animation", { kind: "animation", width: 640, height: 360, durationSeconds: 4 }],
  ["document", { kind: "document" }],
  ["audio", { kind: "audio", durationSeconds: 180, title: "Title", performer: "Artist" }],
];

describe("model-backed source capture strategies", () => {
  const logger = createLogger();
  const capture = new SourceCaptureService(new TelegramDomAdapter(logger), logger);

  it("captures formatted text entities without flattening them to DOM text", async () => {
    const result = await capture.captureSnapshots([modelSnapshot(1, {
      kind: "text",
      text: "hello link",
      entities: [{ kind: "bold", offset: 0, length: 5 }, {
        kind: "text-url",
        offset: 6,
        length: 4,
        url: "https://example.com",
      }],
      linkPreview: "regenerate",
    })]);

    expect(result).toMatchObject({
      kind: "captured",
      payload: {
        units: [{
          kind: "text",
          content: {
            kind: "formatted-text",
            linkPreview: "regenerate",
            entities: [{ kind: "bold" }, { kind: "text-url" }],
          },
        }],
      },
    });
  });

  it("rejects malformed formatted text before a bundle is exposed", async () => {
    const result = await capture.captureSnapshots([modelSnapshot(2, {
      kind: "text",
      text: "short",
      entities: [{ kind: "bold", offset: 3, length: 10 }],
      linkPreview: "disable",
    })]);
    expect(result).toMatchObject({ kind: "unsupported-source", reason: { code: "invalid-model" } });
  });

  it("preserves formatted photo captions but keeps them out of the plain-caption delivery adapter", async () => {
    const content = binaryContent("photo", binaryFamilies[0]![1], {
      caption: {
        text: "bold caption",
        entities: [{ kind: "bold", offset: 0, length: 4 }],
      },
    });
    const result = await capture.captureSnapshots([modelSnapshot(3, content)]);
    expect(result.kind).toBe("captured");
    if (result.kind !== "captured") return;
    expect(result.payload.units[0]).toMatchObject({
      kind: "file",
      item: { caption: { entities: [{ kind: "bold" }] } },
    });
    expect(toTelegramDeliveryPayload(result.payload)).toBeNull();
  });

  it.each(binaryFamilies)("captures detached full-byte %s snapshots", async (role, metadata) => {
    const sourceNode = document.createElement("div");
    document.body.append(sourceNode);
    const content = binaryContent(role, metadata);
    sourceNode.remove();

    const result = await capture.captureSnapshots([modelSnapshot(10, content)]);
    expect(result.kind).toBe("captured");
    if (result.kind !== "captured") return;
    expect(result.payload.units[0]).toMatchObject({
      kind: "file",
      role,
      item: {
        caption: { text: `caption-${role}` },
        media: {
          metadata,
          mimeType: content.binary.mimeType,
          sizeBytes: content.binary.blob.size,
        },
      },
    });
    expect(result.payload.units[0]?.kind === "file" && result.payload.units[0].item.media.blob)
      .toBe(content.binary.blob);
  });

  it.each(binaryFamilies)("rejects malformed %s model bytes", async (role, metadata) => {
    const content = binaryContent(role, metadata);
    const result = await capture.captureSnapshots([modelSnapshot(20, {
      ...content,
      binary: { ...content.binary, declaredSize: content.binary.declaredSize + 1 },
    })]);
    expect(result).toMatchObject({
      kind: "unsupported-source",
      reason: { code: "unavailable-media" },
    });
  });

  it.each(binaryFamilies)("rejects unsupported advanced flags for %s", async (role, metadata) => {
    const result = await capture.captureSnapshots([modelSnapshot(
      30,
      binaryContent(role, metadata, { spoiler: true }),
    )]);
    expect(result).toMatchObject({
      kind: "unsupported-source",
      reason: { code: "unsupported-type" },
    });
  });

  it("captures result-free poll and complete quiz templates", async () => {
    const result = await capture.captureSnapshots([
      modelSnapshot(40, {
        kind: "poll-template",
        poll: {
          question: "Pick one",
          options: ["A", "B"],
          anonymous: true,
          multipleChoice: false,
          mode: "poll",
        },
      }),
      modelSnapshot(41, {
        kind: "poll-template",
        poll: {
          question: "Correct?",
          options: ["No", "Yes"],
          anonymous: true,
          multipleChoice: false,
          mode: "quiz",
          correctOptionIndex: 1,
          explanation: "Because.",
        },
      }),
    ]);
    expect(result).toMatchObject({
      kind: "captured",
      payload: {
        units: [
          { kind: "poll-template", content: { mode: "poll" } },
          { kind: "poll-template", content: { mode: "quiz", correctOptionIndex: 1 } },
        ],
      },
    });
  });

  it("rejects a quiz without a verified correct answer", async () => {
    const result = await capture.captureSnapshots([modelSnapshot(42, {
      kind: "poll-template",
      poll: {
        question: "Correct?",
        options: ["No", "Yes"],
        anonymous: true,
        multipleChoice: false,
        mode: "quiz",
      },
    })]);
    expect(result).toMatchObject({ kind: "unsupported-source", reason: { code: "invalid-model" } });
  });

  it("captures a mixed ordered bundle and drops forward/reply provenance", async () => {
    const result = await capture.captureSnapshots([
      modelSnapshot(53, {
        kind: "poll-template",
        poll: {
          question: "Continue?",
          options: ["Yes", "No"],
          anonymous: false,
          multipleChoice: false,
          mode: "poll",
        },
      }),
      modelSnapshot(51, {
        kind: "text",
        text: "first",
        entities: [],
        linkPreview: "disable",
      }, { provenance: { forwarded: true, reply: true } }),
      modelSnapshot(52, binaryContent("document", { kind: "document" })),
    ]);
    expect(result.kind).toBe("captured");
    if (result.kind !== "captured") return;
    expect(result.payload.messages.map(({ mid }) => mid)).toEqual([51, 52, 53]);
    expect(result.payload.units.map(({ kind }) => kind)).toEqual(["text", "file", "poll-template"]);
    expect(JSON.stringify(result.payload)).not.toContain("forwarded");
    expect(JSON.stringify(result.payload)).not.toContain("reply");
  });

  it.each([
    "reply-semantics",
    "voice",
    "video-note",
    "sticker",
    "animated-sticker",
    "contact",
    "location",
    "venue",
    "service",
    "game",
    "invoice",
    "story",
    "giveaway",
    "dice",
    "unknown",
  ] as const)("keeps RED type %s explicitly unsupported", async (type) => {
    const result = await capture.captureSnapshots([modelSnapshot(60, { kind: "unsupported", type })]);
    expect(result).toMatchObject({
      kind: "unsupported-source",
      reason: { code: "unsupported-type" },
    });
  });

  it.each([
    ["noForwards", "protected-content"],
    ["ephemeral", "ttl-media"],
    ["paid", "paid-media"],
    ["mediaAvailable", "unavailable-media"],
  ] as const)("fails closed for restriction %s", async (restriction, code) => {
    const restrictions = {
      noForwards: false,
      ephemeral: false,
      paid: false,
      mediaAvailable: true,
      [restriction]: restriction === "mediaAvailable" ? false : true,
    };
    const result = await capture.captureSnapshots([modelSnapshot(
      70,
      binaryContent("video", binaryFamilies[1]![1]),
      { restrictions },
    )]);
    expect(result).toMatchObject({ kind: "unsupported-source", reason: { code } });
  });
});

describe("model-backed album boundaries", () => {
  const logger = createLogger();
  const capture = new SourceCaptureService(new TelegramDomAdapter(logger), logger);

  function albumItem(
    mid: number,
    groupedId: string,
    expectedItemCount: number,
    role: "photo" | "video" = "photo",
  ): TelegramModelMessageSnapshot {
    const metadata = role === "photo"
      ? { kind: "photo", width: 800, height: 600 } as const
      : {
          kind: "video",
          width: 800,
          height: 600,
          durationSeconds: 3,
          supportsStreaming: true,
        } as const;
    return modelSnapshot(mid, binaryContent(role, metadata), {
      group: { kind: "complete-model", groupedId, expectedItemCount },
    });
  }

  it("preserves separate adjacent album boundaries and order", async () => {
    const result = await capture.captureSnapshots([
      albumItem(83, "g2", 2),
      albumItem(80, "g1", 2),
      albumItem(82, "g2", 2, "video"),
      albumItem(81, "g1", 2, "video"),
    ]);
    expect(result.kind).toBe("captured");
    if (result.kind !== "captured") return;
    expect(result.payload.units.map((unit) =>
      unit.kind === "media-group" ? [unit.groupedId, unit.items.map(({ order }) => order)] : null,
    )).toEqual([["g1", [0, 1]], ["g2", [2, 3]]]);
  });

  it.each([
    [1, 1],
    [2, 3],
    [11, 11],
  ])("rejects album boundary with %i captured of %i expected", async (capturedCount, expectedCount) => {
    const snapshots = Array.from({ length: capturedCount }, (_, index) =>
      albumItem(100 + index, "invalid-group", expectedCount),
    );
    const result = await capture.captureSnapshots(snapshots);
    expect(result).toMatchObject({
      kind: "unsupported-source",
      reason: { code: "incomplete-selection" },
    });
  });

  it("rejects an animation inside a Telegram media group", async () => {
    const animation = modelSnapshot(
      121,
      binaryContent("animation", binaryFamilies[2]![1]),
      { group: { kind: "complete-model", groupedId: "mixed-group", expectedItemCount: 2 } },
    );
    const result = await capture.captureSnapshots([
      albumItem(120, "mixed-group", 2),
      animation,
    ]);
    expect(result).toMatchObject({
      kind: "unsupported-source",
      reason: { code: "unsupported-type" },
    });
  });

  it("rejects a group whose members do not form one contiguous source sequence", async () => {
    const result = await capture.captureSnapshots([
      albumItem(130, "split-group", 2),
      modelSnapshot(131, {
        kind: "text",
        text: "unexpected middle message",
        entities: [],
        linkPreview: "disable",
      }),
      albumItem(132, "split-group", 2),
    ]);
    expect(result).toMatchObject({
      kind: "unsupported-source",
      reason: { code: "incomplete-selection" },
    });
  });
});
