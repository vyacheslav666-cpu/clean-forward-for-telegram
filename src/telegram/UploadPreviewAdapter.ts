/** Drives Telegram's local upload preview without ever activating its confirm control. */
import type { ArmedMediaInput } from "./MediaModeActivator";
import type { TransferUnit } from "../domain/TransferUnit";
import { isActivePeer, isComposerEmpty, findActiveComposerContext } from "./TelegramComposerDom";
import { TelegramIntegrationError } from "./TelegramIntegrationError";
import { insertTextNatively } from "./nativeTextEditing";
import { readTelegramText } from "./readTelegramText";
import { waitForCondition } from "./waitForCondition";

const ACTIVE_PREVIEW_SELECTOR = ".popup-send-photo.popup-new-media.active";
const PREVIEW_IMAGE_SELECTOR = ".popup-item.popup-item-media img";
const MEDIA_ITEM_SELECTOR = ".popup-item.popup-item-media";
const DOCUMENT_ITEM_SELECTOR = ".popup-item.popup-item-document";
const ALBUM_ITEM_SELECTOR = ".popup-item-album";
const CAPTION_EDITOR_SELECTOR =
  '.simple-message-input-input[contenteditable="true"]:not(.input-field-input-fake)';
const CONFIRM_BUTTON_SELECTOR = ".simple-message-input-confirm";
const CLOSE_BUTTON_SELECTOR = ".popup-close";
const UNSTABLE_EDITOR_SELECTOR = ".animating, .is-changing-height";
const SENDING_SELECTOR = ".sending";
const UNREADY_MEDIA_SELECTOR = ".preloader, .render-progress";
const POPUP_APPEAR_TIMEOUT_MS = 5_000;
const PREVIEW_READY_TIMEOUT_MS = 10_000;
const CAPTION_STABLE_TIMEOUT_MS = 2_000;
const PREVIEW_CLOSE_TIMEOUT_MS = 5_000;

/** Fully rendered preview nodes scoped to one image and one destination peer. */
export interface UploadPreviewSession {
  readonly popup: HTMLElement;
  readonly image: HTMLImageElement;
  readonly captionEditor: HTMLElement;
  readonly peerId: string;
}

/** Handles File selection, preview readiness, caption editing, and safe cancellation. */
export class UploadPreviewAdapter {
  private cancelObstacle: string | null = null;

  /** Assigns exactly one File and dispatches only Telegram's confirmed change event. */
  public selectFile(target: ArmedMediaInput, file: File): void {
    this.selectFiles(target, [file]);
  }

