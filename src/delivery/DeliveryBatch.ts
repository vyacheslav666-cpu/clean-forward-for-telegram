/** Owns ordered per-recipient and per-unit delivery state independently from presentation. */
import type { Recipient } from "../recipient/Recipient";
import { snapshotRecipient } from "../recipient/Recipient";

/** Lifecycle states exposed for one recipient in an automatic delivery batch. */
export type RecipientDeliveryStatus =
  | "pending"
  | "navigating"
  | "preparing"
  | "sending"
  | "sent"
  | "failed"
  | "unknown";

/** Irreversibility-aware lifecycle for one transfer unit. */
export type UnitDeliveryStatus =
  | "pending"
  | "preparing"
  | "sendClicked"
  | "sent"
  | "failed-before-send"
  | "unknown-after-send";

/** Immutable unit result used for duplicate-prevention diagnostics. */
export interface UnitDeliverySnapshot {
  readonly index: number;
  readonly status: UnitDeliveryStatus;
  readonly attemptCount: number;
  readonly sendClicked: boolean;
  readonly outgoingConfirmed: boolean;
  readonly failedBeforeSend: boolean;
  readonly unknownAfterSend: boolean;
  readonly safeToRetry: boolean;
  readonly messageIds: readonly string[];
  readonly detail?: string;
}

/** Immutable status exposed to progress UI and diagnostics. */
export interface RecipientDeliverySnapshot {
  readonly recipient: Readonly<Recipient>;
  readonly status: RecipientDeliveryStatus;
  readonly sendClicked: boolean;
  readonly attemptCount: number;
  readonly retryReason?: string;
  readonly detail?: string;
  readonly messageId?: string;
  readonly units: readonly UnitDeliverySnapshot[];
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
  /** A fail-closed infrastructure condition that forbids any further delivery work. */
  readonly safetyFailure?: string;
}

interface MutableUnitDelivery {
  readonly index: number;
  status: UnitDeliveryStatus;
  attemptCount: number;
  messageIds: string[];
  detail?: string;
}

interface MutableRecipientDelivery {
  readonly recipient: Readonly<Recipient>;
  readonly units: MutableUnitDelivery[];
  status: RecipientDeliveryStatus;
  attemptCount: number;
  retryReason?: string;
  detail?: string;
}

/** Enforces terminal-state and duplicate-protection rules for one ordered bundle batch. */
export class DeliveryBatch {
  private readonly records: MutableRecipientDelivery[];
  private currentIndex: number | null = null;
  private cancelRequested = false;
  private running = false;
  private safetyFailure: string | null = null;

  public constructor(
    recipients: readonly Readonly<Recipient>[],
    unitCount = 1,
  ) {
    if (!Number.isSafeInteger(unitCount) || unitCount < 1) {
      throw new Error("Delivery batch requires at least one transfer unit.");
    }
    this.records = recipients.map((recipient) => ({
      recipient: snapshotRecipient(recipient),
      status: "pending",
      attemptCount: 0,
      units: Array.from({ length: unitCount }, (_, index) => ({
        index,
        status: "pending",
        attemptCount: 0,
        messageIds: [],
      })),
    }));
  }

  /** Returns the next recipient with unfinished retry-safe work. */
  public nextPending(): Readonly<Recipient> | null {
    const record = this.records.find((candidate) => candidate.status === "pending");
    return record?.recipient ?? null;
  }

  /** Returns the first untouched unit and therefore preserves immutable bundle order. */
  public nextPendingUnitIndex(peerKey: string): number | null {
    const record = this.records[this.requireRecordIndex(peerKey)]!;
    return record.units.find((unit) => unit.status === "pending")?.index ?? null;
  }

  /** Starts one run pass while preserving earlier unit terminal results. */
  public beginRun(): void {
    if (this.safetyFailure) {
      throw new Error("A delivery batch with an unresolved safety failure cannot run again.");
    }
    this.running = true;
    this.cancelRequested = false;
    this.currentIndex = null;
  }

  /** Marks the current run pass as stopped without changing delivery results. */
  public finishRun(): void {
    this.running = false;
    this.currentIndex = null;
  }

  /** Moves one retry-safe recipient into navigation. */
  public beginNavigation(peerKey: string): void {
    const index = this.requireRecordIndex(peerKey);
    this.requireRecipientStatus(index, "pending");
    this.currentIndex = index;
    const record = this.records[index]!;
    record.status = "navigating";
    record.attemptCount += 1;
    const nextUnit = record.units.find((unit) => unit.status === "pending");
    if (!nextUnit) {
      throw new Error("Navigation requires unfinished retry-safe work.");
    }
    nextUnit.attemptCount += 1;
  }

