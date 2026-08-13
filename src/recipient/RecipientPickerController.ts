/** Coordinates recipient loading, confirmation, navigation, and message preparation. */
import type { PendingTransfer } from "../domain/PendingTransfer";
import { toTelegramDeliveryPayload } from "../domain/MessagePayload";
import type { DeliveryCoordinator } from "../delivery/DeliveryCoordinator";
import type { ComposerAdapter } from "../telegram/ComposerAdapter";
import type { TelegramChatNavigator } from "../telegram/TelegramChatNavigator";
import type { RecipientPicker, RecipientPickerActions } from "../ui/RecipientPicker";
import type { Logger } from "../utils/logger";
import type { Recipient } from "./Recipient";
import { RecipientSelection } from "./RecipientSelection";
import type { RecipientSourceAdapter } from "./RecipientSourceAdapter";

const MULTI_RECIPIENT_MESSAGE =
  "Отправка нескольким получателям пока не реализована. Снимите лишние выборы или нажмите «Отмена».";

/** Runs recipient selection while limiting the preparation pipeline to one chosen chat. */
export class RecipientPickerController {
  private session: AbortController | null = null;
  private searchSession: AbortController | null = null;
  private recentRecipients: readonly Recipient[] = [];
  private recipients: readonly Recipient[] = [];
  private sourceRecipient: Readonly<Recipient> | null = null;
  private readonly selection = new RecipientSelection();

  public constructor(
    private readonly source: RecipientSourceAdapter,
    private readonly navigator: TelegramChatNavigator,
    private readonly picker: RecipientPicker,
    private readonly composer: ComposerAdapter,
    private readonly pending: PendingTransfer,
    private readonly log: Logger,
    private readonly delivery?: DeliveryCoordinator,
  ) {}

  /** Opens a new picker session for the payload already stored in PendingTransfer. */
  public async open(): Promise<void> {
    this.abortSession();
    this.selection.clear();
    const capturedSource = this.pending.peek()?.source ?? null;
    const activeSourcePeerKey = this.source.getActiveRecipient?.()?.peerKey ?? null;
    // Navigation metadata is owned exclusively by the immutable payload. The live DOM may prove
    // exact peer identity, but it must never overwrite title/query after asynchronous capture.
    this.sourceRecipient = capturedSource &&
      (activeSourcePeerKey === null || activeSourcePeerKey === capturedSource.peerKey)
      ? Object.freeze({
          peerKey: capturedSource.peerKey,
          title: capturedSource.title ?? capturedSource.peerKey,
          ...(capturedSource.searchQuery
            ? { searchQuery: capturedSource.searchQuery }
            : {}),
          supported: true,
        })
      : null;
    if (capturedSource && activeSourcePeerKey !== null && !this.sourceRecipient) {
      this.log.warn("Active Telegram peer does not match the immutable captured source target.", {
        capturedPeerKey: capturedSource.peerKey,
        activePeerKey: activeSourcePeerKey,
      });
    }
    const session = new AbortController();
    this.session = session;
    const actions = this.createActions(session);
    this.picker.showLoading(actions);

    try {
      const recipients = await this.source.listLoadedRecipients(session.signal);
      if (session.signal.aborted || this.session !== session) {
        return;
      }
      this.recentRecipients = recipients;
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
    if (this.delivery) {
      this.delivery.notifyDomChanged();
    } else {
      this.navigator.notifyDomChanged();
    }
  }

  /** Cancels the picker flow and clears only project-owned pending data. */
  public cancel(): void {
    this.selection.clear();
    this.abortSession();
    this.pending.clear();
    this.picker.hide();
    this.log.info("Выбор получателя отменён; временный payload очищен.");
  }

  /** Stops all project waits when the parent controller is disposed. */
  public stop(): void {
    this.selection.clear();
    this.abortSession();
    this.picker.hide();
    this.delivery?.stop();
  }

  private createActions(session: AbortController): RecipientPickerActions {
    return {
      onToggle: (recipient) => this.toggleRecipient(recipient, session),
      onSearchQueryChange: (query) => this.search(query, session),
      onNext: (legacyRecipient) => {
        // Keeping the optional argument lets older test doubles compile; production UI always
        // toggles through onToggle, so controller-owned state remains authoritative.
        if (legacyRecipient && this.selection.count() === 0) {
          this.selection.toggle(legacyRecipient);
        }
        void this.confirm(session);
      },
      onCancel: () => this.cancel(),
    };
  }

  private search(query: string, session: AbortController): void {
    if (this.session !== session || session.signal.aborted) {
      return;
    }

    this.searchSession?.abort();
    this.searchSession = null;
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      this.source.clearSearch();
      this.recipients = this.recentRecipients;
      this.picker.updateRecipients(this.recentRecipients, this.selection.peerKeys());
      return;
    }

    const searchSession = new AbortController();
    this.searchSession = searchSession;
    const abortSearch = (): void => searchSession.abort();
    session.signal.addEventListener("abort", abortSearch, { once: true });
    searchSession.signal.addEventListener(
      "abort",
      () => session.signal.removeEventListener("abort", abortSearch),
      { once: true },
    );
    this.picker.setError("");
    this.picker.setSearchLoading();
    try {
      this.source.searchRecipients(normalizedQuery, searchSession.signal, (recipients) => {
        if (
          this.session !== session ||
          this.searchSession !== searchSession ||
          searchSession.signal.aborted
        ) {
          return;
        }
        this.recipients = recipients;
        this.picker.updateRecipients(recipients, this.selection.peerKeys());
      });
    } catch (error) {
      searchSession.abort();
      if (this.searchSession === searchSession) {
        this.searchSession = null;
      }
      const message = error instanceof Error ? error.message : "Не удалось запустить поиск чатов.";
      this.picker.updateRecipients([], this.selection.peerKeys());
      this.picker.setError(message);
      this.log.error("Ошибка native recipient search.", error);
    }
  }

