import { describe, expect, it } from "vitest";
import { describePayload, type MessagePayload } from "../../src/domain/MessagePayload";
import { PendingTransfer } from "../../src/domain/PendingTransfer";

describe("MessagePayload", () => {
  it("represents text payloads", () => {
    const payload: MessagePayload = { kind: "text", text: "hello" };
    expect(payload).toEqual({ kind: "text", text: "hello" });
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
    const payload: MessagePayload = { kind: "text", text: "saved" };
    pending.select(payload);
    expect(pending.peek()).toBe(payload);
    expect(pending.hasValue()).toBe(true);
  });

  it("clears the payload when cancellation clears the transfer", () => {
    const pending = new PendingTransfer();
    pending.select({ kind: "text", text: "cancel me" });
    pending.clear();
    expect(pending.peek()).toBeNull();
    expect(pending.hasValue()).toBe(false);
  });
});
