import { describe, expect, it, vi } from "vitest";
import { TelegramDomAdapter } from "../../src/telegram/TelegramDomAdapter";
import { TelegramSelectionDomAdapter } from "../../src/telegram/TelegramSelectionDomAdapter";
import { TelegramSelectionIntegration } from "../../src/telegram/TelegramSelectionIntegration";
import { createLogger, installComposer } from "../helpers";

interface SelectionFixture {
  readonly history: HTMLElement;
  readonly wrapper: HTMLElement;
  readonly toolbar: HTMLElement;
  readonly countButton: HTMLButtonElement;
  readonly count: HTMLElement;
  readonly forward: HTMLButtonElement;
}

function selectionFixture(count: number, peerKey = "20"): SelectionFixture {
  const history = document.createElement("div");
  history.className = "bubbles is-selecting";
  document.body.append(history);
  const composer = installComposer(peerKey);
  composer.parentElement!.classList.add("is-selecting");
  const wrapper = document.createElement("div");
  wrapper.className = "chat-input-wrapper selection-wrapper";
  const toolbar = document.createElement("div");
  toolbar.className = "chat-input-plate selection-container";
  const countButton = document.createElement("button");
  countButton.className = "btn-primary chat-input-plate-button";
  const countNode = document.createElement("span");
  countNode.className = "selection-container-count";
  countNode.textContent = `${count} messages`;
  countButton.append(countNode);
  const forward = document.createElement("button");
  forward.className = "btn-icon tgico-forward selection-container-forward";
  toolbar.append(countButton, forward);
  wrapper.append(toolbar);
  composer.parentElement!.append(wrapper);
  return { history, wrapper, toolbar, countButton, count: countNode, forward };
}

function selectedMessage(
  history: HTMLElement,
  mid: number,
  text: string,
  peerKey = "20",
): HTMLElement {
  const bubble = document.createElement("div");
  bubble.className = "bubble is-selected";
  bubble.dataset.mid = String(mid);
  bubble.dataset.peerId = peerKey;
  const checkbox = document.createElement("label");
  checkbox.className = "bubble-select-checkbox";
  const input = document.createElement("input");
  input.className = "checkbox-field-input";
  input.type = "checkbox";
  input.checked = true;
  checkbox.append(input);
  const message = document.createElement("div");
  message.className = "message";
  message.textContent = text;
  bubble.append(checkbox, message);
  history.append(bubble);
  return bubble;
}

function createAdapters() {
  const logger = createLogger();
  const dom = new TelegramDomAdapter(logger);
  return {
    adapter: new TelegramSelectionDomAdapter(dom, logger),
    integration: new TelegramSelectionIntegration(logger),
  };
}

