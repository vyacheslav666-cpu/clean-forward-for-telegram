/** Owns an immutable ordered source snapshot independently from current Telegram UI support. */
import {
  createSourceChatDescriptor,
  createSourceMessageDescriptor,
  sourceMessageIdentity,
  type SourceChatDescriptor,
  type SourceMessageDescriptor,
} from "./SourceMessageDescriptor";
import type { TelegramDeliveryPayload } from "./TelegramDeliveryPayload";
import {
  createBinaryMediaContent,
  createMediaCaption,
  createFormattedTextContent,
  createPlainTextContent,
  createTransferMediaItem,
  type TransferMediaItem,
} from "./TransferableContent";
import {
  createFileTransferUnit,
  createMediaGroupTransferUnit,
  createPollTemplateTransferUnit,
  createTextTransferUnit,
  type TransferUnit,
} from "./TransferUnit";

const LEGACY_PHOTO_MIME_TYPE = "image/jpeg";

/** Immutable ordered bundle captured before recipient selection begins. */
export interface MessagePayload {
  readonly kind: "transfer-bundle";
  readonly operationId: string;
  readonly source: SourceChatDescriptor;
  readonly messages: readonly SourceMessageDescriptor[];
  readonly units: readonly TransferUnit[];
  readonly atomicity: "sequence";
}

/** Structured reason why an entire source selection cannot be reproduced safely. */
export interface UnsupportedSource {
  readonly kind: "unsupported-source";
  readonly source: SourceChatDescriptor;
  readonly messages: readonly SourceMessageDescriptor[];
  readonly reason: {
    readonly code:
      | "protected-content"
      | "ttl-media"
      | "paid-media"
      | "unsupported-type"
      | "unavailable-media"
      | "incomplete-selection"
      | "model-unavailable"
      | "invalid-model";
    readonly message: string;
  };
}

/** Technical capture failure that cannot be attached to one valid source descriptor set. */
export interface SourceCaptureFailure {
  readonly kind: "capture-failed";
  readonly reason: {
    readonly code: "empty-selection" | "duplicate-identity" | "mixed-peer" | "invalid-model";
    readonly message: string;
  };
}

/** Capture classification never disguises an unsupported source as a transferable unit. */
export type SourceCaptureResult =
  | { readonly kind: "captured"; readonly payload: MessagePayload }
  | UnsupportedSource
  | SourceCaptureFailure;

/** Creates and validates one immutable ordered transfer bundle. */
export function createMessagePayload(input: {
  readonly operationId: string;
  readonly source: SourceChatDescriptor;
  readonly messages: readonly SourceMessageDescriptor[];
  readonly units: readonly TransferUnit[];
}): MessagePayload {
  if (!input.operationId.trim() || input.messages.length === 0 || input.units.length === 0) {
    throw new Error("Transfer bundle requires an operation id, messages, and units.");
  }

  const source = createSourceChatDescriptor(input.source.peerKey, input.source.title);
  const messages = Object.freeze(
    input.messages
      .map(createSourceMessageDescriptor)
      .sort((left, right) => left.order - right.order),
  );
  const units = Object.freeze(input.units.map(normalizeTransferUnit));
  validateSourceMessages(source, messages);
  validateUnitMembership(messages, units);
  validateUniqueMediaGroups(units);

  return Object.freeze({
    kind: "transfer-bundle",
    operationId: input.operationId,
    source,
    messages,
    units,
    atomicity: "sequence",
  });
}

/** Creates a frozen unsupported classification before the recipient picker is opened. */
export function createUnsupportedSource(input: {
  readonly source: SourceChatDescriptor;
  readonly messages: readonly SourceMessageDescriptor[];
  readonly reason: UnsupportedSource["reason"];
}): UnsupportedSource {
  const source = createSourceChatDescriptor(input.source.peerKey, input.source.title);
  const messages = Object.freeze(
    input.messages
      .map(createSourceMessageDescriptor)
      .sort((left, right) => left.order - right.order),
  );
  validateSourceMessages(source, messages);
  return Object.freeze({
    kind: "unsupported-source",
    source,
    messages,
    reason: Object.freeze({ ...input.reason }),
  });
}

