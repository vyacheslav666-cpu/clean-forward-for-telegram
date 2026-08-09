/** Isolates every Telegram Web K DOM assumption behind a narrow adapter. */
import type { Logger } from "../utils/logger";
import type {
  ComposerDraftTransaction,
  ComposerDraftTransactionStart,
} from "./ComposerDraftTransaction";
import { findActiveComposerContext, isComposerEmpty } from "./TelegramComposerDom";
import { insertTextNatively } from "./nativeTextEditing";
import { readTelegramText } from "./readTelegramText";

const MESSAGE_ROOT_SELECTOR = ".bubble[data-mid][data-peer-id]";
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

/** DOM snapshot needed by the extractor without leaking Telegram selectors into other layers. */
export interface TelegramMessageSnapshot {
  readonly text: string | null;
  readonly imageUrl: string | null;
  readonly imageCount: number;
  readonly hasUnsupportedAttachment: boolean;
}

/** A verified message element paired with its currently open context menu. */
export interface TelegramMessageContext {
  readonly menu: HTMLElement;
  readonly message: HTMLElement;
  /** Closes only the message menu paired with this context. */
  readonly dismiss: () => boolean;
}

/**
 * Boundary for Telegram Web K markup observed in an authenticated session on 2026-08-03.
 * Keeping these selectors here limits the repair surface when Telegram changes its frontend.
 */
export class TelegramDomAdapter {
  private lastContextMessage: HTMLElement | null = null;
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
      this.lastContextMessage = target?.closest<HTMLElement>(MESSAGE_ROOT_SELECTOR) ?? null;
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
    this.lastLoggedMessageId = null;
  }

  /**
   * Finds the open message menu and pairs it with the bubble that received contextmenu.
   */
  public findOpenMessageContext(): TelegramMessageContext | null {
    if (!this.lastContextMessage) {
      return null;
    }

    const message = this.lastContextMessage;
    const menuItems = document.querySelector<HTMLElement>(ACTIVE_MESSAGE_MENU_SELECTOR);

    if (!message?.isConnected || !menuItems) {
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
      dismiss: () => this.dismissMessageMenu(menuItems),
    };
  }

  /**
   * Reads the verified text/caption and photo nodes while rejecting other attachment families.
   */
  public readMessageSnapshot(message: HTMLElement): TelegramMessageSnapshot | null {
    if (!message.matches(MESSAGE_ROOT_SELECTOR)) {
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

    return {
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

    const text = readTelegramText(context.composer);
    const transaction = this.createDraftTransaction(expectedPeerKey, text);
    if (text.length === 0) {
      return { success: true, message: "Composer уже пуст.", transaction };
    }

    const cleared = insertTextNatively(context.composer, "", { replaceContents: true });
    if (!cleared || readTelegramText(context.composer).length !== 0) {
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

  private createDraftTransaction(peerKey: string, text: string): ComposerDraftTransaction {
    let restored = false;
    return Object.freeze({
      peerKey,
      hadDraft: text.length > 0,
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
