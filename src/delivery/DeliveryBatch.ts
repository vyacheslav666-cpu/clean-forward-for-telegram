/** Owns ordered per-recipient delivery state independently from presentation. */
import type { Recipient } from "../recipient/Recipient";
import { snapshotRecipient } from "../recipient/Recipient";

/** Lifecycle states allowed for one recipient in an automatic delivery batch. */
export type RecipientDeliveryStatus =
  | "pending"
  | "navigating"
  | "preparing"
  | "sending"
  | "sent"
  | "failed"
  | "unknown";

/** Immutable status exposed to progress UI and diagnostics. */
export interface RecipientDeliverySnapshot {
  readonly recipient: Readonly<Recipient>;
  readonly status: RecipientDeliveryStatus;
  readonly sendClicked: boolean;
  readonly attemptCount: number;
  readonly retryReason?: string;
  readonly detail?: string;
  readonly messageId?: string;
}

/** Immutable aggregate view of one ordered delivery attempt. */
export interface DeliveryBatchSnapshot {
  readonly recipients: readonly RecipientDeliverySnapshot[];
  readonly currentIndex: number | null;
  readonly currentRecipient: Readonly<Recipient> | null;
  readonly sentCount: number;
  readonly failedCount: number;
  readonly unknownCount: number;
  readonly cancelRequested: boolean;
  readonly running: boolean;
  readonly retryableCount: number;
}

interface MutableRecipientDelivery {
  readonly recipient: Readonly<Recipient>;
  status: RecipientDeliveryStatus;
  sendClicked: boolean;
  attemptCount: number;
  retryReason?: string;
  detail?: string;
  messageId?: string;
}

/** Enforces terminal-state and duplicate-protection rules for one ordered batch. */
export class DeliveryBatch {
  private readonly records: MutableRecipientDelivery[];
  private currentIndex: number | null = null;
  private cancelRequested = false;
  private running = false;

  public constructor(recipients: readonly Readonly<Recipient>[]) {
    this.records = recipients.map((recipient) => ({
      recipient: snapshotRecipient(recipient),
      status: "pending",
      sendClicked: false,
      attemptCount: 0,
    }));
  }

  /** Returns the next untouched recipient without ever revisiting a sent record. */
  public nextPending(): Readonly<Recipient> | null {
    const index = this.records.findIndex((record) => record.status === "pending");
    return index >= 0 ? this.records[index]?.recipient ?? null : null;
  }

  /** Starts one run pass while preserving earlier terminal results. */
  public beginRun(): void {
    this.running = true;
    this.cancelRequested = false;
    this.currentIndex = null;
  }

  /** Marks the current run pass as stopped without changing recipient results. */
  public finishRun(): void {
    this.running = false;
    this.currentIndex = null;
  }

  /** Moves one pending recipient into navigation. */
  public beginNavigation(peerKey: string): void {
    const index = this.requireRecordIndex(peerKey);
    this.requireStatus(index, "pending");
    this.currentIndex = index;
    const record = this.records[index]!;
    record.status = "navigating";
    record.attemptCount += 1;
  }

  /** Marks that Telegram opened and validated the intended clean composer. */
  public beginPreparation(peerKey: string): void {
    const index = this.requireRecordIndex(peerKey);
    this.requireStatus(index, "navigating");
    this.records[index]!.status = "preparing";
  }

  /** Records the irreversible Send boundary before delivery confirmation begins. */
  public markSendClicked(peerKey: string): void {
    const index = this.requireRecordIndex(peerKey);
    this.requireStatus(index, "preparing");
    const record = this.records[index]!;
    record.status = "sending";
    record.sendClicked = true;
  }

  /** Completes one recipient only after a new outgoing data-mid is confirmed. */
  public markSent(peerKey: string, messageId: string): void {
    const index = this.requireRecordIndex(peerKey);
    this.requireStatus(index, "sending");
    const record = this.records[index]!;
    record.status = "sent";
    record.messageId = messageId;
    record.detail = undefined;
    this.currentIndex = null;
  }

  /** Marks a definitely pre-Send failure as safe to retry later. */
  public markFailed(peerKey: string, detail: string): void {
    const index = this.requireRecordIndex(peerKey);
    const record = this.records[index]!;
    if (record.sendClicked || record.status === "sending") {
      throw new Error("A delivery with a clicked Send cannot become retryable.");
    }
    if (!(["navigating", "preparing"] as RecipientDeliveryStatus[]).includes(record.status)) {
      throw new Error(`Cannot fail recipient from ${record.status}.`);
    }
    record.status = "failed";
    record.detail = detail;
    this.currentIndex = null;
  }

