/** Opens one loaded Telegram dialog through its real UI row and verifies the destination. */
import type { Recipient } from "../recipient/Recipient";
import { snapshotRecipient } from "../recipient/Recipient";
import type { Logger } from "../utils/logger";
import {
  findActiveComposerContext,
  isComposerEmpty,
  type TelegramComposerContext,
} from "./TelegramComposerDom";

const ACTIVE_DIALOG_LIST_SELECTOR =
  ".tabs-tab.chatlist-parts.active ul.chatlist.virtual-chatlist";
const DIALOG_ROW_SELECTOR = ":scope > a.row.chatlist-chat[data-peer-id]";
const FORUM_MARKER_SELECTOR = ".is-forum";
const NATIVE_FORWARD_POPUP_SELECTOR = ".popup.popup-forward.active";
const MEDIA_PREVIEW_SELECTOR = ".popup-send-photo.popup-new-media.active";
const REPLY_OR_FORWARD_DRAFT_SELECTOR = ".reply-wrapper";
const SENDING_SELECTOR = ".sending";
const NAVIGATION_MAX_ATTEMPTS = 3;
const NAVIGATION_ATTEMPT_TIMEOUT_MS = 800;
const NAVIGATION_POLL_INTERVAL_MS = 50;
const REQUIRED_STABLE_POLLS = 2;
const NAVIGATION_RETRY_BACKOFF_MS = [100, 250] as const;
const NAVIGATION_TIMEOUT_MESSAGE =
  "Telegram не открыл выбранный чат вовремя. Попробуйте ещё раз.";

/** Result of opening and validating one Telegram destination chat. */
export interface ChatNavigationResult {
  readonly success: boolean;
  readonly message: string;
}

interface StableComposerCandidate {
  readonly composer: HTMLElement;
  readonly container: HTMLElement;
  readonly revision: number;
  stablePolls: number;
}

interface NavigationWait {
  readonly recipient: Readonly<Recipient>;
  readonly resolve: (result: ChatNavigationResult) => void;
  readonly signal: AbortSignal;
  attemptCount: number;
  attemptActivatedRow: boolean;
  attemptTimeoutId: number | null;
  retryTimeoutId: number | null;
  pollTimeoutId: number | null;
  candidate: StableComposerCandidate | null;
  lastTransientBlocker: string | null;
  finish(result: ChatNavigationResult): void;
}

/** Navigates only through a real loaded dialog row and never invokes Telegram forwarding APIs. */
export class TelegramChatNavigator {
  private activeWait: NavigationWait | null = null;
  private domRevision = 0;

  public constructor(private readonly log: Logger) {}

  /** Opens the selected row and resolves only after the exact peer composer becomes stable. */
  public async navigate(
    recipient: Readonly<Recipient>,
    signal: AbortSignal,
  ): Promise<ChatNavigationResult> {
    this.cancelActiveWait("Переход был заменён новой операцией.");
    if (signal.aborted) {
      return { success: false, message: "Переход отменён." };
    }

    const unsupported = this.inspectUnsupportedRow(this.findDialogRow(recipient.peerKey));
    if (unsupported) {
      return { success: false, message: unsupported };
    }

    return this.waitForExpectedPeer(recipient, signal);
  }

  /**
   * Repeatedly drives Telegram toward an immutable recipient and confirms a quiet composer state.
   * A row click is only an attempt; readiness requires exact peer identity and consecutive polls.
   */
  public waitForExpectedPeer(
    recipient: Readonly<Recipient>,
    signal: AbortSignal,
  ): Promise<ChatNavigationResult> {
    if (signal.aborted) {
      return Promise.resolve({ success: false, message: "Переход отменён." });
    }
    return new Promise((resolve) => {
      const wait: NavigationWait = {
        recipient: snapshotRecipient(recipient),
        resolve,
        signal,
        attemptCount: 0,
        attemptActivatedRow: false,
        attemptTimeoutId: null,
        retryTimeoutId: null,
        pollTimeoutId: null,
        candidate: null,
        lastTransientBlocker: null,
        finish: (result) => {
          if (this.activeWait !== wait) {
            return;
          }
          this.clearWaitTimers(wait);
          signal.removeEventListener("abort", onAbort);
          this.activeWait = null;
          resolve(result);
        },
      };
      const onAbort = (): void => wait.finish({ success: false, message: "Переход отменён." });
      signal.addEventListener("abort", onAbort, { once: true });
      this.activeWait = wait;
      this.beginAttempt(wait);
      this.schedulePoll(wait);
    });
  }

