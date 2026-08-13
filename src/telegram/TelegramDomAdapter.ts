/** Isolates every Telegram Web K DOM assumption behind a narrow adapter. */
import {
  createSourceChatDescriptor,
  type SourceChatDescriptor,
} from "../domain/SourceMessageDescriptor";
import type { Logger } from "../utils/logger";
import type {
  ComposerDraftTransaction,
  ComposerDraftTransactionStart,
} from "./ComposerDraftTransaction";
import { findActiveComposerContext, isComposerEmpty } from "./TelegramComposerDom";
import { insertTextNatively } from "./nativeTextEditing";
import { readTelegramText } from "./readTelegramText";
import type { TelegramMessageSnapshot } from "./TelegramSourceSnapshot";

const MESSAGE_ROOT_SELECTOR = ".bubble[data-mid][data-peer-id]";
const GROUPED_ITEM_SELECTOR = ".grouped-item[data-mid][data-peer-id]";
const MESSAGE_IDENTITY_SELECTOR = `${GROUPED_ITEM_SELECTOR}, ${MESSAGE_ROOT_SELECTOR}`;
const MESSAGE_TEXT_SELECTOR = ".message";
const MESSAGE_TIME_SELECTOR = ".time";
const MESSAGE_LAYOUT_FIX_SELECTOR = ".clearfix";
const MESSAGE_PHOTO_SELECTOR = "img.media-photo";
const MESSAGE_ATTACHMENT_SELECTOR = ".attachment";
const ACTIVE_MESSAGE_MENU_SELECTOR =
  ".btn-menu.contextmenu.active.has-items-wrapper .btn-menu-items";
const ACTIVE_MESSAGE_MENU_WRAPPER_SELECTOR = ".btn-menu.contextmenu.active.has-items-wrapper";
const MENU_OVERLAY_SELECTOR = ".btn-menu-overlay";
const ACTIVE_MEDIA_PREVIEW_SELECTOR = ".popup-send-photo.popup-new-media.active";
const REPLY_EDIT_OR_FORWARD_SELECTOR = ".reply-wrapper";
const ACTIVE_DIALOG_ROW_SELECTOR =
  ".tabs-tab.chatlist-parts.active a.row.chatlist-chat.active[data-peer-id]";
const SEARCH_DIALOG_ROW_SELECTOR =
  "#column-left #search-container .search-super-content-chats a.row.chatlist-chat[data-peer-id]";
const ACTIVE_CHAT_TITLE_SELECTOR = ".topbar .peer-title, .topbar .user-title";
const PEER_TITLE_SELECTOR = ".peer-title";
const NATIVE_SEARCH_INPUT_SELECTOR =
  '#column-left .sidebar-header input.input-search-input[type="text"]';

/** A verified message element paired with its currently open context menu. */
export interface TelegramMessageContext {
  readonly menu: HTMLElement;
  readonly message: HTMLElement;
  readonly sourceTarget: SourceChatDescriptor;
  /** Closes only the message menu paired with this context. */
  readonly dismiss: () => boolean;
}

/**
 * Boundary for Telegram Web K markup observed in an authenticated session on 2026-08-03.
 * Keeping these selectors here limits the repair surface when Telegram changes its frontend.
 */
export class TelegramDomAdapter {
  private lastContextMessage: HTMLElement | null = null;
  private lastContextSourceTarget: SourceChatDescriptor | null = null;
  private contextListener: ((event: MouseEvent) => void) | null = null;
  private lastLoggedMessageId: string | null = null;

  public constructor(private readonly log: Logger) {}

