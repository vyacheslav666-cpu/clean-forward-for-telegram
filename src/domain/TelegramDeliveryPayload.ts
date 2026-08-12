/** Keeps the existing Telegram UI delivery surface intentionally limited to MVP capabilities. */

/** Plain text accepted by the existing Telegram composer adapter. */
export interface TextDeliveryPayload {
  readonly kind: "text";
  readonly text: string;
}

/** One photo accepted by the existing Telegram media-preview adapter. */
export interface ImageDeliveryPayload {
  readonly kind: "image";
  readonly image: Blob;
  readonly fileName: string;
  readonly caption?: string;
}

/** Current Telegram delivery capabilities, separate from the generalized source model. */
export type TelegramDeliveryPayload = TextDeliveryPayload | ImageDeliveryPayload;
