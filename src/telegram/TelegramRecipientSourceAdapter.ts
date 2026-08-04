/** Extracts recipient snapshots from the verified Telegram Web K dialog list. */
import type { Recipient } from "../recipient/Recipient";
import { isSimplePeerKey } from "../recipient/Recipient";
import type { RecipientSourceAdapter } from "../recipient/RecipientSourceAdapter";
import { readTelegramText } from "./readTelegramText";

const ACTIVE_DIALOG_LIST_SELECTOR =
  ".tabs-tab.chatlist-parts.active ul.chatlist.virtual-chatlist";
const DIALOG_ROW_SELECTOR = ":scope > a.row.chatlist-chat[data-peer-id]";
const TITLE_SELECTOR = ".peer-title";
const SUBTITLE_SELECTOR = ".row-subtitle";
const AVATAR_IMAGE_SELECTOR = ".avatar img";
const FORUM_MARKER_SELECTOR = ".is-forum";
const SUBTITLE_IGNORED_SELECTORS = [
  ".badge",
  ".dialog-subtitle-badge",
  ".sending-status",
  ".message-time",
] as const;
const UNSUPPORTED_TOPIC_MESSAGE = "Темы форума пока не поддерживаются";
const UNSUPPORTED_SPONSORED_MESSAGE = "Рекламная строка не является чатом получателя";

/** Reads only the active, already-loaded Telegram dialog list and never invokes native search. */
export class TelegramRecipientSourceAdapter implements RecipientSourceAdapter {
  /** Returns unique dialog snapshots in their current Telegram order. */
  public async listLoadedRecipients(signal: AbortSignal): Promise<readonly Recipient[]> {
    await this.waitForRenderTurn(signal);
    const list = document.querySelector<HTMLElement>(ACTIVE_DIALOG_LIST_SELECTOR);
    if (!list) {
      throw new Error("Telegram не показал список загруженных чатов.");
    }

    const recipients = new Map<string, Recipient>();
    for (const row of list.querySelectorAll<HTMLElement>(DIALOG_ROW_SELECTOR)) {
      this.throwIfAborted(signal);
      const recipient = this.readRecipient(row);
      if (recipient && !recipients.has(recipient.peerKey)) {
        recipients.set(recipient.peerKey, recipient);
      }
    }

    if (recipients.size === 0) {
      throw new Error("В Telegram нет загруженных строк диалогов.");
    }

    return Object.freeze(Array.from(recipients.values()));
  }

  private readRecipient(row: HTMLElement): Recipient | null {
    const peerKey = row.dataset.peerId?.trim() ?? "";
    const titleElement = row.querySelector<HTMLElement>(TITLE_SELECTOR);
    const title = titleElement ? readTelegramText(titleElement).trim() : "";
    if (!peerKey || !title) {
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
    const isSponsored = row.dataset.sponsored === "true";
    const isForum = row.querySelector(FORUM_MARKER_SELECTOR) !== null;
    const supported = isSimplePeerKey(peerKey) && !isSponsored && !isForum;
    const unsupportedReason = isSponsored
      ? UNSUPPORTED_SPONSORED_MESSAGE
      : UNSUPPORTED_TOPIC_MESSAGE;

    // A composite key or forum marker carries routing context. Reducing either to a number
    // could target the parent chat, so the row remains visible but deliberately disabled.
    return Object.freeze({
      peerKey,
      title,
      ...(subtitle ? { subtitle } : {}),
      ...(avatarUrl ? { avatarUrl } : {}),
      supported,
      ...(!supported ? { unsupportedReason } : {}),
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
