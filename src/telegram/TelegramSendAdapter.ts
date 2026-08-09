/** Clicks Telegram's native Send controls and confirms one new outgoing message element. */
import type { MessagePayload } from "../domain/MessagePayload";
import { findActiveComposerContext, isActivePeer } from "./TelegramComposerDom";
import { readTelegramText } from "./readTelegramText";

const TEXT_SEND_BUTTON_SELECTOR = ".btn-send";
const ACTIVE_PREVIEW_SELECTOR = ".popup-send-photo.popup-new-media.active";
const PREVIEW_IMAGE_SELECTOR = ".popup-item.popup-item-media img";
const CAPTION_EDITOR_SELECTOR =
  '.simple-message-input-input[contenteditable="true"]:not(.input-field-input-fake)';
const PHOTO_SEND_BUTTON_SELECTOR = ".simple-message-input-confirm";
const REPLY_OR_FORWARD_DRAFT_SELECTOR = ".reply-wrapper";
// Telegram Web K renders acknowledged messages from the current account as is-out bubbles.
// Requiring data-mid avoids treating preview closure or a transient upload placeholder as success.
const OUTGOING_BUBBLE_SELECTOR = ".bubble.is-out[data-mid][data-peer-id]";
const PENDING_MESSAGE_SELECTOR = ".sending";
const OUTGOING_CONFIRM_TIMEOUT_MS = 12_000;

/** Confirmed or fail-closed outcome of exactly one native Send attempt. */
export type TelegramSendResult =
  | { readonly status: "sent"; readonly messageId: string }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "unknown"; readonly message: string };

interface OutgoingWait {
  readonly expectedPeerKey: string;
  readonly baselineIds: ReadonlySet<string>;
  readonly resolve: (result: TelegramSendResult) => void;
  readonly signal: AbortSignal;
  readonly timeoutId: number;
  sendClicked: boolean;
  finish(result: TelegramSendResult): void;
}

/** Uses only observed Telegram Web K DOM controls; it never invokes forwarding APIs or Enter. */
export class TelegramSendAdapter {
  private activeWait: OutgoingWait | null = null;

  /** Verifies prepared content, clicks one scoped native Send control, and waits for data-mid. */
  public async sendPrepared(
    payload: MessagePayload,
    expectedPeerKey: string,
    signal: AbortSignal,
    onSendClicked: () => void,
  ): Promise<TelegramSendResult> {
    if (this.activeWait) {
      return { status: "failed", message: "Уже ожидается результат другой отправки." };
    }
    if (signal.aborted) {
      return { status: "failed", message: "Отправка отменена до нажатия Send." };
    }

    const control = this.findPreparedSendControl(payload, expectedPeerKey);
    if ("message" in control) {
      return control;
    }

    const baselineIds = this.captureOutgoingIds(expectedPeerKey);
    const confirmation = this.armConfirmation(expectedPeerKey, baselineIds, signal);
    const wait = this.readActiveWait();
    if (!wait) {
      return { status: "failed", message: "Не удалось запустить подтверждение отправки." };
    }

    try {
      // Marking the boundary immediately before invoking the native control is deliberately
      // conservative: if browser dispatch itself becomes ambiguous, retrying could duplicate.
      wait.sendClicked = true;
      onSendClicked();
      control.button.click();
      this.checkActiveWait();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Нативная кнопка Send вызвала ошибку.";
      wait.finish({ status: "unknown", message });
    }

    return confirmation;
  }

  /** Rechecks outgoing-message confirmation through the application's shared observer. */
  public notifyDomChanged(): void {
    this.checkActiveWait();
  }

  /** Cancels only a pre-click confirmation; post-click delivery remains observable. */
  public cancel(): void {
    const wait = this.activeWait;
    if (wait && !wait.sendClicked) {
      wait.finish({ status: "failed", message: "Отправка отменена до нажатия Send." });
    }
  }

  private findPreparedSendControl(
    payload: MessagePayload,
    expectedPeerKey: string,
  ): { readonly button: HTMLButtonElement } | { readonly status: "failed"; readonly message: string } {
    if (!isActivePeer(expectedPeerKey)) {
      return { status: "failed", message: "Активный чат изменился до нажатия Send." };
    }

    if (payload.kind === "image") {
      return this.findPhotoSendControl(payload.caption ?? "", expectedPeerKey);
    }

    const context = findActiveComposerContext();
    if (!context || context.peerId !== expectedPeerKey) {
      return { status: "failed", message: "Composer не принадлежит выбранному получателю." };
    }
    const draft = context.container.querySelector<HTMLElement>(REPLY_OR_FORWARD_DRAFT_SELECTOR);
    if (draft && this.isVisible(draft)) {
      return { status: "failed", message: "Перед Send неожиданно появился reply или forward draft." };
    }
    if (readTelegramText(context.composer) !== normalizeText(payload.text)) {
      return { status: "failed", message: "Подготовленный текст изменился до нажатия Send." };
    }

    const buttons = context.container.querySelectorAll<HTMLButtonElement>(TEXT_SEND_BUTTON_SELECTOR);
    if (buttons.length !== 1 || !this.isEnabled(buttons.item(0))) {
      return { status: "failed", message: "Нативная кнопка Send Telegram недоступна." };
    }
    return { button: buttons.item(0) };
  }

