/** Coordinates context-menu integration, extraction, and the recipient flow entrypoint. */
import type { PendingTransfer } from "../domain/PendingTransfer";
import type { RecipientPickerController } from "../recipient/RecipientPickerController";
import type { ContextMenuIntegration } from "../telegram/TelegramContextMenuIntegration";
import type { MessageExtractor } from "../telegram/MessageExtractor";
import type { TelegramDomAdapter } from "../telegram/TelegramDomAdapter";
import type {
  TelegramSelectionContext,
  TelegramSelectionDomAdapter,
} from "../telegram/TelegramSelectionDomAdapter";
import type { TelegramSelectionIntegration } from "../telegram/TelegramSelectionIntegration";
import type { TelegramSourceSnapshot } from "../telegram/TelegramSourceSnapshot";
import type { Logger } from "../utils/logger";
import { observeDom, type DomObservation } from "../utils/observeDom";

/** Application coordinator with one MutationObserver for all dynamic Telegram rendering. */
export class CleanForwardController {
  private observation: DomObservation | null = null;
  private reconciliationQueued = false;
  private captureSession: {
    readonly controller: AbortController;
    readonly selectionContext: TelegramSelectionContext | null;
  } | null = null;

  public constructor(
    private readonly dom: TelegramDomAdapter,
    private readonly extractor: MessageExtractor,
    private readonly pending: PendingTransfer,
    private readonly contextMenu: ContextMenuIntegration,
    private readonly selectionDom: TelegramSelectionDomAdapter,
    private readonly selectionIntegration: TelegramSelectionIntegration,
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
    this.reconcileSelectionToolbar();
    this.log.info("Userscript инициализирован.");
  }

  /** Stops listeners, aborts recipient work, and clears private pending data. */
  public stop(): void {
    this.observation?.disconnect();
    this.observation = null;
    this.dom.stopTrackingContextTargets();
    this.captureSession?.controller.abort();
    this.captureSession = null;
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
    const selectionContext = this.captureSession?.selectionContext;
    if (selectionContext && !this.selectionDom.isContextActive(selectionContext)) {
      // Exiting Telegram selection invalidates the capture intent even though detached snapshots
      // themselves remain safe; opening the picker after an explicit user cancel would be wrong.
      this.captureSession?.controller.abort();
    }
    this.reconcileContextMenu();
    this.reconcileSelectionToolbar();
    this.recipients.notifyDomChanged();
  }

  /** Reconciles the custom action after Telegram creates or reuses its menu. */
  private reconcileContextMenu(): void {
    const context = this.dom.findOpenMessageContext();
    if (!context) {
      return;
    }

    this.contextMenu.ensureAction(context.menu, () => {
      const snapshot = this.dom.readMessageSnapshot(context.message);
      this.log.info("CleanForwardController получил выбор контекстного пункта.", {
        messageConnected: context.message.isConnected,
        snapshotFound: Boolean(snapshot),
      });
      context.dismiss();
      if (snapshot) {
        void this.captureSnapshots([snapshot], null);
      }
    });
  }

  /** Reconciles the action only for Telegram's verified normal-chat selection toolbar. */
  private reconcileSelectionToolbar(): void {
    const context = this.selectionDom.findActiveContext();
    if (!context) {
      return;
    }
    this.selectionIntegration.ensureAction(context, () => {
      const selected = this.selectionDom.readSelectedSnapshots(context);
      if (selected.kind === "rejected") {
        return;
      }
      void this.captureSnapshots(selected.snapshots, context);
    });
  }

  /** Completes one atomic bundle before dismissing source UI or opening recipient selection. */
  private async captureSnapshots(
    snapshots: readonly TelegramSourceSnapshot[],
    selectionContext: TelegramSelectionContext | null,
  ): Promise<void> {
    if (this.captureSession) {
      this.log.warn("Повторный source capture отклонён: предыдущий snapshot ещё формируется.");
      return;
    }
    const session = {
      controller: new AbortController(),
      selectionContext,
    };
    this.captureSession = session;
    this.log.info("CleanForwardController запускает atomic source capture.", {
      messageCount: snapshots.length,
      mode: selectionContext ? "native-selection" : "context-menu",
    });
    try {
      const result = await this.extractor.captureSnapshots(snapshots, session.controller.signal);
      if (session.controller.signal.aborted || this.captureSession !== session) {
        return;
      }
      if (result.kind !== "captured") {
        this.log.warn("Source capture остановлен до recipient picker.", result.reason);
        return;
      }

      if (!this.pending.select(result.payload)) {
        this.log.warn("Новая операция отклонена: предыдущая вставка ещё выполняется.");
        return;
      }
      // Ownership moves to PendingTransfer before Telegram selection is dismissed. Clearing the
      // session first prevents the resulting DOM transition from aborting an accepted bundle.
      this.captureSession = null;
      if (selectionContext && !this.selectionDom.dismiss(selectionContext)) {
        this.pending.clear();
        this.log.warn("Native selection не закрыт; recipient picker не будет открыт.");
        return;
      }
      this.log.info("Immutable source bundle временно сохранён в памяти.");
      await this.recipients.open();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        this.log.info("Source capture отменён до создания bundle.");
        return;
      }
      this.log.error("Необработанная ошибка извлечения payload.", error);
    } finally {
      if (this.captureSession === session) {
        this.captureSession = null;
      }
    }
  }
}
