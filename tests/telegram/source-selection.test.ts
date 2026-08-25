import { describe, expect, it, vi } from "vitest";
import { CLEAN_FORWARD_RUNTIME_FINGERPRINT } from "../../src/app/CleanForwardRuntime";
import { TelegramDomAdapter } from "../../src/telegram/TelegramDomAdapter";
import { TelegramSelectionDomAdapter } from "../../src/telegram/TelegramSelectionDomAdapter";
import { TelegramSelectionIntegration } from "../../src/telegram/TelegramSelectionIntegration";
import { createLogger, installComposer, installDialogRow } from "../helpers";

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
  // Web K renders this plate as three slots; each side slot reserves symmetric space for one
  // icon button, which is why an extra control cannot simply join the Forward slot.
  const countButton = document.createElement("button");
  countButton.className = "btn-primary chat-input-plate-button";
  const countNode = document.createElement("span");
  countNode.className = "selection-container-count";
  countNode.textContent = `${count} messages`;
  countButton.append(countNode);
  const forward = document.createElement("button");
  forward.className = "btn-icon tgico-forward selection-container-forward";
  const leftSlot = document.createElement("div");
  leftSlot.className = "chat-input-plate-side";
  const centerSlot = document.createElement("div");
  centerSlot.className = "chat-input-plate-center";
  centerSlot.append(countButton);
  const rightSlot = document.createElement("div");
  rightSlot.className = "chat-input-plate-side";
  rightSlot.append(forward);
  toolbar.append(leftSlot, centerSlot, rightSlot);
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


/** An album the way selection mode leaves it: every item selected, container selected too. */
function installSelectedAlbum(
  history: HTMLElement,
  mids: readonly number[],
  peerKey = "20",
): HTMLElement[] {
  const bubble = document.createElement("div");
  bubble.className = "bubble is-grouped is-selected";
  bubble.dataset.mid = String(mids[0]);
  bubble.dataset.peerId = peerKey;
  const items = mids.map((mid) => {
    const item = document.createElement("div");
    item.className = "grouped-item is-selected";
    item.dataset.mid = String(mid);
    item.dataset.peerId = peerKey;
    const attachment = document.createElement("div");
    attachment.className = "attachment";
    const image = document.createElement("img");
    image.className = "media-photo";
    Object.defineProperty(image, "currentSrc", { value: `blob:photo-${mid}`, configurable: true });
    attachment.append(image);
    item.append(attachment);
    bubble.append(item);
    return item;
  });
  history.append(bubble);
  return items;
}

