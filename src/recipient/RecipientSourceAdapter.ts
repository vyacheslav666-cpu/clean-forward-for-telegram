/** Declares the source boundary for recipient rows already loaded by Telegram. */
import type { Recipient } from "./Recipient";

/** Supplies recipient snapshots without exposing Telegram DOM nodes to the UI. */
export interface RecipientSourceAdapter {
  /** Reads and deduplicates the currently loaded dialogs, stopping promptly when cancelled. */
  listLoadedRecipients(signal: AbortSignal): Promise<readonly Recipient[]>;
}
