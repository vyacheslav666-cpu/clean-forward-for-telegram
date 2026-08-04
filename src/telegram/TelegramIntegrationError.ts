/** Defines typed failures for recoverable Telegram DOM integration problems. */

/** Stable error categories used to produce precise UI feedback and cleanup decisions. */
export type TelegramIntegrationErrorCode =
  | "composer-unavailable"
  | "composer-not-empty"
  | "preview-already-open"
  | "file-input-unavailable"
  | "media-mode-unavailable"
  | "unsupported-image"
  | "peer-changed"
  | "preview-timeout"
  | "preview-cancelled"
  | "caption-unavailable"
  | "caption-insertion-failed"
  | "cleanup-failed";

/** Error carrying whether a valid image preview should be left open for manual correction. */
export class TelegramIntegrationError extends Error {
  public constructor(
    public readonly code: TelegramIntegrationErrorCode,
    message: string,
    public readonly preservePreview = false,
  ) {
    super(message);
    this.name = "TelegramIntegrationError";
  }
}