  private findPhotoSendControl(
    expectedCaption: string,
    expectedPeerKey: string,
  ): { readonly button: HTMLButtonElement } | { readonly status: "failed"; readonly message: string } {
    const previews = document.querySelectorAll<HTMLElement>(ACTIVE_PREVIEW_SELECTOR);
    if (previews.length !== 1 || !isActivePeer(expectedPeerKey)) {
      return { status: "failed", message: "Подготовленное media preview Telegram недоступно." };
    }
    const popup = previews.item(0);
    const images = popup.querySelectorAll<HTMLImageElement>(PREVIEW_IMAGE_SELECTOR);
    const image = images.length === 1 ? images.item(0) : null;
    if (
      !image ||
      !image.complete ||
      image.naturalWidth <= 0 ||
      image.naturalHeight <= 0 ||
      !image.src.startsWith("blob:")
    ) {
      return { status: "failed", message: "Ожидалась ровно одна картинка в media preview." };
    }
    const captionEditor = popup.querySelector<HTMLElement>(CAPTION_EDITOR_SELECTOR);
    if (!captionEditor || readTelegramText(captionEditor) !== normalizeText(expectedCaption)) {
      return { status: "failed", message: "Подпись в media preview не совпадает с подготовленной." };
    }
    const buttons = popup.querySelectorAll<HTMLButtonElement>(PHOTO_SEND_BUTTON_SELECTOR);
    if (buttons.length !== 1 || !this.isEnabled(buttons.item(0))) {
      return { status: "failed", message: "Нативная кнопка Send Photo Telegram недоступна." };
    }
    return { button: buttons.item(0) };
  }

  private armConfirmation(
    expectedPeerKey: string,
    baselineIds: ReadonlySet<string>,
    signal: AbortSignal,
  ): Promise<TelegramSendResult> {
    return new Promise((resolve) => {
      const timeoutId = window.setTimeout(() => {
        const wait = this.activeWait;
        if (!wait) {
          return;
        }
        wait.finish(wait.sendClicked
          ? {
              status: "unknown",
              message: "После Send не удалось подтвердить новое исходящее сообщение. Batch остановлен.",
            }
          : { status: "failed", message: "Подтверждение было отменено до Send." });
      }, OUTGOING_CONFIRM_TIMEOUT_MS);

      const wait: OutgoingWait = {
        expectedPeerKey,
        baselineIds,
        resolve,
        signal,
        timeoutId,
        sendClicked: false,
        finish: (result) => {
          if (this.activeWait !== wait) {
            return;
          }
          window.clearTimeout(timeoutId);
          signal.removeEventListener("abort", onAbort);
          this.activeWait = null;
          resolve(result);
        },
      };
      const onAbort = (): void => {
        if (!wait.sendClicked) {
          wait.finish({ status: "failed", message: "Отправка отменена до нажатия Send." });
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.activeWait = wait;
    });
  }

  private checkActiveWait(): void {
    const wait = this.activeWait;
    if (!wait || !wait.sendClicked) {
      return;
    }
    if (!isActivePeer(wait.expectedPeerKey)) {
      wait.finish({
        status: "unknown",
        message: "Активный чат изменился после Send; результат нельзя безопасно определить.",
      });
      return;
    }

    const newMessages = this.findOutgoingBubbles(wait.expectedPeerKey).filter((bubble) => {
      const messageId = bubble.dataset.mid;
      return Boolean(messageId && !wait.baselineIds.has(messageId));
    });
    if (newMessages.length > 1) {
      wait.finish({
        status: "unknown",
        message: "После одного Send появилось несколько исходящих сообщений; batch остановлен.",
      });
      return;
    }

    const message = newMessages[0];
    const messageId = message?.dataset.mid;
    if (message && messageId && !message.matches(PENDING_MESSAGE_SELECTOR) && !message.querySelector(PENDING_MESSAGE_SELECTOR)) {
      wait.finish({ status: "sent", messageId });
    }
  }

  private captureOutgoingIds(peerKey: string): ReadonlySet<string> {
    return new Set(
      this.findOutgoingBubbles(peerKey)
        .map((bubble) => bubble.dataset.mid)
        .filter((messageId): messageId is string => Boolean(messageId)),
    );
  }

  private findOutgoingBubbles(peerKey: string): HTMLElement[] {
    // Exact attribute comparison avoids interpolating Telegram's opaque peer key into CSS.
    return Array.from(document.querySelectorAll<HTMLElement>(OUTGOING_BUBBLE_SELECTOR)).filter(
      (bubble) => bubble.dataset.peerId === peerKey,
    );
  }

  private isEnabled(button: HTMLButtonElement): boolean {
    return !button.disabled && !button.hidden && button.getAttribute("aria-disabled") !== "true";
  }

  private isVisible(element: HTMLElement): boolean {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden"
    );
  }

  private readActiveWait(): OutgoingWait | null {
    return this.activeWait;
  }
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}
