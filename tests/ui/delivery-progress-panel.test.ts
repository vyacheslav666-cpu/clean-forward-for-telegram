import { describe, expect, it, vi } from "vitest";
import type { DeliveryBatchSnapshot } from "../../src/delivery/DeliveryBatch";
import type { Recipient } from "../../src/recipient/Recipient";
import { DeliveryProgressPanel } from "../../src/ui/DeliveryProgressPanel";
import type { AppConfig } from "../../src/config";

const recipient: Recipient = { peerKey: "8", title: "Fixture recipient", supported: true };
const productionConfig: AppConfig = { debug: { showDeliveryResultDialog: false } };
const debugConfig: AppConfig = { debug: { showDeliveryResultDialog: true } };

function unit(status: "pending" | "sent" | "failed-before-send") {
  return {
    index: 0,
    status,
    attemptCount: status === "pending" ? 0 : 1,
    sendClicked: status === "sent",
    outgoingConfirmed: status === "sent",
    failedBeforeSend: status === "failed-before-send",
    unknownAfterSend: false,
    safeToRetry: status !== "sent",
    messageIds: status === "sent" ? ["mid-8"] : [],
  } as const;
}

function snapshot(overrides: Partial<DeliveryBatchSnapshot> = {}): DeliveryBatchSnapshot {
  return {
    recipients: [{ recipient, status: "navigating", sendClicked: false, attemptCount: 1, units: [unit("pending")] }],
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

  it("shows mandatory source restoration after the last receipt without premature controls", () => {
    const onCancel = vi.fn();
    const onClose = vi.fn();
    const panel = new DeliveryProgressPanel(productionConfig);
    panel.show(snapshot({
      recipients: [{
        recipient,
        status: "sent",
        sendClicked: true,
        attemptCount: 1,
        units: [unit("sent")],
      }],
      currentIndex: null,
      currentRecipient: null,
      sentCount: 1,
      running: true,
      retryableCount: 0,
    }), { onCancel, onRetry: vi.fn(), onClose });

    const shadow = document.querySelector<HTMLElement>(
      "[data-clean-forward-delivery-progress]",
    )!.shadowRoot!;
    expect(shadow.textContent).toContain("Возвращаемся в исходный чат…");
    expect(shadow.textContent).not.toContain("Операция завершена.");
    expect(shadow.querySelector<HTMLButtonElement>(".cancel")!.hidden).toBe(true);
    expect(shadow.querySelector<HTMLButtonElement>(".retry")!.hidden).toBe(true);
    expect(shadow.querySelector<HTMLButtonElement>(".close")!.hidden).toBe(true);

    const keydown = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    const keyup = new KeyboardEvent("keyup", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(keydown);
    window.dispatchEvent(keyup);
    expect(keydown.defaultPrevented).toBe(true);
    expect(keyup.defaultPrevented).toBe(true);
    expect(onCancel).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    panel.update(snapshot({
      recipients: [{
        recipient,
        status: "sent",
        sendClicked: true,
        attemptCount: 1,
        units: [unit("sent")],
      }],
      currentIndex: null,
      currentRecipient: null,
      sentCount: 1,
      running: false,
      retryableCount: 0,
    }));
    expect(shadow.textContent).toContain("Операция завершена.");
    expect(shadow.textContent).not.toContain("Возвращаемся в исходный чат…");
    expect(shadow.querySelector<HTMLButtonElement>(".cancel")!.hidden).toBe(true);
    expect(shadow.querySelector<HTMLButtonElement>(".close")!.hidden).toBe(false);
    shadow.querySelector<HTMLButtonElement>(".close")!.click();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps retry backoff cancellable and does not label it as source restoration", () => {
    const onCancel = vi.fn();
    const panel = new DeliveryProgressPanel(productionConfig);
    panel.show(snapshot({
      recipients: [{
        recipient,
        status: "pending",
        sendClicked: false,
        attemptCount: 1,
        units: [unit("pending")],
      }],
      currentIndex: null,
      currentRecipient: null,
      running: true,
      retryableCount: 1,
    }), { onCancel, onRetry: vi.fn(), onClose: vi.fn() });

    const shadow = document.querySelector<HTMLElement>(
      "[data-clean-forward-delivery-progress]",
    )!.shadowRoot!;
    expect(shadow.textContent).toContain("Подготовка следующего шага…");
    expect(shadow.textContent).not.toContain("Возвращаемся в исходный чат…");
    expect(shadow.textContent).not.toContain("Операция завершена.");
    const cancel = shadow.querySelector<HTMLButtonElement>(".cancel")!;
    expect(cancel.hidden).toBe(false);
    cancel.click();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(shadow.querySelector<HTMLButtonElement>(".close")!.hidden).toBe(true);
  });

  it("shows a final retryable summary without leaving Cancel active", () => {
    const onRetry = vi.fn();
    const panel = new DeliveryProgressPanel();
    panel.show(snapshot({
      recipients: [{ recipient, status: "failed", sendClicked: false, attemptCount: 3, detail: "before Send", units: [unit("failed-before-send")] }],
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

  it("surfaces a terminal safety failure and hides retry", () => {
    const panel = new DeliveryProgressPanel(productionConfig);
    panel.show(snapshot({
      currentIndex: null,
      currentRecipient: null,
      running: false,
      retryableCount: 0,
      safetyFailure: "Prepared content cleanup could not be confirmed.",
    }), { onCancel: vi.fn(), onRetry: vi.fn(), onClose: vi.fn() });

    const shadow = document.querySelector<HTMLElement>(
      "[data-clean-forward-delivery-progress]",
    )!.shadowRoot!;
    const safety = shadow.querySelector<HTMLElement>("[data-safety-failure]");
    expect(safety?.textContent).toContain("Остановка безопасности");
    expect(safety?.textContent).toContain("Prepared content cleanup could not be confirmed.");
    expect(shadow.querySelector<HTMLButtonElement>(".retry")!.hidden).toBe(true);
  });

  it("shows attempt and retry diagnostics only when the debug modal flag is enabled", () => {
    const panel = new DeliveryProgressPanel(debugConfig);
    panel.show(snapshot({
      recipients: [{
        recipient,
        status: "sent",
        sendClicked: true,
        attemptCount: 2,
        retryReason: "peer not ready",
        messageId: "mid-8",
        units: [unit("sent")],
      }],
      currentIndex: null,
      currentRecipient: null,
      sentCount: 1,
      running: false,
    }), { onCancel: vi.fn(), onRetry: vi.fn(), onClose: vi.fn() });

    const shadow = document.querySelector<HTMLElement>(
      "[data-clean-forward-delivery-progress]",
    )!.shadowRoot!;
    expect(shadow.textContent).toContain("attempts=2");
    expect(shadow.textContent).toContain("retry=peer not ready");
    expect(shadow.textContent).toContain("data-mid=mid-8");
  });

  it("does not mix debug diagnostics into the production result DOM", () => {
    const panel = new DeliveryProgressPanel(productionConfig);
    panel.show(snapshot({
      recipients: [{
        recipient,
        status: "failed",
        sendClicked: false,
        attemptCount: 3,
        retryReason: "composer not ready",
        units: [unit("failed-before-send")],
        detail: "Пользовательская ошибка",
      }],
      currentIndex: null,
      currentRecipient: null,
      failedCount: 1,
      running: false,
      retryableCount: 1,
    }), { onCancel: vi.fn(), onRetry: vi.fn(), onClose: vi.fn() });

    const shadow = document.querySelector<HTMLElement>(
      "[data-clean-forward-delivery-progress]",
    )!.shadowRoot!;
    expect(shadow.textContent).toContain("Пользовательская ошибка");
    expect(shadow.textContent).not.toContain("attempts=");
    expect(shadow.textContent).not.toContain("retry=composer not ready");
  });

  it("consumes Escape and closes only the top-level Clean Forward result overlay", () => {
    const underlyingPicker = document.createElement("div");
    underlyingPicker.setAttribute("data-clean-forward-recipient-picker", "");
    document.body.append(underlyingPicker);
    const panel = new DeliveryProgressPanel(productionConfig);
    const onClose = vi.fn(() => panel.hide());
    panel.show(snapshot({
      recipients: [{ recipient, status: "failed", sendClicked: false, attemptCount: 3, units: [unit("failed-before-send")] }],
      currentIndex: null,
      currentRecipient: null,
      failedCount: 1,
      running: false,
    }), { onCancel: vi.fn(), onRetry: vi.fn(), onClose });
    const telegramKeydown = vi.fn();
    const telegramKeyup = vi.fn();
    window.addEventListener("keydown", telegramKeydown, true);
    window.addEventListener("keyup", telegramKeyup, true);

    const keydown = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    const keyup = new KeyboardEvent("keyup", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(keydown);
    window.dispatchEvent(keyup);
    window.removeEventListener("keydown", telegramKeydown, true);
    window.removeEventListener("keyup", telegramKeyup, true);

    expect(onClose).toHaveBeenCalledOnce();
    expect(keydown.defaultPrevented).toBe(true);
    expect(keyup.defaultPrevented).toBe(true);
    expect(telegramKeydown).not.toHaveBeenCalled();
    expect(telegramKeyup).not.toHaveBeenCalled();
    expect(document.querySelector("[data-clean-forward-delivery-progress]")).toBeNull();
    expect(underlyingPicker.isConnected).toBe(true);
  });
});
