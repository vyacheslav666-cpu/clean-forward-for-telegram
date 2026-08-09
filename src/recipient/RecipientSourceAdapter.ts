/** Declares the source boundary for recipient rows already loaded by Telegram. */
import type { Recipient } from "./Recipient";

/** Supplies recipient snapshots without exposing Telegram DOM nodes to the UI. */
export interface RecipientSourceAdapter {
  /** Reads and deduplicates the currently rendered recent dialogs. */
  listLoadedRecipients(signal: AbortSignal): Promise<readonly Recipient[]>;

  /** Streams native Telegram search snapshots for a non-empty query. */
  searchRecipients(
    query: string,
    signal: AbortSignal,
    onUpdate: (recipients: readonly Recipient[]) => void,
  ): void;

  /** Restores the native Telegram search state used by the current picker session. */
  clearSearch(): void;
}