  private toggleRecipient(recipient: Recipient, session: AbortController): void {
    if (this.session !== session || session.signal.aborted) {
      return;
    }
    this.selection.toggle(recipient);
    this.picker.updateSelection(this.selection.peerKeys());
    this.picker.setError("");
  }

  private async confirm(session: AbortController): Promise<void> {
    if (this.session !== session || session.signal.aborted || !this.pending.hasValue()) {
      return;
    }

    const selectedRecipients = this.selection.snapshot();
    if (selectedRecipients.length === 0) {
      return;
    }

    if (this.delivery) {
      if (!this.sourceRecipient) {
        this.picker.setError("Не удалось надёжно определить исходный чат. Обновите Telegram и повторите попытку.");
        return;
      }
      if (this.pending.peek()?.source.peerKey !== this.sourceRecipient.peerKey) {
        this.sourceRecipient = null;
        this.picker.setError("Исходный чат изменился после capture. Повторите выбор сообщений.");
        return;
      }
      this.picker.hide();
      const started = this.delivery.start(selectedRecipients, this.sourceRecipient);
      if (!started) {
        this.picker.show(this.recipients, this.createActions(session), {
          selectedPeerKeys: this.selection.peerKeys(),
          errorMessage: "Не удалось запустить отправку: другая операция уже выполняется.",
        });
        return;
      }

      // The picker session no longer owns asynchronous work once the coordinator has taken
      // immutable recipient and payload snapshots.
      session.abort();
      this.session = null;
      this.source.clearSearch();
      this.searchSession = null;
      this.recentRecipients = [];
      this.recipients = [];
      this.selection.clear();
      this.sourceRecipient = null;
      return;
    }

    if (selectedRecipients.length > 1) {
      this.picker.setError(MULTI_RECIPIENT_MESSAGE);
      return;
    }

    const selected = selectedRecipients[0];
    if (!selected) {
      return;
    }
    const sourcePayload = this.pending.beginInsertion();
    if (!sourcePayload) {
      return;
    }
    const payload = toTelegramDeliveryPayload(sourcePayload);
    if (!payload) {
      this.reopenAfterError(
        "Выбранный bundle пока не поддерживается текущим Telegram delivery adapter.",
        session,
      );
      return;
    }

    this.picker.setBusy(true);
    this.picker.hide();
    try {
      const navigation = await this.navigator.navigate(selected, session.signal);
      if (session.signal.aborted || this.session !== session) {
        return;
      }

      if (!navigation.success) {
        this.reopenAfterError(navigation.message, session);
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
        this.reopenAfterError(message, session);
        return;
      }

      this.pending.completeInsertion();
      this.selection.clear();
      this.session = null;
      this.source.clearSearch();
      this.searchSession = null;
      this.recentRecipients = [];
      this.recipients = [];
      this.log.info(result.message);
    } catch (error) {
      if (session.signal.aborted || this.session !== session) {
        return;
      }
      const message = error instanceof Error ? error.message : "Операция подготовки прервана.";
      this.log.error("Необработанная ошибка recipient flow.", error);
      this.reopenAfterError(message, session);
    }
  }

  private reopenAfterError(
    message: string,
    session: AbortController,
  ): void {
    if (this.session !== session || session.signal.aborted) {
      return;
    }
    this.pending.restoreAfterFailure();
    this.picker.show(this.recipients, this.createActions(session), {
      selectedPeerKeys: this.selection.peerKeys(),
      errorMessage: message,
    });
    this.log.warn("Recipient flow остановлен до вставки; payload сохранён для повтора.");
  }

  private abortSession(): void {
    this.searchSession?.abort();
    this.searchSession = null;
    this.source.clearSearch();
    this.session?.abort();
    this.session = null;
    this.recentRecipients = [];
    this.recipients = [];
    this.sourceRecipient = null;
    this.pending.restoreAfterFailure();
    this.navigator.cancel();
  }

  private isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError";
  }
}