/** Creates an immutable technical failure without inventing a source identity. */
export function createSourceCaptureFailure(
  reason: SourceCaptureFailure["reason"],
): SourceCaptureFailure {
  return Object.freeze({
    kind: "capture-failed",
    reason: Object.freeze({ ...reason }),
  });
}

/**
 * Migrates one old MVP payload into the generalized snapshot without widening Telegram delivery.
 * Callers must supply real source identity and a fingerprint captured before the picker opens.
 */
export function migrateTelegramDeliveryPayload(input: {
  readonly operationId: string;
  readonly source: SourceChatDescriptor;
  readonly message: SourceMessageDescriptor;
  readonly payload: TelegramDeliveryPayload;
  readonly binaryFingerprint?: string;
}): MessagePayload {
  const message = createSourceMessageDescriptor(input.message);
  const unit = input.payload.kind === "text"
    ? createTextTransferUnit([message], createPlainTextContent(input.payload.text))
    : createFileTransferUnit({
        source: [message],
        role: "photo",
        item: createTransferMediaItem({
          media: createBinaryMediaContent({
            blob: input.payload.image,
            fileName: input.payload.fileName,
            contentFingerprint:
              input.binaryFingerprint ?? metadataFingerprint(input.payload),
            metadata: { kind: "photo", width: null, height: null },
            mimeType: input.payload.image.type || LEGACY_PHOTO_MIME_TYPE,
          }),
          order: 0,
          ...(input.payload.caption
            ? { caption: createMediaCaption(input.payload.caption) }
            : {}),
        }),
      });

  return createMessagePayload({
    operationId: input.operationId,
    source: input.source,
    messages: [message],
    units: [unit],
  });
}

/** Adapts only one supported text/photo unit to the existing Telegram UI pipeline. */
export function toTelegramDeliveryPayload(
  payload: MessagePayload,
): TelegramDeliveryPayload | null {
  if (payload.units.length !== 1) {
    return null;
  }
  const unit = payload.units[0];
  if (!unit) {
    return null;
  }
  return toTelegramDeliveryPayloadUnit(unit);
}

/** Adapts one unit only when the existing native text/photo pipeline preserves its semantics. */
export function toTelegramDeliveryPayloadUnit(
  unit: TransferUnit,
): TelegramDeliveryPayload | null {
  if (unit.kind === "text") {
    return unit.content.kind === "plain-text" && unit.content.linkPreview === "regenerate"
      ? Object.freeze({ kind: "text", text: unit.content.text })
      : null;
  }
  if (unit.kind !== "file" || unit.role !== "photo") {
    return null;
  }
  if (unit.item.caption && unit.item.caption.entities.length > 0) {
    return null;
  }

  return Object.freeze({
    kind: "image",
    image: unit.item.media.blob,
    fileName: unit.item.media.fileName,
    ...(unit.item.caption ? { caption: unit.item.caption.text } : {}),
  });
}

/** Returns a short UI-safe summary without exposing captured message content. */
export function describePayload(payload: MessagePayload): string {
  if (payload.units.length !== 1) {
    return `${payload.messages.length} сообщений готовы к переносу`;
  }
  const unit = payload.units[0];
  if (unit?.kind === "text") {
    return "Текст готов к вставке";
  }
  if (unit?.kind === "file" && unit.role === "photo") {
    return unit.item.caption ? "Картинка с подписью готова" : "Картинка готова";
  }
  return "Содержимое готово к переносу";
}

function validateSourceMessages(
  source: SourceChatDescriptor,
  messages: readonly SourceMessageDescriptor[],
): void {
  const identities = new Set<string>();
  const orders = new Set<number>();
  for (const message of messages) {
    if (message.sourcePeerKey !== source.peerKey) {
      throw new Error("Every source message must belong to the captured source chat.");
    }
    const identity = sourceMessageIdentity(message);
    if (identities.has(identity) || orders.has(message.order)) {
      throw new Error("Source messages require unique identities and sequence order values.");
    }
    identities.add(identity);
    orders.add(message.order);
  }
}

