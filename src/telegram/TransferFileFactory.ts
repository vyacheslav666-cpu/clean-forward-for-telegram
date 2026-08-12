/** Recreates browser File values from immutable in-memory media snapshots. */
import type { BinaryMediaContent } from "../domain/TransferableContent";
import { TelegramIntegrationError } from "./TelegramIntegrationError";

const FALLBACK_FILE_NAME = "clean-forward.bin";

/** Creates a fresh File so the same immutable Blob can be uploaded to multiple recipients. */
export function createTransferFile(media: BinaryMediaContent): File {
  if (media.blob.size !== media.sizeBytes || media.blob.size === 0) {
    throw new TelegramIntegrationError(
      "unsupported-image",
      "Captured media bytes are unavailable or changed before preparation.",
    );
  }

  // Path separators are removed because captured display names are metadata, never destinations.
  const safeName = media.fileName.split(/[\\/]/).pop()?.trim() || FALLBACK_FILE_NAME;
  return new File([media.blob], safeName, { type: media.mimeType });
}
