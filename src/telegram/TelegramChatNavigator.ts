/** Opens one Telegram peer through its native UI and proves exact composer ownership. */
import type { Recipient } from "../recipient/Recipient";
import { isSimplePeerKey, snapshotRecipient } from "../recipient/Recipient";
import type { RecipientSourceAdapter } from "../recipient/RecipientSourceAdapter";
import type { Logger } from "../utils/logger";
import {
  findActiveComposerContext,
  type TelegramComposerContext,
} from "./TelegramComposerDom";

const ACTIVE_DIALOG_LIST_SELECTOR =
  ".tabs-tab.chatlist-parts.active ul.chatlist.virtual-chatlist";
const DIALOG_ROW_SELECTOR = ":scope > a.row.chatlist-chat[data-peer-id]";
const SEARCH_DIALOG_ROW_SELECTOR =
  "#column-left #search-container .search-super-content-chats a.row.chatlist-chat[data-peer-id]";
const FORUM_MARKER_SELECTOR = ".is-forum";
const NATIVE_FORWARD_POPUP_SELECTOR = ".popup.popup-forward.active";
const MEDIA_PREVIEW_SELECTOR = ".popup-send-photo.popup-new-media.active";
const REPLY_OR_FORWARD_DRAFT_SELECTOR = ".reply-wrapper";
const SENDING_SELECTOR = ".sending";
const NAVIGATION_MAX_ATTEMPTS = 3;
const NAVIGATION_ATTEMPT_TIMEOUT_MS = 800;
const NAVIGATION_POLL_INTERVAL_MS = 50;
const REQUIRED_STABLE_POLLS = 3;
const NAVIGATION_RETRY_BACKOFF_MS = [100, 250] as const;
const NAVIGATION_TIMEOUT_MESSAGE =
  "Telegram не открыл выбранный чат вовремя. Попробуйте ещё раз.";

/** Result of opening and validating one Telegram destination chat. */
export interface ChatNavigationResult {
  readonly success: boolean;
  readonly message: string;
}

type NavigationState =
  | "resolve-target"
  | "make-addressable"
  | "initiate-navigation"
  | "initiate-route-fallback"
  | "observe-transition"
  | "prove-exact-peer"
  | "prove-composer-ownership"
  | "stabilize"
  | "release-search"
  | "success";

interface StableComposerCandidate {
  readonly composer: HTMLElement;
  readonly container: HTMLElement;
  readonly chat: HTMLElement | null;
  readonly peerId: string;
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
  searchController: AbortController | null;
  searchOwned: boolean;
  releasingSearch: boolean;
  searchReleased: boolean;
  state: NavigationState;
  finish(result: ChatNavigationResult): void;
}

/** Drives one serialized native navigation transaction; it never invokes Telegram private APIs. */
export class TelegramChatNavigator {
  private activeWait: NavigationWait | null = null;

  public constructor(
    private readonly log: Logger,
    private readonly recipientSource?: RecipientSourceAdapter,
  ) {}