  /** Marks an ambiguous post-Send outcome as terminal and non-retryable. */
  public markUnknown(peerKey: string, detail: string): void {
    const index = this.requireRecordIndex(peerKey);
    this.requireStatus(index, "sending");
    const record = this.records[index]!;
    record.status = "unknown";
    record.detail = detail;
    this.currentIndex = null;
  }

  /** Returns interrupted pre-Send work to pending without counting it as a failure. */
  public returnCurrentToPending(): void {
    if (this.currentIndex === null) {
      return;
    }
    const record = this.records[this.currentIndex]!;
    if (record.sendClicked || record.status === "sending") {
      return;
    }
    record.status = "pending";
    record.detail = undefined;
    this.currentIndex = null;
  }

  /** Returns a definitely pre-Send failure to pending for one automatic bounded retry. */
  public scheduleRetry(peerKey: string, reason: string): void {
    const index = this.requireRecordIndex(peerKey);
    const record = this.records[index]!;
    if (record.sendClicked || record.status === "sending") {
      throw new Error("A delivery with a clicked Send cannot be scheduled for retry.");
    }
    if (!(record.status === "navigating" || record.status === "preparing")) {
      throw new Error(`Cannot retry recipient from ${record.status}.`);
    }
    record.status = "pending";
    record.retryReason = reason;
    record.detail = reason;
    this.currentIndex = null;
  }

  /** Requests a cooperative stop at the next safe pre-Send boundary. */
  public requestCancel(): void {
    this.cancelRequested = true;
  }

  /** Reports whether the user requested a cooperative stop. */
  public isCancelRequested(): boolean {
    return this.cancelRequested;
  }

  /** Returns the active recipient status, if a recipient is currently processing. */
  public currentStatus(): RecipientDeliveryStatus | null {
    return this.currentIndex === null ? null : this.records[this.currentIndex]?.status ?? null;
  }

  /** Resets only recipients that are provably safe to attempt again. */
  public resetRetryable(): boolean {
    if (this.running || this.records.some((record) => record.status === "unknown")) {
      return false;
    }

    let reset = false;
    for (const record of this.records) {
      if (record.status === "failed" && !record.sendClicked) {
        record.status = "pending";
        record.detail = undefined;
        reset = true;
      } else if (record.status === "pending") {
        reset = true;
      }
    }
    return reset;
  }

  /** Creates an immutable progress snapshot without exposing mutable records to UI. */
  public snapshot(): DeliveryBatchSnapshot {
    const recipients = this.records.map((record) => Object.freeze({
      recipient: record.recipient,
      status: record.status,
      sendClicked: record.sendClicked,
      attemptCount: record.attemptCount,
      ...(record.retryReason ? { retryReason: record.retryReason } : {}),
      ...(record.detail ? { detail: record.detail } : {}),
      ...(record.messageId ? { messageId: record.messageId } : {}),
    }));
    const retryableCount = this.records.filter(
      (record) => record.status === "pending" || (record.status === "failed" && !record.sendClicked),
    ).length;

    return Object.freeze({
      recipients: Object.freeze(recipients),
      currentIndex: this.currentIndex,
      currentRecipient:
        this.currentIndex === null ? null : this.records[this.currentIndex]?.recipient ?? null,
      sentCount: this.count("sent"),
      failedCount: this.count("failed"),
      unknownCount: this.count("unknown"),
      cancelRequested: this.cancelRequested,
      running: this.running,
      retryableCount,
    });
  }

  private count(status: RecipientDeliveryStatus): number {
    return this.records.filter((record) => record.status === status).length;
  }

  private requireRecordIndex(peerKey: string): number {
    const index = this.records.findIndex((record) => record.recipient.peerKey === peerKey);
    if (index < 0) {
      throw new Error("Recipient is not part of this delivery batch.");
    }
    return index;
  }

  private requireStatus(index: number, expected: RecipientDeliveryStatus): void {
    const actual = this.records[index]?.status;
    if (actual !== expected) {
      throw new Error(`Expected ${expected}, received ${actual ?? "missing"}.`);
    }
  }
}