  /** Marks preparation of exactly one pending unit after peer validation. */
  public beginUnitPreparation(peerKey: string, unitIndex: number): void {
    const recordIndex = this.requireRecordIndex(peerKey);
    const record = this.records[recordIndex]!;
    if (this.currentIndex !== recordIndex || !(record.status === "navigating" || record.status === "preparing")) {
      throw new Error(`Cannot prepare a unit while recipient is ${record.status}.`);
    }
    const unit = this.requireUnit(record, unitIndex);
    this.requireUnitStatus(unit, "pending");
    const startedWhileAlreadyInRecipient = record.status === "preparing";
    record.status = "preparing";
    unit.status = "preparing";
    if (startedWhileAlreadyInRecipient) {
      unit.attemptCount += 1;
    }
  }

  /** Compatibility alias for the first unit used by legacy state tests. */
  public beginPreparation(peerKey: string): void {
    this.beginUnitPreparation(peerKey, this.nextPendingUnitIndex(peerKey) ?? 0);
  }

  /** Records the irreversible boundary before dispatching the native click. */
  public markUnitSendClicked(peerKey: string, unitIndex: number): void {
    const record = this.records[this.requireRecordIndex(peerKey)]!;
    const unit = this.requireUnit(record, unitIndex);
    this.requireUnitStatus(unit, "preparing");
    unit.status = "sendClicked";
    record.status = "sending";
  }

  /** Compatibility alias for the currently preparing unit. */
  public markSendClicked(peerKey: string): void {
    this.markUnitSendClicked(peerKey, this.requireActiveUnit(peerKey).index);
  }

  /** Confirms one unit only after the complete expected outgoing identity set appears. */
  public markUnitSent(peerKey: string, unitIndex: number, messageIds: readonly string[]): void {
    if (messageIds.length === 0 || new Set(messageIds).size !== messageIds.length) {
      throw new Error("A sent transfer unit requires unique outgoing message identities.");
    }
    const record = this.records[this.requireRecordIndex(peerKey)]!;
    const unit = this.requireUnit(record, unitIndex);
    this.requireUnitStatus(unit, "sendClicked");
    unit.status = "sent";
    unit.messageIds = [...messageIds];
    unit.detail = undefined;
    record.detail = undefined;
    if (record.units.every((candidate) => candidate.status === "sent")) {
      record.status = "sent";
      this.currentIndex = null;
    } else {
      record.status = "preparing";
    }
  }

  /** Compatibility alias for one-message confirmation. */
  public markSent(peerKey: string, messageId: string): void {
    this.markUnitSent(peerKey, this.requireActiveUnit(peerKey).index, [messageId]);
  }

  /** Marks a definitely pre-click unit failure as retry-safe. */
  public markUnitFailedBeforeSend(peerKey: string, unitIndex: number, detail: string): void {
    const record = this.records[this.requireRecordIndex(peerKey)]!;
    const unit = this.requireUnit(record, unitIndex);
    this.requireUnitStatus(unit, "preparing");
    unit.status = "failed-before-send";
    unit.detail = detail;
    record.status = "failed";
    record.detail = detail;
    this.currentIndex = null;
  }

  /** Marks navigation or current preparation as definitely failed before Send. */
  public markFailed(peerKey: string, detail: string): void {
    const record = this.records[this.requireRecordIndex(peerKey)]!;
    if (record.status === "sending" || record.units.some((unit) => unit.status === "sendClicked")) {
      throw new Error("A delivery with a clicked Send cannot become retryable.");
    }
    if (record.status === "preparing") {
      this.markUnitFailedBeforeSend(peerKey, this.requireActiveUnit(peerKey).index, detail);
      return;
    }
    this.requireRecipientStatus(this.requireRecordIndex(peerKey), "navigating");
    const nextUnit = record.units.find((unit) => unit.status === "pending");
    if (!nextUnit) {
      throw new Error("A pre-Send recipient failure requires unfinished retry-safe work.");
    }
    // Navigation and draft setup belong to the next ordered pair even though preparation has
    // not started. Recording that pair keeps user-triggered retry evidence explicit.
    nextUnit.status = "failed-before-send";
    nextUnit.detail = detail;
    record.status = "failed";
    record.detail = detail;
    this.currentIndex = null;
  }

