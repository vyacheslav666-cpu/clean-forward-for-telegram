/** Captures result-free poll and quiz templates from verified Telegram models. */
import { createPollTemplateTransferUnit } from "../../domain/TransferUnit";
import type { TelegramSourceSnapshot } from "../TelegramSourceSnapshot";
import {
  CaptureAdapterError,
  type SourceCaptureAdapter,
  type SourceCaptureAdapterContext,
} from "./SourceCaptureAdapter";

/** Keeps poll results and voter identity out of the reproduction payload by construction. */
export class PollSourceCaptureAdapter implements SourceCaptureAdapter {
  /** Requires a verified model because rendered poll DOM cannot prove quiz settings or answers. */
  public supports(snapshot: TelegramSourceSnapshot): boolean {
    return snapshot.identityResolution === "telegram-model" &&
      snapshot.content.kind === "poll-template";
  }

  /** Copies only a new poll/quiz template and deliberately excludes results and voter identity. */
  public async capture(context: SourceCaptureAdapterContext) {
    const { snapshot } = context;
    if (snapshot.identityResolution !== "telegram-model" || snapshot.content.kind !== "poll-template") {
      throw new CaptureAdapterError("invalid-model", "Expected verified poll template.");
    }
    try {
      return createPollTemplateTransferUnit({
        source: [context.descriptor],
        content: snapshot.content.poll,
      });
    } catch (error) {
      throw new CaptureAdapterError(
        "invalid-model",
        error instanceof Error ? error.message : "Poll template is incomplete.",
      );
    }
  }
}
