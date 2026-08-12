import { describe, expect, it, vi } from "vitest";
import { PendingTransfer } from "../../src/domain/PendingTransfer";
import {
  createMessagePayloadFixture,
  createTextMessagePayload,
} from "../helpers";

describe("PendingTransfer", () => {
  it("keeps the selected immutable bundle", () => {
    const pending = new PendingTransfer();
    const payload = createTextMessagePayload("fixture-selected");
    pending.select(payload);
    expect(pending.peek()).toBe(payload);
    expect(pending.hasValue()).toBe(true);
  });

  it("clears the complete bundle when cancellation clears the transfer", () => {
    const pending = new PendingTransfer();
    pending.select(createTextMessagePayload("fixture-cancel"));
    pending.clear();
    expect(pending.peek()).toBeNull();
    expect(pending.hasValue()).toBe(false);
  });

  it("keeps photo bytes only in memory", () => {
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    const pending = new PendingTransfer();
    const image = new Blob(["fixture-bytes"], { type: "image/webp" });
    const payload = createMessagePayloadFixture({
      kind: "image",
      image,
      fileName: "photo.webp",
    });
    pending.select(payload);
    expect(pending.peek()?.units[0]).toMatchObject({
      kind: "file",
      item: { media: { blob: image } },
    });
    expect(storageWrite).not.toHaveBeenCalled();
  });

  it("atomically blocks a repeated operation while insertion is active", () => {
    const pending = new PendingTransfer();
    pending.select(createTextMessagePayload("fixture-one"));
    expect(pending.beginInsertion()?.units[0]).toMatchObject({ kind: "text" });
    expect(pending.beginInsertion()).toBeNull();
    expect(pending.isInsertionInProgress()).toBe(true);
  });

  it("returns to ready state after a recoverable error", () => {
    const pending = new PendingTransfer();
    const payload = createTextMessagePayload("fixture-retry");
    pending.select(payload);
    pending.beginInsertion();
    expect(pending.restoreAfterFailure()).toBe(true);
    expect(pending.isInsertionInProgress()).toBe(false);
    expect(pending.beginInsertion()).toBe(payload);
  });

  it("does not allow invalid state transitions", () => {
    const pending = new PendingTransfer();
    expect(pending.beginInsertion()).toBeNull();
    expect(pending.restoreAfterFailure()).toBe(false);
    expect(pending.completeInsertion()).toBe(false);
    const payload = createTextMessagePayload("fixture-ready");
    pending.select(payload);
    expect(pending.completeInsertion()).toBe(false);
    expect(pending.peek()).toBe(payload);
  });

  it("does not replace an owned bundle during insertion", () => {
    const pending = new PendingTransfer();
    const original = createTextMessagePayload("fixture-original");
    pending.select(original);
    pending.beginInsertion();
    expect(pending.select(createTextMessagePayload("fixture-replacement"))).toBe(false);
    expect(pending.peek()).toBe(original);
  });

  it("clears the bundle only after a valid completion", () => {
    const pending = new PendingTransfer();
    pending.select(createTextMessagePayload("fixture-done"));
    pending.beginInsertion();
    expect(pending.completeInsertion()).toBe(true);
    expect(pending.peek()).toBeNull();
    expect(pending.isInsertionInProgress()).toBe(false);
  });
});
