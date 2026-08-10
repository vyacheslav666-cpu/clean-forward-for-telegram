/** Extracts recipient snapshots from the verified Telegram Web K dialog list. */
import type { Recipient } from "../recipient/Recipient";
import type { RecipientSourceAdapter } from "../recipient/RecipientSourceAdapter";
import { TelegramPeerEligibility, type RecipientSourceKind } from "./TelegramPeerEligibility";
import { readTelegramText } from "./readTelegramText";

const ACTIVE_DIALOG_LIST_SELECTOR =
  ".tabs-tab.chatlist-parts.active ul.chatlist.virtual-chatlist";
const DIALOG_ROW_SELECTOR = ":scope > a.row.chatlist-chat[data-peer-id]";
const ACTIVE_DIALOG_ROW_SELECTOR =
  ".tabs-tab.chatlist-parts.active a.row.chatlist-chat.active[data-peer-id]";
const LEFT_COLUMN_SELECTOR = "#column-left";
const NATIVE_SEARCH_INPUT_SELECTOR =
  "#column-left .sidebar-header input.input-search-input[type=\"text\"]";
const NATIVE_SEARCH_MAIN_SELECTOR = "#column-left .sidebar-slider-item.item-main";
const NATIVE_SEARCH_RESULTS_SELECTOR =
  "#column-left #search-container .search-super-content-chats";
const NATIVE_SEARCH_ROW_SELECTOR = "a.row.chatlist-chat[data-peer-id]";
const NATIVE_SEARCH_BACK_SELECTOR =
  "#column-left .sidebar-header .sidebar-back-button";
const TITLE_SELECTOR = ".peer-title";
const SUBTITLE_SELECTOR = ".row-subtitle";
const AVATAR_IMAGE_SELECTOR = ".avatar img";
const SUBTITLE_IGNORED_SELECTORS = [
  ".badge",
  ".dialog-subtitle-badge",
  ".sending-status",
  ".message-time",
] as const;

/** Reads recent rows and bridges the project's query into Telegram's native chat search. */
export class TelegramRecipientSourceAdapter implements RecipientSourceAdapter {
  private readonly eligibility = new TelegramPeerEligibility();
  private nativeSearchState: {
    readonly originalValue: string;
    readonly wasActive: boolean;
  } | null = null;

  /** Captures source identity without retaining a Telegram-owned DOM node. */
  public getActiveRecipient(): Readonly<Recipient> | null {
    const rows = document.querySelectorAll<HTMLElement>(ACTIVE_DIALOG_ROW_SELECTOR);
    if (rows.length !== 1) {
      return null;
    }
    const row = rows.item(0);
    const peerKey = row.dataset.peerId?.trim() ?? "";
    const titleElement = row.querySelector<HTMLElement>(TITLE_SELECTOR);
    const title = titleElement ? readTelegramText(titleElement).trim() : "";
    if (!peerKey || !title) {
      return null;
    }
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

    const input = this.findUniqueElement<HTMLInputElement>(NATIVE_SEARCH_INPUT_SELECTOR);
    const leftColumn = this.findUniqueElement<HTMLElement>(LEFT_COLUMN_SELECTOR);
    const main = document.querySelector<HTMLElement>(NATIVE_SEARCH_MAIN_SELECTOR);
    if (!input || !leftColumn || !main) {
      throw new Error("Telegram native chat search is unavailable.");
    }

    if (!this.nativeSearchState) {
      this.nativeSearchState = {
        originalValue: input.value,
        wasActive: main.classList.contains("is-search-active"),
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
      const recipients = this.readSearchRecipients();
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

    if (!main.classList.contains("is-search-active")) {
      input.focus({ preventScroll: true });
    }
    this.setNativeSearchValue(input, normalizedQuery);
  }

  /** Restores the user's native sidebar search after the project picker closes or clears. */
  public clearSearch(): void {
    const state = this.nativeSearchState;
    this.nativeSearchState = null;
    const input = this.findUniqueElement<HTMLInputElement>(NATIVE_SEARCH_INPUT_SELECTOR);
    if (!state || !input) {
      return;
    }

    this.setNativeSearchValue(input, state.originalValue);
    if (!state.wasActive) {
      const main = document.querySelector<HTMLElement>(NATIVE_SEARCH_MAIN_SELECTOR);
      const back = this.findUniqueElement<HTMLElement>(NATIVE_SEARCH_BACK_SELECTOR);
      if (main?.classList.contains("is-search-active") && back) {
        back.click();
      }
    }
  }

  private readSearchRecipients(): readonly Recipient[] {
    const container = this.findUniqueElement<HTMLElement>(NATIVE_SEARCH_RESULTS_SELECTOR);
    if (!container) {
      return Object.freeze([]);
    }

    const recipients = new Map<string, Recipient>();
    for (const row of container.querySelectorAll<HTMLElement>(NATIVE_SEARCH_ROW_SELECTOR)) {
      if (row.closest(".search-group-recent, .search-group-messages")) {
        continue;
      }
      const recipient = this.readRecipient(row, "search");
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

  private readRecipient(row: HTMLElement, source: RecipientSourceKind): Recipient | null {
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