  /** Resolves only after the exact peer owns a stable real composer after search teardown. */
  public async navigate(
    recipient: Readonly<Recipient>,
    signal: AbortSignal,
  ): Promise<ChatNavigationResult> {
    this.cancelActiveWait("Переход был заменён новой операцией.");
    if (signal.aborted) {
      return { success: false, message: "Переход отменён." };
    }
    if (!isSimplePeerKey(recipient.peerKey)) {
      return { success: false, message: "Telegram topics and composite peers are not supported." };
    }
    const unsupported = this.inspectUnsupportedRow(this.findDialogRow(recipient.peerKey));
    return unsupported
      ? { success: false, message: unsupported }
      : this.waitForExpectedPeer(recipient, signal);
  }

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
        searchController: null,
        searchOwned: false,
        releasingSearch: false,
        searchReleased: false,
        state: "resolve-target",
        finish: (result) => {
          if (this.activeWait !== wait) {
            return;
          }
          this.clearWaitTimers(wait);
          signal.removeEventListener("abort", onAbort);
          wait.searchController?.abort();
          wait.searchController = null;
          if (wait.searchOwned && !wait.searchReleased) {
            this.recipientSource?.clearSearch();
          }
          wait.searchReleased = true;
          this.activeWait = null;
          resolve(result);
        },
      };
      const onAbort = (): void => wait.finish({ success: false, message: "Переход отменён." });
      signal.addEventListener("abort", onAbort, { once: true });
      this.activeWait = wait;
      void this.beginAttempt(wait);
      this.schedulePoll(wait);
    });
  }

  /** DOM notifications accelerate fresh-row resolution; semantic evidence is polled independently. */
  public notifyDomChanged(): void {
    const wait = this.activeWait;
    if (!wait) {
      return;
    }
    this.activateRowIfAvailable(wait);
    this.checkExpectedPeer(wait, false);
  }

  public cancel(): void {
    this.cancelActiveWait("Переход отменён.");
  }

  private async beginAttempt(wait: NavigationWait): Promise<void> {
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
    wait.releasingSearch = false;
    wait.searchReleased = false;
    wait.searchController?.abort();
    wait.searchController = null;
    wait.state = "resolve-target";

    const settlement = this.recipientSource?.waitForSearchSettled?.(wait.signal);
    if (settlement) {
      try {
        await settlement;
      } catch (error) {
        if (wait.signal.aborted) {
          return;
        }
        this.log.warn("Telegram search teardown did not settle before navigation retry.", error);
      }
    }
    if (this.activeWait !== wait || wait.signal.aborted) {
      return;
    }

    this.activateRowIfAvailable(wait);
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
    wait.searchController?.abort();
    wait.searchController = null;
    if (wait.searchOwned) {
      this.recipientSource?.clearSearch();
      wait.searchReleased = true;
    }
    if (wait.attemptCount >= NAVIGATION_MAX_ATTEMPTS) {
      wait.finish({ success: false, message: wait.lastTransientBlocker ?? NAVIGATION_TIMEOUT_MESSAGE });
      return;
    }

    const backoff = NAVIGATION_RETRY_BACKOFF_MS[wait.attemptCount - 1] ?? 0;
    this.log.warn("Exact Telegram peer is not ready; restarting navigation from resolution.", {
      attempt: wait.attemptCount,
      maxAttempts: NAVIGATION_MAX_ATTEMPTS,
      state: wait.state,
    });
    wait.retryTimeoutId = window.setTimeout(() => {
      wait.retryTimeoutId = null;
      void this.beginAttempt(wait);
    }, backoff);
  }

  private activateRowIfAvailable(wait: NavigationWait): void {
    if (wait.attemptActivatedRow || wait.releasingSearch || this.findTransientBlocker()) {
      return;
    }
    wait.state = "resolve-target";
    const row = this.findDialogRow(wait.recipient.peerKey);
    const unsupported = this.inspectUnsupportedRow(row);
    if (unsupported) {
      wait.finish({ success: false, message: unsupported });
      return;
    }
    if (!row) {
      wait.state = "make-addressable";
      if (wait.attemptCount > 1) {
        wait.attemptActivatedRow = true;
        wait.state = "initiate-route-fallback";
        // Official TWeb route parser accepts this public address. The route only initiates a
        // transition; success still requires the exact active-chat composer ownership proof.
        window.location.hash = `/im?p=${encodeURIComponent(wait.recipient.peerKey)}`;
        wait.state = "observe-transition";
        return;
      }
      this.startRecipientSearch(wait);
      return;
    }

    wait.attemptActivatedRow = true;
    wait.state = "initiate-navigation";
    this.log.info("Native Telegram peer navigation initiated.", {
      attempt: wait.attemptCount,
      maxAttempts: NAVIGATION_MAX_ATTEMPTS,
      source: row.matches(SEARCH_DIALOG_ROW_SELECTOR) ? "search" : "recent",
    });
    this.activateDialogRow(row);
    wait.state = "observe-transition";
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
    if (this.activeWait !== wait || wait.signal.aborted || wait.releasingSearch) {
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

    wait.state = "prove-exact-peer";
    const composer = findActiveComposerContext();
    if (!composer || composer.peerId !== wait.recipient.peerKey) {
      wait.candidate = null;
      return;
    }
    wait.state = "prove-composer-ownership";
    if (!this.isActiveComposerDom(composer)) {
      wait.candidate = null;
      return;
    }
    const invalid = this.inspectComposer(composer);
    if (invalid) {
      wait.finish({ success: false, message: invalid });
      return;
    }

    wait.state = "stabilize";
    const candidate = wait.candidate;
    const sameCandidate =
      candidate?.composer === composer.composer &&
      candidate.container === composer.container &&
      candidate.chat === composer.chat &&
      candidate.peerId === composer.peerId;
    if (!sameCandidate) {
      wait.candidate = { ...composer, stablePolls: 0 };
      return;
    }
    if (!stablePoll) {
      return;
    }
    candidate.stablePolls += 1;
    if (candidate.stablePolls < REQUIRED_STABLE_POLLS) {
      return;
    }

    if (wait.searchOwned && !wait.searchReleased) {
      void this.releaseSearchAndReprove(wait);
      return;
    }
    wait.state = "success";
    wait.finish({ success: true, message: "Чат получателя открыт." });
  }

  private async releaseSearchAndReprove(wait: NavigationWait): Promise<void> {
    if (wait.releasingSearch || this.activeWait !== wait) {
      return;
    }
    wait.releasingSearch = true;
    wait.state = "release-search";
    wait.searchController?.abort();
    wait.searchController = null;
    this.recipientSource?.clearSearch();
    wait.searchReleased = true;
    const settlement = this.recipientSource?.waitForSearchSettled?.(wait.signal);
    if (settlement) {
      try {
        await settlement;
      } catch (error) {
        if (wait.signal.aborted) {
          return;
        }
        this.log.warn("Telegram search cleanup failed before final peer proof.", error);
      }
    }
    if (this.activeWait !== wait || wait.signal.aborted) {
      return;
    }
    wait.releasingSearch = false;
    wait.candidate = null;
    this.checkExpectedPeer(wait, false);
  }

  private inspectComposer(context: TelegramComposerContext): string | null {
    const draft = context.container.querySelector<HTMLElement>(REPLY_OR_FORWARD_DRAFT_SELECTOR);
    return draft && this.isVisible(draft)
      ? "В выбранном чате открыт reply или forward draft. Закройте его и повторите попытку."
      : null;
  }

  private isActiveComposerDom(context: TelegramComposerContext): boolean {
    if (!context.composer.isConnected || !context.container.isConnected) {
      return false;
    }
    const hiddenAncestor = context.composer.closest<HTMLElement>('[hidden], [aria-hidden="true"]');
    const composerStyle = getComputedStyle(context.composer);
    const containerStyle = getComputedStyle(context.container);
    return !hiddenAncestor && composerStyle.display !== "none" &&
      composerStyle.visibility !== "hidden" && containerStyle.display !== "none" &&
      containerStyle.visibility !== "hidden";
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
    if (
      row?.dataset.sponsored === "true" ||
      row?.querySelector(FORUM_MARKER_SELECTOR) ||
      row?.hasAttribute("data-mid") ||
      row?.hasAttribute("data-thread-id") ||
      row?.hasAttribute("data-monoforum-parent-peer-id")
    ) {
      return "Эта строка Telegram не поддерживается как простой получатель.";
    }
    return null;
  }

  private findDialogRow(peerKey: string): HTMLElement | null {
    const list = document.querySelector<HTMLElement>(ACTIVE_DIALOG_LIST_SELECTOR);
    const recent = list
      ? Array.from(list.querySelectorAll<HTMLElement>(DIALOG_ROW_SELECTOR))
      : [];
    const search = Array.from(document.querySelectorAll<HTMLElement>(SEARCH_DIALOG_ROW_SELECTOR));
    return [...recent, ...search].find((candidate) =>
      candidate.isConnected &&
      candidate.dataset.peerId === peerKey &&
      !candidate.hasAttribute("data-mid") &&
      !candidate.hasAttribute("data-thread-id") &&
      !candidate.hasAttribute("data-monoforum-parent-peer-id")) ?? null;
  }

  private startRecipientSearch(wait: NavigationWait): void {
    if (!this.recipientSource || wait.searchController || wait.signal.aborted) {
      return;
    }
    const controller = new AbortController();
    wait.searchController = controller;
    wait.searchOwned = true;
    const abortSearch = (): void => controller.abort();
    wait.signal.addEventListener("abort", abortSearch, { once: true });
    controller.signal.addEventListener("abort", () => {
      wait.signal.removeEventListener("abort", abortSearch);
      if (wait.searchController === controller) {
        wait.searchController = null;
      }
    }, { once: true });
    try {
      this.recipientSource.searchRecipients(
        wait.recipient.searchQuery?.trim() || wait.recipient.title,
        controller.signal,
        () => {
          if (this.activeWait !== wait || controller.signal.aborted) {
            return;
          }
          this.activateRowIfAvailable(wait);
          this.checkExpectedPeer(wait, false);
        },
      );
    } catch (error) {
      controller.abort();
      this.log.warn("Telegram native search failed during target resolution.", error);
    }
  }

  private activateDialogRow(row: HTMLElement): void {
    const rect = row.getBoundingClientRect();
    // Upstream TWeb listens to capture-phase mousedown on both dialog and autonomous search lists.
    row.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      view: window,
    }));
  }

  private isVisible(element: HTMLElement): boolean {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 &&
      style.display !== "none" && style.visibility !== "hidden";
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
