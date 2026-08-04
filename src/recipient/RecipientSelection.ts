/** Owns the transient multi-recipient selection outside the picker presentation layer. */
import type { Recipient } from "./Recipient";
import { snapshotRecipient } from "./Recipient";

/** Deduplicated in-memory selection keyed by Telegram's opaque peer string. */
export class RecipientSelection {
  private readonly recipients = new Map<string, Readonly<Recipient>>();

  /** Adds or removes one supported recipient without allowing duplicate peer keys. */
  public toggle(recipient: Recipient): void {
    if (!recipient.supported) {
      return;
    }

    if (this.recipients.has(recipient.peerKey)) {
      this.recipients.delete(recipient.peerKey);
      return;
    }

    this.recipients.set(recipient.peerKey, snapshotRecipient(recipient));
  }

  /** Returns immutable recipients in the order in which the user selected them. */
  public snapshot(): readonly Readonly<Recipient>[] {
    return Object.freeze(Array.from(this.recipients.values()));
  }

  /** Returns an immutable peer-key view for rendering selected indicators. */
  public peerKeys(): readonly string[] {
    return Object.freeze(Array.from(this.recipients.keys()));
  }

  /** Reports how many unique supported recipients are selected. */
  public count(): number {
    return this.recipients.size;
  }

  /** Clears all transient recipient choices. */
  public clear(): void {
    this.recipients.clear();
  }
}
