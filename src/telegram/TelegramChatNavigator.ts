/** Opens one loaded Telegram dialog through its real UI row and verifies the destination. */
import type { Recipient } from "../recipient/Recipient";
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
const NAVIGATION_TIMEOUT_MS = 5_000;

/** Result of opening and validating one Telegram destination chat. */
export interface ChatNavigationResult {
  readonly success: boolean;
  readonly message: string;
}

interface NavigationWait {
  readonly expectedPeerKey: string;
  readonly resolve: (result: ChatNavigationResult) => void;
  readonly signal: AbortSignal;
  readonly timeoutId: number;
  finish(result: ChatNavigationResult): void;
}

/** Navigates only through a real loaded dialog row and never invokes Telegram forwarding APIs. */
export class TelegramChatNavigator {
  private activeWait: NavigationWait | null = null;

  public constructor(private readonly log: Logger) {}

  /** Opens the selected row and waits for a clean composer owned by the exact peer key. */
  public async navigate(
    recipient: Readonly<Recipient>,
    signal: AbortSignal,
  ): Promise<ChatNavigationResult> {
    this.cancelActiveWait("Переход был заменён новой операцией.");
    if (signal.aborted) {
      return { success: false, message: "Переход отменён." };
    }

    const blocker = this.findGlobalBlocker();
    if (blocker) {
      return { success: false, message: blocker };
    }

    const row = this.findDialogRow(recipient.peerKey);
    if (!row) {
      return {
        success: false,
        message: "Выбранный чат больше не загружен в списке Telegram. Выберите другой чат.",
      };
    }

    if (row.dataset.sponsored === "true" || row.querySelector(FORUM_MARKER_SELECTOR)) {
      return { success: false, message: "Эта строка Telegram не поддерживается как получатель." };
    }

    this.log.info("Запрошена безопасная UI-навигация к выбранному чату.");
    this.activateDialogRow(row);
    return this.waitForDestination(recipient.peerKey, signal);
  }

  /** Rechecks an active navigation after the application's shared MutationObserver fires. */
  public notifyDomChanged(): void {
    this.checkActiveWait();
  }

  /** Cancels any outstanding destination wait without changing Telegram DOM. */
  public cancel(): void {
    this.cancelActiveWait("Переход отменён.");
  }

  private waitForDestination(
    expectedPeerKey: string,
    signal: AbortSignal,
  ): Promise<ChatNavigationResult> {
    return new Promise((resolve) => {
      const timeoutId = window.setTimeout(() => {
        this.activeWait?.finish({
          success: false,
          message: "Telegram не открыл выбранный чат вовремя. Попробуйте ещё раз.",
        });
      }, NAVIGATION_TIMEOUT_MS);

      const wait: NavigationWait = {
        expectedPeerKey,
        resolve,
        signal,
        timeoutId,
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
      const onAbort = (): void => wait.finish({ success: false, message: "Переход отменён." });
      signal.addEventListener("abort", onAbort, { once: true });
      this.activeWait = wait;
      this.checkActiveWait();
    });
  }

  private checkActiveWait(): void {
    const wait = this.activeWait;
    if (!wait || wait.signal.aborted) {
      return;
    }

    const blocker = this.findGlobalBlocker();
    if (blocker) {
      wait.finish({ success: false, message: blocker });
      return;
    }

    const composer = findActiveComposerContext();
    if (!composer || composer.peerId !== wait.expectedPeerKey) {
      return;
    }

    const invalid = this.inspectComposer(composer);
    if (invalid) {
      wait.finish({ success: false, message: invalid });
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

  private findGlobalBlocker(): string | null {
    if (document.querySelector(NATIVE_FORWARD_POPUP_SELECTOR)) {
      return "Закройте штатное окно Forward Telegram и повторите попытку.";
    }
    if (document.querySelector(MEDIA_PREVIEW_SELECTOR)) {
      return "Закройте открытое media preview Telegram и повторите попытку.";
    }
    if (document.querySelector(SENDING_SELECTOR)) {
      return "Telegram ещё отправляет другое сообщение. Дождитесь завершения и повторите попытку.";
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
    // scoped list; its later click handler only cancels anchor navigation. Dispatching the
    // confirmed event keeps routing inside the real UI path without touching private APIs.
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

  private cancelActiveWait(message: string): void {
    this.activeWait?.finish({ success: false, message });
  }
}
