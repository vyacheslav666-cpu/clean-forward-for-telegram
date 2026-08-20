/** Extracts recipient snapshots from the verified Telegram Web K dialog list. */
import type { Recipient } from "../recipient/Recipient";
import type { RecipientSourceAdapter } from "../recipient/RecipientSourceAdapter";
import { findActiveComposerContext } from "./TelegramComposerDom";
import { TelegramPeerEligibility, type RecipientSourceKind } from "./TelegramPeerEligibility";
import { readTelegramText } from "./readTelegramText";
import {
  ACTIVE_CHAT_TITLE_SELECTOR,
  ACTIVE_DIALOG_LIST_SELECTOR,
  ACTIVE_DIALOG_ROW_SELECTOR,
  AVATAR_IMAGE_SELECTOR,
  DIALOG_ROW_SELECTOR,
  LEFT_COLUMN_SELECTOR,
  NATIVE_SEARCH_BACK_SELECTOR,
  NATIVE_SEARCH_INPUT_SELECTOR,
  NATIVE_SEARCH_MAIN_SELECTOR,
  NATIVE_SEARCH_RESULTS_SELECTOR,
  NATIVE_SEARCH_ROW_SELECTOR,
  NON_DIALOG_SEARCH_GROUP_SELECTOR,
  PEER_TITLE_SELECTOR as TITLE_SELECTOR,
  ROW_SUBTITLE_SELECTOR as SUBTITLE_SELECTOR,
  SEARCH_ACTIVE_CLASS,
  SUBTITLE_IGNORED_SELECTORS,
} from "./domContract";

const SEARCH_TEARDOWN_SETTLE_MS = 180;
const SEARCH_TEARDOWN_TIMEOUT_MS = 750;

/** Reads recent rows and bridges the project's query into Telegram's native chat search. */
export class TelegramRecipientSourceAdapter implements RecipientSourceAdapter {
  private readonly eligibility = new TelegramPeerEligibility();
  private nativeSearchState: {
    readonly originalValue: string;
    readonly wasActive: boolean;
  } | null = null;
  private searchGeneration = 0;
  private searchSettlement: Promise<void> = Promise.resolve();

  /** Captures source identity without retaining a Telegram-owned DOM node. */
  public getActiveRecipient(): Readonly<Recipient> | null {
    const context = findActiveComposerContext();
    const activeRows = Array.from(
      document.querySelectorAll<HTMLElement>(ACTIVE_DIALOG_ROW_SELECTOR),
    );
    const peerKey = context?.peerId ?? (activeRows.length === 1
      ? activeRows[0]?.dataset.peerId?.trim() ?? ""
      : "");
    if (!peerKey) {
      return null;
    }
    const matchingActiveRows = activeRows.filter((row) => row.dataset.peerId === peerKey);
    const rowTitle = matchingActiveRows.length === 1
      ? matchingActiveRows[0]?.querySelector<HTMLElement>(TITLE_SELECTOR)
      : null;
    const chatTitle = context?.chat?.querySelector<HTMLElement>(ACTIVE_CHAT_TITLE_SELECTOR) ?? null;
    // Composer contents are the user's draft, never a peer locator or display title.
    const titleSource = rowTitle ?? chatTitle;
    const title = (titleSource ? readTelegramText(titleSource).trim() : "") || peerKey;
    return Object.freeze({ peerKey, title, supported: true });
  }

  /** Returns unique dialog snapshots in their current Telegram order. */
  public async listLoadedRecipients(signal: AbortSignal): Promise<readonly Recipient[]> {
    await this.waitForRenderTurn(signal);
    const list = document.querySelector<HTMLElement>(ACTIVE_DIALOG_LIST_SELECTOR);
    if (!list) {
      throw new Error("Telegram не показал список загруженных чатов.");
    }

    const recipients = new Map<string, Recipient>();
    const rows = list.querySelectorAll<HTMLElement>(DIALOG_ROW_SELECTOR);
    for (const row of rows) {
      this.throwIfAborted(signal);
      const recipient = this.readRecipient(row, "recent");
      if (recipient && !recipients.has(recipient.peerKey)) {
        recipients.set(recipient.peerKey, recipient);
      }
    }

    if (rows.length === 0) {
      throw new Error("В Telegram нет загруженных строк диалогов.");
    }

    return Object.freeze(Array.from(recipients.values()));
  }

