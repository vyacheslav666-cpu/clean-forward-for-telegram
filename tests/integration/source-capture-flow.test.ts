import { afterEach, describe, expect, it, vi } from "vitest";
import { CleanForwardController } from "../../src/app/CleanForwardController";
import { CaptureNotice } from "../../src/ui/CaptureNotice";
import { PendingTransfer } from "../../src/domain/PendingTransfer";
import type { RecipientPickerController } from "../../src/recipient/RecipientPickerController";
import {
  ContextMenuIntegration,
  SELECTION_ACTION_LABEL,
} from "../../src/telegram/TelegramContextMenuIntegration";
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
    new CaptureNotice(),
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

function appendSelectedPhoto(history: HTMLElement, mid: number, caption: string | null): void {
  const bubble = document.createElement("div");
  bubble.className = "bubble is-selected";
  bubble.dataset.mid = String(mid);
  bubble.dataset.peerId = "20";
  bubble.innerHTML = `<label class="bubble-select-checkbox"><input class="checkbox-field-input" type="checkbox" checked></label><img class="media-photo" src="blob:photo-${mid}">${
    caption === null ? "" : `<div class="message">${caption}</div>`
  }`;
  history.append(bubble);
}

/** Serves deterministic bytes so photo capture completes without touching the network. */
function stubImageFetch(): void {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    status: 200,
    blob: async () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/jpeg" }),
  } as unknown as Response)));
}

/**
 * Reproduces the shape Web K actually renders. Only a desktop menu that also carries a reactions
 * bar moves its items into `.btn-menu-items`; on mobile, and in every selection menu, the items
 * are direct children of `.btn-menu` and no per-menu overlay element exists at all.
 */
function installContextMenu(labels: readonly string[], { wrapped = false } = {}) {
  const wrapper = document.createElement("div");
  wrapper.className = `btn-menu contextmenu active${wrapped ? " has-items-wrapper" : ""}`;
  const items = wrapped ? document.createElement("div") : wrapper;
  if (items !== wrapper) {
    items.className = "btn-menu-items";
    wrapper.append(items);
  }
  for (const label of labels) {
    const item = document.createElement("div");
    item.className = "btn-menu-item";
    item.innerHTML = `<span class="btn-menu-item-text">${label}</span>`;
    items.append(item);
  }
  document.body.append(wrapper);
  return { wrapper, items };
}

function installSelection(count: number, { readOnly = false }: { readOnly?: boolean } = {}) {
  const history = document.createElement("div");
  history.className = "bubbles is-selecting";
  document.body.append(history);
  const composer = installComposer("20");
  if (readOnly) {
    composer.setAttribute("contenteditable", "false");
  }
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
    document.body.append(bubble);
    const menu = installContextMenu(["Forward"], { wrapped: true }).wrapper;
    const overlay = document.createElement("div");
    overlay.className = "btn-menu-overlay";
    menu.before(overlay);
    overlay.addEventListener("click", () => {
      menu.classList.remove("active");
      bubble.remove();
    });
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

  it("forwards the whole selected set from Telegram's selection context menu", async () => {
    const selection = installSelection(3);
    appendSelected(selection.history, 12, "plain text");
    appendSelectedPhoto(selection.history, 11, null);
    appendSelectedPhoto(selection.history, 10, "photo with caption");
    const menu = installContextMenu(["Copy selected", "Forward selected", "Clear selection"]);
    stubImageFetch();
    const harness = createController();
    harness.controller.start();

    // Long-pressing one bubble opens Telegram's menu, but that menu acts on the selected set.
    selection.history.querySelector<HTMLElement>('[data-mid="11"]')!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await Promise.resolve();
    const action = menu.items.querySelector<HTMLElement>("[data-clean-forward-context-action]")!;
    expect(action.textContent).toContain(SELECTION_ACTION_LABEL);

    action.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));

    await vi.waitFor(() => expect(harness.recipients.open).toHaveBeenCalledOnce());
    const payload = harness.pending.peek();
    expect(payload?.messages.map(({ mid }) => mid)).toEqual([10, 11, 12]);
    expect(payload?.units).toHaveLength(3);
    expect(menu.wrapper.classList.contains("active")).toBe(false);
    expect(selection.wrapper.isConnected).toBe(false);
  });

  /**
   * The quieter half of the same failure. With no selection context, the menu item fell back to
   * the single long-pressed bubble while Telegram's menu in selection mode means the whole set —
   * so a channel selection would have sent one message where the visible menu promised five.
   */
  it("forwards the whole selected set from a channel with no writable composer", async () => {
    const selection = installSelection(2, { readOnly: true });
    appendSelected(selection.history, 11, "second channel post");
    appendSelected(selection.history, 10, "first channel post");
    const menu = installContextMenu(["Copy selected", "Forward selected", "Clear selection"]);
    const harness = createController();
    harness.controller.start();

    selection.history.querySelector<HTMLElement>('[data-mid="11"]')!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await Promise.resolve();
    const action = menu.items.querySelector<HTMLElement>("[data-clean-forward-context-action]")!;
    expect(action.textContent).toContain(SELECTION_ACTION_LABEL);

    action.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));

    await vi.waitFor(() => expect(harness.recipients.open).toHaveBeenCalledOnce());
    expect(harness.pending.peek()?.messages.map(({ mid }) => mid)).toEqual([10, 11]);
  });

  it("reaches the selection menu on touch, where Telegram dispatches no contextmenu event", async () => {
    const selection = installSelection(2);
    appendSelected(selection.history, 11, "second");
    appendSelected(selection.history, 10, "first");
    const harness = createController();
    harness.controller.start();

    // Web K opens the menu from its own long-tap timer on Apple touch devices, so the press is the
    // only moment the source bubble is observable. Telegram then renders the menu ~400 ms later.
    const press = new MouseEvent("pointerdown", { bubbles: true });
    Object.defineProperty(press, "pointerType", { value: "touch" });
    selection.history.querySelector<HTMLElement>('[data-mid="10"]')!.dispatchEvent(press);
    const menu = installContextMenu(["Copy selected", "Forward selected", "Delete selected"]);

    const action = await vi.waitFor(() => {
      const found = menu.items.querySelector<HTMLElement>("[data-clean-forward-context-action]");
      expect(found).not.toBeNull();
      return found!;
    });
    action.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));

    await vi.waitFor(() => expect(harness.recipients.open).toHaveBeenCalledOnce());
    expect(harness.pending.peek()?.messages.map(({ mid }) => mid)).toEqual([10, 11]);
    // No overlay element exists in current Web K, so dismissal must still close the menu.
    expect(menu.wrapper.classList.contains("active")).toBe(false);
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