function validateUnitMembership(
  messages: readonly SourceMessageDescriptor[],
  units: readonly TransferUnit[],
): void {
  const canonicalByIdentity = new Map(
    messages.map((message) => [sourceMessageIdentity(message), message] as const),
  );
  const referencedIdentities = new Set<string>();
  let expectedMessageIndex = 0;

  for (const unit of units) {
    for (const message of unit.source) {
      const identity = sourceMessageIdentity(message);
      const canonical = canonicalByIdentity.get(identity);
      if (!canonical) {
        throw new Error("Transfer unit references a message outside its source bundle.");
      }
      if (!hasExactSourceMetadata(message, canonical)) {
        throw new Error(
          "Transfer unit source metadata must exactly match the canonical source descriptor.",
        );
      }
      if (referencedIdentities.has(identity)) {
        throw new Error(
          "Every canonical source message must be referenced exactly once; a unit source may reference each message only once.",
        );
      }

      const expected = messages[expectedMessageIndex];
      if (!expected || sourceMessageIdentity(expected) !== identity) {
        throw new Error(
          "Transfer units must follow canonical source order without gaps, reordering, or interleaving.",
        );
      }

      referencedIdentities.add(identity);
      expectedMessageIndex += 1;
    }
  }

  if (expectedMessageIndex !== messages.length) {
    throw new Error(
      "Every canonical source message must be referenced exactly once; one or more messages are omitted.",
    );
  }
}

function hasExactSourceMetadata(
  candidate: SourceMessageDescriptor,
  canonical: SourceMessageDescriptor,
): boolean {
  return candidate.resolution === canonical.resolution &&
    candidate.sourcePeerKey === canonical.sourcePeerKey &&
    candidate.mid === canonical.mid &&
    candidate.date === canonical.date &&
    candidate.order === canonical.order &&
    candidate.groupedId === canonical.groupedId;
}

function validateUniqueMediaGroups(units: readonly TransferUnit[]): void {
  const groupedIds = new Set<string>();
  for (const unit of units) {
    if (unit.kind !== "media-group") {
      continue;
    }
    if (groupedIds.has(unit.groupedId)) {
      throw new Error("A captured Telegram media group may appear only once in a bundle.");
    }
    groupedIds.add(unit.groupedId);
  }
}

function metadataFingerprint(payload: Extract<TelegramDeliveryPayload, { kind: "image" }>): string {
  // Legacy test fixtures cannot hash asynchronously; production capture supplies a full-byte hash.
  return `legacy:${payload.image.type}:${payload.image.size}:${payload.fileName}`;
}

function normalizeTransferUnit(unit: TransferUnit): TransferUnit {
  const source = unit.source.map(createSourceMessageDescriptor);
  if (unit.kind === "text") {
    return createTextTransferUnit(
      source,
      unit.content.kind === "plain-text"
        ? createPlainTextContent(unit.content.text, unit.content.linkPreview)
        : createFormattedTextContent({
            text: unit.content.text,
            entities: unit.content.entities,
            linkPreview: unit.content.linkPreview,
          }),
    );
  }
  if (unit.kind === "file") {
    return createFileTransferUnit({
      source,
      role: unit.role,
      item: normalizeMediaItem(unit.item),
    });
  }
  if (unit.kind === "media-group") {
    return createMediaGroupTransferUnit({
      source,
      groupedId: unit.groupedId,
      items: unit.items.map(normalizeMediaItem),
      expectedGroups: unit.expectedGroups,
    });
  }
  return createPollTemplateTransferUnit({ source, content: unit.content });
}

function normalizeMediaItem(item: TransferMediaItem): TransferMediaItem {
  return createTransferMediaItem({
    media: createBinaryMediaContent({
      blob: item.media.blob,
      fileName: item.media.fileName,
      contentFingerprint: item.media.contentFingerprint,
      metadata: item.media.metadata,
      mimeType: item.media.mimeType,
    }),
    order: item.order,
    ...(item.caption
      ? { caption: createMediaCaption(item.caption.text, item.caption.entities) }
      : {}),
  });
}