  /** Assigns one ordered file list in one change event so Telegram can preserve album grouping. */
  public selectFiles(target: ArmedMediaInput, files: readonly File[]): void {
    if (!isActivePeer(target.peerId)) {
      throw new TelegramIntegrationError(
        "peer-changed",
        "Чат получателя изменился до выбора файла.",
      );
    }

    const transfer = new DataTransfer();
    for (const file of files) {
      transfer.items.add(file);
    }
    target.fileInput.files = transfer.files;

    if (
      target.fileInput.files?.length !== files.length ||
      files.some((file, index) => target.fileInput.files?.item(index)?.name !== file.name)
    ) {
      throw new TelegramIntegrationError(
        "file-input-unavailable",
        "Браузер не разрешил установить картинку в file input Telegram.",
      );
    }

    target.fileInput.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** Waits for the current image, caption editor, and enabled confirm indicator to be ready. */
  public async waitUntilReady(peerId: string): Promise<UploadPreviewSession> {
    let popup: HTMLElement;
    try {
      popup = await waitForCondition(
        () => this.findSingleActivePreview(),
        POPUP_APPEAR_TIMEOUT_MS,
        "Upload preview не появился вовремя.",
      );
    } catch (error) {
      if (error instanceof TelegramIntegrationError) {
        throw error;
      }
      throw new TelegramIntegrationError(
        "preview-timeout",
        error instanceof Error ? error.message : "Upload preview не появился вовремя.",
      );
    }

    try {
      return await waitForCondition(
        () => this.inspectReadyPreview(popup, peerId),
        PREVIEW_READY_TIMEOUT_MS,
        "Telegram не завершил подготовку preview картинки.",
      );
    } catch (error) {
      if (error instanceof TelegramIntegrationError) {
        throw error;
      }

      if (this.isImageReadyWithoutCaption(popup, peerId)) {
        throw new TelegramIntegrationError(
          "caption-unavailable",
          "Картинка готова, но Telegram не показал редактор подписи. Preview оставлен открытым.",
          true,
        );
      }

      throw new TelegramIntegrationError(
        "preview-timeout",
        error instanceof Error ? error.message : "Preview картинки не стал готовым.",
      );
    }
  }

  /** Waits for Telegram's native preview topology required by one generalized upload unit. */
  public async waitUntilReadyForUnit(
    peerId: string,
    unit: Extract<TransferUnit, { kind: "file" | "media-group" }>,
  ): Promise<UploadPreviewSession> {
    if (unit.kind === "file" && unit.role === "photo") {
      return this.waitUntilReady(peerId);
    }

    let popup: HTMLElement;
    try {
      popup = await waitForCondition(
        () => this.findSingleActivePreview(),
        POPUP_APPEAR_TIMEOUT_MS,
        "Telegram upload preview did not appear in time.",
      );
      return await waitForCondition(
        () => this.inspectGeneralizedPreview(popup, peerId, unit),
        PREVIEW_READY_TIMEOUT_MS,
        "Telegram did not stabilize the expected upload preview.",
      );
    } catch (error) {
      if (error instanceof TelegramIntegrationError) throw error;
      throw new TelegramIntegrationError(
        "preview-timeout",
        error instanceof Error ? error.message : "Upload preview did not become ready.",
      );
    }
  }

  /** Inserts and verifies a caption through Telegram's native rich-input editing path. */
  public async insertCaption(session: UploadPreviewSession, caption: string): Promise<void> {
    this.assertSessionActive(session);
    const normalizedCaption = caption.replace(/\r\n?/g, "\n");
    const inserted = insertTextNatively(session.captionEditor, normalizedCaption, {
      replaceContents: true,
    });
    if (!inserted) {
      throw new TelegramIntegrationError(
        "caption-insertion-failed",
        "Telegram не принял нативную вставку подписи.",
      );
    }

    try {
      await waitForCondition(
        () => {
          this.assertSessionActive(session);
          const valueMatches = readTelegramText(session.captionEditor) === normalizedCaption;
          const editorStable = !session.popup.querySelector(UNSTABLE_EDITOR_SELECTOR);
          return valueMatches && editorStable ? true : null;
        },
        CAPTION_STABLE_TIMEOUT_MS,
        "Telegram не завершил обработку подписи.",
      );
    } catch (error) {
      if (error instanceof TelegramIntegrationError) {
        throw error;
      }
      throw new TelegramIntegrationError(
        "caption-insertion-failed",
        error instanceof Error ? error.message : "Не удалось проверить подпись.",
      );
    }
  }

  /** Reports whether a media preview is currently open. */
  public hasActivePreview(): boolean {
    return document.querySelector(ACTIVE_PREVIEW_SELECTOR) !== null;
  }

  /** Closes only the scoped media preview and verifies that Telegram returned to a clean state. */
  public async cancelActivePreview(): Promise<boolean> {
    const previews = document.querySelectorAll<HTMLElement>(ACTIVE_PREVIEW_SELECTOR);
    if (previews.length === 0) {
      return true;
    }

    if (previews.length !== 1) {
      this.cancelObstacle = `Telegram открыл несколько preview одновременно (${previews.length}).`;
      return false;
    }

    const popup = previews.item(0);
    const closeButtons = popup.querySelectorAll<HTMLElement>(CLOSE_BUTTON_SELECTOR);
    if (closeButtons.length !== 1) {
      this.cancelObstacle =
        `Кнопка закрытия preview не найдена однозначно (${closeButtons.length}).`;
      return false;
    }

    closeButtons.item(0).click();
    try {
      await waitForCondition(
        () => (document.querySelector(ACTIVE_PREVIEW_SELECTOR) ? null : true),
        PREVIEW_CLOSE_TIMEOUT_MS,
        "Telegram не закрыл upload preview.",
      );
    } catch {
      this.cancelObstacle =
        `Telegram не закрыл preview за ${PREVIEW_CLOSE_TIMEOUT_MS} мс после нажатия закрытия.`;
      return false;
    }

    const composer = findActiveComposerContext();
    if (composer && !isComposerEmpty(composer)) {
      this.cancelObstacle = "После закрытия preview поле ввода получателя осталось непустым.";
      return false;
    }
    // Scoped to the destination chat on purpose: this proves that closing the preview did not
    // send anything here. A document-wide match also caught unrelated outgoing messages
    // elsewhere in Telegram and turned ordinary traffic into a cleanup failure.
    const sendingScope = composer?.chat ?? null;
    if (sendingScope?.querySelector(SENDING_SELECTOR)) {
      this.cancelObstacle = "После закрытия preview в чате получателя осталась отправка.";
      return false;
    }

    this.cancelObstacle = null;
    return true;
  }

  /**
   * Reports why the last cancellation could not be confirmed.
   *
   * Cleanup has several independent failure conditions but only one boolean result, which made a
   * real failure impossible to diagnose from the delivery panel alone.
   */
  public describeCancelObstacle(): string | null {
    return this.cancelObstacle;
  }

  private findSingleActivePreview(): HTMLElement | null {
    const previews = document.querySelectorAll<HTMLElement>(ACTIVE_PREVIEW_SELECTOR);
    if (previews.length > 1) {
      throw new TelegramIntegrationError(
        "preview-timeout",
        "Telegram открыл несколько media preview одновременно.",
      );
    }
    return previews.length === 1 ? previews.item(0) : null;
  }

  private inspectReadyPreview(
    popup: HTMLElement,
    peerId: string,
  ): UploadPreviewSession | null {
    if (!popup.isConnected || !popup.matches(ACTIVE_PREVIEW_SELECTOR)) {
      throw new TelegramIntegrationError(
        "preview-cancelled",
        "Upload preview был закрыт во время подготовки.",
      );
    }

    if (!isActivePeer(peerId)) {
      throw new TelegramIntegrationError(
        "peer-changed",
        "Чат получателя изменился во время подготовки preview.",
      );
    }

    const images = popup.querySelectorAll<HTMLImageElement>(PREVIEW_IMAGE_SELECTOR);
    if (images.length > 1) {
      throw new TelegramIntegrationError(
        "unsupported-image",
        "Telegram подготовил больше одной картинки; альбомы не поддерживаются.",
      );
    }

    const image = images.length === 1 ? images.item(0) : null;
    const captionEditor = popup.querySelector<HTMLElement>(CAPTION_EDITOR_SELECTOR);
    const confirm = popup.querySelector<HTMLButtonElement>(CONFIRM_BUTTON_SELECTOR);
    const imageReady = Boolean(
      image?.complete &&
      image.naturalWidth > 0 &&
      image.naturalHeight > 0 &&
      image.src.startsWith("blob:"),
    );

    return imageReady && captionEditor && confirm && !confirm.disabled
      ? { popup, image: image as HTMLImageElement, captionEditor, peerId }
      : null;
  }

  private inspectGeneralizedPreview(
    popup: HTMLElement,
    peerId: string,
    unit: Extract<TransferUnit, { kind: "file" | "media-group" }>,
  ): UploadPreviewSession | null {
    if (!popup.isConnected || !isActivePeer(peerId)) {
      throw new TelegramIntegrationError("peer-changed", "Destination chat changed during upload preparation.");
    }
    const captionEditor = popup.querySelector<HTMLElement>(CAPTION_EDITOR_SELECTOR);
    const confirm = popup.querySelector<HTMLButtonElement>(CONFIRM_BUTTON_SELECTOR);
    if (
      !captionEditor ||
      !confirm ||
      confirm.disabled ||
      popup.querySelector(`${SENDING_SELECTOR}, ${UNREADY_MEDIA_SELECTOR}`)
    ) {
      return null;
    }

    const mediaItems = popup.querySelectorAll(MEDIA_ITEM_SELECTOR).length;
    const documentItems = popup.querySelectorAll(DOCUMENT_ITEM_SELECTOR).length;
    if (unit.kind === "file") {
      const expectedMedia = unit.role === "video" || unit.role === "animation" ? 1 : 0;
      const expectedDocuments = unit.role === "document" || unit.role === "audio" ? 1 : 0;
      if (mediaItems !== expectedMedia || documentItems !== expectedDocuments) return null;
    } else {
      const albums = popup.querySelectorAll(ALBUM_ITEM_SELECTOR);
      if (albums.length !== unit.expectedGroups.length || documentItems !== 0) return null;
      const groupedMediaCount = Array.from(albums).reduce(
        (count, album) => count + album.querySelectorAll(MEDIA_ITEM_SELECTOR).length,
        0,
      );
      if (groupedMediaCount !== unit.items.length) return null;
    }

    const image = popup.querySelector<HTMLImageElement>(PREVIEW_IMAGE_SELECTOR) ?? new Image();
    return { popup, image, captionEditor, peerId };
  }

  private isImageReadyWithoutCaption(popup: HTMLElement, peerId: string): boolean {
    if (!popup.isConnected || !isActivePeer(peerId)) {
      return false;
    }

    const images = popup.querySelectorAll<HTMLImageElement>(PREVIEW_IMAGE_SELECTOR);
    const image = images.length === 1 ? images.item(0) : null;
    const confirm = popup.querySelector<HTMLButtonElement>(CONFIRM_BUTTON_SELECTOR);
    const captionEditor = popup.querySelector<HTMLElement>(CAPTION_EDITOR_SELECTOR);
    return Boolean(
      image?.complete &&
      image.naturalWidth > 0 &&
      image.naturalHeight > 0 &&
      image.src.startsWith("blob:") &&
      confirm &&
      !confirm.disabled &&
      !captionEditor,
    );
  }

  private assertSessionActive(session: UploadPreviewSession): void {
    if (!session.popup.isConnected || !session.popup.matches(ACTIVE_PREVIEW_SELECTOR)) {
      throw new TelegramIntegrationError(
        "preview-cancelled",
        "Upload preview закрыт до завершения вставки подписи.",
      );
    }

    if (!isActivePeer(session.peerId)) {
      throw new TelegramIntegrationError(
        "peer-changed",
        "Чат получателя изменился до завершения вставки подписи.",
      );
    }
  }
}