  /** Marks an ambiguous post-click unit as terminal and permanently non-retryable. */
  public markUnitUnknown(peerKey: string, unitIndex: number, detail: string): void {
    const record = this.records[this.requireRecordIndex(peerKey)]!;
    const unit = this.requireUnit(record, unitIndex);
    this.requireUnitStatus(unit, "sendClicked");
    unit.status = "unknown-after-send";
    unit.detail = detail;
    record.status = "unknown";
    record.detail = detail;
    this.currentIndex = null;
  }

  /** Compatibility alias for the currently clicked unit. */
  public markUnknown(peerKey: string, detail: string): void {
    this.markUnitUnknown(peerKey, this.requireActiveUnit(peerKey).index, detail);
  }

  /** Returns interrupted pre-click work to pending without touching confirmed units. */
  public returnCurrentToPending(): void {
    if (this.currentIndex === null) {
      return;
    }
    const record = this.records[this.currentIndex]!;
    const activeUnit = record.units.find((unit) => unit.status === "preparing");
    if (record.status === "sending" || record.units.some((unit) => unit.status === "sendClicked")) {
      return;
    }
    if (activeUnit) {
      activeUnit.status = "pending";
      activeUnit.detail = undefined;
    }
    record.status = "pending";
    record.detail = undefined;
    this.currentIndex = null;
  }

  /** Schedules only a navigation/preparation attempt whose Send boundary was not crossed. */
  public scheduleRetry(peerKey: string, reason: string): void {
    const record = this.records[this.requireRecordIndex(peerKey)]!;
    if (record.status === "sending" || record.units.some((unit) => unit.status === "sendClicked")) {
      throw new Error("A delivery with a clicked Send cannot be scheduled for retry.");
    }
    const activeUnit = record.units.find((unit) => unit.status === "preparing");
    if (activeUnit) {
      activeUnit.status = "pending";
      activeUnit.detail = reason;
    } else if (record.status !== "navigating") {
      throw new Error(`Cannot retry recipient from ${record.status}.`);
    }
    record.status = "pending";
    record.retryReason = reason;
    record.detail = reason;
    this.currentIndex = null;
  }

  /** Requests a cooperative stop at the next safe pre-click boundary. */
  public requestCancel(): void {
    this.cancelRequested = true;
  }

  /** Reports whether the user requested a cooperative stop. */
  public isCancelRequested(): boolean {
    return this.cancelRequested;
  }

  /** Returns the active recipient status, if a recipient is processing. */
  public currentStatus(): RecipientDeliveryStatus | null {
    return this.currentIndex === null ? null : this.records[this.currentIndex]?.status ?? null;
  }

  /** Returns the active unit index, including the post-click reconciliation state. */
  public currentUnitIndex(): number | null {
    if (this.currentIndex === null) {
      return null;
    }
    return this.records[this.currentIndex]!.units.find((unit) =>
      unit.status === "preparing" || unit.status === "sendClicked",
    )?.index ?? null;
  }

  /** Returns the current pre-Send attempt count for the exact unfinished unit. */
  public currentUnitAttemptCount(peerKey: string): number {
    const record = this.records[this.requireRecordIndex(peerKey)]!;
    const unit = record.units.find((candidate) => candidate.status === "preparing")
      ?? record.units.find((candidate) => candidate.status === "pending");
    if (!unit || unit.attemptCount < 1) {
      throw new Error("Current delivery work has no started unit attempt.");
    }
    return unit.attemptCount;
  }

  /** Records an infrastructure cleanup/restore failure and permanently blocks more work. */
  public markSafetyFailure(detail: string): void {
    if (!this.safetyFailure) {
      this.safetyFailure = detail;
    }
  }

  /** Reports whether this batch has entered a fail-closed terminal safety state. */
  public hasSafetyFailure(): boolean {
    return this.safetyFailure !== null;
  }

  /** Resets only units that are provably retry-safe and never revisits sent units. */
  public resetRetryable(): boolean {
    if (
      this.running ||
      this.safetyFailure ||
      this.records.some((record) => record.status === "unknown")
    ) {
      return false;
    }
    let reset = false;
    for (const record of this.records) {
      for (const unit of record.units) {
        if (unit.status === "failed-before-send") {
          unit.status = "pending";
          unit.detail = undefined;
          reset = true;
        }
      }
      if (record.status === "failed" || record.status === "pending") {
        record.status = "pending";
        record.detail = undefined;
        reset = record.units.some((unit) => unit.status === "pending") || reset;
      }
    }
    return reset;
  }

