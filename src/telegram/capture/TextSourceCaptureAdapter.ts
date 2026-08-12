/** Captures plain DOM text and verified model entities without guessing formatting from markup. */
import {
  createFormattedTextContent,
  createPlainTextContent,
} from "../../domain/TransferableContent";
import { createTextTransferUnit } from "../../domain/TransferUnit";
import type { TelegramSourceSnapshot } from "../TelegramSourceSnapshot";
import {
  CaptureAdapterError,
  type SourceCaptureAdapter,
  type SourceCaptureAdapterContext,
} from "./SourceCaptureAdapter";

/** Owns text-family capture while leaving current delivery limited to plain text. */
export class TextSourceCaptureAdapter implements SourceCaptureAdapter {
  /** Accepts only plain DOM text or an explicitly discriminated model text value. */
  public supports(snapshot: TelegramSourceSnapshot): boolean {
    return snapshot.identityResolution === "telegram-model"
      ? snapshot.content.kind === "text"
      : snapshot.imageCount === 0 && !snapshot.hasUnsupportedAttachment;
  }

  /** Copies text/entities into a detached unit and rejects malformed UTF-16 entity ranges. */
  public async capture(context: SourceCaptureAdapterContext) {
    const { snapshot, descriptor } = context;
    if (snapshot.identityResolution === "dom-fallback") {
      const text = snapshot.text?.trim() ?? "";
      if (!text) {
        throw new CaptureAdapterError("unsupported-type", "Plain text source is empty.");
      }
      return createTextTransferUnit([descriptor], createPlainTextContent(text));
    }
    if (snapshot.content.kind !== "text" || !snapshot.content.text) {
      throw new CaptureAdapterError("invalid-model", "Verified text model is malformed.");
    }

    try {
      const content = snapshot.content.entities.length === 0
        ? createPlainTextContent(snapshot.content.text, snapshot.content.linkPreview)
        : createFormattedTextContent({
            text: snapshot.content.text,
            entities: snapshot.content.entities,
            linkPreview: snapshot.content.linkPreview,
          });
      return createTextTransferUnit([descriptor], content);
    } catch (error) {
      throw new CaptureAdapterError(
        "invalid-model",
        error instanceof Error ? error.message : "Verified text metadata is malformed.",
      );
    }
  }
}
