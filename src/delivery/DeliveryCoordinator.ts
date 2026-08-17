/** Coordinates fail-closed recipient and per-unit delivery while Telegram mechanics stay in adapters. */
import { appConfig, type AppConfig } from "../config";
import type { MessagePayload } from "../domain/MessagePayload";
import type { PendingTransfer } from "../domain/PendingTransfer";
import type { TransferUnit } from "../domain/TransferUnit";
import type { Recipient } from "../recipient/Recipient";
import { snapshotRecipient } from "../recipient/Recipient";
import type { ComposerAdapter } from "../telegram/ComposerAdapter";
import type { TelegramChatNavigator } from "../telegram/TelegramChatNavigator";
import {
  findActiveComposerContext,
  hasIndependentActivePeerProof,
} from "../telegram/TelegramComposerDom";
import type { TelegramSendAdapter } from "../telegram/TelegramSendAdapter";
import type { DeliveryProgressPanel } from "../ui/DeliveryProgressPanel";
import type { Logger } from "../utils/logger";
import { DeliveryBatch, type DeliveryBatchSnapshot } from "./DeliveryBatch";
import { getPreSendRetryDelay } from "./DeliveryRetryPolicy";

interface DeliveryContext {
  readonly sourcePayload: MessagePayload;
  readonly batch: DeliveryBatch;
  readonly sourceRecipient: Readonly<Recipient>;
  leftSourceChat: boolean;
  controller: AbortController;
  running: Promise<DeliveryBatchSnapshot> | null;
}

/** Replays one immutable ordered bundle sequentially for each recipient. */
export class DeliveryCoordinator {
  private context: DeliveryContext | null = null;

  public constructor(
    private readonly navigator: TelegramChatNavigator,
    private readonly composer: ComposerAdapter,
    private readonly sender: TelegramSendAdapter,
    private readonly pending: PendingTransfer,
    private readonly progress: DeliveryProgressPanel,
    private readonly log: Logger,
    private readonly config: AppConfig = appConfig,
  ) {}

  /** Snapshots selected recipients and starts one automatic delivery batch. */
  public start(
    recipients: readonly Readonly<Recipient>[],
    sourceRecipient: Readonly<Recipient>,
  ): Promise<DeliveryBatchSnapshot> | null {
    if (this.context || recipients.length === 0) {
      return null;
    }
    const pendingPayload = this.pending.peek();
    if (!pendingPayload || pendingPayload.source.peerKey !== sourceRecipient.peerKey) {
      this.log.error("Delivery source identity does not match the immutable captured bundle.");
      return null;
    }
    const sourcePayload = this.pending.beginInsertion();
    if (!sourcePayload) {
      return null;
    }

    const context: DeliveryContext = {
      sourcePayload,
      batch: new DeliveryBatch(recipients, sourcePayload.units.length),
      sourceRecipient: snapshotRecipient(sourceRecipient),
      leftSourceChat: false,
      controller: new AbortController(),
      running: null,
    };
    this.context = context;
    this.progress.show(context.batch.snapshot(), {
      onCancel: () => this.requestCancel(),
      onRetry: () => { void this.retryFailed(); },
      onClose: () => this.closeSummary(),
    });
    context.running = this.run(context);
    return context.running;
  }

  /** Resumes only pending or definitely pre-click failed units from the same immutable bundle. */
  public retryFailed(): Promise<DeliveryBatchSnapshot> | null {
    const context = this.context;
    if (!context || context.running || !context.batch.resetRetryable()) {
      return null;
    }
    const payload = this.pending.beginInsertion();
    if (!payload || payload !== context.sourcePayload) {
      return null;
    }

    context.controller = new AbortController();
    context.running = this.run(context);
    return context.running;
  }

  /** Requests cancellation at the next safe boundary without interrupting post-click reconciliation. */
  public requestCancel(): void {
    const context = this.context;
    if (!context || !context.running) {
      return;
    }
    context.batch.requestCancel();
    if (context.batch.currentStatus() === "navigating") {
      context.controller.abort();
      this.navigator.cancel();
    }
    this.progress.update(context.batch.snapshot());
  }

