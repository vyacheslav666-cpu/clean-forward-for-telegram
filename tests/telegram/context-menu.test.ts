import { beforeEach, describe, expect, it, vi } from "vitest";
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
});
