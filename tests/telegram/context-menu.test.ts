import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLEAN_FORWARD_RUNTIME_FINGERPRINT } from "../../src/app/CleanForwardRuntime";
import { ContextMenuIntegration } from "../../src/telegram/TelegramContextMenuIntegration";
import { createLogger } from "../helpers";

function menuFixture(labels: readonly string[]): { wrapper: HTMLElement; items: HTMLElement } {
  const wrapper = document.createElement("div");
  wrapper.className = "btn-menu contextmenu active has-items-wrapper";
  wrapper.style.top = "100px";
  const items = document.createElement("div");
  items.className = "btn-menu-items";
  for (const label of labels) {
    const item = document.createElement("div");
    item.className = `btn-menu-item rp-overflow${label === "Delete" ? " danger" : ""}`;
    const text = document.createElement("span");
    text.className = "btn-menu-item-text";
    text.textContent = label;
    item.append(text);
    items.append(item);
  }
  wrapper.append(items);
  document.body.append(wrapper);
  return { wrapper, items };
}

function labels(items: HTMLElement): string[] {
  return Array.from(items.children, (child) => child.textContent?.trim() ?? "");
}

describe("ContextMenuIntegration", () => {
  beforeEach(() => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(performance.now());
      return 0;
    });
  });

  it("adds the custom item exactly once", () => {
    const { items } = menuFixture(["Reply", "Forward", "Delete"]);
    const integration = new ContextMenuIntegration(createLogger());
    integration.ensureAction(items, vi.fn());
    integration.ensureAction(items, vi.fn());
    expect(items.querySelectorAll("[data-clean-forward-context-action]")).toHaveLength(1);
  });

  it("places the item directly after Forward", () => {
    const { items } = menuFixture(["Reply", "Forward", "Delete"]);
    new ContextMenuIntegration(createLogger()).ensureAction(items, vi.fn());
    expect(labels(items)).toEqual(["Reply", "Forward", "Отправить как новое", "Delete"]);
  });

  it("falls back to placement before Delete when Forward is absent", () => {
    const { items } = menuFixture(["Reply", "Delete"]);
    new ContextMenuIntegration(createLogger()).ensureAction(items, vi.fn());
    expect(labels(items)).toEqual(["Reply", "Отправить как новое", "Delete"]);
  });

  it("does not duplicate the item when a reused menu opens again", () => {
    const { items } = menuFixture(["Forward", "Delete"]);
    const integration = new ContextMenuIntegration(createLogger());
    for (let index = 0; index < 4; index += 1) integration.ensureAction(items, vi.fn());
    expect(items.children).toHaveLength(3);
  });

  it("calls the latest controller handler only once for pointerdown and click", () => {
    const { items } = menuFixture(["Forward"]);
    const integration = new ContextMenuIntegration(createLogger());
    const oldHandler = vi.fn();
    const handler = vi.fn();
    integration.ensureAction(items, oldHandler);
    integration.ensureAction(items, handler);
    const action = items.querySelector<HTMLElement>("[data-clean-forward-context-action]")!;
    action.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    action.click();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(oldHandler).not.toHaveBeenCalled();
  });

  it("reclaims an action owned by another integration instance", () => {
    const { items } = menuFixture(["Forward"]);
    const firstHandler = vi.fn();
    new ContextMenuIntegration(createLogger()).ensureAction(items, firstHandler);
    const staleAction = items.querySelector<HTMLElement>(
      "[data-clean-forward-context-action]",
    )!;

    const secondHandler = vi.fn();
    new ContextMenuIntegration(createLogger()).ensureAction(items, secondHandler);
    const currentAction = items.querySelector<HTMLElement>(
      "[data-clean-forward-context-action]",
    )!;

    expect(currentAction).not.toBe(staleAction);
    expect(staleAction.isConnected).toBe(false);
    expect(items.querySelectorAll("[data-clean-forward-context-action]")).toHaveLength(1);
    expect(currentAction.getAttribute("data-clean-forward-context-action")).toBe(
      CLEAN_FORWARD_RUNTIME_FINGERPRINT,
    );
    expect(currentAction.getAttribute("data-clean-forward-runtime-owner")).toBe(
      CLEAN_FORWARD_RUNTIME_FINGERPRINT,
    );
    currentAction.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    currentAction.click();
    expect(secondHandler).toHaveBeenCalledOnce();
    expect(firstHandler).not.toHaveBeenCalled();
  });

  it("runs the action from primary pointerdown", () => {
    const { items } = menuFixture(["Forward"]);
    const handler = vi.fn();
    new ContextMenuIntegration(createLogger()).ensureAction(items, handler);
    items.querySelector<HTMLElement>("[data-clean-forward-context-action]")!
      .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    expect(handler).toHaveBeenCalledOnce();
  });

  it("keeps click as a keyboard activation fallback", () => {
    const { items } = menuFixture(["Forward"]);
    const handler = vi.fn();
    new ContextMenuIntegration(createLogger()).ensureAction(items, handler);
    items.querySelector<HTMLElement>("[data-clean-forward-context-action]")!.click();
    expect(handler).toHaveBeenCalledOnce();
  });

  it("clamps the menu vertically inside the viewport", () => {
    const { wrapper, items } = menuFixture(["Forward"]);
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 500 });
    vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue({
      top: 100,
      bottom: 525,
      left: 0,
      right: 200,
      width: 200,
      height: 425,
      x: 0,
      y: 100,
      toJSON: () => ({}),
    });
    new ContextMenuIntegration(createLogger()).ensureAction(items, vi.fn());
    expect(wrapper.style.top).toBe("67px");
  });

  it("does not reposition a menu that closed before the animation frames", () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.mocked(window.requestAnimationFrame).mockImplementation((callback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    const { wrapper, items } = menuFixture(["Forward"]);
    const measure = vi.spyOn(wrapper, "getBoundingClientRect");
    new ContextMenuIntegration(createLogger()).ensureAction(items, vi.fn());
    wrapper.classList.remove("active");
    callbacks.shift()?.(0);
    callbacks.shift()?.(16);
    expect(measure).not.toHaveBeenCalled();
    expect(wrapper.style.top).toBe("100px");
  });

  it("does not install temporary document or window listeners", () => {
    const documentListener = vi.spyOn(document, "addEventListener");
    const windowListener = vi.spyOn(window, "addEventListener");
    const { items } = menuFixture(["Forward"]);
    new ContextMenuIntegration(createLogger()).ensureAction(items, vi.fn());
    expect(documentListener).not.toHaveBeenCalled();
    expect(windowListener).not.toHaveBeenCalled();
  });
});