  /** Rechecks active navigation after the application's shared MutationObserver fires. */
  public notifyDomChanged(): void {
    this.domRevision += 1;
    const wait = this.activeWait;
    if (!wait) {
      return;
    }

    // Telegram often reuses a row/composer and changes only attributes. Any relevant mutation
    // invalidates earlier stability evidence, while an arriving row can be activated immediately.
    wait.candidate = null;
    this.activateRowIfAvailable(wait);
    this.checkExpectedPeer(wait, false);
  }

  /** Cancels any outstanding destination wait without changing Telegram DOM. */
  public cancel(): void {
    this.cancelActiveWait("Переход отменён.");
  }

  private beginAttempt(wait: NavigationWait): void {
    if (this.activeWait !== wait || wait.signal.aborted) {
      return;
    }
    const terminalBlocker = this.findTerminalBlocker();
    if (terminalBlocker) {
      wait.finish({ success: false, message: terminalBlocker });
      return;
    }

    wait.attemptCount += 1;
    wait.attemptActivatedRow = false;
    wait.candidate = null;
    this.activateRowIfAvailable(wait);
    if (this.activeWait !== wait) {
      return;
    }
    this.checkExpectedPeer(wait, false);
    if (this.activeWait !== wait) {
      return;
    }
    wait.attemptTimeoutId = window.setTimeout(
      () => this.finishAttempt(wait),
      NAVIGATION_ATTEMPT_TIMEOUT_MS,
    );
  }

  private finishAttempt(wait: NavigationWait): void {
    if (this.activeWait !== wait) {
      return;
    }
    wait.attemptTimeoutId = null;
    if (wait.attemptCount >= NAVIGATION_MAX_ATTEMPTS) {
      wait.finish({
        success: false,
        message: wait.lastTransientBlocker ?? NAVIGATION_TIMEOUT_MESSAGE,
      });
      return;
    }

    const backoff = NAVIGATION_RETRY_BACKOFF_MS[wait.attemptCount - 1] ?? 0;
    this.log.warn("Telegram peer ещё не готов; navigation attempt будет повторён.", {
      attempt: wait.attemptCount,
      maxAttempts: NAVIGATION_MAX_ATTEMPTS,
    });
    wait.retryTimeoutId = window.setTimeout(() => {
      wait.retryTimeoutId = null;
      this.beginAttempt(wait);
    }, backoff);
  }

  private activateRowIfAvailable(wait: NavigationWait): void {
    if (wait.attemptActivatedRow || this.findTransientBlocker()) {
      return;
    }
    const row = this.findDialogRow(wait.recipient.peerKey);
    const unsupported = this.inspectUnsupportedRow(row);
    if (unsupported) {
      wait.finish({ success: false, message: unsupported });
      return;
    }
    if (!row) {
      return;
    }

    wait.attemptActivatedRow = true;
    this.log.info("Запрошена безопасная UI-навигация к выбранному чату.", {
      attempt: wait.attemptCount,
      maxAttempts: NAVIGATION_MAX_ATTEMPTS,
    });
    this.activateDialogRow(row);
  }

  private schedulePoll(wait: NavigationWait): void {
    if (this.activeWait !== wait) {
      return;
    }
    wait.pollTimeoutId = window.setTimeout(() => {
      wait.pollTimeoutId = null;
      this.activateRowIfAvailable(wait);
      this.checkExpectedPeer(wait, true);
      this.schedulePoll(wait);
    }, NAVIGATION_POLL_INTERVAL_MS);
  }

