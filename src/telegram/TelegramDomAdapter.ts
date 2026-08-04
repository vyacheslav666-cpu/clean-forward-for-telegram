/** Isolates every Telegram Web K DOM assumption behind a narrow adapter. */
import type { Logger } from "../utils/logger";
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

  /**
   * Inserts text at the end of Telegram's active composer without dispatching a Send action.
   */
  public insertTextIntoComposer(text: string, expectedPeerKey: string): boolean {
    const context = findActiveComposerContext();
    if (!context || context.peerId !== expectedPeerKey || !isComposerEmpty(context)) {
      this.logMissingComposer();
      return false;
    }

    return insertTextNatively(context.composer, text, { replaceContents: false });
  }

  private logMissingComposer(): void {
    if (!findActiveComposerContext()) {
      this.log.warn("Активный composer Telegram Web K не найден.");
    }
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
