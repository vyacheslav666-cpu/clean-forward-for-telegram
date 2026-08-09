import { afterEach, describe, expect, it, vi } from "vitest";
import type { Recipient } from "../../src/recipient/Recipient";
import { RecipientPicker } from "../../src/ui/RecipientPicker";

const recipients: readonly Recipient[] = [
  { peerKey: "1", title: "Fixture recipient A", subtitle: "Fixture subtitle A", supported: true },
  {
    peerKey: "2",
    title: "FIXTURE RECIPIENT B",
    subtitle: "Кириллический подзаголовок B",
    supported: true,
  },
  {
    peerKey: "3_99",
    title: "Unsupported fixture",
    supported: false,
    unsupportedReason: "Темы форума пока не поддерживаются",
  },
];

const pickers: RecipientPicker[] = [];

function createPicker(): RecipientPicker {
  const picker = new RecipientPicker();
  pickers.push(picker);
  return picker;
}

afterEach(() => {
  pickers.forEach((picker) => picker.hide());
  pickers.length = 0;
});

function renderPicker() {
  const picker = createPicker();
  const onNext = vi.fn();
  const onCancel = vi.fn();
  const selected = new Set<string>();
  const onToggle = vi.fn((recipient: Recipient) => {
    if (selected.has(recipient.peerKey)) {
      selected.delete(recipient.peerKey);
    } else {
      selected.add(recipient.peerKey);
    }
    picker.updateSelection([...selected]);
  });
  picker.show(recipients, { onToggle, onNext, onCancel });
  const host = document.querySelector<HTMLElement>("[data-clean-forward-recipient-picker]")!;
  const shadow = host.shadowRoot!;
  const rows = () => Array.from(shadow.querySelectorAll<HTMLButtonElement>(".recipient"));
  const next = shadow.querySelector<HTMLButtonElement>(".next")!;
  return { picker, host, shadow, rows, next, onNext, onCancel, onToggle, selected };
}

