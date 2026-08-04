/** Creates browser File objects from in-memory Telegram photo Blobs. */
import { TelegramIntegrationError } from "./TelegramIntegrationError";

const DEFAULT_IMAGE_MIME_TYPE = "image/jpeg";
const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/bmp": "bmp",
  "image/webp": "webp",
  "image/avif": "avif",
};
const FILE_EXTENSION_PATTERN = /\.[a-z0-9]+$/i;
const UNSAFE_FILE_NAME_PATTERN = /[^\p{L}\p{N}._-]+/gu;

/** Creates one supported image File while preserving Blob bytes and MIME information. */
export function createImageFile(blob: Blob, suggestedName: string): File {
  if (blob.size === 0) {
    throw new TelegramIntegrationError("unsupported-image", "Выбранная картинка пуста.");
  }

  const mimeType = blob.type.toLowerCase() || DEFAULT_IMAGE_MIME_TYPE;
  const extension = MIME_EXTENSIONS[mimeType];
  if (!extension) {
    throw new TelegramIntegrationError(
      "unsupported-image",
      `Формат картинки ${mimeType} пока не поддерживается.`,
    );
  }

  const safeStem = suggestedName
    .replace(FILE_EXTENSION_PATTERN, "")
    .replace(UNSAFE_FILE_NAME_PATTERN, "-")
    .replace(/^-+|-+$/g, "") || "telegram-image";

  return new File([blob], `${safeStem}.${extension}`, {
    type: mimeType,
    lastModified: Date.now(),
  });
}
