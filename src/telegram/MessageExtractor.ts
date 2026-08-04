/** Converts a verified Telegram message snapshot into a supported in-memory payload. */
import type { MessagePayload } from "../domain/MessagePayload";
import type { Logger } from "../utils/logger";
import type { TelegramDomAdapter, TelegramMessageSnapshot } from "./TelegramDomAdapter";

const DEFAULT_IMAGE_FILE_NAME = "telegram-image.jpg";

/** Extracts only plain text, one image, or one image with a caption. */
export class MessageExtractor {
  public constructor(
    private readonly dom: TelegramDomAdapter,
    private readonly log: Logger,
  ) {}

  /** Returns a supported payload, or null when the message is unsupported or cannot be read. */
  public async extract(message: HTMLElement): Promise<MessagePayload | null> {
    const snapshot = this.dom.readMessageSnapshot(message);
    if (!snapshot || !this.isSupported(snapshot)) {
      this.log.warn("extractMessagePayload не создал payload.", {
        snapshotFound: Boolean(snapshot),
      });
      return null;
    }

    const text = snapshot.text?.trim() ?? "";
    if (!snapshot.imageUrl) {
      const payload: MessagePayload | null = text ? { kind: "text", text } : null;
      this.log.info("Результат extractMessagePayload.", {
        kind: payload?.kind ?? null,
      });
      return payload;
    }

    try {
      const image = await this.loadImage(snapshot.imageUrl);
      const payload: MessagePayload = {
        kind: "image",
        image,
        fileName: DEFAULT_IMAGE_FILE_NAME,
        ...(text ? { caption: text } : {}),
      };
      this.log.info("Результат extractMessagePayload.", {
        kind: payload.kind,
        hasCaption: Boolean(text),
        imageBytes: image.size,
      });
      return payload;
    } catch (error) {
      this.log.error("Не удалось загрузить выбранную картинку в память.", error);
      return null;
    }
  }

  private isSupported(snapshot: TelegramMessageSnapshot): boolean {
    if (snapshot.hasUnsupportedAttachment || snapshot.imageCount > 1) {
      this.log.warn("Выбранный тип сообщения пока не поддерживается.");
      return false;
    }

    return snapshot.imageCount === 0 || snapshot.imageCount === 1;
  }

  private async loadImage(url: string): Promise<Blob> {
    // Fetching the browser-owned URL preserves the image in memory without external storage.
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Image request failed with status ${response.status}`);
    }

    return response.blob();
  }
}
