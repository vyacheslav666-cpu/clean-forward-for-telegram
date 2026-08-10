import { describe, expect, it, vi } from "vitest";
import type { Recipient } from "../../src/recipient/Recipient";
import type { RecipientSourceAdapter } from "../../src/recipient/RecipientSourceAdapter";
import { TelegramChatNavigator } from "../../src/telegram/TelegramChatNavigator";
import { observeDom } from "../../src/utils/observeDom";
import { createLogger, installComposer, installDialogRow } from "../helpers";

const recipient: Recipient = { peerKey: "99", title: "Target", supported: true };

describe("TelegramChatNavigator", () => {
  function appendVisibleDraft(composer: HTMLElement, label: string): void {
    const draft = document.createElement("div");
    draft.className = "reply-wrapper";
    draft.textContent = label;
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
  }

  it("successfully waits for a composer with the expected data-peer-id", async () => {
    const row = installDialogRow("99");
    row.addEventListener("mousedown", () => installComposer("99"));
    const result = await new TelegramChatNavigator(createLogger()).navigate(
      recipient,
      new AbortController().signal,
    );
    expect(result).toEqual({ success: true, message: "Чат получателя открыт." });
  });

  it("detects navigation when Telegram reuses a composer and changes only data-peer-id", async () => {
    const row = installDialogRow("99");
    const composer = installComposer("100");
    const navigator = new TelegramChatNavigator(createLogger());
    const observation = observeDom(document.documentElement, () => navigator.notifyDomChanged());
    row.addEventListener("mousedown", () => {
      queueMicrotask(() => { composer.dataset.peerId = "99"; });
    });

    try {
      await expect(navigator.navigate(recipient, new AbortController().signal)).resolves.toEqual({
        success: true,
        message: "Чат получателя открыт.",
      });
    } finally {
      observation.disconnect();
    }
  });

  it("starts navigation through the confirmed dialog row mousedown", async () => {
    const row = installDialogRow("99");
    const mousedown = vi.fn(() => installComposer("99"));
    const click = vi.fn();
    row.addEventListener("mousedown", mousedown);
    row.addEventListener("click", click);
    await new TelegramChatNavigator(createLogger()).navigate(recipient, new AbortController().signal);
    expect(mousedown).toHaveBeenCalledOnce();
    expect(click).not.toHaveBeenCalled();
  });

  it("opens a search-only recipient without requiring a visible recent row", async () => {
    vi.useFakeTimers();
    const left = document.createElement("div");
    left.id = "column-left";
    const searchContainer = document.createElement("div");
    searchContainer.id = "search-container";
    const results = document.createElement("div");
    results.className = "search-super-content-chats";
    searchContainer.append(results);
    left.append(searchContainer);
    document.body.append(left);
    const clearSearch = vi.fn();
    const source = {
      searchRecipients: vi.fn((_query, _signal, onUpdate) => {
        const row = document.createElement("a");
        row.className = "row chatlist-chat";
        row.dataset.peerId = "99";
        row.addEventListener("mousedown", () => installComposer("99"));
        results.append(row);
        onUpdate([recipient]);
      }),
      clearSearch,
    } as unknown as RecipientSourceAdapter;
    const navigator = new TelegramChatNavigator(createLogger(), source);

    const navigation = navigator.navigate(recipient, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(200);

    await expect(navigation).resolves.toMatchObject({ success: true });
    expect(source.searchRecipients).toHaveBeenCalledWith(
      "Target",
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(clearSearch).toHaveBeenCalledOnce();
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

  it("accepts a non-empty composer without overwriting it", async () => {
    const row = installDialogRow("99");
    row.addEventListener("mousedown", () => installComposer("99", "fixture-draft"));
    const result = await new TelegramChatNavigator(createLogger()).navigate(
      recipient,
      new AbortController().signal,
    );
    expect(result.success).toBe(true);
    expect(document.querySelector(".input-message-input")?.textContent).toBe("fixture-draft");
  });

  it("blocks insertion when a visible reply or forward draft exists", async () => {
    const row = installDialogRow("99");
    row.addEventListener("mousedown", () => {
      const composer = installComposer("99");
      appendVisibleDraft(composer, "reply draft");
    });
    const result = await new TelegramChatNavigator(createLogger()).navigate(
      recipient,
      new AbortController().signal,
    );
    expect(result).toMatchObject({ success: false });
    expect(result.message).toContain("reply или forward draft");
  });

  it("blocks a visible forward draft", async () => {
    const row = installDialogRow("99");
    row.addEventListener("mousedown", () => appendVisibleDraft(installComposer("99"), "forward draft"));
    const result = await new TelegramChatNavigator(createLogger()).navigate(
      recipient,
      new AbortController().signal,
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain("reply или forward draft");
  });

  it("blocks navigation while media preview is open", async () => {
    installDialogRow("99");
    const preview = document.createElement("div");
    preview.className = "popup-send-photo popup-new-media active";
    document.body.append(preview);
    const result = await new TelegramChatNavigator(createLogger()).navigate(
      recipient,
      new AbortController().signal,
    );
    expect(result).toEqual({
      success: false,
      message: "Закройте открытое media preview Telegram и повторите попытку.",
    });
  });

  it("blocks navigation while Telegram is sending", async () => {
    installDialogRow("99");
    const sending = document.createElement("div");
    sending.className = "sending";
    document.body.append(sending);
    const result = await new TelegramChatNavigator(createLogger()).navigate(
      recipient,
      new AbortController().signal,
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain("ещё отправляет");
  });

  it("times out without partially changing composer content", async () => {
    vi.useFakeTimers();
    installDialogRow("99");
    const promise = new TelegramChatNavigator(createLogger()).navigate(
      recipient,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await promise).toEqual({
      success: false,
      message: "Telegram не открыл выбранный чат вовремя. Попробуйте ещё раз.",
    });
    expect(document.querySelector(".input-message-input")).toBeNull();
  });

  it("successful navigation never clicks Send", async () => {
    const row = installDialogRow("99");
    const send = document.createElement("button");
    send.className = "btn-send";
    const sendClick = vi.spyOn(send, "click");
    row.addEventListener("mousedown", () => {
      installComposer("99").parentElement!.append(send);
    });
    const result = await new TelegramChatNavigator(createLogger()).navigate(
      recipient,
      new AbortController().signal,
    );
    expect(result.success).toBe(true);
    expect(sendClick).not.toHaveBeenCalled();
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

  it("retries when navigation initially does not settle and the expected peer becomes available later", async () => {
    vi.useFakeTimers();
    const row = installDialogRow("99");
    const mousedown = vi.fn(() => {
      if (mousedown.mock.calls.length === 2) {
        installComposer("99");
      }
    });
    row.addEventListener("mousedown", mousedown);

    const navigation = new TelegramChatNavigator(createLogger()).navigate(
      recipient,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(1_500);

    await expect(navigation).resolves.toEqual({
      success: true,
      message: "Чат получателя открыт.",
    });
    expect(mousedown).toHaveBeenCalledTimes(2);
  });

  it("exhausts a bounded number of safe navigation attempts", async () => {
    vi.useFakeTimers();
    const row = installDialogRow("99");
    const mousedown = vi.fn();
    row.addEventListener("mousedown", mousedown);

    const navigation = new TelegramChatNavigator(createLogger()).navigate(
      recipient,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(navigation).resolves.toMatchObject({ success: false });
    expect(mousedown).toHaveBeenCalledTimes(3);
  });

  it("reasserts the expected peer after the user switches to another chat during navigation", async () => {
    vi.useFakeTimers();
    const row = installDialogRow("99");
    const mousedown = vi.fn(() => {
      document.querySelectorAll(".chat-input-main").forEach((node) => node.remove());
      installComposer(mousedown.mock.calls.length === 1 ? "100" : "99");
    });
    row.addEventListener("mousedown", mousedown);

    const navigation = new TelegramChatNavigator(createLogger()).navigate(
      recipient,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(1_500);

    await expect(navigation).resolves.toMatchObject({ success: true });
    expect(document.querySelector<HTMLElement>(".input-message-input")?.dataset.peerId).toBe("99");
    expect(mousedown).toHaveBeenCalledTimes(2);
  });

  it("requires the same expected-peer composer to survive the critical rerender window", async () => {
    vi.useFakeTimers();
    const row = installDialogRow("99");
    const navigator = new TelegramChatNavigator(createLogger());
    let firstComposer: HTMLElement | null = null;
    row.addEventListener("mousedown", () => {
      firstComposer = installComposer("99");
      window.setTimeout(() => {
        firstComposer?.closest(".chat-input-main")?.remove();
        installComposer("99");
        navigator.notifyDomChanged();
      }, 60);
    });

    const navigation = navigator.navigate(recipient, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(500);

    await expect(navigation).resolves.toMatchObject({ success: true });
    expect((firstComposer as unknown as HTMLElement | null)?.isConnected).toBe(false);
  });

  it("uses the same peer-readiness contract inside a Chrome PWA-like app shell", async () => {
    vi.useFakeTimers();
    const appShell = document.createElement("main");
    appShell.dataset.fixtureMode = "chrome-pwa";
    const tab = document.createElement("div");
    tab.className = "tabs-tab chatlist-parts active";
    const list = document.createElement("ul");
    list.className = "chatlist virtual-chatlist";
    const row = document.createElement("a");
    row.className = "row chatlist-chat";
    row.dataset.peerId = "99";
    list.append(row);
    tab.append(list);
    appShell.append(tab);
    document.body.append(appShell);
    row.addEventListener("mousedown", () => installComposer("99"));

    const navigation = new TelegramChatNavigator(createLogger()).navigate(
      recipient,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(500);

    await expect(navigation).resolves.toMatchObject({ success: true });
  });
});