describe("Telegram native source selection", () => {
  it("reads several selected identities and sorts them independently from DOM click order", () => {
    const fixture = selectionFixture(3);
    selectedMessage(fixture.history, 30, "third");
    selectedMessage(fixture.history, 10, "first");
    selectedMessage(fixture.history, 20, "second");
    const { adapter } = createAdapters();
    const context = adapter.findActiveContext();
    expect(context).not.toBeNull();
    const result = adapter.readSelectedSnapshots(context!);
    expect(result.kind).toBe("captured");
    if (result.kind !== "captured") return;
    expect(result.snapshots.map(({ mid }) => mid)).toEqual([10, 20, 30]);
  });

  it("reads the current rerendered nodes at activation time", () => {
    const fixture = selectionFixture(1);
    const oldBubble = selectedMessage(fixture.history, 10, "stale");
    const { adapter, integration } = createAdapters();
    const context = adapter.findActiveContext()!;
    let observedText: string | null = null;
    integration.ensureAction(context, () => {
      const result = adapter.readSelectedSnapshots(context);
      if (result.kind === "captured") observedText = result.snapshots[0]?.text ?? null;
    });
    oldBubble.remove();
    selectedMessage(fixture.history, 10, "fresh after rerender");
    fixture.toolbar.querySelector<HTMLElement>("[data-clean-forward-selection-action]")!
      .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    expect(observedText).toBe("fresh after rerender");
  });

  it("rejects a virtualized selection when native count exceeds visible unique identities", () => {
    const fixture = selectionFixture(2);
    selectedMessage(fixture.history, 10, "visible only");
    const { adapter } = createAdapters();
    expect(adapter.readSelectedSnapshots(adapter.findActiveContext()!)).toMatchObject({
      kind: "rejected",
      code: "virtualized-selection",
    });
  });

  it("rejects mixed source peers", () => {
    const fixture = selectionFixture(2);
    selectedMessage(fixture.history, 10, "expected", "20");
    selectedMessage(fixture.history, 11, "other", "99");
    const { adapter } = createAdapters();
    expect(adapter.readSelectedSnapshots(adapter.findActiveContext()!)).toMatchObject({
      kind: "rejected",
      code: "mixed-peer",
    });
  });

  it("rejects DOM album projection instead of silently splitting the group", () => {
    const fixture = selectionFixture(1);
    const album = selectedMessage(fixture.history, 10, "album");
    album.classList.add("is-grouped");
    const item = document.createElement("div");
    item.className = "grouped-item";
    item.dataset.mid = "10";
    item.dataset.peerId = "20";
    album.append(item);
    const { adapter } = createAdapters();
    expect(adapter.readSelectedSnapshots(adapter.findActiveContext()!)).toMatchObject({
      kind: "rejected",
      code: "group-model-required",
    });
  });

  it("never captures when Telegram disables native Forward for the selection", () => {
    const fixture = selectionFixture(1);
    selectedMessage(fixture.history, 10, "protected");
    fixture.forward.disabled = true;
    const { adapter } = createAdapters();
    expect(adapter.readSelectedSnapshots(adapter.findActiveContext()!)).toMatchObject({
      kind: "rejected",
      code: "protected-content",
    });
  });

  it("activates once across pointerdown and click without invoking native Forward", () => {
    const fixture = selectionFixture(1);
    selectedMessage(fixture.history, 10, "selected");
    const nativeForward = vi.fn();
    fixture.forward.addEventListener("click", nativeForward);
    const handler = vi.fn();
    const { adapter, integration } = createAdapters();
    integration.ensureAction(adapter.findActiveContext()!, handler);
    const action = fixture.toolbar.querySelector<HTMLElement>("[data-clean-forward-selection-action]")!;
    action.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    action.click();
    expect(handler).toHaveBeenCalledOnce();
    expect(nativeForward).not.toHaveBeenCalled();
  });

  it("uses Telegram's count button to cancel native selection without synthetic Escape", () => {
    const fixture = selectionFixture(1);
    selectedMessage(fixture.history, 10, "selected");
    const cancel = vi.fn(() => {
      fixture.history.classList.remove("is-selecting");
      fixture.wrapper.remove();
    });
    fixture.countButton.addEventListener("click", cancel);
    const { adapter } = createAdapters();
    expect(adapter.dismiss(adapter.findActiveContext()!)).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not duplicate actions across repeated selection mode entry and exit", () => {
    const first = selectionFixture(1);
    selectedMessage(first.history, 10, "first");
    const { adapter, integration } = createAdapters();
    integration.ensureAction(adapter.findActiveContext()!, vi.fn());
    integration.ensureAction(adapter.findActiveContext()!, vi.fn());
    expect(first.toolbar.querySelectorAll("[data-clean-forward-selection-action]")).toHaveLength(1);
    first.history.remove();
    first.wrapper.remove();
    document.querySelector<HTMLElement>(".chat-input-main")?.remove();

    const second = selectionFixture(1);
    selectedMessage(second.history, 20, "second");
    integration.ensureAction(adapter.findActiveContext()!, vi.fn());
    expect(second.toolbar.querySelectorAll("[data-clean-forward-selection-action]")).toHaveLength(1);
  });
});
