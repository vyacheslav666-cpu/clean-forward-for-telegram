/** Clicks Telegram's native Send controls and confirms one new outgoing message element. */
import type { TelegramDeliveryPayload } from "../domain/TelegramDeliveryPayload";
import { toTelegramDeliveryPayloadUnit } from "../domain/MessagePayload";
import type { TransferUnit } from "../domain/TransferUnit";
import { DELIVERY_RETRY_POLICY } from "../delivery/DeliveryRetryPolicy";
import type { Logger } from "../utils/logger";
import { findActiveComposerContext, isActivePeer } from "./TelegramComposerDom";
import {
  isOutgoingAcknowledged,
  isOutgoingInFlight,
  isOutgoingRejected,
} from "./outgoingMessageState";
import { readTelegramText } from "./readTelegramText";

const TEXT_SEND_BUTTON_SELECTOR = ".btn-send";
const ACTIVE_PREVIEW_SELECTOR = ".popup-send-photo.popup-new-media.active";
const PREVIEW_IMAGE_SELECTOR = ".popup-item.popup-item-media img";
const PREVIEW_MEDIA_ITEM_SELECTOR = ".popup-item.popup-item-media";
const PREVIEW_DOCUMENT_ITEM_SELECTOR = ".popup-item.popup-item-document";
const PREVIEW_ALBUM_SELECTOR = ".popup-item-album";
const CAPTION_EDITOR_SELECTOR =
  '.simple-message-input-input[contenteditable="true"]:not(.input-field-input-fake)';
const PHOTO_SEND_BUTTON_SELECTOR = ".simple-message-input-confirm";
const REPLY_OR_FORWARD_DRAFT_SELECTOR = ".reply-wrapper";
// Telegram Web K renders acknowledged messages from the current account as is-out bubbles.
// Requiring data-mid avoids treating preview closure or a transient upload placeholder as success.
const OUTGOING_BUBBLE_SELECTOR =
  ".bubble.is-out[data-mid][data-peer-id], .bubble.is-out .grouped-item[data-mid]";
const MESSAGE_TEXT_SELECTOR = ".message";
const MESSAGE_TIME_SELECTOR = ".time";
const MESSAGE_LAYOUT_FIX_SELECTOR = ".clearfix";

/** Confirmed or fail-closed outcome of exactly one native Send attempt. */
export type TelegramSendResult =
  | { readonly status: "sent"; readonly messageId: string; readonly messageIds?: readonly string[] }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "unknown"; readonly message: string };

interface OutgoingWait {
  readonly payload: TelegramDeliveryPayload | null;
  readonly unit: TransferUnit | null;
  readonly expectedCount: number;
  readonly expectedPeerKey: string;
  readonly baselineIds: ReadonlySet<string>;
  readonly resolve: (result: TelegramSendResult) => void;
  readonly signal: AbortSignal;
  timeoutId: number | null;
  sendClicked: boolean;
  sendClickedAt: number | null;
  inFlightLogged: boolean;
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
    payload: TelegramDeliveryPayload,
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