  /** Starts remembering the element on which Telegram's context menu was requested. */
  public startTrackingContextTargets(onContextRequest: () => void): void {
    if (this.contextListener) {
      return;
    }

    this.contextListener = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      this.lastContextMessage = target?.closest<HTMLElement>(MESSAGE_IDENTITY_SELECTOR) ?? null;
      this.lastContextSourceTarget = this.lastContextMessage
        ? this.readSourceTargetSnapshot(
            this.lastContextMessage.dataset.peerId?.trim() ?? "",
            this.lastContextMessage,
          )
        : null;
      this.lastLoggedMessageId = null;
      this.log.info("Получен contextmenu Telegram.", {
        targetTag: target?.tagName ?? null,
        messageFound: Boolean(this.lastContextMessage),
        messageId: this.lastContextMessage?.dataset.mid ?? null,
      });
      onContextRequest();
    };
    document.addEventListener("contextmenu", this.contextListener, true);
  }

  /** Removes the context listener installed by startTrackingContextTargets. */
  public stopTrackingContextTargets(): void {
    if (!this.contextListener) {
      return;
    }

    document.removeEventListener("contextmenu", this.contextListener, true);
    this.contextListener = null;
    this.lastContextMessage = null;
    this.lastContextSourceTarget = null;
    this.lastLoggedMessageId = null;
  }

  /**
   * Finds the open message menu and pairs it with the bubble that received contextmenu.
   */
  public findOpenMessageContext(): TelegramMessageContext | null {
    if (!this.lastContextMessage || !this.lastContextSourceTarget) {
      return null;
    }

    const message = this.lastContextMessage;
    const sourceTarget = this.lastContextSourceTarget;
    const menuItems = document.querySelector<HTMLElement>(ACTIVE_MESSAGE_MENU_SELECTOR);

    if (
      !message?.isConnected ||
      !menuItems ||
      !this.isMessageBoundToSource(message, sourceTarget.peerKey)
    ) {
      return null;
    }

    const messageId = message.dataset.mid ?? null;
    if (messageId !== this.lastLoggedMessageId) {
      this.lastLoggedMessageId = messageId;
      this.log.info("Исходное сообщение для Clean Forward найдено.", {
        messageId,
        connected: message.isConnected,
      });
    }

    return {
      menu: menuItems,
      message,
      sourceTarget,
      dismiss: () => this.dismissMessageMenu(menuItems),
    };
  }

  /**
   * Captures the source navigation target while its exact peer still owns the active chat.
   * Composer contents are deliberately never used as a chat title.
   */
  public readSourceTargetSnapshot(
    expectedPeerKey: string,
    sourceMessage?: HTMLElement,
  ): SourceChatDescriptor | null {
    const peerKey = expectedPeerKey.trim();
    if (!peerKey || (sourceMessage && !this.isMessageBoundToSource(sourceMessage, peerKey))) {
      return null;
    }
    const composer = findActiveComposerContext();
    if (composer && composer.peerId !== peerKey) {
      return null;
    }

    const title = this.readReliableSourceTitle(peerKey, composer?.chat ?? null);
    // A query that currently renders the exact peer is strongest. An exact visible title remains
    // a practical native-search locator after TWeb destroys the one-shot source search row.
    const searchQuery = this.readCurrentExactSearchQuery(peerKey) ?? title ?? undefined;
    return createSourceChatDescriptor(peerKey, title, searchQuery);
  }

  /**
   * Reads the verified text/caption and photo nodes while rejecting other attachment families.
   */
  public readMessageSnapshot(
    message: HTMLElement,
    expectedSourcePeerKey?: string,
  ): TelegramMessageSnapshot | null {
    if (!message.matches(MESSAGE_IDENTITY_SELECTOR)) {
      return null;
    }

    const sourcePeerKey = message.dataset.peerId?.trim() ?? "";
    const mid = Number(message.dataset.mid);
    if (
      !sourcePeerKey ||
      !Number.isSafeInteger(mid) ||
      (expectedSourcePeerKey !== undefined && sourcePeerKey !== expectedSourcePeerKey) ||
      !this.isMessageBoundToSource(message, sourcePeerKey)
    ) {
      // A synthetic id would break duplicate detection and could bind delivery to the wrong source.
      this.log.warn("Telegram message identity отсутствует или имеет неожиданный формат.");
      return null;
    }

    const textElement = message.querySelector<HTMLElement>(MESSAGE_TEXT_SELECTOR);
    const photos = Array.from(message.querySelectorAll<HTMLImageElement>(MESSAGE_PHOTO_SELECTOR));
    const attachments = Array.from(
      message.querySelectorAll<HTMLElement>(MESSAGE_ATTACHMENT_SELECTOR),
    );
    const hasUnsupportedAttachment = attachments.some(
      (attachment) => !attachment.querySelector(MESSAGE_PHOTO_SELECTOR),
    );
    const grouped =
      message.matches(GROUPED_ITEM_SELECTOR) ||
      message.classList.contains("is-grouped") ||
      Boolean(message.querySelector(GROUPED_ITEM_SELECTOR));

    return {
      identityResolution: "dom-fallback",
      sourcePeerKey,
      mid,
      date: this.readTimestamp(message),
      group: grouped ? { kind: "ambiguous-dom" } : { kind: "none" },
      text: textElement
        ? readTelegramText(textElement, {
            ignoredSelectors: [MESSAGE_TIME_SELECTOR, MESSAGE_LAYOUT_FIX_SELECTOR],
          }).trim() || null
        : null,
      imageUrl: photos[0]?.currentSrc || photos[0]?.src || null,
      imageCount: photos.length,
      hasUnsupportedAttachment,
    };
  }

  /** Snapshots and clears only a plain-text draft owned by the expected peer. */
  public beginDraftTransaction(expectedPeerKey: string): ComposerDraftTransactionStart {
    const context = findActiveComposerContext();
    if (!context || context.peerId !== expectedPeerKey) {
      return { success: false, message: "Активный composer не принадлежит ожидаемому чату." };
    }
    if (document.querySelector(ACTIVE_MEDIA_PREVIEW_SELECTOR)) {
      return {
        success: false,
        message: "Открытый attachment/caption preview нельзя безопасно сохранить и восстановить.",
      };
    }
    const helper = context.container.querySelector<HTMLElement>(REPLY_EDIT_OR_FORWARD_SELECTOR);
    if (helper && this.isVisible(helper)) {
      return {
        success: false,
        message: "Reply, forward или edit state нельзя безопасно сохранить и восстановить.",
      };
    }
    if (!this.isPlainTextDraft(context.composer)) {
      return {
        success: false,
        message: "Форматированный draft с entities нельзя безопасно сохранить и восстановить.",
      };
    }

    // Telegram represents a visually empty contenteditable with sentinel `<br>` and sometimes
    // whitespace text nodes. Snapshot semantic emptiness, not that implementation markup.
    const text = isComposerEmpty(context) ? "" : readTelegramText(context.composer);
    const transaction = this.createDraftTransaction(expectedPeerKey, text);
    if (text.length === 0) {
      return { success: true, message: "Composer уже пуст.", transaction };
    }

    const cleared = insertTextNatively(context.composer, "", { replaceContents: true });
    if (!cleared || !isComposerEmpty(context)) {
      if (findActiveComposerContext()?.peerId === expectedPeerKey) {
        insertTextNatively(context.composer, text, { replaceContents: true });
      }
      return { success: false, message: "Не удалось временно освободить composer без потери draft." };
    }

    return { success: true, message: "Draft сохранён, composer временно освобождён.", transaction };
  }

  /**
   * Inserts text at the end of Telegram's active composer without dispatching a Send action.
   */
  public insertTextIntoComposer(text: string, expectedPeerKey: string): boolean {
    const context = findActiveComposerContext();
    if (!context || context.peerId !== expectedPeerKey || !isComposerEmpty(context)) {
      this.logMissingComposer();
      return false;
    }

    const inserted = insertTextNatively(context.composer, text, { replaceContents: false });
    return inserted && readTelegramText(context.composer) === text.replace(/\r\n?/g, "\n");
  }

  /** Removes only the exact text prepared by this project before an unclicked Send. */
  public clearPreparedText(text: string, expectedPeerKey: string): boolean {
    const context = findActiveComposerContext();
    const normalizedText = text.replace(/\r\n?/g, "\n");
    if (
      !context ||
      context.peerId !== expectedPeerKey ||
      readTelegramText(context.composer) !== normalizedText
    ) {
      return false;
    }

    // Exact-value ownership prevents cancellation from erasing a draft the user changed
    // after Clean Forward prepared it.
    const cleared = insertTextNatively(context.composer, "", { replaceContents: true });
    return cleared && isComposerEmpty(context);
  }

  private logMissingComposer(): void {
    if (!findActiveComposerContext()) {
      this.log.warn("Активный composer Telegram Web K не найден.");
    }
  }

  private isMessageBoundToSource(message: HTMLElement, peerKey: string): boolean {
    if (message.dataset.peerId?.trim() !== peerKey) {
      return false;
    }
    const composer = findActiveComposerContext();
    if (!composer) {
      // Legacy/fallback markup cannot prove chat containment, but the message identity remains
      // usable. When TWeb exposes an active main chat, the stricter checks below are mandatory.
      return true;
    }
    if (composer.peerId !== peerKey) {
      return false;
    }
    return !composer.chat || composer.chat.contains(message);
  }

  private readReliableSourceTitle(peerKey: string, chat: HTMLElement | null): string | null {
    const chatTitle = chat?.querySelector<HTMLElement>(ACTIVE_CHAT_TITLE_SELECTOR);
    const fromChat = chatTitle ? readTelegramText(chatTitle).trim() : "";
    if (fromChat) {
      return fromChat;
    }

    for (const selector of [ACTIVE_DIALOG_ROW_SELECTOR, SEARCH_DIALOG_ROW_SELECTOR]) {
      const rows = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(
        (row) => row.dataset.peerId?.trim() === peerKey && !row.hasAttribute("data-mid"),
      );
      const titles = new Set(rows.flatMap((row) => {
        const title = row.querySelector<HTMLElement>(PEER_TITLE_SELECTOR);
        const value = title ? readTelegramText(title).trim() : "";
        return value ? [value] : [];
      }));
      if (titles.size === 1) {
        return titles.values().next().value ?? null;
      }
    }
    return null;
  }

  private readCurrentExactSearchQuery(peerKey: string): string | null {
    const inputs = document.querySelectorAll<HTMLInputElement>(NATIVE_SEARCH_INPUT_SELECTOR);
    if (inputs.length !== 1) {
      return null;
    }
    const query = inputs.item(0).value.trim();
    if (!query) {
      return null;
    }
    const matchingRows = Array.from(
      document.querySelectorAll<HTMLElement>(SEARCH_DIALOG_ROW_SELECTOR),
    ).filter((row) =>
      row.dataset.peerId?.trim() === peerKey &&
      !row.hasAttribute("data-mid") &&
      !row.closest(".search-group-messages"));
    return matchingRows.length > 0 ? query : null;
  }

  private createDraftTransaction(peerKey: string, text: string): ComposerDraftTransaction {
    let restored = false;
    const hadDraft = text.length > 0;
    return Object.freeze({
      peerKey,
      hadDraft,
      restore: async () => {
        if (restored) {
          return { success: true, message: "Draft уже восстановлен." };
        }
        const context = findActiveComposerContext();
        if (!context || context.peerId !== peerKey) {
          return { success: false, message: "Draft не восстановлен: активен другой peer." };
        }
        const currentText = readTelegramText(context.composer);
        if (currentText === text) {
          restored = true;
          return { success: true, message: "Draft уже присутствует в composer." };
        }
        if (!hadDraft) {
          // A successful native Send may leave a transient acknowledgement/placeholder in the
          // contenteditable even though no user draft existed before this transaction. There is
          // nothing to restore, so never turn that Telegram-owned post-Send state into a false
          // safety failure and never erase it. Non-empty snapshots still take the strict branch.
          restored = true;
          return { success: true, message: "Исходный draft был пуст; восстановление не требуется." };
        }
        if (currentText.length !== 0 || !this.isPlainTextDraft(context.composer)) {
          return {
            success: false,
            message: "Draft не восстановлен: composer был изменён после snapshot.",
          };
        }
        if (text.length > 0) {
          const inserted = insertTextNatively(context.composer, text, { replaceContents: true });
          if (!inserted || readTelegramText(context.composer) !== text) {
            return { success: false, message: "Telegram не подтвердил восстановление draft." };
          }
        }
        restored = true;
        return { success: true, message: "Draft восстановлен." };
      },
    });
  }

  private isPlainTextDraft(composer: HTMLElement): boolean {
    return Array.from(composer.querySelectorAll("*")).every(
      (element) => element.tagName === "BR",
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

  private readTimestamp(message: HTMLElement): number | null {
    const raw = message.dataset.timestamp ?? message.closest<HTMLElement>(MESSAGE_ROOT_SELECTOR)?.dataset.timestamp;
    if (!raw) {
      return null;
    }
    const timestamp = Number(raw);
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  private dismissMessageMenu(menuItems: HTMLElement): boolean {
    const menu = menuItems.closest<HTMLElement>(ACTIVE_MESSAGE_MENU_WRAPPER_SELECTOR);
    const overlay = menu?.previousElementSibling;
    if (!(overlay instanceof HTMLElement) || !overlay.matches(MENU_OVERLAY_SELECTOR)) {
      this.log.warn("Не найден scoped overlay контекстного меню Telegram.");
      return false;
    }

    overlay.click();
    const dismissed = !menu?.classList.contains("active");
    this.log.info("Закрытие контекстного меню запрошено.", { dismissed });
    return dismissed;
  }
}
