/** Builds and starts the userscript dependency graph after Telegram's document is ready. */
import { CleanForwardController } from "./app/CleanForwardController";
import { claimCleanForwardRuntime } from "./app/CleanForwardRuntime";
import { DeliveryCoordinator } from "./delivery/DeliveryCoordinator";
import { PendingTransfer } from "./domain/PendingTransfer";
import { RecipientPickerController } from "./recipient/RecipientPickerController";
import { ComposerAdapter } from "./telegram/ComposerAdapter";
import { MediaModeActivator } from "./telegram/MediaModeActivator";
import { MessageExtractor } from "./telegram/MessageExtractor";
import { TelegramChatNavigator } from "./telegram/TelegramChatNavigator";
import { ContextMenuIntegration } from "./telegram/TelegramContextMenuIntegration";
import { TelegramDomAdapter } from "./telegram/TelegramDomAdapter";
import { TelegramRecipientSourceAdapter } from "./telegram/TelegramRecipientSourceAdapter";
import { TelegramSelectionDomAdapter } from "./telegram/TelegramSelectionDomAdapter";
import { TelegramSelectionIntegration } from "./telegram/TelegramSelectionIntegration";
import { TelegramSendAdapter } from "./telegram/TelegramSendAdapter";
import { UploadPreviewAdapter } from "./telegram/UploadPreviewAdapter";
import { CaptureNotice } from "./ui/CaptureNotice";
import { DeliveryProgressPanel } from "./ui/DeliveryProgressPanel";
import { RecipientPicker } from "./ui/RecipientPicker";
import { logger } from "./utils/logger";

/** Creates one instance of every application service and starts the controller. */
function bootstrap(): void {
  const runtime = claimCleanForwardRuntime(
    document,
    window as unknown as Record<string, unknown>,
    logger,
  );
  if (!runtime) {
    return;
  }

  try {
    const telegramDom = new TelegramDomAdapter(logger);
    const telegramSelection = new TelegramSelectionDomAdapter(telegramDom, logger);
    const pending = new PendingTransfer();
    const preview = new UploadPreviewAdapter();
    const recipientSource = new TelegramRecipientSourceAdapter();
    const navigator = new TelegramChatNavigator(logger, recipientSource);
    const composer = new ComposerAdapter(
      telegramDom,
      new MediaModeActivator(),
      preview,
    );
    const delivery = new DeliveryCoordinator(
      navigator,
      composer,
      new TelegramSendAdapter(logger),
      pending,
      new DeliveryProgressPanel(),
      logger,
    );
    const recipientController = new RecipientPickerController(
      recipientSource,
      navigator,
      new RecipientPicker(),
      composer,
      pending,
      logger,
      delivery,
    );
    const controller = new CleanForwardController(
      telegramDom,
      new MessageExtractor(telegramDom, logger),
      pending,
      new ContextMenuIntegration(logger),
      telegramSelection,
      new TelegramSelectionIntegration(logger),
      recipientController,
      logger,
      new CaptureNotice(),
    );

    runtime.start(controller);
  } catch (error) {
    runtime.stop();
    logger.error("Clean Forward runtime bootstrap failed.", {
      runtime: runtime.identity,
      error,
    });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
} else {
  bootstrap();
}
