/** Orchestrates safe composer insertion while Telegram-specific mechanics stay in the DOM adapter. */
import type { MessagePayload } from "../domain/MessagePayload";
import type { ImageMessagePayload } from "../domain/MessagePayload";
import { createImageFile } from "./ImageFileFactory";
import type { MediaModeActivator } from "./MediaModeActivator";
import type { ComposerDraftTransactionStart } from "./ComposerDraftTransaction";
import type { TelegramDomAdapter } from "./TelegramDomAdapter";
import { TelegramIntegrationError } from "./TelegramIntegrationError";
import type { UploadPreviewAdapter } from "./UploadPreviewAdapter";

/** Outcome shown by the transfer panel after an insertion attempt. */
export interface ComposerInsertResult {
  readonly success: boolean;
  readonly message: string;
}

const OPERATION_IN_PROGRESS_MESSAGE = "Подготовка картинки уже выполняется.";

type ImagePreparationState =
  | "idle"
  | "arming-media"
  | "file-selected"
  | "preview-rendering"
  | "preview-ready"
  | "caption-ready"
  | "cancelling"
  | "clean";

/** Places supported payloads into the current chat before a separate native Send step. */
export class ComposerAdapter {
  private imageOperationInProgress = false;
  private ownsOpenPreview = false;

  public constructor(
    private readonly dom: TelegramDomAdapter,
    private readonly mediaMode: MediaModeActivator,
    private readonly preview: UploadPreviewAdapter,
  ) {}

  /** Begins a peer-scoped plain-text draft transaction before payload preparation. */
  public beginDraftTransaction(expectedPeerKey: string): ComposerDraftTransactionStart {
    return this.dom.beginDraftTransaction(expectedPeerKey);
  }

  /** Attempts to populate the current composer without activating a Send control itself. */
  public async insert(
    payload: MessagePayload,
    expectedPeerKey: string,
  ): Promise<ComposerInsertResult> {
    if (payload.kind === "image") {
      return this.prepareImage(payload, expectedPeerKey);
    }

    return this.dom.insertTextIntoComposer(payload.text, expectedPeerKey)
      ? { success: true, message: "Текст подготовлен и проверен перед Send." }
      : { success: false, message: "Не удалось вставить текст в активный composer." };
  }

  /** Removes only project-owned prepared content when cancellation happens before Send. */
  public async cancelPreparedPayload(
    payload: MessagePayload,
    expectedPeerKey: string,
  ): Promise<boolean> {
    if (payload.kind === "image") {
      return this.cancelPreparedPreview();
    }
    return this.dom.clearPreparedText(payload.text, expectedPeerKey);
  }

  /** Safely closes a media preview left open after a recoverable partial failure. */
  public async cancelPreparedPreview(): Promise<boolean> {
    if (!this.ownsOpenPreview) {
      return true;
    }

    const closed = await this.preview.cancelActivePreview();
    if (closed) {
      this.ownsOpenPreview = false;
    }
    return closed;
  }

  private async prepareImage(
    payload: ImageMessagePayload,
    expectedPeerKey: string,
  ): Promise<ComposerInsertResult> {
    if (this.imageOperationInProgress) {
      return { success: false, message: OPERATION_IN_PROGRESS_MESSAGE };
    }

    this.imageOperationInProgress = true;
    if (!this.preview.hasActivePreview()) {
      this.ownsOpenPreview = false;
    }
    let state: ImagePreparationState = "idle";

    try {
      const file = createImageFile(payload.image, payload.fileName);
      state = "arming-media";
      const target = await this.mediaMode.arm();
      if (target.peerId !== expectedPeerKey) {
        throw new TelegramIntegrationError(
          "peer-changed",
          "Telegram открыл другой чат до подготовки картинки.",
        );
      }

      state = "file-selected";
      this.preview.selectFile(target, file);
      state = "preview-rendering";
      const session = await this.preview.waitUntilReady(target.peerId);

      state = "preview-ready";
      this.ownsOpenPreview = true;
      if (payload.caption) {
        await this.preview.insertCaption(session, payload.caption);
        state = "caption-ready";
      }

      return {
        success: true,
        message: "Картинка и подпись подготовлены и проверены перед Send.",
      };
    } catch (error) {
      const integrationError =
        error instanceof TelegramIntegrationError
          ? error
          : new TelegramIntegrationError(
              "preview-timeout",
              error instanceof Error ? error.message : "Неизвестная ошибка подготовки картинки.",
            );

      const previewMayExist =
        state === "preview-rendering" ||
        state === "preview-ready" ||
        state === "caption-ready";
      if (
        previewMayExist &&
        this.preview.hasActivePreview() &&
        !integrationError.preservePreview
      ) {
        state = "cancelling";
        const cleaned = await this.preview.cancelActivePreview();
        state = "clean";
        if (!cleaned) {
          this.ownsOpenPreview = true;
          return {
            success: false,
            message: `${integrationError.message} Не удалось полностью закрыть preview; закройте его вручную.`,
          };
        }
        this.ownsOpenPreview = false;
      } else if (integrationError.preservePreview && this.preview.hasActivePreview()) {
        this.ownsOpenPreview = true;
      }

      return { success: false, message: integrationError.message };
    } finally {
      this.imageOperationInProgress = false;
    }
  }
}