  /** Drives Telegram's own debounced chat search and streams its rendered peer snapshots. */
  public searchRecipients(
    query: string,
    signal: AbortSignal,
    onUpdate: (recipients: readonly Recipient[]) => void,
  ): void {
    this.throwIfAborted(signal);
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      throw new Error("Recipient search query must not be empty.");
    }

    // A new owner supersedes any old settlement loop. Navigation serializes calls by awaiting
    // waitForSearchSettled(), while rapid picker typing intentionally replaces the old query.
    this.searchGeneration += 1;
    this.searchSettlement = Promise.resolve();

    const input = this.findUniqueElement<HTMLInputElement>(NATIVE_SEARCH_INPUT_SELECTOR);
    const leftColumn = this.findUniqueElement<HTMLElement>(LEFT_COLUMN_SELECTOR);
    const main = document.querySelector<HTMLElement>(NATIVE_SEARCH_MAIN_SELECTOR);
    if (!input || !leftColumn || !main) {
      throw new Error("Telegram native chat search is unavailable.");
    }

    if (!this.nativeSearchState) {
      this.nativeSearchState = {
        originalValue: input.value,
        wasActive: main.classList.contains(SEARCH_ACTIVE_CLASS),
      };
    }

    let frameId = 0;
    let lastSignature: string | null = null;
    const publish = (): void => {
      frameId = 0;
      const currentInput = this.findUniqueElement<HTMLInputElement>(NATIVE_SEARCH_INPUT_SELECTOR);
      if (signal.aborted || currentInput?.value !== normalizedQuery) {
        return;
      }
      const recipients = this.readSearchRecipients(normalizedQuery);
      const signature = recipients
        .map((recipient) => `${recipient.peerKey}\u0000${recipient.title}\u0000${recipient.subtitle ?? ""}`)
        .join("\u0001");
      if (signature === lastSignature) {
        return;
      }
      lastSignature = signature;
      onUpdate(recipients);
    };
    const schedulePublish = (): void => {
      if (!frameId) {
        frameId = requestAnimationFrame(publish);
      }
    };
    const observer = new MutationObserver(schedulePublish);
    observer.observe(leftColumn, { childList: true, subtree: true, characterData: true });
    const abort = (): void => {
      observer.disconnect();
      if (frameId) {
        cancelAnimationFrame(frameId);
      }
    };
    signal.addEventListener("abort", abort, { once: true });

