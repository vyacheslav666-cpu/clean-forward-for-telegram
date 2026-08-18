/** Coordinates context-menu integration, extraction, and the recipient flow entrypoint. */
import type { PendingTransfer } from "../domain/PendingTransfer";
import type { RecipientPickerController } from "../recipient/RecipientPickerController";
import {
  SELECTION_ACTION_LABEL,
  type ContextMenuIntegration,
} from "../telegram/TelegramContextMenuIntegration";
import type { MessageExtractor } from "../telegram/MessageExtractor";
import type { TelegramDomAdapter } from "../telegram/TelegramDomAdapter";
import type {
  TelegramSelectionContext,
  TelegramSelectionDomAdapter,
} from "../telegram/TelegramSelectionDomAdapter";
import type { TelegramSelectionIntegration } from "../telegram/TelegramSelectionIntegration";
import type {
  TelegramSourceSnapshot,
  TelegramSourceTargetSnapshot,
} from "../telegram/TelegramSourceSnapshot";
import type { CaptureNotice } from "../ui/CaptureNotice";
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
    private readonly notice: CaptureNotice,
  ) {}

  /** Starts DOM tracking and wires the userscript into Telegram's dynamic page. */
  public start(): void {
    if (this.observation) {
      return;
    }

    this.dom.startTrackingContextTargets(() => this.scheduleReconciliation());
    this.observation = observeDom(document.documentElement, () => this.handleDomChanged());
    this.reconcileActions();
    this.log.info("Userscript инициализирован.");
  }

  /** Stops listeners, aborts recipient work, and clears private pending data. */
  public stop(): void {
    this.observation?.disconnect();
    this.observation = null;
    this.dom.stopTrackingContextTargets();
    this.captureSession?.controller.abort();
    this.captureSession = null;
    this.notice.hide();
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
      this.reconcileActions();
    });
  }

  /** Shares the one MutationObserver between menu reconciliation and recipient navigation. */
  private handleDomChanged(): void {
    const captured = this.captureSession?.selectionContext;
    if (captured && !this.selectionDom.isContextActive(captured)) {
      // Exiting Telegram selection invalidates the capture intent even though detached snapshots
      // themselves remain safe; opening the picker after an explicit user cancel would be wrong.
      this.captureSession?.controller.abort();
    }
    this.reconcileActions();
    this.recipients.notifyDomChanged();
  }

  /**
   * Resolves the native selection state once and reconciles every surface against it.
   *
   * Both entry surfaces must agree on the same selection context: reading it twice per batch would
   * double this method's cost on the hot observer path and could pair a menu with a toolbar from
   * two different Telegram states.
   */
  private reconcileActions(): void {
    const selection = this.selectionDom.findActiveContext();
    if (selection) {
      this.selectionIntegration.ensureAction(selection, () =>
        this.beginSelectionCapture(selection));
    }
    this.reconcileContextMenu(selection);
  }

  /** Reconciles the custom action after Telegram creates or reuses its menu. */
  private reconcileContextMenu(selection: TelegramSelectionContext | null): void {
    const context = this.dom.findOpenMessageContext();
    if (!context) {
      return;
    }

    // While selection mode owns the bubbles, Telegram's menu acts on the selected set rather than
    // the long-pressed bubble. Following that meaning keeps one message from being sent when the
    // visible menu promises the whole selection.
    if (selection) {
      this.contextMenu.ensureAction(
        context.menu,
        () => {
          const selected = this.selectionDom.readSelectedSnapshots(selection);
          context.dismiss();
          if (selected.kind === "captured") {
            void this.captureSnapshots(selected.snapshots, selection.sourceTarget, selection);
          }
        },
        { label: SELECTION_ACTION_LABEL },
      );
      return;
    }

    this.contextMenu.ensureAction(context.menu, () => {
      // Both values are copied synchronously while the context menu is still bound to its active
      // source chat. Media capture may await later without rereading a different Telegram peer.
      const sourceTarget = context.sourceTarget;
      const snapshot = this.dom.readMessageSnapshot(context.message, sourceTarget.peerKey);
      this.log.info("CleanForwardController получил выбор контекстного пункта.", {
        messageConnected: context.message.isConnected,
        snapshotFound: Boolean(snapshot),
      });
      context.dismiss();
      if (snapshot) {
        void this.captureSnapshots([snapshot], sourceTarget, null);
      }
    });
  }

  /** Starts one bundle from Telegram's verified native multi-selection. */
  private beginSelectionCapture(context: TelegramSelectionContext): void {
    const selected = this.selectionDom.readSelectedSnapshots(context);
    if (selected.kind === "rejected") {
      return;
    }
    void this.captureSnapshots(selected.snapshots, context.sourceTarget, context);
  }

  /** Completes one atomic bundle before dismissing source UI or opening recipient selection. */
  private async captureSnapshots(
    snapshots: readonly TelegramSourceSnapshot[],
    sourceTarget: TelegramSourceTargetSnapshot,
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
      const result = await this.extractor.captureSnapshots(
        snapshots,
        sourceTarget,
        session.controller.signal,
      );
      if (session.controller.signal.aborted || this.captureSession !== session) {
        return;
      }
      if (result.kind !== "captured") {
        // A rejected capture used to log and return, so the click looked like a dead button and
        // gave no way to tell "not supported" apart from "userscript is not running".
        this.log.warn("Source capture остановлен до recipient picker.", result.reason);
        this.notice.show("Clean Forward не может скопировать это сообщение", result.reason.message);
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
      this.notice.show(
        "Clean Forward не смог подготовить сообщение",
        error instanceof Error ? error.message : "Неизвестная ошибка извлечения.",
      );
    } finally {
      if (this.captureSession === session) {
        this.captureSession = null;
      }
    }
  }
}