  /** Rechecks navigation and outgoing confirmation through the shared MutationObserver. */
  public notifyDomChanged(): void {
    this.navigator.notifyDomChanged();
    this.sender.notifyDomChanged();
  }

  /** Hides a completed summary and releases any retryable payload retained in memory. */
  public closeSummary(): void {
    const context = this.context;
    if (!context || context.running) {
      return;
    }
    this.pending.clear();
    this.progress.hide();
    this.context = null;
  }

  /** Stops pre-click work when the userscript is disposed without interrupting clicked Send. */
  public stop(): void {
    this.requestCancel();
    if (!this.context?.running) {
      this.closeSummary();
    }
  }

  /** Reports whether a running batch or its result summary still owns delivery state. */
  public hasOpenBatch(): boolean {
    return this.context !== null;
  }

  private async run(context: DeliveryContext): Promise<DeliveryBatchSnapshot> {
    context.batch.beginRun();
    this.progress.update(context.batch.snapshot());
    await Promise.resolve();

    try {
      while (
        this.context === context &&
        !context.batch.isCancelRequested() &&
        !context.batch.hasSafetyFailure()
      ) {
        const recipient = context.batch.nextPending();
        if (!recipient || !(await this.deliverRecipient(context, recipient))) {
          break;
        }
      }
    } catch (error) {
      await this.handleUnexpectedError(context, error);
    } finally {
      try {
        await this.restoreSourceChat(context);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Unknown source restoration error.";
        this.recordSafetyFailure(
          context,
          `Source chat restoration failed unexpectedly: ${reason}`,
          error,
        );
      } finally {
        context.batch.finishRun();
        context.running = null;
        this.finalizePendingState(context);
        const snapshot = context.batch.snapshot();
        this.progress.update(snapshot);
        if (this.shouldAutoCloseSummary(snapshot)) {
          this.closeSummary();
        }
      }
    }
    return context.batch.snapshot();
  }

  private async deliverRecipient(
    context: DeliveryContext,
    recipient: Readonly<Recipient>,
  ): Promise<boolean> {
    const peerKey = recipient.peerKey;
    if (peerKey !== context.sourceRecipient.peerKey) {
      context.leftSourceChat = true;
    }
    context.batch.beginNavigation(peerKey);
    this.progress.update(context.batch.snapshot());
    const navigation = await this.navigator.navigate(
      recipient,
      context.controller.signal,
      "destination",
    );
    if (context.batch.isCancelRequested()) {
      context.batch.returnCurrentToPending();
      return false;
    }
    if (!navigation.success) {
      return this.retryPreSend(context, recipient, "navigation", navigation.message);
    }

    const draft = this.composer.beginDraftTransaction(peerKey);
    if (!draft.success) {
      return this.retryPreSend(context, recipient, "draft", draft.message);
    }

    let preSendFailure: { readonly reason: string; readonly message: string } | null = null;
    let shouldContinue = true;
    let draftRestoreSafe = true;
    try {
      while (true) {
        if (context.batch.isCancelRequested()) {
          context.batch.returnCurrentToPending();
          shouldContinue = false;
          break;
        }
        const unitIndex = context.batch.nextPendingUnitIndex(peerKey);
        if (unitIndex === null) {
          break;
        }
        const unit = context.sourcePayload.units[unitIndex];
        if (!unit) {
          throw new Error("Immutable bundle and delivery ledger lost unit correspondence.");
        }
        const result = await this.deliverUnit(context, recipient, unit, unitIndex);
        if (result.kind === "sent") {
          continue;
        }
        if (result.kind === "unknown") {
          shouldContinue = false;
          break;
        }
        if (result.kind === "cancelled") {
          shouldContinue = false;
          break;
        }
        if (result.kind === "safety") {
          shouldContinue = false;
          break;
        }
        preSendFailure = result;
        break;
      }
    } catch (error) {
      await this.handleUnexpectedError(context, error);
      shouldContinue = false;
    } finally {
      draftRestoreSafe = await this.restoreRecipientDraft(
        context,
        peerKey,
        () => draft.transaction.restore(),
      );
    }

    if (!draftRestoreSafe || context.batch.hasSafetyFailure()) {
      return false;
    }
    if (preSendFailure) {
      return this.retryPreSend(context, recipient, preSendFailure.reason, preSendFailure.message);
    }
    return shouldContinue && !context.batch.isCancelRequested();
  }

