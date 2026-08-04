import { describe, expect, it, vi } from "vitest";
import type { Recipient } from "../../src/recipient/Recipient";
import { TelegramChatNavigator } from "../../src/telegram/TelegramChatNavigator";
import { createLogger, installComposer, installDialogRow } from "../helpers";

const recipient: Recipient = { peerKey: "99", title: "Target", supported: true };

describe("TelegramChatNavigator", () => {
  it("successfully waits for a composer with the expected data-peer-id", async () => {
    const row = installDialogRow("99");
    row.addEventListener("mousedown", () => installComposer("99"));
    const result = await new TelegramChatNavigator(createLogger()).navigate(
      recipient,
      new AbortController().signal,
    );
    expect(result).toEqual({ success: true, message: "Чат получателя открыт." });
  });

  it("finishes with an error when the active composer peerId does not match", async () => {
    vi.useFakeTimers();
    const row = installDialogRow("99");
    row.addEventListener("mousedown", () => installComposer("100"));
    const promise = new TelegramChatNavigator(createLogger()).navigate(
      recipient,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await promise).toMatchObject({ success: false });
  });

  it("does not overwrite a non-empty composer", async () => {
    const row = installDialogRow("99");
    row.addEventListener("mousedown", () => installComposer("99", "existing draft"));
    const result = await new TelegramChatNavigator(createLogger()).navigate(
      recipient,
      new AbortController().signal,
    );
    expect(result.success).toBe(false);
    expect(document.querySelector(".input-message-input")?.textContent).toBe("existing draft");
  });

  it("blocks insertion when a visible reply or forward draft exists", async () => {
    const row = installDialogRow("99");
    row.addEventListener("mousedown", () => {
      const composer = installComposer("99");
      const draft = document.createElement("div");
      draft.className = "reply-wrapper";
      vi.spyOn(draft, "getBoundingClientRect").mockReturnValue({
        width: 100,
        height: 30,
        top: 0,
        left: 0,
        right: 100,
        bottom: 30,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
      composer.parentElement!.append(draft);
    });
    const result = await new TelegramChatNavigator(createLogger()).navigate(
      recipient,
      new AbortController().signal,
    );
    expect(result).toMatchObject({ success: false });
    expect(result.message).toContain("reply или forward draft");
  });

  it("times out without partially changing composer content", async () => {
    vi.useFakeTimers();
    installDialogRow("99");
    const promise = new TelegramChatNavigator(createLogger()).navigate(
      recipient,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await promise).toMatchObject({ success: false });
    expect(document.querySelector(".input-message-input")).toBeNull();
  });

  it("stops waiting when AbortController aborts and removes its listener", async () => {
    installDialogRow("99");
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const promise = new TelegramChatNavigator(createLogger()).navigate(recipient, controller.signal);
    controller.abort();
    expect(await promise).toEqual({ success: false, message: "Переход отменён." });
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});
