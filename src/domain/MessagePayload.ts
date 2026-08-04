/** Defines the supported in-memory message shapes for the MVP. */

/** Plain text that will be inserted into the destination composer. */
export interface TextMessagePayload {
  readonly kind: "text";
  readonly text: string;
}

/** One image, optionally accompanied by a caption. */
export interface ImageMessagePayload {
  readonly kind: "image";
  readonly image: Blob;
  readonly fileName: string;
  readonly caption?: string;
}

/** Message data supported by the first Clean Forward release. */
export type MessagePayload = TextMessagePayload | ImageMessagePayload;

/** Returns a short UI-safe summary without exposing message content. */
export function describePayload(payload: MessagePayload): string {
  if (payload.kind === "text") {
    return "Текст готов к вставке";
  }

  return payload.caption ? "Картинка с подписью готова" : "Картинка готова";
}
