import { describe, expect, it, vi } from "vitest";
import { PendingTransfer } from "../../src/domain/PendingTransfer";
import {
  createMessagePayload,
  type MessagePayload,
} from "../../src/domain/MessagePayload";
import {
  createSourceChatDescriptor,
  createSourceMessageDescriptor,
} from "../../src/domain/SourceMessageDescriptor";
import { createPlainTextContent } from "../../src/domain/TransferableContent";
import { createTextTransferUnit } from "../../src/domain/TransferUnit";
import type { DeliveryCoordinator } from "../../src/delivery/DeliveryCoordinator";
import type { Recipient } from "../../src/recipient/Recipient";
import { RecipientPickerController } from "../../src/recipient/RecipientPickerController";
import type { RecipientSourceAdapter } from "../../src/recipient/RecipientSourceAdapter";
import type { ComposerAdapter } from "../../src/telegram/ComposerAdapter";
import type { TelegramChatNavigator } from "../../src/telegram/TelegramChatNavigator";
import { RecipientPicker, type RecipientPickerActions } from "../../src/ui/RecipientPicker";
import { createLogger, createTextMessagePayload } from "../helpers";

const recipient: Recipient = { peerKey: "7", title: "Fixture recipient", supported: true };

function payloadWithSourceLocator(): MessagePayload {
  const source = createSourceChatDescriptor("42", "Immutable source", "@immutable_source");
  const message = createSourceMessageDescriptor({
    resolution: "telegram-model",
    sourcePeerKey: source.peerKey,
    mid: 1,
    date: 1,
    order: 0,
  });
  return createMessagePayload({
    operationId: "immutable-source-picker",
    source,
    messages: [message],
    units: [createTextTransferUnit([message], createPlainTextContent("fixture"))],
  });
}

