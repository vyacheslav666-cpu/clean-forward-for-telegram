/** Coordinates fail-closed sequential delivery while keeping Telegram mechanics in adapters. */
import type { MessagePayload } from "../domain/MessagePayload";
import { appConfig, type AppConfig } from "../config";
import type { PendingTransfer } from "../domain/PendingTransfer";
import type { Recipient } from "../recipient/Recipient";
import type { ComposerAdapter } from "../telegram/ComposerAdapter";
import type { TelegramChatNavigator } from "../telegram/TelegramChatNavigator";
import type { TelegramSendAdapter, TelegramSendResult } from "../telegram/TelegramSendAdapter";
import type { DeliveryProgressPanel } from "../ui/DeliveryProgressPanel";
import type { Logger } from "../utils/logger";
import { DeliveryBatch, type DeliveryBatchSnapshot } from "./DeliveryBatch";
import { getPreSendRetryDelay } from "./DeliveryRetryPolicy";

interface DeliveryContext {
  readonly payload: MessagePayload;
  readonly batch: DeliveryBatch;
  readonly sourceRecipient: Readonly<Recipient>;
  leftSourceChat: boolean;
  controller: AbortController;
  running: Promise<DeliveryBatchSnapshot> | null;
}

/** Runs one recipient at a time and stops before any result could become ambiguous. */
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
    const payload = this.pending.beginInsertion();
    if (!payload) {
      return null;
    }

    const context: DeliveryContext = {
      payload,
      batch: new DeliveryBatch(recipients),
      sourceRecipient,
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

  /** Retries only pending or definitely pre-Send failed recipients from the same snapshot. */
  public retryFailed(): Promise<DeliveryBatchSnapshot> | null {
    const context = this.context;
    if (!context || context.running || !context.batch.resetRetryable()) {
      return null;
    }
    const payload = this.pending.beginInsertion();
    if (!payload || payload !== context.payload) {
      return null;
    }

    context.controller = new AbortController();
    context.running = this.run(context);
    return context.running;
  }

  /** Requests cancellation at the next boundary before a native Send click. */
  public requestCancel(): void {
    const context = this.context;
    if (!context || !context.running) {
      return;
    }
    context.batch.requestCancel();
    const status = context.batch.currentStatus();
    if (status === "navigating") {
      context.controller.abort();
      this.navigator.cancel();
    }
    // A sending state has crossed the irreversible boundary, so its confirmation remains alive.
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

  /** Stops pre-Send work when the userscript is disposed without interrupting clicked Send. */
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
    // Give the public cancellation API one deterministic pre-navigation boundary without
    // relying on elapsed time or allowing any Telegram side effect first.
    await Promise.resolve();

    try {
      while (this.context === context) {
        if (context.batch.isCancelRequested()) {
          break;
        }
        const recipient = context.batch.nextPending();
        if (!recipient) {
          break;
        }

        const shouldContinue = await this.deliverRecipient(context, recipient);
        if (!shouldContinue) {
          break;
        }
      }
    } catch (error) {
      await this.handleUnexpectedError(context, error);
    } finally {
      await this.restoreSourceChat(context);
      context.batch.finishRun();
      context.running = null;
      this.finalizePendingState(context);
      const snapshot = context.batch.snapshot();
      this.progress.update(snapshot);
      if (this.shouldAutoCloseSummary(snapshot)) {
        this.closeSummary();
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
    const navigation = await this.navigator.navigate(recipient, context.controller.signal);

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

    let sendResult: TelegramSendResult | null = null;
    let preSendFailure: { readonly reason: string; readonly message: string } | null = null;
    try {
      context.batch.beginPreparation(peerKey);
      this.progress.update(context.batch.snapshot());
      const prepared = await this.composer.insert(context.payload, peerKey);
      if (context.batch.isCancelRequested()) {
        await this.composer.cancelPreparedPayload(context.payload, peerKey);
        context.batch.returnCurrentToPending();
        return false;
      }
      if (!prepared.success) {
        await this.composer.cancelPreparedPayload(context.payload, peerKey);
        preSendFailure = { reason: "preparation", message: prepared.message };
      } else {
        sendResult = await this.sender.sendPrepared(
          context.payload,
          peerKey,
          context.controller.signal,
          () => {
            context.batch.markSendClicked(peerKey);
            this.progress.update(context.batch.snapshot());
          },
        );
        if (sendResult.status === "failed") {
          await this.composer.cancelPreparedPayload(context.payload, peerKey);
          preSendFailure = { reason: "send-control", message: sendResult.message };
          sendResult = null;
        }
      }
    } catch (error) {
      await this.handleUnexpectedError(context, error);
      return false;
    } finally {
      const restored = await draft.transaction.restore();
      if (!restored.success) {
        this.log.error("Не удалось восстановить пользовательский draft.", restored.message);
      }
    }

    if (preSendFailure) {
      return this.retryPreSend(
        context,
        recipient,
        preSendFailure.reason,
        preSendFailure.message,
      );
    }
    return sendResult ? this.applySendResult(context, recipient, sendResult) : false;
  }

  private async applySendResult(
    context: DeliveryContext,
    recipient: Readonly<Recipient>,
    result: TelegramSendResult,
  ): Promise<boolean> {
    if (result.status === "sent") {
      context.batch.markSent(recipient.peerKey, result.messageId);
      this.log.info("Исходящее сообщение подтверждено новым data-mid.");
      this.progress.update(context.batch.snapshot());
      return !context.batch.isCancelRequested();
    }

    if (result.status === "unknown") {
      context.batch.markUnknown(recipient.peerKey, result.message);
      this.log.error("Результат после Send неоднозначен; batch остановлен.");
      return false;
    }

    await this.composer.cancelPreparedPayload(context.payload, recipient.peerKey);
    return this.retryPreSend(context, recipient, "send-control", result.message);
  }

  private async retryPreSend(
    context: DeliveryContext,
    recipient: Readonly<Recipient>,
    reason: string,
    message: string,
  ): Promise<boolean> {
    const record = context.batch.snapshot().recipients.find(
      (candidate) => candidate.recipient.peerKey === recipient.peerKey,
    );
    const attempt = record?.attemptCount ?? 1;
    const delayMs = getPreSendRetryDelay(attempt);
    if (delayMs === null || context.batch.isCancelRequested()) {
      context.batch.markFailed(recipient.peerKey, message);
      this.log.warn("Delivery исчерпал безопасные pre-Send попытки.", {
        peerKey: recipient.peerKey,
        attempt,
        reason,
      });
      return !context.batch.isCancelRequested();
    }

    context.batch.scheduleRetry(recipient.peerKey, message);
    this.progress.update(context.batch.snapshot());
    this.log.debug("Delivery автоматически повторит безопасную pre-Send попытку.", {
      peerKey: recipient.peerKey,
      attempt,
      nextAttempt: attempt + 1,
      reason,
      retryReason: message,
      delayMs,
    });
    await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));
    if (context.batch.isCancelRequested()) {
      return false;
    }
    return this.deliverRecipient(context, recipient);
  }

  private async handleUnexpectedError(context: DeliveryContext, error: unknown): Promise<void> {
    const snapshot = context.batch.snapshot();
    const current = snapshot.currentRecipient;
    const status = context.batch.currentStatus();
    const detail = error instanceof Error ? error.message : "Неизвестная ошибка delivery pipeline.";
    if (current && status === "sending") {
      context.batch.markUnknown(current.peerKey, detail);
    } else if (current && (status === "navigating" || status === "preparing")) {
      if (status === "preparing") {
        await this.composer.cancelPreparedPayload(context.payload, current.peerKey);
      }
      context.batch.markFailed(current.peerKey, detail);
    }
    this.log.error("Необработанная ошибка delivery pipeline.", error);
  }

  private finalizePendingState(context: DeliveryContext): void {
    const snapshot = context.batch.snapshot();
    if (snapshot.unknownCount > 0) {
      // Ambiguous delivery must never expose the same payload as retryable.
      this.pending.clear();
      return;
    }
    if (snapshot.retryableCount > 0) {
      this.pending.restoreAfterFailure();
      return;
    }
    this.pending.completeInsertion();
  }

  private async restoreSourceChat(context: DeliveryContext): Promise<void> {
    if (!context.leftSourceChat) {
      return;
    }
    const result = await this.navigator.navigate(
      context.sourceRecipient,
      new AbortController().signal,
    );
    if (!result.success) {
      this.log.error("Не удалось восстановить исходный чат после delivery batch.", result.message);
      return;
    }
    context.leftSourceChat = false;
  }

  private shouldAutoCloseSummary(snapshot: DeliveryBatchSnapshot): boolean {
    return (
      !this.config.debug.showDeliveryResultDialog &&
      !snapshot.running &&
      !snapshot.cancelRequested &&
      snapshot.sentCount === snapshot.recipients.length &&
      snapshot.failedCount === 0 &&
      snapshot.unknownCount === 0 &&
      snapshot.retryableCount === 0
    );
  }
}
