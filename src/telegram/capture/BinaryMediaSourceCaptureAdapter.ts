/** Captures ordinary photos and verified full-byte uploadable document families. */
import {
  createBinaryMediaContent,
  createMediaCaption,
  createTransferMediaItem,
  fingerprintBlob,
  type BinaryMediaMetadata,
  type CapturedTextEntity,
  type TransferMediaItem,
} from "../../domain/TransferableContent";
import { createFileTransferUnit, type FileTransferUnit } from "../../domain/TransferUnit";
import { fetchMediaBytes, MediaBytesError } from "../fetchMediaBytes";
import type { TelegramSourceSnapshot } from "../TelegramSourceSnapshot";
import {
  CaptureAdapterError,
  type SourceCaptureAdapter,
  type SourceCaptureAdapterContext,
  throwIfCaptureAborted,
} from "./SourceCaptureAdapter";

const DEFAULT_IMAGE_FILE_NAME = "telegram-image.jpg";
const VIDEO_FILE_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
});
const MAX_CAPTURE_BINARY_BYTES = 64 * 1024 * 1024;

/** Materializes one uploadable binary unit without using thumbnail or mounted source DOM later. */
export class BinaryMediaSourceCaptureAdapter implements SourceCaptureAdapter {
  /** Accepts the proven one-photo DOM fallback or a verified uploadable model family. */
  public supports(snapshot: TelegramSourceSnapshot): boolean {
    return snapshot.identityResolution === "telegram-model"
      ? snapshot.content.kind === "binary"
      : snapshot.imageCount > 0 || Boolean(snapshot.imageUrl) || snapshot.video !== null;
  }

  /** Produces one independent file unit after all full-byte metadata checks pass. */
  public async capture(context: SourceCaptureAdapterContext) {
    const item = await this.captureItem(context);
    return createFileTransferUnit({
      source: [context.descriptor],
      role: this.readRole(context.snapshot),
      item,
    });
  }

  /** Captures one media item for either an independent file or an atomic album strategy. */
  public async captureItem(context: SourceCaptureAdapterContext): Promise<TransferMediaItem> {
    const { snapshot, descriptor, signal } = context;
    throwIfCaptureAborted(signal);
    if (snapshot.identityResolution === "dom-fallback") {
      if (snapshot.video) {
        return this.captureDomVideo(context);
      }
      if (
        snapshot.imageCount !== 1 ||
        !snapshot.imageUrl ||
        snapshot.hasUnsupportedAttachment ||
        snapshot.group.kind !== "none"
      ) {
        throw new CaptureAdapterError(
          "unsupported-type",
          "DOM photo fallback requires exactly one ordinary ungrouped image.",
        );
      }
      const response = signal
        ? await fetch(snapshot.imageUrl, { signal })
        : await fetch(snapshot.imageUrl);
      if (!response.ok) {
        throw new CaptureAdapterError(
          "unavailable-media",
          `Image request failed with status ${response.status}`,
        );
      }
      const blob = await response.blob();
      throwIfCaptureAborted(signal);
      return this.createItem({
        blob,
        fileName: DEFAULT_IMAGE_FILE_NAME,
        mimeType: blob.type,
        declaredSize: blob.size,
        metadata: { kind: "photo", width: null, height: null },
        caption: snapshot.text ? { text: snapshot.text, entities: [] } : null,
        order: descriptor.order,
      });
    }

    if (snapshot.content.kind !== "binary") {
      throw new CaptureAdapterError("invalid-model", "Expected verified binary content.");
    }
    if (snapshot.content.spoiler || snapshot.content.invertMedia) {
      throw new CaptureAdapterError(
        "unsupported-type",
        "Spoiler or invert-media flags need a separate proven native UI capability.",
      );
    }
    const binary = snapshot.content.binary;
    this.validateModelBinary(snapshot.content.role, binary);
    return this.createItem({
      ...binary,
      caption: snapshot.content.caption,
      order: descriptor.order,
    });
  }