  private async deliverUnit(
    context: DeliveryContext,
    recipient: Readonly<Recipient>,
    unit: TransferUnit,
    unitIndex: number,
  ): Promise<
    | { readonly kind: "sent" }
    | { readonly kind: "unknown" }
    | { readonly kind: "cancelled" }
    | { readonly kind: "safety" }
    | { readonly kind: "failed"; readonly reason: string; readonly message: string }
  > {
    const peerKey = recipient.peerKey;
    context.batch.beginUnitPreparation(peerKey, unitIndex);
    this.progress.update(context.batch.snapshot());
    const prepared = await this.composer.prepareUnit(unit, peerKey);
    if (context.batch.isCancelRequested()) {
      const cleanupSafe = await this.cancelPreparedUnitSafely(
        context,
        unit,
        peerKey,
        "cancellation",
      );
      if (!cleanupSafe) {
        return { kind: "safety" };
      }
      context.batch.returnCurrentToPending();
      return { kind: "cancelled" };
    }
    if (!prepared.success) {
      const cleanupSafe = await this.cancelPreparedUnitSafely(
        context,
        unit,
        peerKey,
        "preparation failure",
        prepared.message,
      );
      if (!cleanupSafe) {
        return { kind: "safety" };
      }
      return { kind: "failed", reason: "preparation", message: prepared.message };
    }

    const sendResult = await this.sender.sendPreparedUnit(
      unit,
      peerKey,
      context.controller.signal,
      () => {
        context.batch.markUnitSendClicked(peerKey, unitIndex);
        this.progress.update(context.batch.snapshot());
      },
    );
    if (sendResult.status === "failed") {
      const cleanupSafe = await this.cancelPreparedUnitSafely(
        context,
        unit,
        peerKey,
        "Send-control failure",
        sendResult.message,
      );
      if (!cleanupSafe) {
        return { kind: "safety" };
      }
      return { kind: "failed", reason: "send-control", message: sendResult.message };
    }
    if (sendResult.status === "unknown") {
      context.batch.markUnitUnknown(peerKey, unitIndex, sendResult.message);
      this.log.error("Post-Send result is ambiguous; remaining units and recipients are stopped.");
      return { kind: "unknown" };
    }

    const messageIds = sendResult.messageIds ?? [sendResult.messageId];
    const expectedMessageCount = unit.delivery.outgoing.expectedCount;
    if (
      messageIds.length !== expectedMessageCount ||
      new Set(messageIds).size !== expectedMessageCount
    ) {
      const detail = `Outgoing receipt expected ${expectedMessageCount} unique message identities, received ${messageIds.length}.`;
      context.batch.markUnitUnknown(peerKey, unitIndex, detail);
      this.log.error("Post-Send receipt is incomplete or ambiguous; delivery stopped.", {
        peerKey,
        unitIndex,
        expectedMessageCount,
        messageIds,
      });
      return { kind: "unknown" };
    }
    context.batch.markUnitSent(peerKey, unitIndex, messageIds);
    this.log.info("Transfer unit confirmed by new outgoing Telegram identities.", {
      peerKey,
      unitIndex,
      messageIds,
    });
    this.progress.update(context.batch.snapshot());
    return { kind: "sent" };
  }

