import { afterEach, describe, expect, it, vi } from "vitest";
import { EscapeKeyLifecycle } from "../../src/utils/EscapeKeyLifecycle";

const lifecycle = new EscapeKeyLifecycle();

function createLifecycle(): EscapeKeyLifecycle {
  return lifecycle;
}

function escapeEvent(): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
}

function pressEscape(target: EventTarget = window): void {
  target.dispatchEvent(escapeEvent());
  target.dispatchEvent(
    new KeyboardEvent("keyup", { key: "Escape", bubbles: true, cancelable: true }),
  );
}

afterEach(() => {
  lifecycle.deactivate();
});

describe("EscapeKeyLifecycle", () => {
  it("calls cancel exactly once", () => {
    const onEscape = vi.fn();
    createLifecycle().activate({ shouldHandle: () => true, onEscape });
    pressEscape();
    expect(onEscape).toHaveBeenCalledOnce();
  });

  it("prevents the default Escape action", () => {
    createLifecycle().activate({ shouldHandle: () => true, onEscape: vi.fn() });
    const event = escapeEvent();
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("stops immediate propagation", () => {
    const laterListener = vi.fn();
    createLifecycle().activate({ shouldHandle: () => true, onEscape: vi.fn() });
    window.addEventListener("keydown", laterListener);
    window.dispatchEvent(escapeEvent());
    window.removeEventListener("keydown", laterListener);
    expect(laterListener).not.toHaveBeenCalled();
  });

  it("blocks a Telegram keyup listener registered after construction", () => {
    const lifecycle = createLifecycle();
    const telegramBack = vi.fn();
    let pickerOpen = true;
    const telegramKeyup = () => telegramBack();
    window.addEventListener("keyup", telegramKeyup, true);
    lifecycle.activate({
      shouldHandle: () => true,
      onEscape: () => {
        pickerOpen = false;
        lifecycle.deactivate();
      },
    });

    window.dispatchEvent(escapeEvent());
    expect(pickerOpen).toBe(true);
    const keyup = new KeyboardEvent("keyup", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(keyup);
    window.removeEventListener("keyup", telegramKeyup, true);

    expect(pickerOpen).toBe(false);
    expect(keyup.defaultPrevented).toBe(true);
    expect(telegramBack).not.toHaveBeenCalled();
  });

  it("does not handle Escape after cleanup", () => {
    const lifecycle = createLifecycle();
    const onEscape = vi.fn();
    lifecycle.activate({ shouldHandle: () => true, onEscape });
    lifecycle.deactivate();
    pressEscape();
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("does not duplicate listeners on repeated activation", () => {
    const lifecycle = createLifecycle();
    const oldHandler = vi.fn();
    const currentHandler = vi.fn();
    lifecycle.activate({ shouldHandle: () => true, onEscape: oldHandler });
    lifecycle.activate({ shouldHandle: () => true, onEscape: currentHandler });
    pressEscape();
    expect(oldHandler).not.toHaveBeenCalled();
    expect(currentHandler).toHaveBeenCalledOnce();
  });

  it("does not handle Escape after deactivate", () => {
    const lifecycle = createLifecycle();
    const onEscape = vi.fn();
    lifecycle.activate({ shouldHandle: () => true, onEscape });
    lifecycle.deactivate();
    window.dispatchEvent(escapeEvent());
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("ignores other keys", () => {
    const onEscape = vi.fn();
    createLifecycle().activate({ shouldHandle: () => true, onEscape });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("honors the active modal guard", () => {
    const onEscape = vi.fn();
    createLifecycle().activate({ shouldHandle: () => false, onEscape });
    window.dispatchEvent(escapeEvent());
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("creates a fresh working lifecycle after reopening", () => {
    const lifecycle = createLifecycle();
    const first = vi.fn();
    const second = vi.fn();
    lifecycle.activate({ shouldHandle: () => true, onEscape: first });
    lifecycle.deactivate();
    lifecycle.activate({ shouldHandle: () => true, onEscape: second });
    pressEscape();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });
});