describe("RecipientPicker", () => {
  it("renders the recipient list", () => {
    const { rows } = renderPicker();
    expect(rows().map((row) => row.querySelector(".title")?.textContent)).toEqual([
      "Fixture recipient A",
      "FIXTURE RECIPIENT B",
      "Unsupported fixture",
    ]);
  });

  it("renders title and subtitle", () => {
    const { rows } = renderPicker();
    expect(rows()[0]?.querySelector(".title")?.textContent).toBe("Fixture recipient A");
    expect(rows()[0]?.querySelector(".subtitle")?.textContent).toBe("Fixture subtitle A");
  });

  it("renders an avatar image or a text fallback", () => {
    const picker = createPicker();
    picker.show(
      [
        { peerKey: "10", title: "Avatar fixture", avatarUrl: "blob:avatar", supported: true },
        { peerKey: "11", title: "Text fallback", supported: true },
      ],
      { onToggle: vi.fn(), onNext: vi.fn(), onCancel: vi.fn() },
    );
    const shadow = document.querySelector<HTMLElement>("[data-clean-forward-recipient-picker]")!.shadowRoot!;
    const avatars = shadow.querySelectorAll<HTMLElement>(".avatar");
    expect(avatars[0]?.querySelector("img")?.src).toBe("blob:avatar");
    expect(avatars[1]?.textContent).toBe("T");
  });

  it("filters locally without regard to case", () => {
    const { shadow, rows } = renderPicker();
    const search = shadow.querySelector<HTMLInputElement>(".search")!;
    search.value = "fixture recipient b";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(rows().filter((row) => !row.hidden).map((row) => row.textContent)).toHaveLength(1);
    expect(rows()[1]?.hidden).toBe(false);
  });

  it("does not render rows hidden by the search filter", () => {
    const { shadow, rows } = renderPicker();
    const search = shadow.querySelector<HTMLInputElement>(".search")!;
    search.value = "fixture recipient b";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(rows()[0]?.hidden).toBe(true);
    expect(rows()[1]?.hidden).toBe(false);
    expect(shadow.querySelector("style")?.textContent).toMatch(
      /\.recipient\[hidden\]\s*\{\s*display:\s*none;\s*\}/,
    );
  });

  it("supports Cyrillic local search", () => {
    const { shadow, rows } = renderPicker();
    const search = shadow.querySelector<HTMLInputElement>(".search")!;
    search.value = "КИРИЛЛИЧЕСКИЙ ПОДЗАГОЛОВОК";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(rows()[1]?.hidden).toBe(false);
    expect(rows()[0]?.hidden).toBe(true);
  });

  it("shows the empty state for a search without matches", () => {
    const { shadow } = renderPicker();
    const search = shadow.querySelector<HTMLInputElement>(".search")!;
    search.value = "missing";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    const empty = shadow.querySelector<HTMLElement>(".empty")!;
    expect(empty.hidden).toBe(false);
    expect(empty.textContent).toBe("Ничего не найдено");
  });

  it("selects one recipient", () => {
    const { rows } = renderPicker();
    rows()[0]?.click();
    expect(rows()[0]?.getAttribute("aria-selected")).toBe("true");
    expect(rows()[1]?.getAttribute("aria-selected")).toBe("false");
  });

  it("keeps multiple recipients selected", () => {
    const { rows } = renderPicker();
    rows()[0]?.click();
    rows()[1]?.click();
    expect(rows()[0]?.getAttribute("aria-selected")).toBe("true");
    expect(rows()[1]?.getAttribute("aria-selected")).toBe("true");
  });

  it("updates the selected-recipient count", () => {
    const { shadow, rows } = renderPicker();
    expect(shadow.querySelector(".selection-count")?.textContent).toBe("Выбрано: 0");
    rows()[0]?.click();
    rows()[1]?.click();
    expect(shadow.querySelector(".selection-count")?.textContent).toBe("Выбрано: 2");
  });

  it("removes a recipient when its row is selected again", () => {
    const { rows, next } = renderPicker();
    rows()[0]?.click();
    rows()[1]?.click();
    rows()[0]?.click();
    expect(rows()[0]?.getAttribute("aria-selected")).toBe("false");
    expect(rows()[1]?.getAttribute("aria-selected")).toBe("true");
    expect(next.disabled).toBe(false);
  });

  it("keeps Next disabled without a selection", () => {
    expect(renderPicker().next.disabled).toBe(true);
  });

  it("enables Next after a supported row is selected", () => {
    const { rows, next } = renderPicker();
    rows()[0]?.click();
    expect(next.disabled).toBe(false);
  });

  it("confirms the externally owned selection", () => {
    const { rows, next, onNext } = renderPicker();
    rows()[0]?.click();
    rows()[1]?.click();
    next.click();
    expect(onNext).toHaveBeenCalledOnce();
    expect(onNext).toHaveBeenCalledWith();
  });

  it("emits cancellation from the Cancel button", () => {
    const { shadow, onCancel } = renderPicker();
    shadow.querySelector<HTMLButtonElement>(".cancel")!.click();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("emits cancellation from the close button", () => {
    const { shadow, onCancel } = renderPicker();
    shadow.querySelector<HTMLButtonElement>(".close")!.click();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("emits cancellation from Escape while the picker owns focus", () => {
    const { shadow, onCancel } = renderPicker();
    shadow.querySelector<HTMLInputElement>(".search")!.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("restores search focus whenever Telegram reclaims or drops it", async () => {
    const { shadow } = renderPicker();
    const search = shadow.querySelector<HTMLInputElement>(".search")!;
    const telegramCaption = document.createElement("div");
    telegramCaption.tabIndex = 0;
    telegramCaption.setAttribute("contenteditable", "true");
    document.body.append(telegramCaption);
    telegramCaption.focus();

    expect(shadow.activeElement).toBe(search);

    search.blur();
    await Promise.resolve();

    expect(shadow.activeElement).toBe(search);

    telegramCaption.focus();

    expect(shadow.activeElement).toBe(search);
  });

  it("recovers synchronously from a Telegram focusin steal", () => {
    const { shadow } = renderPicker();
    const search = shadow.querySelector<HTMLInputElement>(".search")!;
    const focusSearch = vi.spyOn(search, "focus");
    const telegramInput = document.createElement("textarea");
    document.body.append(telegramInput);

    focusSearch.mockClear();
    telegramInput.focus();

    expect(focusSearch).toHaveBeenCalledOnce();
    expect(shadow.activeElement).toBe(search);
  });

  it("recovers from focusout to document.body in a microtask", async () => {
    const { shadow } = renderPicker();
    const search = shadow.querySelector<HTMLInputElement>(".search")!;
    const focusSearch = vi.spyOn(search, "focus");

    focusSearch.mockClear();
    search.blur();
    expect(focusSearch).not.toHaveBeenCalled();

    await Promise.resolve();

    expect(focusSearch).toHaveBeenCalledOnce();
    expect(shadow.activeElement).toBe(search);
  });

  it("does not run a queued focus recovery after close", async () => {
    const { picker, shadow } = renderPicker();
    const search = shadow.querySelector<HTMLInputElement>(".search")!;
    const focusSearch = vi.spyOn(search, "focus");

    search.blur();
    picker.hide();
    focusSearch.mockClear();
    await Promise.resolve();

    expect(focusSearch).not.toHaveBeenCalled();
  });

  it("reopens with exactly one active focus guard", () => {
    const { picker } = renderPicker();
    picker.hide();
    picker.show(recipients, { onToggle: vi.fn(), onNext: vi.fn(), onCancel: vi.fn() });
    const shadow = document.querySelector<HTMLElement>("[data-clean-forward-recipient-picker]")!.shadowRoot!;
    const search = shadow.querySelector<HTMLInputElement>(".search")!;
    const focusSearch = vi.spyOn(search, "focus");
    const telegramInput = document.createElement("input");
    document.body.append(telegramInput);

    telegramInput.focus();

    expect(focusSearch).toHaveBeenCalledOnce();
    expect(shadow.activeElement).toBe(search);
  });

  it("leaves a foreign non-text modal control usable", () => {
    renderPicker();
    const modalButton = document.createElement("button");
    const activateModal = vi.fn();
    modalButton.addEventListener("click", activateModal);
    document.body.append(modalButton);

    modalButton.focus();
    modalButton.click();

    expect(document.activeElement).toBe(modalButton);
    expect(activateModal).toHaveBeenCalledOnce();
  });

  it("focuses search on open so typing filters without a manual click", () => {
    const { shadow, rows } = renderPicker();
    const search = shadow.querySelector<HTMLInputElement>(".search")!;
    expect(shadow.activeElement).toBe(search);

    search.value = "fixture recipient b";
    search.dispatchEvent(new InputEvent("input", { bubbles: true, data: "b" }));

    expect(rows()[0]?.hidden).toBe(true);
    expect(rows()[1]?.hidden).toBe(false);
  });

  it("focus recovery leaves composer content untouched and never calls Send", () => {
    const { shadow } = renderPicker();
    const composer = document.createElement("div");
    composer.setAttribute("contenteditable", "true");
    composer.textContent = "existing composer text";
    const send = document.createElement("button");
    send.className = "btn-send";
    const sendClick = vi.spyOn(send, "click");
    const sendMessageWithForward = vi.fn();
    Object.assign(window, { ChatInput: { sendMessageWithForward } });
    document.body.append(composer, send);

    composer.focus();

    expect(shadow.activeElement).toBe(shadow.querySelector(".search"));
    expect(composer.textContent).toBe("existing composer text");
    expect(sendClick).not.toHaveBeenCalled();
    expect(sendMessageWithForward).not.toHaveBeenCalled();
  });

  it("keeps selection while filtering and restoring the list", () => {
    const { shadow, rows, selected } = renderPicker();
    rows()[0]?.click();
    const search = shadow.querySelector<HTMLInputElement>(".search")!;
    search.value = "fixture recipient b";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(selected).toEqual(new Set(["1"]));
    expect(rows()[0]?.getAttribute("aria-selected")).toBe("true");
  });

  it("keeps selection actionable when a virtualized rerender removes its row", () => {
    const { picker, rows, next } = renderPicker();
    rows()[0]?.click();
    picker.updateRecipients([recipients[1]!], ["1"]);
    expect(next.disabled).toBe(false);
    expect(next.parentElement?.querySelector(".selection-count")?.textContent).toContain("1");
  });

  it("does not hide a native search result found by metadata outside title and subtitle", () => {
    const { picker, shadow, rows } = renderPicker();
    const search = shadow.querySelector<HTMLInputElement>(".search")!;
    search.value = "remote_username";
    search.dispatchEvent(new InputEvent("input", { bubbles: true }));
    picker.updateRecipients(
      [{ peerKey: "99", title: "Unrelated display name", supported: true }],
      [],
    );
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.hidden).toBe(false);
  });

  it("clears rendered selection when closed", () => {
    const { picker, rows } = renderPicker();
    rows()[0]?.click();
    picker.hide();
    picker.show(recipients, { onToggle: vi.fn(), onNext: vi.fn(), onCancel: vi.fn() });
    const host = document.querySelector<HTMLElement>("[data-clean-forward-recipient-picker]")!;
    expect(host.shadowRoot!.querySelector(".recipient")?.getAttribute("aria-selected")).toBe("false");
  });

  it("does not create another popup DOM node when shown repeatedly", () => {
    const { picker } = renderPicker();
    picker.show(recipients, { onToggle: vi.fn(), onNext: vi.fn(), onCancel: vi.fn() });
    expect(document.querySelectorAll("[data-clean-forward-recipient-picker]")).toHaveLength(1);
  });

  it("does not duplicate the search input listener when shown repeatedly", () => {
    const { picker, shadow } = renderPicker();
    const applyFilter = vi.spyOn(
      picker as unknown as { applyFilter(): void },
      "applyFilter",
    );
    picker.show(recipients, { onToggle: vi.fn(), onNext: vi.fn(), onCancel: vi.fn() });
    applyFilter.mockClear();
    const search = shadow.querySelector<HTMLInputElement>(".search")!;
    search.value = "fixture";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(applyFilter).toHaveBeenCalledOnce();
  });

  it("cleanup removes popup DOM, Escape binding, and stale callbacks", () => {
    const { picker, host, rows, onCancel, onToggle } = renderPicker();
    const detachedRow = rows()[0]!;
    picker.hide();
    expect(host.isConnected).toBe(false);
    detachedRow.click();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onToggle).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("reopening installs one fresh Escape lifecycle", () => {
    const { picker, onCancel } = renderPicker();
    picker.hide();
    picker.show(recipients, { onToggle: vi.fn(), onNext: vi.fn(), onCancel });
    const host = document.querySelector<HTMLElement>("[data-clean-forward-recipient-picker]")!;
    host.shadowRoot!.querySelector<HTMLInputElement>(".search")!.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", cancelable: true }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("leaves Escape to another focused modal", () => {
    const { onCancel } = renderPicker();
    const modalButton = document.createElement("button");
    document.body.append(modalButton);
    modalButton.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("does not allow a composite unsupported peer key to be selected", () => {
    const { rows, next } = renderPicker();
    expect(rows()[2]?.disabled).toBe(true);
    rows()[2]?.click();
    expect(next.disabled).toBe(true);
  });
});
