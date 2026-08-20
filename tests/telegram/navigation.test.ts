import { describe, expect, it, vi } from "vitest";
import type { Recipient } from "../../src/recipient/Recipient";
import type { RecipientSourceAdapter } from "../../src/recipient/RecipientSourceAdapter";
import { TelegramChatNavigator } from "../../src/telegram/TelegramChatNavigator";
import { observeDom } from "../../src/utils/observeDom";
import { createLogger, installComposer, installDialogRow } from "../helpers";

const recipient: Recipient = { peerKey: "99", title: "Target", supported: true };

describe("TelegramChatNavigator", () => {
  /**
   * @param readOnly Renders the chat the way Web K renders a broadcast channel: the input node is
   * still there and still bound to the peer, but `finishPeerChange` left it non-editable because
   * the user cannot post. This is the shape in which a channel source is restored.
   */
  function installProductionChat(
    composerPeerKey: string,
    avatarPeerKey?: string,
    { readOnly = false }: { readOnly?: boolean } = {},
  ): HTMLElement {
    const column = document.createElement("section");
    column.id = "column-center";
    const chats = document.createElement("div");
    chats.className = "chats-container";
    const chat = document.createElement("div");
    chat.className = "chat tabs-tab active";
    if (avatarPeerKey !== undefined) {
      const topbar = document.createElement("div");
      topbar.className = "topbar";
      const avatar = document.createElement("div");
      avatar.className = "avatar person-avatar";
      avatar.dataset.peerId = avatarPeerKey;
      topbar.append(avatar);
      chat.append(topbar);
    }
    const owner = document.createElement("div");
    owner.className = "chat-input chat-input-main";
    const composer = document.createElement("div");
    composer.className = "input-message-input";
    composer.setAttribute("contenteditable", readOnly ? "false" : "true");
    composer.dataset.peerId = composerPeerKey;
    owner.append(composer);
    chat.append(owner);
    chats.append(chat);
    column.append(chats);
    document.body.append(column);
    return chat;
  }

  /** Builds the outgoing bubble Web K renders, with the state classes it really uses. */
  function appendOutgoing(
    parent: ParentNode,
    { messageId = "1001", classes = "", peerKey = "99" }: {
      messageId?: string;
      classes?: string;
      peerKey?: string;
    } = {},
  ): HTMLElement {
    const bubble = document.createElement("div");
    bubble.className = `bubble is-out ${classes}`.trim();
    bubble.dataset.peerId = peerKey;
    bubble.dataset.mid = messageId;
    parent.append(bubble);
    return bubble;
  }

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
        row.addEventListener("mousedown", () => {
          row.remove();
          queueMicrotask(() => installComposer("99"));
        });
        results.append(row);
        onUpdate([recipient]);
      }),
      clearSearch,
    } as unknown as RecipientSourceAdapter;
    const navigator = new TelegramChatNavigator(createLogger(), source);

    const navigation = navigator.navigate(recipient, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(700);

    await expect(navigation).resolves.toMatchObject({ success: true });
    expect(source.searchRecipients).toHaveBeenCalledWith(
      "Target",
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(clearSearch).toHaveBeenCalledOnce();
  });

  it("freshly resolves search again after a transient search-start failure", async () => {
    vi.useFakeTimers();
    const left = document.createElement("div");
    left.id = "column-left";
    left.innerHTML = '<div id="search-container"><div class="search-super-content-chats"></div></div>';
    document.body.append(left);
    let calls = 0;
    const source = {
      searchRecipients: vi.fn((_query, _signal, onUpdate) => {
        calls += 1;
        if (calls === 1) {
          throw new Error("input is being replaced");
        }
        const row = document.createElement("a");
        row.className = "row chatlist-chat";
        row.dataset.peerId = "99";
        row.addEventListener("mousedown", () => {
          row.remove();
          installComposer("99");
        });
        left.querySelector(".search-super-content-chats")!.append(row);
        onUpdate([recipient]);
      }),
      clearSearch: vi.fn(),
    } as unknown as RecipientSourceAdapter;

    const navigation = new TelegramChatNavigator(createLogger(), source).navigate(
      recipient,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(navigation).resolves.toMatchObject({ success: true });
    expect(source.searchRecipients).toHaveBeenCalledTimes(2);
  });

  it("uses the public TWeb route as a fallback and still waits for exact composer proof", async () => {
    vi.useFakeTimers();
    const source = {
      searchRecipients: vi.fn(),
      clearSearch: vi.fn(),
      waitForSearchSettled: vi.fn(async () => undefined),
    } as unknown as RecipientSourceAdapter;
    const onHashChange = (): void => {
      if (window.location.hash === "#/im?p=99") {
        installComposer("99");
      }
    };
    window.addEventListener("hashchange", onHashChange);

    try {
      const navigation = new TelegramChatNavigator(createLogger(), source).navigate(
        recipient,
        new AbortController().signal,
      );
      await vi.advanceTimersByTimeAsync(1_500);

      await expect(navigation).resolves.toMatchObject({ success: true });
      expect(window.location.hash).toBe("#/im?p=99");
    } finally {
      window.removeEventListener("hashchange", onHashChange);
      window.history.replaceState(null, "", "/");
    }
  });

  it("uses the original successful query instead of the display title", async () => {
    vi.useFakeTimers();
    const left = document.createElement("div");
    left.id = "column-left";
    left.innerHTML = '<div id="search-container"><div class="search-super-content-chats"></div></div>';
    document.body.append(left);
    const target = { ...recipient, title: "Display Name", searchQuery: "@exact_username" };
    const source = {
      searchRecipients: vi.fn((query, _signal, onUpdate) => {
        if (query !== "@exact_username") {
          return;
        }
        const row = document.createElement("a");
        row.className = "row chatlist-chat";
        row.dataset.peerId = "99";
        row.addEventListener("mousedown", () => installComposer("99"));
        left.querySelector(".search-super-content-chats")!.append(row);
        onUpdate([target]);
      }),
      clearSearch: vi.fn(),
    } as unknown as RecipientSourceAdapter;

    const navigation = new TelegramChatNavigator(createLogger(), source).navigate(
      target,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(700);

    await expect(navigation).resolves.toMatchObject({ success: true });
    expect(source.searchRecipients).toHaveBeenCalledWith(
      "@exact_username",
      expect.any(AbortSignal),
      expect.any(Function),
    );
  });

  it("ignores a stale hidden composer outside the active main chat", async () => {
    vi.useFakeTimers();
    installComposer("100").closest(".chat-input-main")!.classList.add("hide");
    const row = installDialogRow("99");
    row.addEventListener("mousedown", () => {
      row.classList.add("active");
      const column = document.createElement("section");
      column.id = "column-center";
      const chats = document.createElement("div");
      chats.className = "chats-container";
      const chat = document.createElement("div");
      chat.className = "chat tabs-tab active";
      const owner = document.createElement("div");
      owner.className = "chat-input chat-input-main";
      const composer = document.createElement("div");
      composer.className = "input-message-input";
      composer.setAttribute("contenteditable", "true");
      composer.dataset.peerId = "99";
      owner.append(composer);
      chat.append(owner);
      chats.append(chat);
      column.append(chats);
      document.body.append(column);
    });

    const navigation = new TelegramChatNavigator(createLogger()).navigate(
      recipient,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(500);
    await expect(navigation).resolves.toMatchObject({ success: true });
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

  it("blocks navigation while a send started after Telegram opened the destination", async () => {
    vi.useFakeTimers();
    installDialogRow("99");
    installComposer("99");
    const navigation = new TelegramChatNavigator(createLogger()).navigate(
      recipient,
      new AbortController().signal,
    );
    // Appended after the navigator first observed the destination, so it belongs to this window.
    appendOutgoing(document.body, { messageId: "1001.0001", classes: "is-outgoing is-sending" });

    await vi.advanceTimersByTimeAsync(5_000);

    const result = await navigation;
    expect(result.success).toBe(false);
    expect(result.message).toContain("ещё отправляет");
  });

  it("ignores an outgoing message that was already stuck before navigation started", async () => {
    // A message left sending by an offline session never completes. Blocking on it would make
    // the destination permanently unreachable instead of delaying it.
    vi.useFakeTimers();
    installDialogRow("99");
    installComposer("99");
    appendOutgoing(document.body, { messageId: "1001.0001", classes: "is-outgoing is-sending" });

    const navigation = new TelegramChatNavigator(createLogger()).navigate(
      recipient,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await navigation).toMatchObject({ success: true });
  });

  it("ignores an outgoing message Telegram already rejected", async () => {
    vi.useFakeTimers();
    installDialogRow("99");
    installComposer("99");
    const navigation = new TelegramChatNavigator(createLogger()).navigate(
      recipient,
      new AbortController().signal,
    );
    appendOutgoing(document.body, {
      messageId: "1001.0001",
      classes: "is-outgoing is-sending is-error",
    });

    await vi.advanceTimersByTimeAsync(5_000);

    expect(await navigation).toMatchObject({ success: true });
  });

  it("never blocks source restoration on a send that starts in the restored chat", async () => {
    // Restoration sends nothing, and a failed restore is a safety failure of the whole batch.
    vi.useFakeTimers();
    const row = installDialogRow("99");
    row.addEventListener("mousedown", () => {
      const chat = installProductionChat("99", "99");
      appendOutgoing(chat, { messageId: "1001.0001", classes: "is-outgoing is-sending" });
    });

    const navigation = new TelegramChatNavigator(createLogger()).navigate(
      recipient,
      new AbortController().signal,
      "source-restore",
    );
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await navigation).toMatchObject({ success: true });
  });

  it("restores the source despite in-flight sends in the chat being left and an inactive mounted chat", async () => {
    vi.useFakeTimers();
    const column = document.createElement("section");
    column.id = "column-center";
    const chats = document.createElement("div");
    chats.className = "chats-container";
    column.append(chats);
    document.body.append(column);

    const appendChat = (peerKey: string, active: boolean, sending: boolean): HTMLElement => {
      const chat = document.createElement("div");
      chat.className = `chat tabs-tab${active ? " active" : ""}`;
      const owner = document.createElement("div");
      owner.className = "chat-input chat-input-main";
      const composer = document.createElement("div");
      composer.className = "input-message-input";
      composer.setAttribute("contenteditable", "true");
      composer.dataset.peerId = peerKey;
      owner.append(composer);
      chat.append(owner);
      if (sending) {
        appendOutgoing(chat, {
          peerKey,
          messageId: `${peerKey}.0001`,
          classes: "is-outgoing is-sending",
        });
      }
      chats.append(chat);
      return chat;
    };

    const destinationChat = appendChat("100", true, true);
    const sourceChat = appendChat("99", false, false);
    appendChat("777", false, true);
    const row = installDialogRow("99");
    const mousedown = vi.fn(() => {
      row.classList.add("active");
      destinationChat.classList.remove("active");
      sourceChat.classList.add("active");
    });
    row.addEventListener("mousedown", mousedown);

    const navigation = new TelegramChatNavigator(createLogger()).navigate(
      recipient,
      new AbortController().signal,
      "source-restore",
    );
    await vi.advanceTimersByTimeAsync(600);

    await expect(navigation).resolves.toMatchObject({ success: true });
    expect(mousedown).toHaveBeenCalledOnce();
    expect(sourceChat.classList.contains("active")).toBe(true);
  });

  /**
   * The live failure this covers: every delivery from a channel ended in a red safety stop while
   * the channel was demonstrably open, because a broadcast peer has no writable composer at all.
   */
  it("restores a source channel that renders no writable composer", async () => {
    vi.useFakeTimers();
    const row = installDialogRow("99");
    row.addEventListener("mousedown", () => {
      row.classList.add("active");
      installProductionChat("99", "99", { readOnly: true });
    });

    const navigation = new TelegramChatNavigator(createLogger()).navigate(
      recipient,
      new AbortController().signal,
      "source-restore",
    );
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(navigation).resolves.toMatchObject({ success: true });
    expect(document.querySelector('.input-message-input[contenteditable="true"]')).toBeNull();
  });

  /**
   * The dangerous half of the same relaxation: a chat caught mid-transition still carries the
   * previous peer on that node, and a non-editable input must never turn that into a success.
   */
  it("keeps refusing restoration while a read-only chat still shows the previous peer", async () => {
    vi.useFakeTimers();
    const row = installDialogRow("99");
    row.addEventListener("mousedown", () => installProductionChat("100", "100", { readOnly: true }));

    const navigation = new TelegramChatNavigator(createLogger()).navigate(
      recipient,
      new AbortController().signal,
      "source-restore",
    );
    await vi.advanceTimersByTimeAsync(8_000);

    await expect(navigation).resolves.toMatchObject({ success: false });
  });

  it("still requires the independent peer proof when the source is read-only", async () => {
    vi.useFakeTimers();
    const row = installDialogRow("99");
    row.addEventListener("mousedown", () => installProductionChat("99", "100", { readOnly: true }));

    const navigation = new TelegramChatNavigator(createLogger()).navigate(
      recipient,
      new AbortController().signal,
      "source-restore",
    );
    await vi.advanceTimersByTimeAsync(8_000);

    await expect(navigation).resolves.toMatchObject({ success: false });
  });

  /** A destination is written into, so a chat without a writable composer must fail here. */
  it("never accepts a read-only chat as a delivery destination", async () => {
    vi.useFakeTimers();
    const row = installDialogRow("99");
    row.addEventListener("mousedown", () => {
      row.classList.add("active");
      installProductionChat("99", "99", { readOnly: true });
    });

    const navigation = new TelegramChatNavigator(createLogger()).navigate(
      recipient,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(8_000);

    await expect(navigation).resolves.toMatchObject({ success: false });
  });

  it("does not report source restore success when the same-chat topbar proves another peer", async () => {
    vi.useFakeTimers();
    const row = installDialogRow("99");
    row.addEventListener("mousedown", () => installProductionChat("99", "100"));

    const navigation = new TelegramChatNavigator(createLogger()).navigate(
      recipient,
      new AbortController().signal,
      "source-restore",
    );
    await vi.advanceTimersByTimeAsync(8_000);

    await expect(navigation).resolves.toMatchObject({ success: false });
  });

  it("accepts search-only source restore when the same-chat topbar independently proves the peer", async () => {
    vi.useFakeTimers();
    const row = installDialogRow("99");
    row.addEventListener("mousedown", () => {
      row.remove();
      installProductionChat("99", "99");
    });

    const navigation = new TelegramChatNavigator(createLogger()).navigate(
      recipient,
      new AbortController().signal,
      "source-restore",
    );
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(navigation).resolves.toMatchObject({ success: true });
    expect(document.querySelector(".row.chatlist-chat.active[data-peer-id='99']")).toBeNull();
  });

  it("accepts source restore without topbar avatar when the active recent row proves the peer", async () => {
    vi.useFakeTimers();
    const row = installDialogRow("99");
    row.addEventListener("mousedown", () => {
      row.classList.add("active");
      installProductionChat("99");
    });

    const navigation = new TelegramChatNavigator(createLogger()).navigate(
      recipient,
      new AbortController().signal,
      "source-restore",
    );
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(navigation).resolves.toMatchObject({ success: true });
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

  it("gives source restoration one stronger but still bounded navigation policy", async () => {
    vi.useFakeTimers();
    const row = installDialogRow("99");
    const mousedown = vi.fn();
    row.addEventListener("mousedown", mousedown);

    const navigation = new TelegramChatNavigator(createLogger()).navigate(
      recipient,
      new AbortController().signal,
      "source-restore",
    );
    await vi.advanceTimersByTimeAsync(8_000);

    await expect(navigation).resolves.toMatchObject({ success: false });
    expect(mousedown).toHaveBeenCalledTimes(4);
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