  private async retryPreSend(
    context: DeliveryContext,
    recipient: Readonly<Recipient>,
    reason: string,
    message: string,
  ): Promise<boolean> {
    if (context.batch.hasSafetyFailure()) {
      return false;
    }
    const attempt = context.batch.currentUnitAttemptCount(recipient.peerKey);
    const delayMs = getPreSendRetryDelay(attempt);
    if (delayMs === null || context.batch.isCancelRequested()) {
      context.batch.markFailed(recipient.peerKey, message);
      this.log.warn("Delivery exhausted safe pre-Send attempts.", {
        peerKey: recipient.peerKey,
        attempt,
        reason,
      });
      return !context.batch.isCancelRequested();
    }

    context.batch.scheduleRetry(recipient.peerKey, message);
    this.progress.update(context.batch.snapshot());
    this.log.debug("Delivery автоматически повторит только retry-safe работу до Send.", {
      peerKey: recipient.peerKey,
      attempt,
      nextAttempt: attempt + 1,
      reason,
      retryReason: message,
      delayMs,
    });
    await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));
    return context.batch.isCancelRequested() || context.batch.hasSafetyFailure()
      ? false
      : this.deliverRecipient(context, recipient);
  }

  private async handleUnexpectedError(context: DeliveryContext, error: unknown): Promise<void> {
    const snapshot = context.batch.snapshot();
    const current = snapshot.currentRecipient;
    const status = context.batch.currentStatus();
    const unitIndex = context.batch.currentUnitIndex();
    const detail = error instanceof Error ? error.message : "Unknown delivery pipeline error.";
    if (current && status === "sending" && unitIndex !== null) {
      context.batch.markUnitUnknown(current.peerKey, unitIndex, detail);
    } else if (current && (status === "navigating" || status === "preparing")) {
      if (status === "preparing" && unitIndex !== null) {
        const unit = context.sourcePayload.units[unitIndex];
        if (unit) {
          const cleanupSafe = await this.cancelPreparedUnitSafely(
            context,
            unit,
            current.peerKey,
            "unexpected pre-Send exception",
          );
          if (!cleanupSafe) {
            this.log.error("Unhandled delivery pipeline error.", error);
            return;
          }
        }
      } else if (status === "preparing") {
        const pendingUnitIndex = context.batch.nextPendingUnitIndex(current.peerKey);
        if (pendingUnitIndex !== null) {
          // A confirmed prior unit leaves the recipient between items; materialize the next
          // pre-Send state so an infrastructure exception remains explicitly retry-safe.
          context.batch.beginUnitPreparation(current.peerKey, pendingUnitIndex);
        }
      }
      context.batch.markFailed(current.peerKey, detail);
    }
    this.log.error("Unhandled delivery pipeline error.", error);
  }

  private finalizePendingState(context: DeliveryContext): void {
    const snapshot = context.batch.snapshot();
    if (snapshot.unknownCount > 0) {
      this.pending.clear();
    } else if (snapshot.retryableCount > 0) {
      this.pending.restoreAfterFailure();
    } else {
      this.pending.completeInsertion();
    }
  }

  private async restoreSourceChat(context: DeliveryContext): Promise<void> {
    const activeComposer = findActiveComposerContext();
    const activePeer = activeComposer?.peerId ?? null;
    if (
      activeComposer &&
      activePeer === context.sourceRecipient.peerKey &&
      hasIndependentActivePeerProof(activeComposer, context.sourceRecipient.peerKey)
    ) {
      context.leftSourceChat = false;
      this.log.info("Source chat restoration skipped after exact active-peer proof.", {
        peerKey: context.sourceRecipient.peerKey,
        intent: "source-restore",
      });
      return;
    }
    this.log.info("Source chat restoration started.", {
      peerKey: context.sourceRecipient.peerKey,
      intent: "source-restore",
      activePeer,
      leftSourceChat: context.leftSourceChat,
    });
    try {
      const result = await this.navigator.navigate(
        context.sourceRecipient,
        new AbortController().signal,
        "source-restore",
      );
      if (!result.success) {
        const detail = `Source chat restoration could not be confirmed: ${result.message}`;
        this.recordSafetyFailure(context, detail);
        this.log.warn("Source chat restoration failed exact peer proof.", {
          peerKey: context.sourceRecipient.peerKey,
          intent: "source-restore",
        });
        this.log.error("Failed to restore the source chat after delivery batch.", result.message);
        return;
      }
      context.leftSourceChat = false;
      this.log.info("Source chat restoration proved exact peer and composer.", {
        peerKey: context.sourceRecipient.peerKey,
        intent: "source-restore",
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown navigation error.";
      const detail = `Source chat restoration threw before confirmation: ${reason}`;
      this.recordSafetyFailure(context, detail, error);
      this.log.warn("Source chat restoration threw before exact peer proof.", {
        peerKey: context.sourceRecipient.peerKey,
        intent: "source-restore",
      });
      this.log.error("Source-chat restoration threw after delivery batch.", error);
    }
  }

  private shouldAutoCloseSummary(snapshot: DeliveryBatchSnapshot): boolean {
    return (
      !this.config.debug.showDeliveryResultDialog &&
      !snapshot.running &&
      !snapshot.cancelRequested &&
      snapshot.sentCount === snapshot.recipients.length &&
      snapshot.failedCount === 0 &&
      snapshot.unknownCount === 0 &&
      snapshot.retryableCount === 0 &&
      !snapshot.safetyFailure
    );
  }

  /**
   * @param cause What already failed before cleanup started. It is preserved because that is the
   * question a user needs answered; reporting only the cleanup outcome discarded the real reason
   * and left the panel showing a safety stop with no cause at all.
   */
  private async cancelPreparedUnitSafely(
    context: DeliveryContext,
    unit: TransferUnit,
    peerKey: string,
    phase: string,
    cause?: string,
  ): Promise<boolean> {
    const describe = (summary: string): string =>
      [cause, summary, this.composer.describePreviewObstacle?.() ?? null]
        .filter(Boolean)
        .join(" ");

    try {
      if (await this.composer.cancelPreparedUnit(unit, peerKey)) {
        return true;
      }
      const detail = describe(`Prepared content cleanup could not be confirmed after ${phase}.`);
      this.recordSafetyFailure(context, detail);
      this.markCurrentPreSendFailure(context, peerKey, detail);
      return false;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown cleanup error.";
      const detail = describe(`Prepared content cleanup threw after ${phase}: ${reason}`);
      this.recordSafetyFailure(context, detail, error);
      this.markCurrentPreSendFailure(context, peerKey, detail);
      return false;
    }
  }

  private async restoreRecipientDraft(
    context: DeliveryContext,
    peerKey: string,
    restore: () => Promise<{ readonly success: boolean; readonly message: string }>,
  ): Promise<boolean> {
    try {
      const result = await restore();
      if (result.success) {
        return true;
      }
      const detail = `Recipient draft restoration could not be confirmed: ${result.message}`;
      this.recordSafetyFailure(context, detail);
      this.markCurrentPreSendFailure(context, peerKey, detail);
      this.log.error("Failed to restore the recipient draft.", result.message);
      return false;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown draft restore error.";
      const detail = `Recipient draft restoration threw: ${reason}`;
      this.recordSafetyFailure(context, detail, error);
      this.markCurrentPreSendFailure(context, peerKey, detail);
      this.log.error("Recipient draft restoration threw.", error);
      return false;
    }
  }

  private markCurrentPreSendFailure(
    context: DeliveryContext,
    peerKey: string,
    detail: string,
  ): void {
    const current = context.batch.snapshot().currentRecipient;
    const status = context.batch.currentStatus();
    if (
      current?.peerKey === peerKey &&
      (status === "navigating" || status === "preparing")
    ) {
      context.batch.markFailed(peerKey, detail);
    }
  }

  private recordSafetyFailure(
    context: DeliveryContext,
    detail: string,
    cause?: unknown,
  ): void {
    context.batch.markSafetyFailure(detail);
    this.log.error("Delivery stopped because safe cleanup or restoration was not confirmed.", cause ?? detail);
  }
}