/** Stands in for the live model bridge. */
function installAlbumBridge(mids: readonly number[], peerKey = "20"): void {
  vi.stubGlobal("apiManagerProxy", {
    getMessageByPeer: (_peerId: number, mid: number) =>
      mids.includes(mid) ? { mid, peerId: Number(peerKey), grouped_id: "9001" } : undefined,
    getMessagesByGroupedId: () =>
      mids.map((mid) => ({ mid, peerId: Number(peerKey), grouped_id: "9001" })),
  });
}
describe("Telegram native source selection", () => {
  it("captures one immutable source navigation target with the selection context", () => {
    selectionFixture(1);
    const row = installDialogRow("20", "Selection source");
    row.classList.add("active");
    const { adapter } = createAdapters();

    expect(adapter.findActiveContext()?.sourceTarget).toEqual({
      peerKey: "20",
      title: "Selection source",
      searchQuery: "Selection source",
    });
    expect(Object.isFrozen(adapter.findActiveContext()?.sourceTarget)).toBe(true);
  });

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

  it("gives the toolbar action visible content instead of an empty cloned button", () => {
    const fixture = selectionFixture(1);
    selectedMessage(fixture.history, 10, "selected");
    const { adapter, integration } = createAdapters();

    integration.ensureAction(adapter.findActiveContext()!, vi.fn());

    const action = fixture.toolbar.querySelector<HTMLElement>(
      "[data-clean-forward-selection-action]",
    )!;
    expect(action.textContent).toContain("Как новое");
    expect(action.getAttribute("aria-label")).toBe("Отправить как новое");
    // Telegram's stylesheet must never be able to render this control as the native Forward button.
    expect(action.classList.contains("selection-container-forward")).toBe(false);
    // It must occupy its own plate slot rather than being squeezed into the Forward slot.
    const slot = action.parentElement!;
    expect(slot.className).toBe("chat-input-plate-side");
    expect(slot.contains(fixture.forward)).toBe(false);
    expect(slot.nextElementSibling).toBe(fixture.forward.parentElement);
  });

  it("removes its own plate slot together with a stale action", () => {
    const fixture = selectionFixture(1);
    selectedMessage(fixture.history, 10, "selected");
    const logger = createLogger();
    const adapter = new TelegramSelectionDomAdapter(new TelegramDomAdapter(logger), logger);
    const context = adapter.findActiveContext()!;
    new TelegramSelectionIntegration(logger).ensureAction(context, vi.fn());

    new TelegramSelectionIntegration(logger).ensureAction(context, vi.fn());

    // A leftover empty slot would keep shifting Telegram's centred count button.
    expect(fixture.toolbar.querySelectorAll("[data-clean-forward-selection-slot]")).toHaveLength(1);
    expect(fixture.toolbar.querySelectorAll("[data-clean-forward-selection-action]")).toHaveLength(1);
    // Telegram's own two side slots must survive untouched.
    expect(fixture.toolbar.querySelectorAll(".chat-input-plate-side")).toHaveLength(3);
  });

  it("resolves the selection context while Telegram keeps the message input hidden", () => {
    const fixture = selectionFixture(1);
    selectedMessage(fixture.history, 10, "selected");
    // Selection mode replaces the composer with this plate, so the input itself is not displayed.
    document.querySelector<HTMLElement>(".input-message-input")!.classList.add("hide");
    const { adapter } = createAdapters();

    const context = adapter.findActiveContext();

    expect(context?.toolbar).toBe(fixture.toolbar);
    expect(context?.sourcePeerKey).toBe("20");
    expect(adapter.readSelectedSnapshots(context!)).toMatchObject({ kind: "captured" });
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
    // Upstream selects an album by toggling each item, and marks the container only as a
    // consequence (selection.ts). The item is therefore what carries the selection.
    const item = document.createElement("div");
    item.className = "grouped-item is-selected";
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

  it("reclaims an action owned by another integration instance", () => {
    const fixture = selectionFixture(1);
    selectedMessage(fixture.history, 10, "selected");
    const logger = createLogger();
    const adapter = new TelegramSelectionDomAdapter(new TelegramDomAdapter(logger), logger);
    const context = adapter.findActiveContext()!;
    const firstHandler = vi.fn();
    new TelegramSelectionIntegration(logger).ensureAction(context, firstHandler);
    const staleAction = fixture.toolbar.querySelector<HTMLElement>(
      "[data-clean-forward-selection-action]",
    )!;

    const secondHandler = vi.fn();
    new TelegramSelectionIntegration(logger).ensureAction(context, secondHandler);
    const currentAction = fixture.toolbar.querySelector<HTMLElement>(
      "[data-clean-forward-selection-action]",
    )!;

    expect(currentAction).not.toBe(staleAction);
    expect(staleAction.isConnected).toBe(false);
    expect(fixture.toolbar.querySelectorAll("[data-clean-forward-selection-action]")).toHaveLength(
      1,
    );
    expect(currentAction.getAttribute("data-clean-forward-selection-action")).toBe(
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

  it("captures a whole album selected in selection mode", () => {
    const fixture = selectionFixture(3);
    installSelectedAlbum(fixture.history, [70, 71, 72]);
    installAlbumBridge([70, 71, 72]);
    const { adapter } = createAdapters();

    const result = adapter.readSelectedSnapshots(adapter.findActiveContext()!);

    expect(result.kind).toBe("captured");
    if (result.kind !== "captured") return;
    // The container is selected too once every item is, but it is not a message.
    expect(result.snapshots.map(({ mid }) => mid)).toEqual([70, 71, 72]);
    expect(result.snapshots.every((snapshot) => snapshot.group.kind === "complete-model")).toBe(true);
  });

  it("refuses a partially selected album rather than widening it", () => {
    const fixture = selectionFixture(2);
    const items = installSelectedAlbum(fixture.history, [70, 71, 72]);
    items[2]!.classList.remove("is-selected");
    installAlbumBridge([70, 71, 72]);
    const { adapter } = createAdapters();

    const result = adapter.readSelectedSnapshots(adapter.findActiveContext()!);

    // Two of three are captured here; the whole-album requirement is enforced at capture, where
    // expectedItemCount is compared against what was actually selected.
    expect(result.kind).toBe("captured");
    if (result.kind !== "captured") return;
    expect(result.snapshots).toHaveLength(2);
    expect(result.snapshots[0]?.group).toMatchObject({ expectedItemCount: 3 });
  });
});