function createController(picker: RecipientPicker, pending: PendingTransfer) {
  const source: RecipientSourceAdapter = {
    listLoadedRecipients: vi.fn(async () => [recipient]),
    searchRecipients: vi.fn(),
    clearSearch: vi.fn(),
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
  it("hands delivery only the immutable payload source locator, never a late DOM title/query", async () => {
    const pending = new PendingTransfer();
    pending.select(payloadWithSourceLocator());
    let actions: RecipientPickerActions | null = null;
    const picker = {
      showLoading: vi.fn((value: RecipientPickerActions) => { actions = value; }),
      show: vi.fn((_items, value: RecipientPickerActions) => { actions = value; }),
      hide: vi.fn(),
      updateSelection: vi.fn(),
      setError: vi.fn(),
    } as unknown as RecipientPicker;
    const source: RecipientSourceAdapter = {
      getActiveRecipient: vi.fn(() => ({
        peerKey: "42",
        title: "Wrong late title",
        searchQuery: "@wrong_late_query",
        supported: true,
      })),
      listLoadedRecipients: vi.fn(async () => [recipient]),
      searchRecipients: vi.fn(),
      clearSearch: vi.fn(),
    };
    const delivery = {
      start: vi.fn(() => Promise.resolve({})),
      notifyDomChanged: vi.fn(),
      stop: vi.fn(),
    } as unknown as DeliveryCoordinator;
    const controller = new RecipientPickerController(
      source,
      { cancel: vi.fn(), notifyDomChanged: vi.fn() } as unknown as TelegramChatNavigator,
      picker,
      {} as ComposerAdapter,
      pending,
      createLogger(),
      delivery,
    );

    await controller.open();
    actions!.onToggle?.(recipient);
    actions!.onNext();

    expect(delivery.start).toHaveBeenCalledWith(
      [expect.objectContaining({ peerKey: recipient.peerKey })],
      {
        peerKey: "42",
        title: "Immutable source",
        searchQuery: "@immutable_source",
        supported: true,
      },
    );
  });

  it("uses active DOM only as exact-peer verification for the captured source", async () => {
    const pending = new PendingTransfer();
    pending.select(payloadWithSourceLocator());
    const picker = {
      showLoading: vi.fn(),
      show: vi.fn(),
      updateSelection: vi.fn(),
      setError: vi.fn(),
      hide: vi.fn(),
    } as unknown as RecipientPicker;
    const source: RecipientSourceAdapter = {
      getActiveRecipient: vi.fn(() => ({ peerKey: "99", title: "Other", supported: true })),
      listLoadedRecipients: vi.fn(async () => [recipient]),
      searchRecipients: vi.fn(),
      clearSearch: vi.fn(),
    };
    const delivery = { start: vi.fn() } as unknown as DeliveryCoordinator;
    const controller = new RecipientPickerController(
      source,
      { cancel: vi.fn(), notifyDomChanged: vi.fn() } as unknown as TelegramChatNavigator,
      picker,
      {} as ComposerAdapter,
      pending,
      createLogger(),
      delivery,
    );

    await controller.open();
    const actions = vi.mocked(picker.showLoading).mock.calls[0]?.[0];
    actions?.onToggle?.(recipient);
    actions?.onNext();

    expect(delivery.start).not.toHaveBeenCalled();
  });

  it("clears pending state when Cancel is clicked", async () => {
    const pending = new PendingTransfer();
    pending.select(createTextMessagePayload("fixture-payload"));
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
    pending.select(createTextMessagePayload("fixture-payload"));
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
    const payload = createTextMessagePayload("fixture-retry");
    pending.select(payload);
    let actions: RecipientPickerActions | null = null;
    const picker = {
      showLoading: vi.fn((value: RecipientPickerActions) => { actions = value; }),
      show: vi.fn((_items, value: RecipientPickerActions) => { actions = value; }),
      hide: vi.fn(),
      setBusy: vi.fn(),
    } as unknown as RecipientPicker;
    const source: RecipientSourceAdapter = {
      listLoadedRecipients: vi.fn(async () => [recipient]),
      searchRecipients: vi.fn(),
      clearSearch: vi.fn(),
    };
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
    pending.select(createTextMessagePayload("fixture-payload"));
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
      searchRecipients: vi.fn(),
      clearSearch: vi.fn(),
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

  it("clearing search restores recent recipients without losing selection", async () => {
    const pending = new PendingTransfer();
    pending.select(createTextMessagePayload("fixture-payload"));
    const recent: Recipient = { peerKey: "10", title: "Recent", supported: true };
    const found: Recipient = { peerKey: "20", title: "Found remotely", supported: true };
    let actions: RecipientPickerActions | null = null;
    let publishSearch: ((recipients: readonly Recipient[]) => void) | null = null;
    const picker = {
      showLoading: vi.fn((value: RecipientPickerActions) => { actions = value; }),
      show: vi.fn((_items, value: RecipientPickerActions) => { actions = value; }),
      updateRecipients: vi.fn(),
      updateSelection: vi.fn(),
      setSearchLoading: vi.fn(),
      setError: vi.fn(),
    } as unknown as RecipientPicker;
    const source: RecipientSourceAdapter = {
      listLoadedRecipients: vi.fn(async () => [recent]),
      searchRecipients: vi.fn((_query, _signal, onUpdate) => { publishSearch = onUpdate; }),
      clearSearch: vi.fn(),
    };
    const controller = new RecipientPickerController(
      source,
      { cancel: vi.fn(), notifyDomChanged: vi.fn() } as unknown as TelegramChatNavigator,
      picker,
      {} as ComposerAdapter,
      pending,
      createLogger(),
    );

    await controller.open();
    actions!.onToggle?.(recent);
    actions!.onSearchQueryChange?.("Found remotely");
    publishSearch!([found]);
    expect(picker.updateRecipients).toHaveBeenLastCalledWith([found], ["10"]);

    actions!.onSearchQueryChange?.("");
    expect(source.clearSearch).toHaveBeenCalled();
    expect(picker.updateRecipients).toHaveBeenLastCalledWith([recent], ["10"]);
  });
});
