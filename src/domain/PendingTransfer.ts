/** Owns the one pending transfer and deliberately keeps it out of persistent storage. */
import type { MessagePayload } from "./MessagePayload";

/** In-memory storage for the message currently waiting to be inserted. */
export class PendingTransfer {
  private payload: MessagePayload | null = null;

  /** Replaces any earlier selection with the newly extracted message. */
  public select(payload: MessagePayload): void {
    // Keeping the Blob only on this instance prevents private media from surviving a reload.
    this.payload = payload;
  }

  /** Returns the current payload without removing it. */
  public peek(): MessagePayload | null {
    return this.payload;
  }

  /** Forgets the selected data so its Blob can be reclaimed. */
  public clear(): void {
    this.payload = null;
  }

  /** Reports whether the transfer panel has data to insert. */
  public hasValue(): boolean {
    return this.payload !== null;
  }
}
