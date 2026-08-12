/** Activates Telegram's verified Photo or Video branch without leaving a native picker open. */
import {
  findActiveComposerContext,
  isActivePeer,
  isComposerEmpty,
} from "./TelegramComposerDom";
import { TelegramIntegrationError } from "./TelegramIntegrationError";
import { waitForCondition } from "./waitForCondition";

const FILE_INPUT_SELECTOR = '.new-message-wrapper input[type="file"]';
const ATTACHMENT_BUTTON_SELECTOR = "attach-menu-button.attach-file";
const ACTIVE_MENU_SELECTOR = ".btn-menu.active";
const MENU_ITEM_SELECTOR = ".btn-menu-item";
const MENU_ITEM_TEXT_SELECTOR = ".btn-menu-item-text";
const MENU_OVERLAY_SELECTOR = ".btn-menu-overlay";
const ACTIVE_MEDIA_PREVIEW_SELECTOR = ".popup-send-photo.popup-new-media.active";
const VERIFIED_MENU_LABELS = Object.freeze({
  media: "Photo or Video",
  document: "Document",
});
const MEDIA_MODE_TIMEOUT_MS = 2_000;

/** File input armed by Telegram for media attachment in one captured destination chat. */
export interface ArmedMediaInput {
  readonly fileInput: HTMLInputElement;
  readonly peerId: string;
}

/** Native attachment branch proven from the current Telegram Web K menu. */
export type AttachmentMode = keyof typeof VERIFIED_MENU_LABELS;

/** Uses Telegram's own attachment action to set the internal willAttachType to media. */
export class MediaModeActivator {
  /**
   * Arms the active composer and suppresses only the native picker opened by Telegram afterward.
   */
  public async arm(mode: AttachmentMode = "media"): Promise<ArmedMediaInput> {
    const context = findActiveComposerContext();
    if (!context) {
      throw new TelegramIntegrationError(
        "composer-unavailable",
        "Не найден единственный активный composer Telegram.",
      );
    }

    if (!isComposerEmpty(context)) {
      throw new TelegramIntegrationError(
        "composer-not-empty",
        "Перед вставкой картинки очистите поле сообщения в чате получателя.",
      );
    }

    if (document.querySelector(ACTIVE_MEDIA_PREVIEW_SELECTOR)) {
      throw new TelegramIntegrationError(
        "preview-already-open",
        "В Telegram уже открыто другое вложение. Сначала закройте его.",
      );
    }

    const fileInputs = context.container.querySelectorAll<HTMLInputElement>(FILE_INPUT_SELECTOR);
    if (fileInputs.length !== 1) {
      throw new TelegramIntegrationError(
        "file-input-unavailable",
        "Не найден единственный file input активного composer.",
      );
    }

    const attachmentButtons = context.container.querySelectorAll<HTMLElement>(
      ATTACHMENT_BUTTON_SELECTOR,
    );
    if (attachmentButtons.length !== 1) {
      throw new TelegramIntegrationError(
        "media-mode-unavailable",
        "Не найдена кнопка вложений активного composer.",
      );
    }

    const fileInput = fileInputs.item(0);
    const attachmentButton = attachmentButtons.item(0);
    let mediaItem = this.findVerifiedItem(mode);

    if (!mediaItem) {
      attachmentButton.click();
      try {
        mediaItem = await waitForCondition(
          () => this.findVerifiedItem(mode),
          MEDIA_MODE_TIMEOUT_MS,
          "Telegram не открыл меню вложений.",
        );
      } catch (error) {
        this.closeAttachmentMenu();
        throw new TelegramIntegrationError(
          "media-mode-unavailable",
          error instanceof Error ? error.message : "Не удалось открыть меню вложений.",
        );
      }
    }

    let pickerClickObserved = false;
    const preventNativePicker = (event: MouseEvent): void => {
      pickerClickObserved = true;
      // The menu handler has already assigned willAttachType before calling input.click().
      // Cancelling that click prevents browser chrome while preserving Telegram's internal mode.
      event.preventDefault();
    };

    fileInput.addEventListener("click", preventNativePicker, { capture: true, once: true });
    try {
      mediaItem.click();
      await waitForCondition(
        () => (pickerClickObserved ? true : null),
        MEDIA_MODE_TIMEOUT_MS,
        "Telegram не активировал выбор медиафайла.",
      );
    } catch (error) {
      throw new TelegramIntegrationError(
        "media-mode-unavailable",
        error instanceof Error ? error.message : "Не удалось активировать media-режим.",
      );
    } finally {
      fileInput.removeEventListener("click", preventNativePicker, true);
    }

    if (!isActivePeer(context.peerId)) {
      throw new TelegramIntegrationError(
        "peer-changed",
        "Чат получателя изменился во время подготовки картинки.",
      );
    }

    const mediaAcceptsBinary = fileInput.accept
      .split(",")
      .some((mimeType) => /^(image|video)\//.test(mimeType.trim()));
    const modeMatches = mode === "media" ? mediaAcceptsBinary : fileInput.accept.trim() === "";
    if (!modeMatches) {
      throw new TelegramIntegrationError(
        "media-mode-unavailable",
        "Telegram открыл не media-режим вложения.",
      );
    }

    return { fileInput, peerId: context.peerId };
  }

  private findVerifiedItem(mode: AttachmentMode): HTMLElement | null {
    const matches: HTMLElement[] = [];
    for (const menu of document.querySelectorAll<HTMLElement>(ACTIVE_MENU_SELECTOR)) {
      for (const item of menu.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR)) {
        const label = item.querySelector<HTMLElement>(MENU_ITEM_TEXT_SELECTOR)?.textContent?.trim();
        if (label === VERIFIED_MENU_LABELS[mode]) {
          matches.push(item);
        }
      }
    }

    // TODO: Telegram exposes no locale-independent attribute for this action. Add only labels
    // observed in authenticated sessions; guessing translations could select the wrong action.
    return matches.length === 1 ? matches[0] ?? null : null;
  }

  private closeAttachmentMenu(): void {
    const activeMenu = Array.from(document.querySelectorAll<HTMLElement>(ACTIVE_MENU_SELECTOR)).find(
      (menu) => menu.querySelector(MENU_ITEM_SELECTOR),
    );
    const overlay = activeMenu?.previousElementSibling;
    if (overlay instanceof HTMLElement && overlay.matches(MENU_OVERLAY_SELECTOR)) {
      overlay.click();
    }
  }
}
