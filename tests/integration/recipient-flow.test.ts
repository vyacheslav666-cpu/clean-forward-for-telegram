import { describe, expect, it, vi } from "vitest";
import type { MessagePayload } from "../../src/domain/MessagePayload";
import { PendingTransfer } from "../../src/domain/PendingTransfer";
import type { Recipient } from "../../src/recipient/Recipient";
import { RecipientPickerController } from "../../src/recipient/RecipientPickerController";
import type { RecipientSourceAdapter } from "../../src/recipient/RecipientSourceAdapter";
import type { ComposerAdapter } from "../../src/telegram/ComposerAdapter";
import type { ChatNavigationResult, TelegramChatNavigator } from "../../src/telegram/TelegramChatNavigator";
import { RecipientPicker, type RecipientPickerActions } from "../../src/ui/RecipientPicker";
import { createLogger } from "../helpers";

const first: Recipient = { peerKey: "101", title: "Fixture recipient A", supported: true };
const second: Recipient = { peerKey: "202", title: "Fixture recipient B", supported: true };

function createFlow(options: {
  payload?: MessagePayload;
  navigate?: (recipient: Readonly<Recipient>, signal: AbortSignal) => Promise<ChatNavigationResult>;
  insert?: (payload: MessagePayload, peerKey: string) => Promise<{ success: boolean; message: string }>;
} = {}) {
  const pending = new PendingTransfer();
  const payload = options.payload ?? { kind: "text", text: "fixture-text" };
  pending.select(payload);
  let actions: RecipientPickerActions | null = null;
  const picker = {
    showLoading: vi.fn((nextActions: RecipientPickerActions) => { actions = nextActions; }),
    show: vi.fn((_recipients, nextActions: RecipientPickerActions) => { actions = nextActions; }),
    hide: vi.fn(),
    setBusy: vi.fn(),
    setError: vi.fn(),
    updateSelection: vi.fn(),
  } as unknown as RecipientPicker;
  const source: RecipientSourceAdapter = {
    listLoadedRecipients: vi.fn(async () => [first, second]),
  };
  const navigator = {
    navigate: vi.fn(options.navigate ?? (async () => ({ success: true, message: "opened" }))),
    notifyDomChanged: vi.fn(),
    cancel: vi.fn(),
  } as unknown as TelegramChatNavigator;
  const composer = {
    insert: vi.fn(options.insert ?? (async () => ({ success: true, message: "prepared" }))),
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
  const currentActions = (): RecipientPickerActions => {
    if (!actions) throw new Error("Picker actions are unavailable");
    return actions;
  };
  return { controller, pending, payload, picker, navigator, composer, currentActions };
}

async function selectAndConfirm(
  flow: ReturnType<typeof createFlow>,
  recipients: readonly Recipient[] = [first],
): Promise<void> {
  await flow.controller.open();
  recipients.forEach((recipient) => flow.currentActions().onToggle?.(recipient));
  flow.currentActions().onNext();
}

describe("recipient flow integration through adapter boundaries", () => {
  it("runs text → picker → one recipient → navigation → composer", async () => {
    const flow = createFlow();
    await selectAndConfirm(flow);
    await vi.waitFor(() => expect(flow.composer.insert).toHaveBeenCalledOnce());
    expect(flow.navigator.navigate).toHaveBeenCalledWith(first, expect.any(AbortSignal));
    expect(flow.composer.insert).toHaveBeenCalledWith(flow.payload, "101");
    expect(flow.pending.peek()).toBeNull();
  });

  it("passes a photo and caption unchanged to the existing preview pipeline", async () => {
    const payload: MessagePayload = {
      kind: "image",
      image: new Blob(["photo"], { type: "image/jpeg" }),
      fileName: "photo.jpg",
      caption: "fixture-caption 🙂",
    };
    const flow = createFlow({ payload });
    await selectAndConfirm(flow);
    await vi.waitFor(() => expect(flow.composer.insert).toHaveBeenCalledWith(payload, "101"));
  });

  it("cancels the picker and clears pending payload", async () => {
    const flow = createFlow();
    await flow.controller.open();
    flow.currentActions().onCancel();
    expect(flow.pending.peek()).toBeNull();
    expect(flow.picker.hide).toHaveBeenCalled();
  });

  it("routes Escape through the same controller cancellation", async () => {
    const pending = new PendingTransfer();
    pending.select({ kind: "text", text: "fixture-escape" });
    const picker = new RecipientPicker();
    const source: RecipientSourceAdapter = { listLoadedRecipients: vi.fn(async () => [first]) };
    const navigator = { cancel: vi.fn(), notifyDomChanged: vi.fn() } as unknown as TelegramChatNavigator;
    const controller = new RecipientPickerController(
      source,
      navigator,
      picker,
      {} as ComposerAdapter,
      pending,
      createLogger(),
    );
    await controller.open();
    document.querySelector<HTMLElement>("[data-clean-forward-recipient-picker]")!
      .shadowRoot!.querySelector<HTMLInputElement>(".search")!.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(pending.peek()).toBeNull();
    expect(picker.isVisible()).toBe(false);
  });

  it("stops after a navigation error and preserves payload", async () => {
    const flow = createFlow({ navigate: async () => ({ success: false, message: "navigation failed" }) });
    await selectAndConfirm(flow);
    await vi.waitFor(() => expect(flow.picker.show).toHaveBeenCalledTimes(2));
    expect(flow.composer.insert).not.toHaveBeenCalled();
    expect(flow.pending.peek()).toBe(flow.payload);
  });

  it("does not call composer when navigation reports a non-empty composer", async () => {
    const flow = createFlow({
      navigate: async () => ({ success: false, message: "В поле сообщения уже есть текст." }),
    });
    await selectAndConfirm(flow);
    await vi.waitFor(() => expect(flow.picker.setBusy).toHaveBeenCalled());
    await vi.waitFor(() => expect(flow.picker.show).toHaveBeenCalledTimes(2));
    expect(flow.composer.insert).not.toHaveBeenCalled();
  });

  it("safely cancels preview after a media preparation error", async () => {
    const flow = createFlow({ insert: async () => ({ success: false, message: "preview failed" }) });
    await selectAndConfirm(flow);
    await vi.waitFor(() => expect(flow.composer.cancelPreparedPreview).toHaveBeenCalledOnce());
    expect(flow.pending.peek()).toBe(flow.payload);
  });

  it("allows a successful retry after a recoverable error", async () => {
    let attempt = 0;
    const flow = createFlow({
      insert: async () => {
        attempt += 1;
        return attempt === 1
          ? { success: false, message: "retry" }
          : { success: true, message: "prepared" };
      },
    });
    await selectAndConfirm(flow);
    await vi.waitFor(() => expect(flow.picker.show).toHaveBeenCalledTimes(2));
    flow.currentActions().onNext();
    await vi.waitFor(() => expect(flow.composer.insert).toHaveBeenCalledTimes(2));
    expect(flow.pending.peek()).toBeNull();
  });

  it("keeps retry selection only inside the current session", async () => {
    const flow = createFlow({ navigate: async () => ({ success: false, message: "retry" }) });
    await selectAndConfirm(flow);
    await vi.waitFor(() => expect(flow.picker.show).toHaveBeenCalledTimes(2));
    expect(vi.mocked(flow.picker.show).mock.calls[1]?.[2]).toMatchObject({
      selectedPeerKeys: ["101"],
    });
    await flow.controller.open();
    expect(vi.mocked(flow.picker.show).mock.calls[2]?.[2]).toBeUndefined();
  });

  it("shows a multi-recipient message without navigation or composer calls", async () => {
    const flow = createFlow();
    await selectAndConfirm(flow, [first, second]);
    expect(flow.picker.setError).toHaveBeenCalledWith(expect.stringContaining("нескольким получателям"));
    expect(flow.navigator.navigate).not.toHaveBeenCalled();
    expect(flow.composer.insert).not.toHaveBeenCalled();
  });

  it("blocks double confirmation while the first navigation is pending", async () => {
    let release: ((result: ChatNavigationResult) => void) | null = null;
    const flow = createFlow({
      navigate: () => new Promise<ChatNavigationResult>((resolve) => { release = resolve; }),
    });
    await flow.controller.open();
    flow.currentActions().onToggle?.(first);
    flow.currentActions().onNext();
    flow.currentActions().onNext();
    expect(flow.navigator.navigate).toHaveBeenCalledOnce();
    release!({ success: true, message: "opened" });
    await vi.waitFor(() => expect(flow.composer.insert).toHaveBeenCalledOnce());
  });

  it("aborts an active navigation when the picker flow is closed", async () => {
    let observedSignal: AbortSignal | null = null;
    const flow = createFlow({
      navigate: (_recipient, signal) => {
        observedSignal = signal;
        return new Promise<ChatNavigationResult>((resolve) => {
          signal.addEventListener("abort", () => resolve({ success: false, message: "aborted" }), {
            once: true,
          });
        });
      },
    });
    await selectAndConfirm(flow);
    flow.controller.cancel();
    await vi.waitFor(() => expect((observedSignal as unknown as AbortSignal).aborted).toBe(true));
    expect(flow.pending.peek()).toBeNull();
  });
});
