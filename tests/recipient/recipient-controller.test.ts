import { describe, expect, it, vi } from "vitest";
import { PendingTransfer } from "../../src/domain/PendingTransfer";
import type { Recipient } from "../../src/recipient/Recipient";
import { RecipientPickerController } from "../../src/recipient/RecipientPickerController";
import type { RecipientSourceAdapter } from "../../src/recipient/RecipientSourceAdapter";
import type { ComposerAdapter } from "../../src/telegram/ComposerAdapter";
import type { TelegramChatNavigator } from "../../src/telegram/TelegramChatNavigator";
import { RecipientPicker, type RecipientPickerActions } from "../../src/ui/RecipientPicker";
import { createLogger } from "../helpers";

const recipient: Recipient = { peerKey: "7", title: "Target", supported: true };

function createController(picker: RecipientPicker, pending: PendingTransfer) {
  const source: RecipientSourceAdapter = {
    listLoadedRecipients: vi.fn(async () => [recipient]),
  };
  const navigator = {
    navigate: vi.fn(async () => ({ success: true, message: "opened" })),
    notifyDomChanged: vi.fn(),
    cancel: vi.fn(),
  } as unknown as TelegramChatNavigator;
  const composer = {
    insert: vi.fn(async () => ({ success: true, message: "prepared" })),
    cancelPreparedPreview: vi.fn(async () => true),
  } as unknown as ComposerAdapter;
  return new RecipientPickerController(source, navigator, picker, composer, pending, createLogger());
}

describe("RecipientPickerController", () => {
  it("clears pending state when Cancel is clicked", async () => {
    const pending = new PendingTransfer();
    pending.select({ kind: "text", text: "payload" });
    const picker = new RecipientPicker();
    const controller = createController(picker, pending);
    await controller.open();
    document
      .querySelector<HTMLElement>("[data-clean-forward-recipient-picker]")!
      .shadowRoot!.querySelector<HTMLButtonElement>(".cancel")!
      .click();
    expect(pending.peek()).toBeNull();
    expect(picker.isVisible()).toBe(false);
  });

  it("clears pending state when the close cross is clicked", async () => {
    const pending = new PendingTransfer();
    pending.select({ kind: "text", text: "payload" });
    const picker = new RecipientPicker();
    const controller = createController(picker, pending);
    await controller.open();
    document
      .querySelector<HTMLElement>("[data-clean-forward-recipient-picker]")!
      .shadowRoot!.querySelector<HTMLButtonElement>(".close")!
      .click();
    expect(pending.peek()).toBeNull();
    expect(picker.isVisible()).toBe(false);
  });

  it("keeps the payload after a recoverable preparation error", async () => {
    const pending = new PendingTransfer();
    const payload = { kind: "text", text: "retry" } as const;
    pending.select(payload);
    let actions: RecipientPickerActions | null = null;
    const picker = {
      showLoading: vi.fn((value: RecipientPickerActions) => { actions = value; }),
      show: vi.fn((_items, value: RecipientPickerActions) => { actions = value; }),
      hide: vi.fn(),
      setBusy: vi.fn(),
    } as unknown as RecipientPicker;
    const source: RecipientSourceAdapter = { listLoadedRecipients: vi.fn(async () => [recipient]) };
    const navigator = {
      navigate: vi.fn(async () => ({ success: true, message: "opened" })),
      notifyDomChanged: vi.fn(),
      cancel: vi.fn(),
    } as unknown as TelegramChatNavigator;
    const composer = {
      insert: vi.fn(async () => ({ success: false, message: "preview failed" })),
      cancelPreparedPreview: vi.fn(async () => true),
    } as unknown as ComposerAdapter;
    const controller = new RecipientPickerController(
      source,
      navigator,
      picker,
      composer,
      pending,
      createLogger(),
    );

    await controller.open();
    const currentActions = actions as RecipientPickerActions | null;
    expect(currentActions).not.toBeNull();
    currentActions!.onNext(recipient);
    await vi.waitFor(() => expect(composer.insert).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(picker.show).toHaveBeenCalledTimes(2));
    expect(pending.peek()).toBe(payload);
  });

  it("aborts the active session and drops temporary callbacks on close", async () => {
    const pending = new PendingTransfer();
    pending.select({ kind: "text", text: "payload" });
    let observedSignal: AbortSignal | null = null;
    const source: RecipientSourceAdapter = {
      listLoadedRecipients: vi.fn((signal) => {
        observedSignal = signal;
        return new Promise<readonly Recipient[]>((_, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("cancelled", "AbortError")),
            { once: true },
          );
        });
      }),
    };
    const picker = new RecipientPicker();
    const navigator = {
      notifyDomChanged: vi.fn(),
      cancel: vi.fn(),
    } as unknown as TelegramChatNavigator;
    const composer = {} as ComposerAdapter;
    const controller = new RecipientPickerController(
      source,
      navigator,
      picker,
      composer,
      pending,
      createLogger(),
    );
    const opening = controller.open();
    controller.cancel();
    await opening;
    expect((observedSignal as unknown as AbortSignal).aborted).toBe(true);
    expect(navigator.cancel).toHaveBeenCalled();
    expect(picker.isVisible()).toBe(false);
  });
});
