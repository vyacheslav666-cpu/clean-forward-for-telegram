/** Clicks Telegram's native Send controls and confirms one new outgoing message element. */
import type { MessagePayload } from "../domain/MessagePayload";
import { DELIVERY_RETRY_POLICY } from "../delivery/DeliveryRetryPolicy";
import type { Logger } from "../utils/logger";
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
const MESSAGE_TEXT_SELECTOR = ".message";
const MESSAGE_TIME_SELECTOR = ".time";
const MESSAGE_LAYOUT_FIX_SELECTOR = ".clearfix";

/** Confirmed or fail-closed outcome of exactly one native Send attempt. */
export type TelegramSendResult =
  | { readonly status: "sent"; readonly messageId: string }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "unknown"; readonly message: string };

interface OutgoingWait {
  readonly payload: MessagePayload;
  readonly expectedPeerKey: string;
  readonly baselineIds: ReadonlySet<string>;
  readonly resolve: (result: TelegramSendResult) => void;
  readonly signal: AbortSignal;
  timeoutId: number | null;
  sendClicked: boolean;
  reconciliationAttempt: number;
  uncertaintyReason: string | null;
  finish(result: TelegramSendResult): void;
}

/** Uses only observed Telegram Web K DOM controls; it never invokes forwarding APIs or Enter. */
export class TelegramSendAdapter {
  private activeWait: OutgoingWait | null = null;

  public constructor(
    private readonly log: Pick<Logger, "debug"> = { debug: () => undefined },
  ) {}

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
    const confirmation = this.armConfirmation(payload, expectedPeerKey, baselineIds, signal);
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
      wait.uncertaintyReason =
        error instanceof Error ? error.message : "Нативная кнопка Send вызвала ошибку.";
      this.log.debug("Send click стал неопределённым; запущено bounded reconciliation.", {
        peerKey: expectedPeerKey,
        reason: wait.uncertaintyReason,
      });
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
    payload: MessagePayload,
    expectedPeerKey: string,
    baselineIds: ReadonlySet<string>,
    signal: AbortSignal,
  ): Promise<TelegramSendResult> {
    return new Promise((resolve) => {
      const wait: OutgoingWait = {
        payload,
        expectedPeerKey,
        baselineIds,
        resolve,
        signal,
        timeoutId: null,
        sendClicked: false,
        reconciliationAttempt: 0,
        uncertaintyReason: null,
        finish: (result) => {
          if (this.activeWait !== wait) {
            return;
          }
          if (wait.timeoutId !== null) {
            window.clearTimeout(wait.timeoutId);
          }
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
      wait.timeoutId = window.setTimeout(
        () => this.reconcileAfterTimeout(wait),
        DELIVERY_RETRY_POLICY.outgoingConfirmationTimeoutMs,
      );
    });
  }

  private reconcileAfterTimeout(wait: OutgoingWait): void {
    if (this.activeWait !== wait) {
      return;
    }
    wait.timeoutId = null;
    this.checkActiveWait();
    if (this.activeWait !== wait) {
      return;
    }
    if (!wait.sendClicked) {
      wait.finish({ status: "failed", message: "Подтверждение было отменено до Send." });
      return;
    }

    const delayMs = DELIVERY_RETRY_POLICY.reconciliationBackoffMs[wait.reconciliationAttempt];
    if (delayMs === undefined) {
      wait.finish({
        status: "unknown",
        message:
          wait.uncertaintyReason ??
          "После Send bounded reconciliation не подтвердил новое исходящее сообщение.",
      });
      return;
    }

    wait.reconciliationAttempt += 1;
    this.log.debug("Post-Send reconciliation продолжится без повторного Send.", {
      peerKey: wait.expectedPeerKey,
      attempt: wait.reconciliationAttempt,
      maxAttempts: DELIVERY_RETRY_POLICY.reconciliationBackoffMs.length,
      delayMs,
    });
    wait.timeoutId = window.setTimeout(() => this.reconcileAfterTimeout(wait), delayMs);
  }

  private checkActiveWait(): void {
    const wait = this.activeWait;
    if (!wait || !wait.sendClicked) {
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
    if (
      message &&
      messageId &&
      this.matchesPayloadWhenObservable(message, wait.payload) !== false &&
      !message.matches(PENDING_MESSAGE_SELECTOR) &&
      !message.querySelector(PENDING_MESSAGE_SELECTOR)
    ) {
      wait.finish({ status: "sent", messageId });
    }
  }

  private matchesPayloadWhenObservable(
    bubble: HTMLElement,
    payload: MessagePayload,
  ): boolean | null {
    if (payload.kind !== "text") {
      return null;
    }
    const message = bubble.querySelector<HTMLElement>(MESSAGE_TEXT_SELECTOR);
    if (!message) {
      return null;
    }
    const observed = readTelegramText(message, {
      ignoredSelectors: [MESSAGE_TIME_SELECTOR, MESSAGE_LAYOUT_FIX_SELECTOR],
    });
    return normalizeText(observed).trim() === normalizeText(payload.text).trim();
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
