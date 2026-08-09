import { describe, expect, it, vi } from "vitest";
import type { DeliveryCoordinator } from "../../src/delivery/DeliveryCoordinator";
import { PendingTransfer } from "../../src/domain/PendingTransfer";
import type { Recipient } from "../../src/recipient/Recipient";
import { RecipientPickerController } from "../../src/recipient/RecipientPickerController";
import type { RecipientSourceAdapter } from "../../src/recipient/RecipientSourceAdapter";
import type { ComposerAdapter } from "../../src/telegram/ComposerAdapter";
import type { TelegramChatNavigator } from "../../src/telegram/TelegramChatNavigator";
import type { RecipientPicker, RecipientPickerActions } from "../../src/ui/RecipientPicker";
import { createLogger } from "../helpers";

const first: Recipient = { peerKey: "101", title: "First", supported: true };
const second: Recipient = { peerKey: "202", title: "Second", supported: true };

describe("automatic recipient-controller wiring", () => {
  it("hands one ordered snapshot to delivery and blocks a double Next", async () => {
    const pending = new PendingTransfer();
    pending.select({ kind: "text", text: "payload" });
    let actions: RecipientPickerActions | null = null;
    const picker = {
      showLoading: vi.fn((next: RecipientPickerActions) => { actions = next; }),
      show: vi.fn((_recipients, next: RecipientPickerActions) => { actions = next; }),
      hide: vi.fn(),
      updateSelection: vi.fn(),
      setError: vi.fn(),
    } as unknown as RecipientPicker;
    const source: RecipientSourceAdapter = {
      listLoadedRecipients: vi.fn(async () => [first, second]),
      searchRecipients: vi.fn(),
      clearSearch: vi.fn(),
    };
    const navigator = {
      navigate: vi.fn(),
      notifyDomChanged: vi.fn(),
      cancel: vi.fn(),
    } as unknown as TelegramChatNavigator;
    const composer = { insert: vi.fn() } as unknown as ComposerAdapter;
    const delivery = {
      start: vi.fn(() => Promise.resolve({})),
      notifyDomChanged: vi.fn(),
      stop: vi.fn(),
    } as unknown as DeliveryCoordinator;
    const controller = new RecipientPickerController(
      source,
      navigator,
      picker,
      composer,
      pending,
      createLogger(),
      delivery,
    );

    await controller.open();
    const current = actions as RecipientPickerActions | null;
    if (!current) throw new Error("Picker actions are unavailable");
    current.onToggle?.(second);
    current.onToggle?.(first);
    current.onNext();
    current.onNext();

    expect(delivery.start).toHaveBeenCalledOnce();
    expect(delivery.start).toHaveBeenCalledWith([
      expect.objectContaining({ peerKey: "202" }),
      expect.objectContaining({ peerKey: "101" }),
    ]);
    expect(picker.hide).toHaveBeenCalled();
    expect(navigator.navigate).not.toHaveBeenCalled();
    expect(composer.insert).not.toHaveBeenCalled();
  });
});
