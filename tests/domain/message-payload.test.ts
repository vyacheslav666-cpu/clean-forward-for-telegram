import { describe, expect, it } from "vitest";
import {
  createMessagePayload,
  createUnsupportedSource,
  describePayload,
  migrateTelegramDeliveryPayload,
  toTelegramDeliveryPayload,
} from "../../src/domain/MessagePayload";
import {
  createSourceChatDescriptor,
  createSourceMessageDescriptor,
  type SourceMessageDescriptor,
} from "../../src/domain/SourceMessageDescriptor";
import {
  createBinaryMediaContent,
  createMediaCaption,
  createPlainTextContent,
  createTransferMediaItem,
} from "../../src/domain/TransferableContent";
import {
  createMediaGroupTransferUnit,
  createTextTransferUnit,
} from "../../src/domain/TransferUnit";

const source = createSourceChatDescriptor("42", "Source chat");

function message(
  mid: number,
  order: number,
  groupedId?: string,
): SourceMessageDescriptor {
  return createSourceMessageDescriptor({
    resolution: "telegram-model",
    sourcePeerKey: source.peerKey,
    mid,
    date: 1_700_000_000 + order,
    order,
    ...(groupedId ? { groupedId } : {}),
  });
}

function binary(label: string): ReturnType<typeof createBinaryMediaContent> {
  return createBinaryMediaContent({
    blob: new Blob([label], { type: "image/jpeg" }),
    fileName: `${label}.jpg`,
    contentFingerprint: `fixture:${label}`,
    metadata: { kind: "photo", width: null, height: null },
  });
}

