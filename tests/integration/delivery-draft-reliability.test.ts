import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config";
import { DeliveryCoordinator } from "../../src/delivery/DeliveryCoordinator";
import { PendingTransfer } from "../../src/domain/PendingTransfer";
import type { Recipient } from "../../src/recipient/Recipient";
import { ComposerAdapter } from "../../src/telegram/ComposerAdapter";
import type { MediaModeActivator } from "../../src/telegram/MediaModeActivator";
import { TelegramDomAdapter } from "../../src/telegram/TelegramDomAdapter";
import type { TelegramChatNavigator } from "../../src/telegram/TelegramChatNavigator";
import type { TelegramSendAdapter } from "../../src/telegram/TelegramSendAdapter";
import type { UploadPreviewAdapter } from "../../src/telegram/UploadPreviewAdapter";
import { readTelegramText } from "../../src/telegram/readTelegramText";
import type { DeliveryProgressPanel } from "../../src/ui/DeliveryProgressPanel";
import { createLogger, createTextMessagePayload, installComposer } from "../helpers";

const source: Recipient = { peerKey: "101", title: "Source", supported: true };
const destination: Recipient = { peerKey: "202", title: "Destination", supported: true };
const config: AppConfig = { debug: { showDeliveryResultDialog: false } };

describe("delivery draft reliability", () => {
  it.each([
    { label: "success", outcome: "success", expectedAttempts: 1 },
    { label: "terminal pre-Send failure", outcome: "failure", expectedAttempts: 3 },
    { label: "pre-Send cancellation", outcome: "cancel", expectedAttempts: 0 },
  ])(
    "preserves a destination user draft after $label without sending it",
    async ({ outcome, expectedAttempts }) => {
      installComposer(source.peerKey);
      const pending = new PendingTransfer();
      pending.select(createTextMessagePayload("clean-forward payload", source.peerKey));
      const log = createLogger();
      let destinationDraftAtRestore: string | null = null;
      const navigator = {
        navigate: vi.fn(async (recipient: Recipient) => {
          const active = document.querySelector<HTMLElement>(".input-message-input");
          if (recipient.peerKey === source.peerKey) {
            if (active?.dataset.peerId === destination.peerKey) {
              destinationDraftAtRestore = readTelegramText(active);
            }
            document.querySelectorAll(".chat-input-main").forEach((node) => node.remove());
            installComposer(source.peerKey);
          } else if (active?.dataset.peerId !== destination.peerKey) {
            document.querySelectorAll(".chat-input-main").forEach((node) => node.remove());
            installComposer(destination.peerKey, "user draft");
          }
          return { success: true as const, message: "opened" };
        }),
        notifyDomChanged: vi.fn(),
        cancel: vi.fn(),
      } as unknown as TelegramChatNavigator;
      const actualComposer = new ComposerAdapter(
        new TelegramDomAdapter(log),
        {} as MediaModeActivator,
        {} as UploadPreviewAdapter,
      );
      let coordinator: DeliveryCoordinator;
      const composer = outcome === "cancel"
        ? {
            beginDraftTransaction: actualComposer.beginDraftTransaction.bind(actualComposer),
            prepareUnit: async (...args: Parameters<ComposerAdapter["prepareUnit"]>) => {
              const result = await actualComposer.prepareUnit(...args);
              coordinator.requestCancel();
              return result;
            },
            cancelPreparedUnit: actualComposer.cancelPreparedUnit.bind(actualComposer),
          } as unknown as ComposerAdapter
        : actualComposer;
      const observedSendContents: string[] = [];
      const sender = {
        sendPreparedUnit: vi.fn(async (
          _unit: unknown,
          peerKey: string,
          _signal: AbortSignal,
          onSendClicked: () => void,
        ) => {
          const active = document.querySelector<HTMLElement>(".input-message-input");
          expect(active?.dataset.peerId).toBe(peerKey);
          observedSendContents.push(active ? readTelegramText(active) : "");
          if (outcome === "failure") {
            return { status: "failed" as const, message: "native Send unavailable" };
          }
          onSendClicked();
          active?.replaceChildren();
          return { status: "sent" as const, messageId: "destination-mid" };
        }),
        notifyDomChanged: vi.fn(),
        cancel: vi.fn(),
      } as unknown as TelegramSendAdapter;
      const progress = {
        show: vi.fn(), update: vi.fn(), hide: vi.fn(),
      } as unknown as DeliveryProgressPanel;
      coordinator = new DeliveryCoordinator(
        navigator, composer, sender, pending, progress, log, config,
      );

      const result = await coordinator.start([destination], source)!;

      expect(observedSendContents).toEqual(
        Array.from({ length: expectedAttempts }, () => "clean-forward payload"),
      );
      expect(observedSendContents).not.toContain("user draft");
      expect(destinationDraftAtRestore).toBe("user draft");
      expect(result.sentCount).toBe(outcome === "success" ? 1 : 0);
      expect(result.failedCount).toBe(outcome === "failure" ? 1 : 0);
      expect(result.cancelRequested).toBe(outcome === "cancel");
    },
  );
});
