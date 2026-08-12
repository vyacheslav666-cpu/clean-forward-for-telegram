/** Defines immutable text, caption, and binary values detached from Telegram's live page. */

/** Plain text with an explicit link-preview reproduction policy. */
export interface PlainTextContent {
  readonly kind: "plain-text";
  readonly text: string;
  readonly linkPreview: "regenerate" | "disable";
}

/** Telegram text entity copied as scalar metadata from a verified read-only model. */
export type CapturedTextEntity =
  | (CapturedTextEntityRange & { readonly kind: BasicTextEntityKind })
  | (CapturedTextEntityRange & { readonly kind: "text-url"; readonly url: string })
  | (CapturedTextEntityRange & { readonly kind: "mention-name"; readonly userId: string })
  | (CapturedTextEntityRange & { readonly kind: "custom-emoji"; readonly documentId: string });

interface CapturedTextEntityRange {
  readonly offset: number;
  readonly length: number;
}

type BasicTextEntityKind =
  | "bold"
    | "italic"
    | "underline"
    | "strike"
    | "code"
    | "pre"
    | "blockquote"
    | "spoiler"
    | "url"
    | "email"
    | "phone"
    | "mention"
    | "hashtag"
    | "bot-command";

/** Formatted text retained for a future entity-aware native composer adapter. */
export interface FormattedTextContent {
  readonly kind: "formatted-text";
  readonly text: string;
  readonly entities: readonly CapturedTextEntity[];
  readonly linkPreview: "regenerate" | "disable";
}

/** Text content is explicit so the current delivery adapter can reject unsupported formatting. */
export type TransferTextContent = PlainTextContent | FormattedTextContent;

/** Caption ownership remains attached to the media item that originally carried it. */
export interface MediaCaption {
  readonly kind: "caption";
  readonly text: string;
  readonly entities: readonly CapturedTextEntity[];
}

/** Binary media kept only in memory; Blob bytes are immutable by browser contract. */
export interface BinaryMediaContent {
  readonly kind: "binary-media";
  readonly blob: Blob;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly contentFingerprint: string;
  readonly metadata: BinaryMediaMetadata;
}

/** Type-specific metadata required to reproduce one upload through the matching native UI. */
export type BinaryMediaMetadata =
  | {
      readonly kind: "photo";
      readonly width: number | null;
      readonly height: number | null;
    }
  | {
      readonly kind: "video";
      readonly width: number;
      readonly height: number;
      readonly durationSeconds: number;
      readonly supportsStreaming: boolean;
    }
  | {
      readonly kind: "animation";
      readonly width: number;
      readonly height: number;
      readonly durationSeconds: number;
    }
  | { readonly kind: "document" }
  | {
      readonly kind: "audio";
      readonly durationSeconds: number;
      readonly title: string | null;
      readonly performer: string | null;
    };

/** One ordered upload item, optionally owning a caption. */
export interface TransferMediaItem {
  readonly media: BinaryMediaContent;
  readonly order: number;
  readonly caption?: MediaCaption;
}

/** Creates immutable plain text while preserving the preview policy for a future adapter. */
export function createPlainTextContent(
  text: string,
  linkPreview: PlainTextContent["linkPreview"] = "regenerate",
): PlainTextContent {
  if (!text.trim()) {
    throw new Error("Transfer text must not be empty.");
  }
  return Object.freeze({ kind: "plain-text", text, linkPreview });
}

/** Copies verified entities and rejects malformed UTF-16 ranges before recipient selection. */
export function createFormattedTextContent(input: {
  readonly text: string;
  readonly entities: readonly CapturedTextEntity[];
  readonly linkPreview: FormattedTextContent["linkPreview"];
}): FormattedTextContent {
  if (!input.text.trim() || input.entities.length === 0) {
    throw new Error("Formatted text requires non-empty text and entities.");
  }
  const entities = Object.freeze(input.entities.map((entity) => {
    if (
      !Number.isSafeInteger(entity.offset) ||
      !Number.isSafeInteger(entity.length) ||
      entity.offset < 0 ||
      entity.length < 1 ||
      entity.offset + entity.length > input.text.length
    ) {
      throw new Error("Formatted text entity range is invalid.");
    }
    if (
      (entity.kind === "text-url" && (!("url" in entity) || !entity.url.trim())) ||
      (entity.kind === "mention-name" && (!("userId" in entity) || !entity.userId.trim())) ||
      (entity.kind === "custom-emoji" && (!("documentId" in entity) || !entity.documentId.trim()))
    ) {
      throw new Error("Formatted text entity metadata is incomplete.");
    }
    return Object.freeze({ ...entity });
  }));
  return Object.freeze({
    kind: "formatted-text",
    text: input.text,
    entities,
    linkPreview: input.linkPreview,
  });
}

/** Creates an immutable non-empty media caption. */
export function createMediaCaption(
  text: string,
  entities: readonly CapturedTextEntity[] = [],
): MediaCaption {
  if (!text.trim()) {
    throw new Error("Media caption must not be empty.");
  }
  const frozenEntities = entities.length === 0
    ? Object.freeze([]) as readonly CapturedTextEntity[]
    : createFormattedTextContent({ text, entities, linkPreview: "disable" }).entities;
  return Object.freeze({ kind: "caption", text, entities: frozenEntities });
}

/** Copies binary metadata while retaining only the immutable Blob value in memory. */
export function createBinaryMediaContent(input: {
  readonly blob: Blob;
  readonly fileName: string;
  readonly contentFingerprint: string;
  readonly metadata: BinaryMediaMetadata;
  readonly mimeType?: string;
}): BinaryMediaContent {
  const mimeType = input.mimeType?.trim() || input.blob.type.trim();
  if (!input.fileName.trim() || !input.contentFingerprint.trim() || !mimeType) {
    throw new Error("Binary media requires a file name and content fingerprint.");
  }

  return Object.freeze({
    kind: "binary-media",
    blob: input.blob,
    fileName: input.fileName,
    mimeType,
    sizeBytes: input.blob.size,
    contentFingerprint: input.contentFingerprint,
    metadata: Object.freeze({ ...input.metadata }),
  });
}

/** Creates an immutable media item without detaching its caption from the original item. */
export function createTransferMediaItem(input: {
  readonly media: BinaryMediaContent;
  readonly order: number;
  readonly caption?: MediaCaption;
}): TransferMediaItem {
  if (!Number.isSafeInteger(input.order) || input.order < 0) {
    throw new Error("Media item order must be a non-negative safe integer.");
  }
  return Object.freeze({ ...input });
}

/**
 * Produces a correlation fingerprint from full bytes without treating it as Telegram identity.
 * A compact FNV-1a hash avoids depending on WebCrypto availability inside userscript sandboxes.
 */
export async function fingerprintBlob(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await readBlobBytes(blob));
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}:${blob.size}`;
}

async function readBlobBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") {
    return blob.arrayBuffer();
  }
  // Older WebView/jsdom Blob implementations still expose FileReader, so capture stays byte-based.
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
      } else {
        reject(new Error("Blob reader returned a non-binary result."));
      }
    }, { once: true });
    reader.addEventListener("error", () => reject(reader.error ?? new Error("Blob read failed.")), {
      once: true,
    });
    reader.readAsArrayBuffer(blob);
  });
}

/** Produces a deterministic text correlation fingerprint without exposing it as message identity. */
export function fingerprintText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}:${text.length}`;
}
