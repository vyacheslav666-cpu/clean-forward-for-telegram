import { afterEach, describe, expect, it, vi } from "vitest";
import { CleanForwardController } from "../../src/app/CleanForwardController";
import { PendingTransfer } from "../../src/domain/PendingTransfer";
import type { RecipientPickerController } from "../../src/recipient/RecipientPickerController";
import { ContextMenuIntegration } from "../../src/telegram/TelegramContextMenuIntegration";
import { TelegramDomAdapter } from "../../src/telegram/TelegramDomAdapter";
import { MessageExtractor } from "../../src/telegram/MessageExtractor";
import { TelegramSelectionDomAdapter } from "../../src/telegram/TelegramSelectionDomAdapter";
import { TelegramSelectionIntegration } from "../../src/telegram/TelegramSelectionIntegration";
import { createLogger, installComposer } from "../helpers";

const controllers: CleanForwardController[] = [];

function createController() {
  const logger = createLogger();
  const dom = new TelegramDomAdapter(logger);
  const selectionDom = new TelegramSelectionDomAdapter(dom, logger);
  const pending = new PendingTransfer();
  const recipients = {
    open: vi.fn(async () => undefined),
    notifyDomChanged: vi.fn(),
    stop: vi.fn(),
  } as unknown as RecipientPickerController;
  const controller = new CleanForwardController(
    dom,
    new MessageExtractor(dom, logger),
    pending,
    new ContextMenuIntegration(logger),
    selectionDom,
    new TelegramSelectionIntegration(logger),
    recipients,
    logger,
  );
  controllers.push(controller);
  return { controller, pending, recipients };
}

function appendSelected(history: HTMLElement, mid: number, text: string): void {
  const bubble = document.createElement("div");
  bubble.className = "bubble is-selected";
  bubble.dataset.mid = String(mid);
  bubble.dataset.peerId = "20";
  bubble.innerHTML = `<label class="bubble-select-checkbox"><input class="checkbox-field-input" type="checkbox" checked></label><div class="message">${text}</div>`;
  history.append(bubble);
}

function installSelection(count: number) {
  const history = document.createElement("div");
  history.className = "bubbles is-selecting";
  document.body.append(history);
  const composer = installComposer("20");
  composer.parentElement!.classList.add("is-selecting");
  const wrapper = document.createElement("div");
  wrapper.className = "chat-input-wrapper selection-wrapper";
  wrapper.innerHTML = `<div class="chat-input-plate selection-container"><button class="chat-input-plate-button"><span class="selection-container-count">${count} messages</span></button><button class="btn-icon tgico-forward selection-container-forward"></button></div>`;
  composer.parentElement!.append(wrapper);
  const countButton = wrapper.querySelector<HTMLButtonElement>(".chat-input-plate-button")!;
  countButton.addEventListener("click", () => {
    history.classList.remove("is-selecting");
    wrapper.remove();
  });
  return { history, wrapper };
}

afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.stop());
});

describe("source capture entrypoints", () => {
  it("keeps the single-message context-menu UX while snapshotting before DOM removal", async () => {
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.dataset.mid = "10";
    bubble.dataset.peerId = "20";
    bubble.innerHTML = '<div class="message">single source</div>';
    const overlay = document.createElement("div");
    overlay.className = "btn-menu-overlay";
    const menu = document.createElement("div");
    menu.className = "btn-menu contextmenu active has-items-wrapper";
    menu.innerHTML = '<div class="btn-menu-items"><div class="btn-menu-item"><span class="btn-menu-item-text">Forward</span></div></div>';
    overlay.addEventListener("click", () => {
      menu.classList.remove("active");
      bubble.remove();
    });
    document.body.append(bubble, overlay, menu);
    const harness = createController();
    harness.controller.start();

    bubble.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await Promise.resolve();
    menu.querySelector<HTMLElement>("[data-clean-forward-context-action]")!
      .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));

    await vi.waitFor(() => expect(harness.recipients.open).toHaveBeenCalledOnce());
    expect(bubble.isConnected).toBe(false);
    expect(harness.pending.peek()?.messages.map(({ mid }) => mid)).toEqual([10]);
  });

  it("captures native multi-selection and opens the existing recipient picker", async () => {
    const selection = installSelection(2);
    appendSelected(selection.history, 30, "second in DOM");
    appendSelected(selection.history, 10, "first by mid");
    const harness = createController();
    harness.controller.start();
    const action = selection.wrapper.querySelector<HTMLElement>(
      "[data-clean-forward-selection-action]",
    )!;

    action.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));

    await vi.waitFor(() => expect(harness.recipients.open).toHaveBeenCalledOnce());
    expect(harness.pending.peek()?.messages.map(({ mid }) => mid)).toEqual([10, 30]);
    expect(selection.wrapper.isConnected).toBe(false);
  });

  it("cancels an in-flight selection capture when Telegram selection mode exits", async () => {
    const selection = installSelection(1);
    const bubble = document.createElement("div");
    bubble.className = "bubble is-selected";
    bubble.dataset.mid = "40";
    bubble.dataset.peerId = "20";
    bubble.innerHTML = '<label class="bubble-select-checkbox"><input class="checkbox-field-input" type="checkbox" checked></label><img class="media-photo" src="blob:pending-photo">';
    selection.history.append(bubble);
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        );
      }),
    ));
    const harness = createController();
    harness.controller.start();
    selection.wrapper.querySelector<HTMLElement>("[data-clean-forward-selection-action]")!
      .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    selection.history.classList.remove("is-selecting");
    selection.wrapper.remove();
    document.body.append(document.createElement("span"));

    await vi.waitFor(() => expect(harness.recipients.notifyDomChanged).toHaveBeenCalled());
    await Promise.resolve();
    expect(harness.recipients.open).not.toHaveBeenCalled();
    expect(harness.pending.peek()).toBeNull();
  });
});