  /**
   * Captures one ordinary bubble video as full bytes.
   *
   * Telegram re-encodes on upload, so the copy is a new video rather than a byte-identical one.
   * What must not happen is a silently truncated file, which is why byte acquisition proves the
   * complete length before anything reaches the bundle.
   */
  private async captureDomVideo(
    context: SourceCaptureAdapterContext,
  ): Promise<TransferMediaItem> {
    const { snapshot, descriptor, signal } = context;
    if (snapshot.identityResolution !== "dom-fallback" || !snapshot.video) {
      throw new CaptureAdapterError("invalid-model", "Expected one ordinary DOM video.");
    }
    if (
      snapshot.videoCount !== 1 ||
      snapshot.imageCount > 0 ||
      snapshot.hasUnsupportedAttachment ||
      snapshot.group.kind !== "none"
    ) {
      throw new CaptureAdapterError(
        "unsupported-type",
        "DOM video fallback requires exactly one ordinary ungrouped video.",
      );
    }

    const video = snapshot.video;
    let bytes;
    try {
      bytes = await fetchMediaBytes(video.url, MAX_CAPTURE_BINARY_BYTES, signal);
    } catch (error) {
      if (error instanceof MediaBytesError) {
        throw new CaptureAdapterError("unavailable-media", error.message);
      }
      throw error;
    }
    throwIfCaptureAborted(signal);
    if (!bytes.mimeType.startsWith("video/")) {
      throw new CaptureAdapterError(
        "unavailable-media",
        `Bubble video was served as ${bytes.mimeType}, which is not a video upload.`,
      );
    }

    return this.createItem({
      blob: bytes.blob,
      fileName: `telegram-video.${VIDEO_FILE_EXTENSIONS[bytes.mimeType] ?? "mp4"}`,
      mimeType: bytes.mimeType,
      declaredSize: bytes.blob.size,
      metadata: {
        kind: "video",
        width: video.width,
        height: video.height,
        durationSeconds: video.durationSeconds,
        supportsStreaming: true,
      },
      caption: snapshot.text ? { text: snapshot.text, entities: [] } : null,
      order: descriptor.order,
    });
  }

  private readRole(snapshot: TelegramSourceSnapshot): FileTransferUnit["role"] {
    if (snapshot.identityResolution === "dom-fallback") {
      return snapshot.video ? "video" : "photo";
    }
    if (snapshot.content.kind !== "binary") {
      throw new CaptureAdapterError("invalid-model", "Expected verified binary role.");
    }
    return snapshot.content.role;
  }

  private async createItem(input: {
    readonly blob: Blob;
    readonly fileName: string;
    readonly mimeType: string;
    readonly declaredSize: number;
    readonly metadata: BinaryMediaMetadata;
    readonly caption: {
      readonly text: string;
      readonly entities: readonly CapturedTextEntity[];
    } | null;
    readonly order: number;
  }): Promise<TransferMediaItem> {
    if (
      !input.fileName.trim() ||
      !input.mimeType.trim() ||
      input.blob.size > MAX_CAPTURE_BINARY_BYTES ||
      input.declaredSize !== input.blob.size ||
      (input.blob.type && input.blob.type !== input.mimeType)
    ) {
      throw new CaptureAdapterError(
        "unavailable-media",
        "Full binary bytes do not match verified file metadata.",
      );
    }
    const caption = input.caption?.text ?? "";
    return createTransferMediaItem({
      media: createBinaryMediaContent({
        blob: input.blob,
        fileName: input.fileName,
        contentFingerprint: await fingerprintBlob(input.blob),
        metadata: input.metadata,
        mimeType: input.mimeType,
      }),
      order: input.order,
      ...(caption.trim()
        ? { caption: createMediaCaption(caption, input.caption?.entities ?? []) }
        : {}),
    });
  }

  private validateModelBinary(
    role: FileTransferUnit["role"],
    binary: { readonly metadata: BinaryMediaMetadata },
  ): void {
    if (role !== binary.metadata.kind) {
      throw new CaptureAdapterError(
        "invalid-model",
        "Verified document role does not match its required metadata family.",
      );
    }
    const metadata = binary.metadata;
    if (
      metadata.kind === "photo" &&
      (metadata.width === null || metadata.height === null || metadata.width <= 0 || metadata.height <= 0)
    ) {
      throw new CaptureAdapterError("invalid-model", "Photo dimensions are incomplete.");
    }
    if (
      (metadata.kind === "video" || metadata.kind === "animation") &&
      (metadata.width <= 0 || metadata.height <= 0 || metadata.durationSeconds < 0)
    ) {
      throw new CaptureAdapterError("invalid-model", "Video metadata is incomplete.");
    }
    if (metadata.kind === "audio" && metadata.durationSeconds < 0) {
      throw new CaptureAdapterError("invalid-model", "Audio duration is invalid.");
    }
  }
}
