import { describe, expect, it, vi } from "vitest";
import type { DeliveryBatchSnapshot } from "../../src/delivery/DeliveryBatch";
import type { Recipient } from "../../src/recipient/Recipient";
import { DeliveryProgressPanel } from "../../src/ui/DeliveryProgressPanel";

const recipient: Recipient = { peerKey: "8", title: "Fixture recipient", supported: true };

function snapshot(overrides: Partial<DeliveryBatchSnapshot> = {}): DeliveryBatchSnapshot {
  return {
    recipients: [{ recipient, status: "navigating", sendClicked: false }],
    currentIndex: 0,
    currentRecipient: recipient,
    sentCount: 0,
    failedCount: 0,
    unknownCount: 0,
    cancelRequested: false,
    running: true,
    retryableCount: 0,
    ...overrides,
  };
}

describe("DeliveryProgressPanel", () => {
  it("shows current position, recipient, counts, and a working cancel action", () => {
    const onCancel = vi.fn();
    const panel = new DeliveryProgressPanel();
    panel.show(snapshot(), { onCancel, onRetry: vi.fn(), onClose: vi.fn() });
    const shadow = document.querySelector<HTMLElement>("[data-clean-forward-delivery-progress]")!.shadowRoot!;
    expect(shadow.textContent).toContain("Отправка 1 / 1");
    expect(shadow.textContent).toContain("Fixture recipient");
    expect(shadow.textContent).toContain("Отправлено: 0");
    shadow.querySelector<HTMLButtonElement>(".cancel")!.click();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("shows a final retryable summary without leaving Cancel active", () => {
    const onRetry = vi.fn();
    const panel = new DeliveryProgressPanel();
    panel.show(snapshot({
      recipients: [{ recipient, status: "failed", sendClicked: false, detail: "before Send" }],
      currentIndex: null,
      currentRecipient: null,
      failedCount: 1,
      running: false,
      retryableCount: 1,
    }), { onCancel: vi.fn(), onRetry, onClose: vi.fn() });
    const shadow = document.querySelector<HTMLElement>("[data-clean-forward-delivery-progress]")!.shadowRoot!;
    expect(shadow.querySelector<HTMLButtonElement>(".cancel")!.hidden).toBe(true);
    expect(shadow.querySelector<HTMLButtonElement>(".retry")!.hidden).toBe(false);
    expect(shadow.textContent).toContain("before Send");
    shadow.querySelector<HTMLButtonElement>(".retry")!.click();
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
