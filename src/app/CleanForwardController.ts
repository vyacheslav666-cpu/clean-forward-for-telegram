/** Coordinates context-menu integration, extraction, and the recipient flow entrypoint. */
import type { PendingTransfer } from "../domain/PendingTransfer";
import type { RecipientPickerController } from "../recipient/RecipientPickerController";
import type { ContextMenuIntegration } from "../telegram/TelegramContextMenuIntegration";
import type { MessageExtractor } from "../telegram/MessageExtractor";
import type { TelegramDomAdapter } from "../telegram/TelegramDomAdapter";
import type { Logger } from "../utils/logger";
import { observeDom, type DomObservation } from "../utils/observeDom";

/** Application coordinator with one MutationObserver for all dynamic Telegram rendering. */
export class CleanForwardController {
  private observation: DomObservation | null = null;
  private reconciliationQueued = false;

  public constructor(
    private readonly dom: TelegramDomAdapter,
    private readonly extractor: MessageExtractor,
    private readonly pending: PendingTransfer,
    private readonly contextMenu: ContextMenuIntegration,
    private readonly recipients: RecipientPickerController,
    private readonly log: Logger,
  ) {}

  /** Starts DOM tracking and wires the userscript into Telegram's dynamic page. */
  public start(): void {
    if (this.observation) {
      return;
    }

    this.dom.startTrackingContextTargets(() => this.scheduleReconciliation());
    this.observation = observeDom(document.documentElement, () => this.handleDomChanged());
    this.reconcileContextMenu();
    this.log.info("Userscript инициализирован.");
  }

  /** Stops listeners, aborts recipient work, and clears private pending data. */
  public stop(): void {
    this.observation?.disconnect();
    this.observation = null;
    this.dom.stopTrackingContextTargets();
    this.recipients.stop();
    this.pending.clear();
  }

  private scheduleReconciliation(): void {
    if (this.reconciliationQueued) {
      return;
    }

    this.reconciliationQueued = true;
    queueMicrotask(() => {
      this.reconciliationQueued = false;
      this.reconcileContextMenu();
    });
  }

  /** Shares the one MutationObserver between menu reconciliation and recipient navigation. */
  private handleDomChanged(): void {
    this.reconcileContextMenu();
    this.recipients.notifyDomChanged();
  }

  /** Reconciles the custom action after Telegram creates or reuses its menu. */
  private reconcileContextMenu(): void {
    const context = this.dom.findOpenMessageContext();
    if (!context) {
      return;
    }

    this.contextMenu.ensureAction(context.menu, () => {
      this.log.info("CleanForwardController получил выбор контекстного пункта.", {
        messageConnected: context.message.isConnected,
      });
      context.dismiss();
      void this.captureMessage(context.message);
    });
  }

  /** Extracts one supported payload before exposing any recipient choice. */
  private async captureMessage(message: HTMLElement): Promise<void> {
    this.log.info("CleanForwardController запускает извлечение payload.", {
      messageConnected: message.isConnected,
    });
    try {
      const payload = await this.extractor.extract(message);
      if (!payload) {
        this.log.warn("Сообщение не выбрано: DOM не распознан или формат не поддерживается.");
        return;
      }

      if (!this.pending.select(payload)) {
        this.log.warn("Новая операция отклонена: предыдущая вставка ещё выполняется.");
        return;
      }
      this.log.info("Сообщение временно сохранено в памяти.");
      await this.recipients.open();
    } catch (error) {
      this.log.error("Необработанная ошибка извлечения payload.", error);
    }
  }
}
