/** Builds and starts the userscript dependency graph after Telegram's document is ready. */
import { CleanForwardController } from "./app/CleanForwardController";
import { PendingTransfer } from "./domain/PendingTransfer";
import { RecipientPickerController } from "./recipient/RecipientPickerController";
import { ComposerAdapter } from "./telegram/ComposerAdapter";
import { MediaModeActivator } from "./telegram/MediaModeActivator";
import { MessageExtractor } from "./telegram/MessageExtractor";
import { TelegramChatNavigator } from "./telegram/TelegramChatNavigator";
import { ContextMenuIntegration } from "./telegram/TelegramContextMenuIntegration";
import { TelegramDomAdapter } from "./telegram/TelegramDomAdapter";
import { TelegramRecipientSourceAdapter } from "./telegram/TelegramRecipientSourceAdapter";
import { UploadPreviewAdapter } from "./telegram/UploadPreviewAdapter";
import { RecipientPicker } from "./ui/RecipientPicker";
import { logger } from "./utils/logger";

/** Creates one instance of every application service and starts the controller. */
function bootstrap(): void {
  const telegramDom = new TelegramDomAdapter(logger);
  const pending = new PendingTransfer();
  const composer = new ComposerAdapter(
    telegramDom,
    new MediaModeActivator(),
    new UploadPreviewAdapter(),
  );
  const recipientController = new RecipientPickerController(
    new TelegramRecipientSourceAdapter(),
    new TelegramChatNavigator(logger),
    new RecipientPicker(),
    composer,
    pending,
    logger,
  );
  const controller = new CleanForwardController(
    telegramDom,
    new MessageExtractor(telegramDom, logger),
    pending,
    new ContextMenuIntegration(logger),
    recipientController,
    logger,
  );

  controller.start();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
} else {
  bootstrap();
}