describe("generalized MessagePayload", () => {
  it("represents one text source and migrates it to the existing composer DTO", () => {
    const descriptor = message(10, 0);
    const payload = migrateTelegramDeliveryPayload({
      operationId: "operation-text",
      source,
      message: descriptor,
      payload: { kind: "text", text: "fixture-text" },
    });

    expect(payload.messages).toEqual([descriptor]);
    expect(payload.units[0]).toMatchObject({
      kind: "text",
      content: { kind: "plain-text", text: "fixture-text", linkPreview: "regenerate" },
      delivery: {
        prepareCapability: "text-composer",
        sendClickCount: 1,
        outgoing: { kind: "single-message", expectedCount: 1 },
      },
    });
    expect(toTelegramDeliveryPayload(payload)).toEqual({ kind: "text", text: "fixture-text" });
    expect(describePayload(payload)).toBe("Текст готов к вставке");
  });

  it("represents one image with caption and immutable binary media", () => {
    const image = new Blob(["photo"], { type: "image/jpeg" });
    const payload = migrateTelegramDeliveryPayload({
      operationId: "operation-photo",
      source,
      message: message(11, 0),
      payload: { kind: "image", image, fileName: "photo.jpg", caption: "caption" },
      binaryFingerprint: "fixture:photo",
    });

    expect(payload.units[0]).toMatchObject({
      kind: "file",
      role: "photo",
      item: {
        media: { kind: "binary-media", blob: image, mimeType: "image/jpeg" },
        caption: { kind: "caption", text: "caption" },
      },
      delivery: { prepareCapability: "media-upload", atomicity: "single" },
    });
    expect(toTelegramDeliveryPayload(payload)).toEqual({
      kind: "image",
      image,
      fileName: "photo.jpg",
      caption: "caption",
    });
    expect(describePayload(payload)).toBe("Картинка с подписью готова");
  });

  it("normalizes source order while preserving explicit unit sequence", () => {
    const first = message(20, 0);
    const second = message(21, 1);
    const secondUnit = createTextTransferUnit([second], createPlainTextContent("second"));
    const firstUnit = createTextTransferUnit([first], createPlainTextContent("first"));
    const payload = createMessagePayload({
      operationId: "operation-sequence",
      source,
      messages: [second, first],
      units: [firstUnit, secondUnit],
    });

    expect(payload.messages.map(({ mid }) => mid)).toEqual([20, 21]);
    expect(payload.units.map((unit) => unit.source[0]?.mid)).toEqual([20, 21]);
    expect(payload.atomicity).toBe("sequence");
    expect(toTelegramDeliveryPayload(payload)).toBeNull();
  });

  it("represents an album as one atomic media-group with caption ownership", () => {
    const groupId = "group-900";
    const first = message(30, 0, groupId);
    const second = message(31, 1, groupId);
    const firstItem = createTransferMediaItem({
      media: binary("first"),
      order: 0,
      caption: createMediaCaption("album caption"),
    });
    const secondItem = createTransferMediaItem({ media: binary("second"), order: 1 });
    const album = createMediaGroupTransferUnit({
      source: [first, second],
      groupedId: groupId,
      items: [secondItem, firstItem],
      expectedGroups: [{ groupIndex: 0, itemOrders: [0, 1] }],
    });
    const payload = createMessagePayload({
      operationId: "operation-album",
      source,
      messages: [first, second],
      units: [album],
    });

    expect(album.items.map(({ order }) => order)).toEqual([0, 1]);
    expect(album.items[0]?.caption?.text).toBe("album caption");
    expect(album.delivery).toMatchObject({
      prepareCapability: "album-upload",
      atomicity: "album",
      sendClickCount: 1,
      outgoing: { kind: "media-groups", expectedCount: 2 },
    });
    expect(payload.units[0]?.kind).toBe("media-group");
    expect(toTelegramDeliveryPayload(payload)).toBeNull();
  });

  it("freezes the snapshot deeply enough that caller mutation cannot change delivery", () => {
    const descriptor = message(40, 0);
    const payload = migrateTelegramDeliveryPayload({
      operationId: "operation-immutable",
      source,
      message: descriptor,
      payload: { kind: "text", text: "immutable" },
    });

    expect(Object.isFrozen(payload)).toBe(true);
    expect(Object.isFrozen(payload.source)).toBe(true);
    expect(Object.isFrozen(payload.messages)).toBe(true);
    expect(Object.isFrozen(payload.messages[0])).toBe(true);
    expect(Object.isFrozen(payload.units)).toBe(true);
    const unit = payload.units[0];
    if (!unit || unit.kind !== "text") {
      throw new Error("Expected the immutable text fixture unit.");
    }
    expect(Object.isFrozen(unit)).toBe(true);
    expect(Object.isFrozen(unit.content)).toBe(true);
    expect(Object.isFrozen(unit.delivery)).toBe(true);
    expect(() => (payload.messages as SourceMessageDescriptor[]).push(message(41, 1))).toThrow();
  });

  it("keeps unsupported source as a structured non-transferable classification", () => {
    const unsupported = createUnsupportedSource({
      source,
      messages: [message(50, 0)],
      reason: {
        code: "unsupported-type",
        message: "Voice messages are not reproducible by the current capability set.",
      },
    });

    expect(unsupported).toMatchObject({
      kind: "unsupported-source",
      reason: { code: "unsupported-type" },
    });
    expect(unsupported).not.toHaveProperty("units");
    expect(Object.isFrozen(unsupported.reason)).toBe(true);
  });

  it("rejects duplicate identities, mixed peers, and duplicate album units", () => {
    const first = message(60, 0);
    const duplicate = createSourceMessageDescriptor({ ...first, order: 1 });
    const unit = createTextTransferUnit([first], createPlainTextContent("fixture"));
    expect(() => createMessagePayload({
      operationId: "operation-duplicate",
      source,
      messages: [first, duplicate],
      units: [unit],
    })).toThrow(/unique identities/);

    const otherPeer = createSourceMessageDescriptor({
      resolution: "telegram-model",
      sourcePeerKey: "99",
      mid: 61,
      date: 1_700_000_061,
      order: 0,
    });
    expect(() => createMessagePayload({
      operationId: "operation-mixed-peer",
      source,
      messages: [otherPeer],
      units: [createTextTransferUnit([otherPeer], createPlainTextContent("fixture"))],
    })).toThrow(/source chat/);

    const groupId = "group-duplicate";
    const grouped = message(62, 0, groupId);
    const item = createTransferMediaItem({ media: binary("duplicate"), order: 0 });
    const album = createMediaGroupTransferUnit({
      source: [grouped],
      groupedId: groupId,
      items: [item],
      expectedGroups: [{ groupIndex: 0, itemOrders: [0] }],
    });
    expect(() => createMessagePayload({
      operationId: "operation-duplicate-album",
      source,
      messages: [grouped],
      units: [album, album],
    })).toThrow(/only once/);
  });

  it("rejects a payload whose units omit a canonical source message", () => {
    const first = message(70, 0);
    const second = message(71, 1);

    expect(() => createMessagePayload({
      operationId: "operation-omitted-source",
      source,
      messages: [first, second],
      units: [createTextTransferUnit([first], createPlainTextContent("first"))],
    })).toThrow(/messages are omitted/);
  });

  it("rejects duplicate source references across transfer units", () => {
    const descriptor = message(72, 0);

    expect(() => createMessagePayload({
      operationId: "operation-duplicate-reference",
      source,
      messages: [descriptor],
      units: [
        createTextTransferUnit([descriptor], createPlainTextContent("first copy")),
        createTextTransferUnit([descriptor], createPlainTextContent("second copy")),
      ],
    })).toThrow(/only once/);
  });

  it("rejects unit descriptors whose metadata differs from the canonical snapshot", () => {
    const canonical = message(73, 0);
    const mismatched = createSourceMessageDescriptor({
      ...canonical,
      date: canonical.date === null ? 1 : canonical.date + 1,
    });

    expect(() => createMessagePayload({
      operationId: "operation-metadata-mismatch",
      source,
      messages: [canonical],
      units: [createTextTransferUnit([mismatched], createPlainTextContent("fixture"))],
    })).toThrow(/exactly match the canonical source descriptor/);
  });

  it("rejects transfer units and unit sources that do not follow canonical order", () => {
    const first = message(74, 0);
    const second = message(75, 1);

    expect(() => createMessagePayload({
      operationId: "operation-unit-order",
      source,
      messages: [first, second],
      units: [
        createTextTransferUnit([second], createPlainTextContent("second")),
        createTextTransferUnit([first], createPlainTextContent("first")),
      ],
    })).toThrow(/canonical source order/);

    expect(() => createMessagePayload({
      operationId: "operation-intra-unit-order",
      source,
      messages: [first, second],
      units: [createTextTransferUnit(
        [second, first],
        createPlainTextContent("combined"),
      )],
    })).toThrow(/canonical source order/);
  });
});
