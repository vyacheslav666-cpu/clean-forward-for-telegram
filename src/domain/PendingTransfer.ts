/** Owns the one pending transfer and deliberately keeps it out of persistent storage. */
import type { MessagePayload } from "./MessagePayload";

/** In-memory storage for the message currently waiting to be inserted. */
export class PendingTransfer {
  private payload: MessagePayload | null = null;
  private state: "empty" | "ready" | "inserting" = "empty";

  /** Replaces any earlier selection with the newly extracted message. */
  public select(payload: MessagePayload): boolean {
    if (this.state === "inserting") {
      return false;
    }
    // Keeping the Blob only on this instance prevents private media from surviving a reload.
    this.payload = payload;
    this.state = "ready";
    return true;
  }

  /** Returns the current payload without removing it. */
  public peek(): MessagePayload | null {
    return this.payload;
  }

  /** Forgets the selected data so its Blob can be reclaimed. */
  public clear(): void {
    this.payload = null;
    this.state = "empty";
  }

  /** Reports whether the transfer panel has data to insert. */
  public hasValue(): boolean {
    return this.payload !== null;
  }

  /** Atomically reserves the current payload for one insertion attempt. */
  public beginInsertion(): MessagePayload | null {
    if (this.state !== "ready" || !this.payload) {
      return null;
    }

    this.state = "inserting";
    return this.payload;
  }

  /** Returns a failed insertion to the retryable ready state. */
  public restoreAfterFailure(): boolean {
    if (this.state !== "inserting" || !this.payload) {
      return false;
    }

    this.state = "ready";
    return true;
  }

  /** Clears a payload only when the active insertion completed successfully. */
  public completeInsertion(): boolean {
    if (this.state !== "inserting") {
      return false;
    }

    this.clear();
    return true;
  }

  /** Reports whether one controller operation currently owns the payload. */
  public isInsertionInProgress(): boolean {
    return this.state === "inserting";
  }
}
