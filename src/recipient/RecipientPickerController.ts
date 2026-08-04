/** Coordinates recipient loading, confirmation, navigation, and message preparation. */
import type { PendingTransfer } from "../domain/PendingTransfer";
import type { ComposerAdapter } from "../telegram/ComposerAdapter";
import type { TelegramChatNavigator } from "../telegram/TelegramChatNavigator";
import type { RecipientPicker, RecipientPickerActions } from "../ui/RecipientPicker";
import type { Logger } from "../utils/logger";
import type { Recipient } from "./Recipient";
import { snapshotRecipient } from "./Recipient";
import type { RecipientSourceAdapter } from "./RecipientSourceAdapter";

/** Runs one single-recipient flow while PendingTransfer remains the payload source of truth. */
export class RecipientPickerController {
  private session: AbortController | null = null;
  private recipients: readonly Recipient[] = [];

  public constructor(
    private readonly source: RecipientSourceAdapter,
    private readonly navigator: TelegramChatNavigator,
    private readonly picker: RecipientPicker,
    private readonly composer: ComposerAdapter,
    private readonly pending: PendingTransfer,
    private readonly log: Logger,
  ) {}

  /** Opens a new picker session for the payload already stored in PendingTransfer. */
  public async open(): Promise<void> {
    this.abortSession();
    const session = new AbortController();
    this.session = session;
    const actions = this.createActions(session);
    this.picker.showLoading(actions);

    try {
      const recipients = await this.source.listLoadedRecipients(session.signal);
      if (session.signal.aborted || this.session !== session) {
        return;
      }
      this.recipients = recipients;
      this.picker.show(recipients, actions);
      this.log.info("Собственный recipient picker открыт.", { count: recipients.length });
    } catch (error) {
      if (this.isAbortError(error) || session.signal.aborted) {
        return;
      }
      const message = error instanceof Error ? error.message : "Не удалось загрузить список чатов.";
      this.log.error("Ошибка загрузки recipient picker.", error);
      this.picker.show([], actions, { errorMessage: message });
    }
  }

  /** Rechecks navigation through the application's one shared MutationObserver. */
  public notifyDomChanged(): void {
    this.navigator.notifyDomChanged();
  }

  /** Cancels the picker flow and clears only project-owned pending data. */
  public cancel(): void {
    this.abortSession();
    this.pending.clear();
    this.picker.hide();
    this.log.info("Выбор получателя отменён; временный payload очищен.");
  }

  /** Stops all project waits when the parent controller is disposed. */
  public stop(): void {
    this.abortSession();
    this.picker.hide();
  }

  private createActions(session: AbortController): RecipientPickerActions {
    return {
      onNext: (recipient) => void this.confirm(recipient, session),
      onCancel: () => this.cancel(),
    };
  }

  private async confirm(recipient: Recipient, session: AbortController): Promise<void> {
    if (this.session !== session || session.signal.aborted || !this.pending.hasValue()) {
      return;
    }

    const selected = snapshotRecipient(recipient);
    this.picker.setBusy(true);
    this.picker.hide();
    const navigation = await this.navigator.navigate(selected, session.signal);
    if (session.signal.aborted || this.session !== session) {
      return;
    }

    if (!navigation.success) {
      this.reopenAfterError(selected.peerKey, navigation.message, session);
      return;
    }

    const payload = this.pending.peek();
    if (!payload) {
      this.reopenAfterError(selected.peerKey, "Временный payload больше недоступен.", session);
      return;
    }

    const result = await this.composer.insert(payload, selected.peerKey);
    if (session.signal.aborted || this.session !== session) {
      return;
    }

    if (!result.success) {
      const previewClosed = await this.composer.cancelPreparedPreview();
      const message = previewClosed
        ? result.message
        : `${result.message} Закройте media preview Telegram вручную перед повтором.`;
      this.reopenAfterError(selected.peerKey, message, session);
      return;
    }

    this.pending.clear();
    this.session = null;
    this.recipients = [];
    this.log.info(result.message);
  }

  private reopenAfterError(
    selectedPeerKey: string,
    message: string,
    session: AbortController,
  ): void {
    if (this.session !== session || session.signal.aborted) {
      return;
    }
    this.picker.show(this.recipients, this.createActions(session), {
      selectedPeerKey,
      errorMessage: message,
    });
    this.log.warn("Recipient flow остановлен до вставки; payload сохранён для повтора.");
  }

  private abortSession(): void {
    this.session?.abort();
    this.session = null;
    this.recipients = [];
    this.navigator.cancel();
  }

  private isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError";
  }
}
