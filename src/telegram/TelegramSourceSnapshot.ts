/** Defines plain source data copied across the Telegram DOM/model boundary. */
import type {
  BinaryMediaMetadata,
  CapturedTextEntity,
} from "../domain/TransferableContent";
import type { PollTemplateContent } from "../domain/TransferUnit";

/** Telegram album metadata is accepted only when a verified model bridge proves completeness. */
export type TelegramMessageGroupSnapshot =
  | { readonly kind: "none" }
  | { readonly kind: "ambiguous-dom" }
  | {
      readonly kind: "complete-model";
      readonly groupedId: string;
      readonly expectedItemCount: number;
    };

/**
 * Detached message snapshot containing no Telegram model object, DOM node, or session data.
 * Browser-owned media URLs are consumed during atomic capture and never retained in the bundle.
 */
export interface TelegramMessageSnapshot {
  readonly identityResolution: "dom-fallback";
  readonly sourcePeerKey: string;
  readonly mid: number;
  readonly date: number | null;
  readonly group: TelegramMessageGroupSnapshot;
  readonly text: string | null;
  readonly imageUrl: string | null;
  readonly imageCount: number;
  readonly hasUnsupportedAttachment: boolean;
}

/** Full in-memory bytes and model metadata resolved before the source chat is left. */
export interface TelegramFullBinarySnapshot {
  readonly blob: Blob;
  readonly fileName: string;
  readonly mimeType: string;
  readonly declaredSize: number;
  readonly metadata: BinaryMediaMetadata;
}

/** Supported model content is discriminated before any capture strategy runs. */
export type TelegramModelContentSnapshot =
  | {
      readonly kind: "text";
      readonly text: string;
      readonly entities: readonly CapturedTextEntity[];
      readonly linkPreview: "regenerate" | "disable";
    }
  | {
      readonly kind: "binary";
      readonly role: "photo" | "video" | "animation" | "document" | "audio";
      readonly binary: TelegramFullBinarySnapshot;
      readonly caption: {
        readonly text: string;
        readonly entities: readonly CapturedTextEntity[];
      } | null;
      readonly spoiler: boolean;
      readonly invertMedia: boolean;
    }
  | {
      readonly kind: "poll-template";
      readonly poll: PollTemplateContent;
    }
  | {
      readonly kind: "unsupported";
      readonly type:
        | "reply-semantics"
        | "voice"
        | "video-note"
        | "sticker"
        | "animated-sticker"
        | "contact"
        | "location"
        | "venue"
        | "service"
        | "game"
        | "invoice"
        | "story"
        | "giveaway"
        | "dice"
        | "unknown";
    };

/** Capture restrictions copied from a verified read-only Telegram model. */
export interface TelegramCaptureRestrictions {
  readonly noForwards: boolean;
  readonly ephemeral: boolean;
  readonly paid: boolean;
  readonly mediaAvailable: boolean;
}

/** Detached model-backed snapshot; it intentionally contains no mutable Telegram manager object. */
export interface TelegramModelMessageSnapshot {
  readonly identityResolution: "telegram-model";
  readonly sourcePeerKey: string;
  readonly mid: number;
  readonly date: number;
  readonly group: TelegramMessageGroupSnapshot;
  readonly restrictions: TelegramCaptureRestrictions;
  readonly provenance: {
    readonly forwarded: boolean;
    readonly reply: boolean;
  };
  readonly content: TelegramModelContentSnapshot;
}

/** Input accepted by source capture after either strict DOM or verified model resolution. */
export type TelegramSourceSnapshot = TelegramMessageSnapshot | TelegramModelMessageSnapshot;