  private checkExpectedPeer(wait: NavigationWait, stablePoll: boolean): void {
    if (this.activeWait !== wait || wait.signal.aborted) {
      return;
    }
    const terminalBlocker = this.findTerminalBlocker();
    if (terminalBlocker) {
      wait.finish({ success: false, message: terminalBlocker });
      return;
    }
    const transientBlocker = this.findTransientBlocker();
    wait.lastTransientBlocker = transientBlocker;
    if (transientBlocker) {
      wait.candidate = null;
      return;
    }

    const composer = findActiveComposerContext();
    if (!composer || composer.peerId !== wait.recipient.peerKey) {
      // A manual switch to another chat is never accepted. The current attempt continues to
      // drive the exact snapshotted row, then bounded retries take over if Telegram ignores it.
      wait.candidate = null;
      return;
    }
    if (!this.isActiveComposerDom(composer)) {
      wait.candidate = null;
      return;
    }

    const invalid = this.inspectComposer(composer);
    if (invalid) {
      wait.finish({ success: false, message: invalid });
      return;
    }

    const candidate = wait.candidate;
    const sameCandidate =
      candidate?.composer === composer.composer &&
      candidate.container === composer.container &&
      candidate.revision === this.domRevision;
    if (!sameCandidate) {
      wait.candidate = {
        composer: composer.composer,
        container: composer.container,
        revision: this.domRevision,
        stablePolls: 0,
      };
      return;
    }
    if (!stablePoll) {
      return;
    }

    candidate.stablePolls += 1;
    if (candidate.stablePolls < REQUIRED_STABLE_POLLS) {
      return;
    }
    wait.finish({ success: true, message: "Чат получателя открыт." });
  }

  private inspectComposer(context: TelegramComposerContext): string | null {
    if (!isComposerEmpty(context)) {
      return "В поле сообщения выбранного чата уже есть текст. Очистите его и повторите попытку.";
    }

    const draft = context.container.querySelector<HTMLElement>(REPLY_OR_FORWARD_DRAFT_SELECTOR);
    if (draft && this.isVisible(draft)) {
      return "В выбранном чате открыт reply или forward draft. Закройте его и повторите попытку.";
    }

    return null;
  }

  private isActiveComposerDom(context: TelegramComposerContext): boolean {
    if (!context.composer.isConnected || !context.container.isConnected) {
      return false;
    }
    const hiddenAncestor = context.composer.closest<HTMLElement>('[hidden], [aria-hidden="true"]');
    const composerStyle = getComputedStyle(context.composer);
    const containerStyle = getComputedStyle(context.container);
    return (
      !hiddenAncestor &&
      composerStyle.display !== "none" &&
      composerStyle.visibility !== "hidden" &&
      containerStyle.display !== "none" &&
      containerStyle.visibility !== "hidden"
    );
  }

  private findTerminalBlocker(): string | null {
    if (document.querySelector(NATIVE_FORWARD_POPUP_SELECTOR)) {
      return "Закройте штатное окно Forward Telegram и повторите попытку.";
    }
    if (document.querySelector(MEDIA_PREVIEW_SELECTOR)) {
      return "Закройте открытое media preview Telegram и повторите попытку.";
    }
    return null;
  }

  private findTransientBlocker(): string | null {
    return document.querySelector(SENDING_SELECTOR)
      ? "Telegram ещё отправляет другое сообщение. Дождитесь завершения и повторите попытку."
      : null;
  }

  private inspectUnsupportedRow(row: HTMLElement | null): string | null {
    if (row?.dataset.sponsored === "true" || row?.querySelector(FORUM_MARKER_SELECTOR)) {
      return "Эта строка Telegram не поддерживается как получатель.";
    }
    return null;
  }

  private findDialogRow(peerKey: string): HTMLElement | null {
    const list = document.querySelector<HTMLElement>(ACTIVE_DIALOG_LIST_SELECTOR);
    if (!list) {
      return null;
    }

    // Iteration avoids interpolating an opaque peer key into CSS and remains exact for signs.
    return (
      Array.from(list.querySelectorAll<HTMLElement>(DIALOG_ROW_SELECTOR)).find(
        (candidate) => candidate.dataset.peerId === peerKey,
      ) ?? null
    );
  }

  private activateDialogRow(row: HTMLElement): void {
    const rect = row.getBoundingClientRect();
    // Telegram Web K opens dialog rows from a capture-phase mousedown listener on the
    // scoped list; retries repeat only this confirmed UI path and never call private APIs.
    row.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 1,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        view: window,
      }),
    );
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

  private clearWaitTimers(wait: NavigationWait): void {
    for (const timeoutId of [wait.attemptTimeoutId, wait.retryTimeoutId, wait.pollTimeoutId]) {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    }
    wait.attemptTimeoutId = null;
    wait.retryTimeoutId = null;
    wait.pollTimeoutId = null;
  }

  private cancelActiveWait(message: string): void {
    this.activeWait?.finish({ success: false, message });
  }
}
