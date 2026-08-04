import { describe, expect, it, vi } from "vitest";
import type { Recipient } from "../../src/recipient/Recipient";
import { RecipientPicker } from "../../src/ui/RecipientPicker";

const recipients: readonly Recipient[] = [
  { peerKey: "1", title: "Alice", subtitle: "Работа", supported: true },
  { peerKey: "2", title: "БОРИС", subtitle: "Друзья", supported: true },
  {
    peerKey: "3_99",
    title: "Forum topic",
    supported: false,
    unsupportedReason: "Темы форума пока не поддерживаются",
  },
];

function renderPicker() {
  const picker = new RecipientPicker();
  const onNext = vi.fn();
  const onCancel = vi.fn();
  picker.show(recipients, { onNext, onCancel });
  const host = document.querySelector<HTMLElement>("[data-clean-forward-recipient-picker]")!;
  const shadow = host.shadowRoot!;
  const rows = () => Array.from(shadow.querySelectorAll<HTMLButtonElement>(".recipient"));
  const next = shadow.querySelector<HTMLButtonElement>(".next")!;
  return { picker, host, shadow, rows, next, onNext, onCancel };
}

describe("RecipientPicker", () => {
  it("renders the recipient list", () => {
    const { rows } = renderPicker();
    expect(rows().map((row) => row.querySelector(".title")?.textContent)).toEqual([
      "Alice",
      "БОРИС",
      "Forum topic",
    ]);
  });

  it("filters locally without regard to case", () => {
    const { shadow, rows } = renderPicker();
    const search = shadow.querySelector<HTMLInputElement>(".search")!;
    search.value = "борис";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(rows().filter((row) => !row.hidden).map((row) => row.textContent)).toHaveLength(1);
    expect(rows()[1]?.hidden).toBe(false);
  });

  it("selects one recipient", () => {
    const { rows } = renderPicker();
    rows()[0]?.click();
    expect(rows()[0]?.getAttribute("aria-selected")).toBe("true");
    expect(rows()[1]?.getAttribute("aria-selected")).toBe("false");
  });

  it("replaces the previous selection when another row is chosen", () => {
    const { rows } = renderPicker();
    rows()[0]?.click();
    rows()[1]?.click();
    expect(rows()[0]?.getAttribute("aria-selected")).toBe("false");
    expect(rows()[1]?.getAttribute("aria-selected")).toBe("true");
  });

  it("keeps Next disabled without a selection", () => {
    expect(renderPicker().next.disabled).toBe(true);
  });

  it("enables Next after a supported row is selected", () => {
    const { rows, next } = renderPicker();
    rows()[0]?.click();
    expect(next.disabled).toBe(false);
  });

  it("confirms only the one selected recipient", () => {
    const { rows, next, onNext } = renderPicker();
    rows()[0]?.click();
    rows()[1]?.click();
    next.click();
    expect(onNext).toHaveBeenCalledOnce();
    expect(onNext).toHaveBeenCalledWith(recipients[1]);
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

  it("does not allow a composite unsupported peer key to be selected", () => {
    const { rows, next } = renderPicker();
    expect(rows()[2]?.disabled).toBe(true);
    rows()[2]?.click();
    expect(next.disabled).toBe(true);
  });
});