  /** Creates an immutable progress snapshot without exposing mutable ledger records. */
  public snapshot(): DeliveryBatchSnapshot {
    const recipients = this.records.map((record) => {
      const units = Object.freeze(record.units.map((unit) => Object.freeze({
        index: unit.index,
        status: unit.status,
        attemptCount: unit.attemptCount,
        sendClicked:
          unit.status === "sendClicked" ||
          unit.status === "sent" ||
          unit.status === "unknown-after-send",
        outgoingConfirmed: unit.status === "sent",
        failedBeforeSend: unit.status === "failed-before-send",
        unknownAfterSend: unit.status === "unknown-after-send",
        safeToRetry: unit.status === "pending" || unit.status === "failed-before-send",
        messageIds: Object.freeze([...unit.messageIds]),
        ...(unit.detail ? { detail: unit.detail } : {}),
      })));
      const messageIds = units.flatMap((unit) => unit.messageIds);
      return Object.freeze({
        recipient: record.recipient,
        status: this.deriveRecipientStatus(record),
        sendClicked: units.some((unit) =>
          unit.status === "sendClicked" || unit.status === "sent" || unit.status === "unknown-after-send",
        ),
        attemptCount: record.attemptCount,
        units,
        ...(record.retryReason ? { retryReason: record.retryReason } : {}),
        ...(record.detail ? { detail: record.detail } : {}),
        ...(messageIds[0] ? { messageId: messageIds[0] } : {}),
      });
    });
    const retryableCount = this.safetyFailure
      ? 0
      : this.records.filter((record) =>
        this.deriveRecipientStatus(record) !== "sent" &&
        this.deriveRecipientStatus(record) !== "unknown" &&
        record.units.some((unit) => unit.status === "pending" || unit.status === "failed-before-send"),
      ).length;
    const sentCount = recipients.filter((record) => record.status === "sent").length;
    const failedCount = recipients.filter((record) => record.status === "failed").length;
    const unknownCount = recipients.filter((record) => record.status === "unknown").length;

    return Object.freeze({
      recipients: Object.freeze(recipients),
      currentIndex: this.currentIndex,
      currentRecipient: this.currentIndex === null ? null : this.records[this.currentIndex]?.recipient ?? null,
      sentCount,
      failedCount,
      unknownCount,
      cancelRequested: this.cancelRequested,
      running: this.running,
      retryableCount,
      ...(this.safetyFailure ? { safetyFailure: this.safetyFailure } : {}),
    });
  }

  private deriveRecipientStatus(record: MutableRecipientDelivery): RecipientDeliveryStatus {
    if (record.units.some((unit) => unit.status === "unknown-after-send")) return "unknown";
    if (record.units.every((unit) => unit.status === "sent")) return "sent";
    if (record.units.some((unit) => unit.status === "failed-before-send")) return "failed";
    if (record.units.some((unit) => unit.status === "sendClicked")) return "sending";
    if (record.units.some((unit) => unit.status === "preparing")) return "preparing";
    return record.status;
  }

  private requireRecordIndex(peerKey: string): number {
    const index = this.records.findIndex((record) => record.recipient.peerKey === peerKey);
    if (index < 0) {
      throw new Error("Recipient is not part of this delivery batch.");
    }
    return index;
  }

  private requireUnit(record: MutableRecipientDelivery, unitIndex: number): MutableUnitDelivery {
    const unit = record.units[unitIndex];
    if (!unit) {
      throw new Error("Transfer unit is not part of this recipient ledger.");
    }
    return unit;
  }

  private requireActiveUnit(peerKey: string): MutableUnitDelivery {
    const record = this.records[this.requireRecordIndex(peerKey)]!;
    const unit = record.units.find((candidate) =>
      candidate.status === "preparing" || candidate.status === "sendClicked",
    );
    if (!unit) {
      throw new Error("Recipient has no active transfer unit.");
    }
    return unit;
  }

  private requireRecipientStatus(index: number, expected: RecipientDeliveryStatus): void {
    const actual = this.records[index]?.status;
    if (actual !== expected) {
      throw new Error(`Expected ${expected}, received ${actual ?? "missing"}.`);
    }
  }

  private requireUnitStatus(unit: MutableUnitDelivery, expected: UnitDeliveryStatus): void {
    if (unit.status !== expected) {
      throw new Error(`Expected unit ${expected}, received ${unit.status}.`);
    }
  }
}
