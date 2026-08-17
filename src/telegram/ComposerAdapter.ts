/** Orchestrates safe composer insertion while Telegram-specific mechanics stay in the DOM adapter. */
import type {
  ImageDeliveryPayload,
  TelegramDeliveryPayload,
} from "../domain/TelegramDeliveryPayload";
import { toTelegramDeliveryPayloadUnit } from "../domain/MessagePayload";
import type { TransferUnit } from "../domain/TransferUnit";
import { createImageFile } from "./ImageFileFactory";
import { createTransferFile } from "./TransferFileFactory";
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
    payload: TelegramDeliveryPayload,
    expectedPeerKey: string,
  ): Promise<ComposerInsertResult> {
    if (payload.kind === "image") {
      return this.prepareImage(payload, expectedPeerKey);
    }

    return this.dom.insertTextIntoComposer(payload.text, expectedPeerKey)
      ? { success: true, message: "Текст подготовлен и проверен перед Send." }
      : { success: false, message: "Не удалось вставить текст в активный composer." };
  }

  /** Prepares one generalized unit or fails before Send when no proven native strategy exists. */
  public async prepareUnit(
    unit: TransferUnit,
    expectedPeerKey: string,
  ): Promise<ComposerInsertResult> {
    const payload = toTelegramDeliveryPayloadUnit(unit);
    if (payload) {
      return this.insert(payload, expectedPeerKey);
    }
    if (unit.kind === "file" || unit.kind === "media-group") {
      return this.prepareUploadUnit(unit, expectedPeerKey);
    }
    if (unit.kind === "text" && unit.content.kind === "formatted-text") {
      return {
        success: false,
        message: "Formatted entities have no proven lossless native composer injection contract.",
      };
    }
    if (unit.kind === "text") {
      return {
        success: false,
        message: "The requested link-preview policy has no proven native composer control.",
      };
    }
    return {
      success: false,
      message: "The captured poll template lacks every setting exposed by the current Telegram popup.",
    };
  }

  /** Removes only project-owned prepared content when cancellation happens before Send. */
  public async cancelPreparedPayload(
    payload: TelegramDeliveryPayload,
    expectedPeerKey: string,
  ): Promise<boolean> {
    if (payload.kind === "image") {
      return this.cancelPreparedPreview();
    }
    return this.dom.clearPreparedText(payload.text, expectedPeerKey);
  }

  /** Removes only content prepared for one generalized unit before its Send boundary. */
  public async cancelPreparedUnit(unit: TransferUnit, expectedPeerKey: string): Promise<boolean> {
    const payload = toTelegramDeliveryPayloadUnit(unit);
    if (payload) return this.cancelPreparedPayload(payload, expectedPeerKey);
    return unit.kind === "file" || unit.kind === "media-group"
      ? this.cancelPreparedPreview()
      : true;
  }

  /** Reports why the last preview cleanup could not be confirmed, when the adapter exposes it. */
  public describePreviewObstacle(): string | null {
    return this.preview.describeCancelObstacle?.() ?? null;
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
    payload: ImageDeliveryPayload,
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

  private async prepareUploadUnit(
    unit: Extract<TransferUnit, { kind: "file" | "media-group" }>,
    expectedPeerKey: string,
  ): Promise<ComposerInsertResult> {
    if (this.imageOperationInProgress) {
      return { success: false, message: OPERATION_IN_PROGRESS_MESSAGE };
    }

    const items = unit.kind === "file" ? [unit.item] : unit.items;
    const captions = items.filter((item) => item.caption);
    if (
      captions.some((item) => (item.caption?.entities.length ?? 0) > 0) ||
      captions.length > 1 ||
      (captions.length === 1 && captions[0] !== items[0])
    ) {
      return { success: false, message: "Native upload cannot preserve these caption boundaries losslessly." };
    }
    if (unit.kind === "media-group" && unit.expectedGroups.length !== 1) {
      return { success: false, message: "Telegram preview cannot prove the captured album partition." };
    }

    this.imageOperationInProgress = true;
    if (!this.preview.hasActivePreview()) this.ownsOpenPreview = false;
    try {
      const mode = unit.delivery.prepareCapability === "document-upload" ? "document" : "media";
      const target = await this.mediaMode.arm(mode);
      if (target.peerId !== expectedPeerKey) {
        throw new TelegramIntegrationError("peer-changed", "Telegram opened another chat before upload preparation.");
      }
      const files = items.map((item) => createTransferFile(item.media));
      this.preview.selectFiles(target, files);
      const session = await this.preview.waitUntilReadyForUnit(target.peerId, unit);
      this.ownsOpenPreview = true;
      const caption = items[0]?.caption?.text;
      if (caption) await this.preview.insertCaption(session, caption);
      return { success: true, message: "Native upload preview is ready and peer-scoped." };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Upload preparation failed.";
      if (this.preview.hasActivePreview()) {
        const cleaned = await this.preview.cancelActivePreview();
        this.ownsOpenPreview = !cleaned;
        return { success: false, message: cleaned ? message : `${message} Preview cleanup was not confirmed.` };
      }
      return { success: false, message };
    } finally {
      this.imageOperationInProgress = false;
    }
  }
}
