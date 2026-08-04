import { afterEach, describe, expect, it, vi } from "vitest";
import { EscapeKeyLifecycle } from "../../src/utils/EscapeKeyLifecycle";

const lifecycles: EscapeKeyLifecycle[] = [];

function createLifecycle(): EscapeKeyLifecycle {
  const lifecycle = new EscapeKeyLifecycle();
  lifecycles.push(lifecycle);
  return lifecycle;
}

function escapeEvent(): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
}

afterEach(() => {
  lifecycles.forEach((lifecycle) => lifecycle.deactivate());
  lifecycles.length = 0;
});

describe("EscapeKeyLifecycle", () => {
  it("calls cancel exactly once", () => {
    const onEscape = vi.fn();
    createLifecycle().activate({ shouldHandle: () => true, onEscape });
    window.dispatchEvent(escapeEvent());
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

  it("removes the listener after cleanup", () => {
    const lifecycle = createLifecycle();
    const onEscape = vi.fn();
    lifecycle.activate({ shouldHandle: () => true, onEscape });
    lifecycle.deactivate();
    window.dispatchEvent(escapeEvent());
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("does not duplicate listeners on repeated activation", () => {
    const lifecycle = createLifecycle();
    const oldHandler = vi.fn();
    const currentHandler = vi.fn();
    lifecycle.activate({ shouldHandle: () => true, onEscape: oldHandler });
    lifecycle.activate({ shouldHandle: () => true, onEscape: currentHandler });
    window.dispatchEvent(escapeEvent());
    expect(oldHandler).not.toHaveBeenCalled();
    expect(currentHandler).toHaveBeenCalledOnce();
  });

  it("does not handle Escape after its signal is aborted by deactivate", () => {
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
    window.dispatchEvent(escapeEvent());
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });
});