    return this.dispatchSend(control.button, payload, null, expectedPeerKey, signal, onSendClicked);
  }

  private async dispatchSend(
    button: HTMLButtonElement,
    payload: TelegramDeliveryPayload | null,
    unit: TransferUnit | null,
    expectedPeerKey: string,
    signal: AbortSignal,
    onSendClicked: () => void,
  ): Promise<TelegramSendResult> {
    const baselineIds = this.captureOutgoingIds(expectedPeerKey);
    const expectedCount = unit?.delivery.outgoing.expectedCount ?? 1;
    const confirmation = this.armConfirmation(
      payload,
      unit,
      expectedCount,
      expectedPeerKey,
      baselineIds,
      signal,
    );
    const wait = this.readActiveWait();
    if (!wait) {
      return { status: "failed", message: "Не удалось запустить подтверждение отправки." };
    }

    try {
      // Marking the boundary immediately before invoking the native control is deliberately
      // conservative: if browser dispatch itself becomes ambiguous, retrying could duplicate.
      wait.sendClicked = true;
      wait.sendClickedAt = Date.now();
      onSendClicked();
      button.click();
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

  /** Sends one generalized unit only when its preparation has a proven native adapter. */
  public async sendPreparedUnit(
    unit: TransferUnit,
    expectedPeerKey: string,
    signal: AbortSignal,
    onSendClicked: () => void,
  ): Promise<TelegramSendResult> {
    const payload = toTelegramDeliveryPayloadUnit(unit);
    if (payload) return this.sendPrepared(payload, expectedPeerKey, signal, onSendClicked);
    if (signal.aborted) {
      return { status: "failed", message: "Delivery was cancelled before Send." };
    }
    if (this.activeWait) {
      return { status: "failed", message: "Another outgoing result is still being reconciled." };
    }
    if (unit.kind !== "file" && unit.kind !== "media-group") {
      return { status: "failed", message: "Prepared unit has no proven native Send strategy." };
    }
    const control = this.findGeneralizedUploadSendControl(unit, expectedPeerKey);
    if ("message" in control) return control;
    return this.dispatchSend(control.button, null, unit, expectedPeerKey, signal, onSendClicked);
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
    payload: TelegramDeliveryPayload,
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

  private findGeneralizedUploadSendControl(
    unit: Extract<TransferUnit, { kind: "file" | "media-group" }>,
    expectedPeerKey: string,
  ): { readonly button: HTMLButtonElement } | { readonly status: "failed"; readonly message: string } {
    const previews = document.querySelectorAll<HTMLElement>(ACTIVE_PREVIEW_SELECTOR);
    if (previews.length !== 1 || !isActivePeer(expectedPeerKey)) {
      return { status: "failed", message: "Expected peer-scoped upload preview is unavailable." };
    }
    const popup = previews.item(0);
    const captionEditor = popup.querySelector<HTMLElement>(CAPTION_EDITOR_SELECTOR);
    const expectedCaption = unit.kind === "file"
      ? unit.item.caption?.text ?? ""
      : unit.items[0]?.caption?.text ?? "";
    if (!captionEditor || readTelegramText(captionEditor) !== normalizeText(expectedCaption)) {
      return { status: "failed", message: "Upload caption changed before Send." };
    }
    const mediaCount = popup.querySelectorAll(PREVIEW_MEDIA_ITEM_SELECTOR).length;
    const documentCount = popup.querySelectorAll(PREVIEW_DOCUMENT_ITEM_SELECTOR).length;
    if (unit.kind === "file") {
      const expectsDocument = unit.role === "document" || unit.role === "audio";
      if ((expectsDocument ? documentCount : mediaCount) !== 1 || (expectsDocument ? mediaCount : documentCount) !== 0) {
        return { status: "failed", message: "Native preview no longer matches the prepared file type." };
      }
    } else {
      const albums = popup.querySelectorAll(PREVIEW_ALBUM_SELECTOR);
      const groupedCount = Array.from(albums).reduce(
        (count, album) => count + album.querySelectorAll(PREVIEW_MEDIA_ITEM_SELECTOR).length,
        0,
      );
      if (albums.length !== unit.expectedGroups.length || groupedCount !== unit.items.length || documentCount !== 0) {
        return { status: "failed", message: "Native preview no longer proves the expected album grouping." };
      }
    }
    const buttons = popup.querySelectorAll<HTMLButtonElement>(PHOTO_SEND_BUTTON_SELECTOR);
    if (buttons.length !== 1 || !this.isEnabled(buttons.item(0))) {
      return { status: "failed", message: "Native Telegram upload Send control is unavailable." };
    }
    return { button: buttons.item(0) };
  }

  private armConfirmation(
    payload: TelegramDeliveryPayload | null,
    unit: TransferUnit | null,
    expectedCount: number,
    expectedPeerKey: string,
    baselineIds: ReadonlySet<string>,
    signal: AbortSignal,
  ): Promise<TelegramSendResult> {
    return new Promise((resolve) => {
      const wait: OutgoingWait = {
        payload,
        unit,
        expectedCount,
        expectedPeerKey,
        baselineIds,
        resolve,
        signal,
        timeoutId: null,
        sendClicked: false,
        sendClickedAt: null,
        inFlightLogged: false,
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
    if (this.hasOutgoingInFlight(wait)) {
      // A large upload legitimately outlives the confirmation timeout. Reporting `unknown` while
      // Telegram is visibly still sending our own message would stop the batch over a message that
      // is on its way, so the wait follows the observable upload instead of the clock.
      const waitedMs = Date.now() - (wait.sendClickedAt ?? Date.now());
      if (waitedMs < DELIVERY_RETRY_POLICY.inFlightConfirmationTimeoutMs) {
        if (!wait.inFlightLogged) {
          wait.inFlightLogged = true;
          this.log.debug("Telegram ещё отправляет это сообщение; подтверждение продолжает ждать.", {
            peerKey: wait.expectedPeerKey,
            maxWaitMs: DELIVERY_RETRY_POLICY.inFlightConfirmationTimeoutMs,
          });
        }
        wait.timeoutId = window.setTimeout(
          () => this.reconcileAfterTimeout(wait),
          DELIVERY_RETRY_POLICY.inFlightPollIntervalMs,
        );
        return;
      }
      wait.finish({
        status: "unknown",
        message: "Telegram не завершил отправку сообщения за отведённое время; batch остановлен.",
      });
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
    const newMessages = this.findNewOutgoing(wait);
    if (newMessages.length > wait.expectedCount) {
      wait.finish({
        status: "unknown",
        message: "После одного Send появилось несколько исходящих сообщений; batch остановлен.",
      });
      return;
    }

    if (newMessages.length !== wait.expectedCount) return;
    if (newMessages.some((message) => isOutgoingRejected(message))) {
      wait.finish({
        status: "unknown",
        message: "Telegram отметил отправленное сообщение как неудачное; batch остановлен.",
      });
      return;
    }
    const messageIds = newMessages
      .map((message) => message.dataset.mid)
      .filter((messageId): messageId is string => Boolean(messageId));
    // Success is the server identity, not the optimistic bubble. Reporting the bubble as sent
    // released the next unit while this one was still uploading, and Telegram then numbered the
    // two messages by whichever upload finished first, so a bundle could arrive reordered.
    const allAcknowledged = newMessages.every((message) => isOutgoingAcknowledged(message));
    const payloadMatches = wait.payload
      ? this.matchesPayloadWhenObservable(newMessages[0]!, wait.payload)
      : true;
    const groupMatches = wait.unit?.kind !== "media-group" || this.hasOneOutgoingGroup(newMessages);
    if (messageIds.length === wait.expectedCount && allAcknowledged && payloadMatches && groupMatches) {
      wait.finish({
        status: "sent",
        messageId: messageIds[0]!,
        ...(wait.unit?.kind === "media-group" ? { messageIds } : {}),
      });
    }
  }

  private matchesPayloadWhenObservable(
    bubble: HTMLElement,
    payload: TelegramDeliveryPayload,
  ): boolean {
    if (payload.kind !== "text") {
      return true;
    }
    const message = bubble.querySelector<HTMLElement>(MESSAGE_TEXT_SELECTOR);
    if (!message) {
      return false;
    }
    const observed = readTelegramText(message, {
      ignoredSelectors: [MESSAGE_TIME_SELECTOR, MESSAGE_LAYOUT_FIX_SELECTOR],
    });
    return normalizeText(observed).trim() === normalizeText(payload.text).trim();
  }

  private findNewOutgoing(wait: OutgoingWait): HTMLElement[] {
    return this.findOutgoingBubbles(wait.expectedPeerKey).filter((bubble) => {
      const messageId = bubble.dataset.mid;
      return Boolean(messageId && !wait.baselineIds.has(messageId));
    });
  }

  private hasOutgoingInFlight(wait: OutgoingWait): boolean {
    return this.findNewOutgoing(wait).some((message) => isOutgoingInFlight(message));
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
      (bubble) => (bubble.dataset.peerId ?? bubble.closest<HTMLElement>(".bubble.is-out")?.dataset.peerId) === peerKey,
    );
  }

  private hasOneOutgoingGroup(messages: readonly HTMLElement[]): boolean {
    const containers = new Set(messages.map((message) => message.closest(".bubble.is-out")));
    return !containers.has(null) && containers.size === 1;
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