    if (!main.classList.contains(SEARCH_ACTIVE_CLASS)) {
      input.focus({ preventScroll: true });
    }
    this.setNativeSearchValue(input, normalizedQuery);
  }

  /** Restores the user's native sidebar search after the project picker closes or clears. */
  public clearSearch(): void {
    const state = this.nativeSearchState;
    this.nativeSearchState = null;
    if (!state) {
      return;
    }

    const generation = ++this.searchGeneration;
    const startedAt = Date.now();
    const ownedLeftColumn = document.querySelector<HTMLElement>(LEFT_COLUMN_SELECTOR);
    const restore = (): boolean => {
      if (generation !== this.searchGeneration) {
        return true;
      }
      if (document.querySelector<HTMLElement>(LEFT_COLUMN_SELECTOR) !== ownedLeftColumn) {
        return true;
      }
      const input = this.findUniqueElement<HTMLInputElement>(NATIVE_SEARCH_INPUT_SELECTOR);
      const main = document.querySelector<HTMLElement>(NATIVE_SEARCH_MAIN_SELECTOR);
      if (!input || !main) {
        return false;
      }
      if (input.value !== state.originalValue) {
        this.setNativeSearchValue(input, state.originalValue);
      }
      if (!state.wasActive && main.classList.contains(SEARCH_ACTIVE_CLASS)) {
        this.findUniqueElement<HTMLElement>(NATIVE_SEARCH_BACK_SELECTOR)?.click();
      }
      return (
        input.value === state.originalValue &&
        main.classList.contains(SEARCH_ACTIVE_CLASS) === state.wasActive
      );
    };

    // Apply synchronously for UI responsiveness, then keep reacquiring replaced nodes through
    // TWeb's documented 150 ms search destruction window.
    restore();
    this.searchSettlement = new Promise((resolve) => {
      const poll = (): void => {
        const elapsed = Date.now() - startedAt;
        if (
          generation !== this.searchGeneration ||
          (restore() && elapsed >= SEARCH_TEARDOWN_SETTLE_MS) ||
          elapsed >= SEARCH_TEARDOWN_TIMEOUT_MS
        ) {
          resolve();
          return;
        }
        window.setTimeout(poll, 25);
      };
      window.setTimeout(poll, 25);
    });
  }

  /** Serializes navigation after TWeb has replaced/destroyed its one-shot search DOM. */
  public async waitForSearchSettled(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      throw new DOMException("Recipient search settlement was cancelled.", "AbortError");
    }
    await Promise.race([
      this.searchSettlement,
      new Promise<never>((_, reject) => {
        const abort = (): void =>
          reject(new DOMException("Recipient search settlement was cancelled.", "AbortError"));
        signal.addEventListener("abort", abort, { once: true });
        this.searchSettlement.finally(() => signal.removeEventListener("abort", abort));
      }),
    ]);
  }

  private readSearchRecipients(searchQuery: string): readonly Recipient[] {
    const container = this.findUniqueElement<HTMLElement>(NATIVE_SEARCH_RESULTS_SELECTOR);
    if (!container) {
      return Object.freeze([]);
    }

    const recipients = new Map<string, Recipient>();
    for (const row of container.querySelectorAll<HTMLElement>(NATIVE_SEARCH_ROW_SELECTOR)) {
      if (row.closest(NON_DIALOG_SEARCH_GROUP_SELECTOR)) {
        continue;
      }
      const recipient = this.readRecipient(row, "search", searchQuery);
      if (recipient && !recipients.has(recipient.peerKey)) {
        recipients.set(recipient.peerKey, recipient);
      }
    }
    return Object.freeze(Array.from(recipients.values()));
  }

  private setNativeSearchValue(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  }

  private findUniqueElement<T extends Element>(selector: string): T | null {
    const matches = document.querySelectorAll<T>(selector);
    return matches.length === 1 ? matches[0] ?? null : null;
  }

  private readRecipient(
    row: HTMLElement,
    source: RecipientSourceKind,
    searchQuery?: string,
  ): Recipient | null {
    const peerKey = row.dataset.peerId?.trim() ?? "";
    const titleElement = row.querySelector<HTMLElement>(TITLE_SELECTOR);
    const title = titleElement ? readTelegramText(titleElement).trim() : "";
    if (!peerKey || !title || !this.eligibility.canSendToPeer(row, source)) {
      return null;
    }

    const subtitleElement = row.querySelector<HTMLElement>(SUBTITLE_SELECTOR);
    const subtitle = subtitleElement
      ? readTelegramText(subtitleElement, {
          ignoredSelectors: [...SUBTITLE_IGNORED_SELECTORS],
        }).trim()
      : "";
    const avatar = row.querySelector<HTMLImageElement>(AVATAR_IMAGE_SELECTOR);
    const avatarUrl = avatar?.currentSrc || avatar?.src || "";
    return Object.freeze({
      peerKey,
      title,
      ...(searchQuery ? { searchQuery } : {}),
      ...(subtitle ? { subtitle } : {}),
      ...(avatarUrl ? { avatarUrl } : {}),
      supported: true,
    });
  }

  private waitForRenderTurn(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        cancelAnimationFrame(frameId);
        reject(new DOMException("Recipient loading was cancelled.", "AbortError"));
      };
      const frameId = requestAnimationFrame(() => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) {
          reject(new DOMException("Recipient loading was cancelled.", "AbortError"));
          return;
        }
        resolve();
      });
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new DOMException("Recipient loading was cancelled.", "AbortError");
    }
  }
}
