/** Coordinates fail-closed sequential delivery while keeping Telegram mechanics in adapters. */
import type { MessagePayload } from "../domain/MessagePayload";
import type { PendingTransfer } from "../domain/PendingTransfer";
import type { Recipient } from "../recipient/Recipient";
import type { ComposerAdapter } from "../telegram/ComposerAdapter";
import type { TelegramChatNavigator } from "../telegram/TelegramChatNavigator";
import type { TelegramSendAdapter, TelegramSendResult } from "../telegram/TelegramSendAdapter";
import type { DeliveryProgressPanel } from "../ui/DeliveryProgressPanel";
import type { Logger } from "../utils/logger";
import { DeliveryBatch, type DeliveryBatchSnapshot } from "./DeliveryBatch";

interface DeliveryContext {
  readonly payload: MessagePayload;
  readonly batch: DeliveryBatch;
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
  ) {}

  /** Snapshots selected recipients and starts one automatic delivery batch. */
  public start(
    recipients: readonly Readonly<Recipient>[],
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
      context.batch.finishRun();
      context.running = null;
      this.finalizePendingState(context);
      this.progress.update(context.batch.snapshot());
    }

    return context.batch.snapshot();
  }

  private async deliverRecipient(
    context: DeliveryContext,
    recipient: Readonly<Recipient>,
  ): Promise<boolean> {
    const peerKey = recipient.peerKey;
    context.batch.beginNavigation(peerKey);
    this.progress.update(context.batch.snapshot());
    const navigation = await this.navigator.navigate(recipient, context.controller.signal);

    if (context.batch.isCancelRequested()) {
      context.batch.returnCurrentToPending();
      return false;
    }
    if (!navigation.success) {
      context.batch.markFailed(peerKey, navigation.message);
      this.log.warn("Delivery остановлен до Send: навигация или composer не прошли проверку.");
      return false;
    }

    const draft = this.composer.beginDraftTransaction(peerKey);
    if (!draft.success) {
      context.batch.markFailed(peerKey, draft.message);
      this.log.warn("Delivery остановлен до Send: draft transaction не запущена.");
      return false;
    }

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
        context.batch.markFailed(peerKey, prepared.message);
        this.log.warn("Delivery остановлен до Send: payload не был подготовлен.");
        return false;
      }

      const result = await this.sender.sendPrepared(
        context.payload,
        peerKey,
        context.controller.signal,
        () => {
          context.batch.markSendClicked(peerKey);
          this.progress.update(context.batch.snapshot());
        },
      );
      return this.applySendResult(context, recipient, result);
    } catch (error) {
      await this.handleUnexpectedError(context, error);
      return false;
    } finally {
      const restored = await draft.transaction.restore();
      if (!restored.success) {
        this.log.error("Не удалось восстановить пользовательский draft.", restored.message);
      }
    }
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
    context.batch.markFailed(recipient.peerKey, result.message);
    this.log.warn("Delivery остановлен до Send: нативный Send недоступен или состояние изменилось.");
    return false;
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
}
