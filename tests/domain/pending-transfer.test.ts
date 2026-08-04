import { describe, expect, it, vi } from "vitest";
import { describePayload, type MessagePayload } from "../../src/domain/MessagePayload";
import { PendingTransfer } from "../../src/domain/PendingTransfer";

describe("MessagePayload", () => {
  it("represents text payloads", () => {
    const payload: MessagePayload = { kind: "text", text: "fixture-text" };
    expect(payload).toEqual({ kind: "text", text: "fixture-text" });
    expect(describePayload(payload)).toBe("Текст готов к вставке");
  });

  it("represents photo payloads", () => {
    const image = new Blob(["image"], { type: "image/png" });
    const payload: MessagePayload = { kind: "image", image, fileName: "photo.png" };
    expect(payload.kind).toBe("image");
    expect(describePayload(payload)).toBe("Картинка готова");
  });
});

describe("PendingTransfer", () => {
  it("keeps the selected payload", () => {
    const pending = new PendingTransfer();
    const payload: MessagePayload = { kind: "text", text: "fixture-selected" };
    pending.select(payload);
    expect(pending.peek()).toBe(payload);
    expect(pending.hasValue()).toBe(true);
  });

  it("clears the payload when cancellation clears the transfer", () => {
    const pending = new PendingTransfer();
    pending.select({ kind: "text", text: "fixture-cancel" });
    pending.clear();
    expect(pending.peek()).toBeNull();
    expect(pending.hasValue()).toBe(false);
  });

  it("keeps a photo Blob only on the in-memory payload", () => {
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    const pending = new PendingTransfer();
    const image = new Blob(["fixture-bytes"], { type: "image/webp" });
    pending.select({ kind: "image", image, fileName: "photo.webp" });
    expect(pending.peek()).toMatchObject({ kind: "image", image });
    expect(storageWrite).not.toHaveBeenCalled();
  });

  it("atomically blocks a repeated operation while insertion is active", () => {
    const pending = new PendingTransfer();
    pending.select({ kind: "text", text: "fixture-one" });
    expect(pending.beginInsertion()).toMatchObject({ text: "fixture-one" });
    expect(pending.beginInsertion()).toBeNull();
    expect(pending.isInsertionInProgress()).toBe(true);
  });

  it("returns to ready state after a recoverable error", () => {
    const pending = new PendingTransfer();
    pending.select({ kind: "text", text: "fixture-retry" });
    pending.beginInsertion();
    expect(pending.restoreAfterFailure()).toBe(true);
    expect(pending.isInsertionInProgress()).toBe(false);
    expect(pending.beginInsertion()).toMatchObject({ text: "fixture-retry" });
  });

  it("does not allow invalid state transitions", () => {
    const pending = new PendingTransfer();
    expect(pending.beginInsertion()).toBeNull();
    expect(pending.restoreAfterFailure()).toBe(false);
    expect(pending.completeInsertion()).toBe(false);
    pending.select({ kind: "text", text: "fixture-ready" });
    expect(pending.completeInsertion()).toBe(false);
    expect(pending.peek()).toMatchObject({ text: "fixture-ready" });
  });

  it("does not replace an owned payload during insertion", () => {
    const pending = new PendingTransfer();
    const original: MessagePayload = { kind: "text", text: "fixture-original" };
    pending.select(original);
    pending.beginInsertion();
    expect(pending.select({ kind: "text", text: "fixture-replacement" })).toBe(false);
    expect(pending.peek()).toBe(original);
  });

  it("clears the payload only after a valid completion", () => {
    const pending = new PendingTransfer();
    pending.select({ kind: "text", text: "fixture-done" });
    pending.beginInsertion();
    expect(pending.completeInsertion()).toBe(true);
    expect(pending.peek()).toBeNull();
    expect(pending.isInsertionInProgress()).toBe(false);
  });
});
