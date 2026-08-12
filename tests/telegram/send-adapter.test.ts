import { describe, expect, it, vi } from "vitest";
import type { ImageDeliveryPayload } from "../../src/domain/TelegramDeliveryPayload";
import type { MediaGroupTransferUnit } from "../../src/domain/TransferUnit";
import { TelegramSendAdapter } from "../../src/telegram/TelegramSendAdapter";
import { observeDom } from "../../src/utils/observeDom";
import { installComposer } from "../helpers";

function appendOutgoing(
  peerKey: string,
  messageId: string,
  pending = false,
  text = "fixture-text",
): HTMLElement {
  const bubble = document.createElement("div");
  bubble.className = `bubble is-out${pending ? " sending" : ""}`;
  bubble.dataset.peerId = peerKey;
  bubble.dataset.mid = messageId;
  const message = document.createElement("span");
  message.className = "message";
  message.textContent = text;
  bubble.append(message);
  document.body.append(bubble);
  return bubble;
}

function installTextSend(peerKey: string, text: string) {
  const composer = installComposer(peerKey, text);
  const button = document.createElement("button");
  button.className = "btn-send";
  composer.parentElement!.append(button);
  return { composer, button };
}

function installPhotoSend(peerKey: string, caption = "") {
  installComposer(peerKey);
  const popup = document.createElement("div");
  popup.className = "popup-send-photo popup-new-media active";
  const item = document.createElement("div");
  item.className = "popup-item popup-item-media";
  const image = document.createElement("img");
  image.src = "blob:fixture-photo";
  Object.defineProperties(image, {
    complete: { configurable: true, value: true },
    naturalWidth: { configurable: true, value: 320 },
    naturalHeight: { configurable: true, value: 200 },
  });
  item.append(image);
  const editor = document.createElement("div");
  editor.className = "simple-message-input-input";
  editor.setAttribute("contenteditable", "true");
  editor.textContent = caption;
  const button = document.createElement("button");
  button.className = "simple-message-input-confirm";
  popup.append(item, editor, button);
  document.body.append(popup);
  return { popup, editor, button };
}

function installAlbumSend(peerKey: string) {
  installComposer(peerKey);
  const popup = document.createElement("div");
  popup.className = "popup-send-photo popup-new-media active";
  const album = document.createElement("div");
  album.className = "popup-item-album";
  for (let index = 0; index < 2; index += 1) {
    const item = document.createElement("div");
    item.className = "popup-item popup-item-media";
    album.append(item);
  }
  const editor = document.createElement("div");
  editor.className = "simple-message-input-input";
  editor.setAttribute("contenteditable", "true");
  const button = document.createElement("button");
  button.className = "simple-message-input-confirm";
  popup.append(album, editor, button);
  document.body.append(popup);
  return { button };
}

function albumUnitFixture(): MediaGroupTransferUnit {
  return {
    kind: "media-group",
    groupedId: "group-1",
    source: [{ resolution: "telegram-model", sourcePeerKey: "8", mid: 1, groupedId: "group-1", date: 1, order: 0 }],
    items: [{ order: 0 }, { order: 1 }] as unknown as MediaGroupTransferUnit["items"],
    expectedGroups: [{ groupIndex: 0, itemOrders: [0, 1] }],
    delivery: {
      prepareCapability: "album-upload",
      sendClickCount: 1,
      atomicity: "album",
      outgoing: { kind: "media-groups", expectedCount: 2, groups: [{ groupIndex: 0, itemOrders: [0, 1] }] },
      contentFingerprint: "album-fixture",
      limits: { maxBinaryBytes: 1, preparationTimeoutMs: 1 },
    },
  };
}

describe("TelegramSendAdapter", () => {
  it("clicks native text Send once and confirms a new outgoing data-mid", async () => {
    const { button } = installTextSend("8", "fixture-text");
    appendOutgoing("8", "old-mid");
    const click = vi.spyOn(button, "click");
    button.addEventListener("click", () => appendOutgoing("8", "new-mid"));
    const onSendClicked = vi.fn();
    const result = await new TelegramSendAdapter().sendPrepared(
      { kind: "text", text: "fixture-text" },
      "8",
      new AbortController().signal,
      onSendClicked,
    );
    expect(click).toHaveBeenCalledOnce();
    expect(onSendClicked).toHaveBeenCalledOnce();
    expect(result).toEqual({ status: "sent", messageId: "new-mid" });
  });

  it.each([
    ["photo", ""],
    ["photo with caption", "fixture-caption"],
  ])("clicks native Send Photo once for %s", async (_label, caption) => {
    const { button } = installPhotoSend("8", caption);
    const click = vi.spyOn(button, "click");
    button.addEventListener("click", () => appendOutgoing("8", `mid-${caption || "photo"}`));
    const payload: ImageDeliveryPayload = {
      kind: "image",
      image: new Blob(["photo"]),
      fileName: "photo.jpg",
      ...(caption ? { caption } : {}),
    };
    const result = await new TelegramSendAdapter().sendPrepared(
      payload,
      "8",
      new AbortController().signal,
      vi.fn(),
    );
    expect(click).toHaveBeenCalledOnce();
    expect(result.status).toBe("sent");
  });

  it("waits for every new grouped data-mid before confirming one album Send", async () => {
    const { button } = installAlbumSend("8");
    const adapter = new TelegramSendAdapter();
    let group: HTMLElement | null = null;
    button.addEventListener("click", () => {
      group = document.createElement("div");
      group.className = "bubble is-out";
      group.dataset.peerId = "8";
      const first = document.createElement("div");
      first.className = "grouped-item";
      first.dataset.mid = "album-mid-1";
      group.append(first);
      document.body.append(group);
    });
    let settled = false;
    const sending = adapter.sendPreparedUnit(
      albumUnitFixture(),
      "8",
      new AbortController().signal,
      vi.fn(),
    ).then((result) => { settled = true; return result; });
    await Promise.resolve();
    expect(settled).toBe(false);
    const second = document.createElement("div");
    second.className = "grouped-item";
    second.dataset.mid = "album-mid-2";
    group!.append(second);
    adapter.notifyDomChanged();
    await expect(sending).resolves.toEqual({
      status: "sent",
      messageId: "album-mid-1",
      messageIds: ["album-mid-1", "album-mid-2"],
    });
  });

  it("does not advance success while the new outgoing bubble is still sending", async () => {
    const { button } = installTextSend("8", "fixture-text");
    const adapter = new TelegramSendAdapter();
    let bubble: HTMLElement | null = null;
    button.addEventListener("click", () => { bubble = appendOutgoing("8", "new-mid", true); });
    let settled = false;
    const sending = adapter.sendPrepared(
      { kind: "text", text: "fixture-text" },
      "8",
      new AbortController().signal,
      vi.fn(),
    ).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    (bubble as unknown as HTMLElement).classList.remove("sending");
    adapter.notifyDomChanged();
    expect(await sending).toEqual({ status: "sent", messageId: "new-mid" });
  });

  it("confirms delivery when Telegram removes only the sending class", async () => {
    const { button } = installTextSend("8", "fixture-text");
    const adapter = new TelegramSendAdapter();
    const observation = observeDom(document.documentElement, () => adapter.notifyDomChanged());
    let bubble: HTMLElement | null = null;
    button.addEventListener("click", () => { bubble = appendOutgoing("8", "new-mid", true); });

    try {
      const sending = adapter.sendPrepared(
        { kind: "text", text: "fixture-text" },
        "8",
        new AbortController().signal,
        vi.fn(),
      );
      await Promise.resolve();
      adapter.notifyDomChanged();
      (bubble as unknown as HTMLElement).classList.remove("sending");
      await expect(sending).resolves.toEqual({ status: "sent", messageId: "new-mid" });
    } finally {
      observation.disconnect();
    }
  });

  it("confirms delivery when data-mid is assigned to an existing outgoing node", async () => {
    const { button } = installTextSend("8", "fixture-text");
    const adapter = new TelegramSendAdapter();
    const observation = observeDom(document.documentElement, () => adapter.notifyDomChanged());
    let bubble: HTMLElement | null = null;
    button.addEventListener("click", () => {
      bubble = document.createElement("div");
      bubble.className = "bubble is-out";
      bubble.dataset.peerId = "8";
      const message = document.createElement("span");
      message.className = "message";
      message.textContent = "fixture-text";
      bubble.append(message);
      document.body.append(bubble);
    });

    try {
      const sending = adapter.sendPrepared(
        { kind: "text", text: "fixture-text" },
        "8",
        new AbortController().signal,
        vi.fn(),
      );
      await Promise.resolve();
      adapter.notifyDomChanged();
      (bubble as unknown as HTMLElement).dataset.mid = "late-mid";
      await expect(sending).resolves.toEqual({ status: "sent", messageId: "late-mid" });
    } finally {
      observation.disconnect();
    }
  });

  it("fails before Send when prepared text changed", async () => {
    const { button } = installTextSend("8", "changed");
    const click = vi.spyOn(button, "click");
    const result = await new TelegramSendAdapter().sendPrepared(
      { kind: "text", text: "expected" },
      "8",
      new AbortController().signal,
      vi.fn(),
    );
    expect(result.status).toBe("failed");
    expect(click).not.toHaveBeenCalled();
  });

  it("ignores Telegram's collapsed dormant reply wrapper before Send", async () => {
    const { composer, button } = installTextSend("8", "fixture-text");
    const draft = document.createElement("div");
    draft.className = "reply-wrapper";
    draft.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      top: 0,
      right: 696,
      bottom: 0,
      left: 0,
      width: 696,
      height: 0,
      toJSON: () => ({}),
    });
    composer.parentElement!.append(draft);
    button.addEventListener("click", () => appendOutgoing("8", "new-mid"));

    const result = await new TelegramSendAdapter().sendPrepared(
      { kind: "text", text: "fixture-text" },
      "8",
      new AbortController().signal,
      vi.fn(),
    );

    expect(result).toEqual({ status: "sent", messageId: "new-mid" });
  });

  it("fails before Send when the selected peer becomes non-writable", async () => {
    const { composer, button } = installTextSend("8", "fixture-text");
    composer.setAttribute("contenteditable", "false");
    const click = vi.spyOn(button, "click");
    const result = await new TelegramSendAdapter().sendPrepared(
      { kind: "text", text: "fixture-text" },
      "8",
      new AbortController().signal,
      vi.fn(),
    );
    expect(result.status).toBe("failed");
    expect(click).not.toHaveBeenCalled();
  });

  it("marks the result unknown when the chat changes after Send", async () => {
    vi.useFakeTimers();
    const { composer, button } = installTextSend("8", "fixture-text");
    button.addEventListener("click", () => { composer.dataset.peerId = "9"; });
    const sending = new TelegramSendAdapter().sendPrepared(
      { kind: "text", text: "fixture-text" },
      "8",
      new AbortController().signal,
      vi.fn(),
    );
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await sending).status).toBe("unknown");
  });

  it("returns unknown after Send when no outgoing bubble can be confirmed", async () => {
    vi.useFakeTimers();
    const { button } = installTextSend("8", "fixture-text");
    const click = vi.spyOn(button, "click");
    const sending = new TelegramSendAdapter().sendPrepared(
      { kind: "text", text: "fixture-text" },
      "8",
      new AbortController().signal,
      vi.fn(),
    );
    await vi.advanceTimersByTimeAsync(20_000);
    expect(click).toHaveBeenCalledOnce();
    expect(await sending).toMatchObject({ status: "unknown" });
  });

  it("reconciles a late outgoing bubble after timeout without a second Send", async () => {
    vi.useFakeTimers();
    const { button } = installTextSend("8", "fixture-text");
    const click = vi.spyOn(button, "click");
    const sending = new TelegramSendAdapter().sendPrepared(
      { kind: "text", text: "fixture-text" },
      "8",
      new AbortController().signal,
      vi.fn(),
    );

    await vi.advanceTimersByTimeAsync(12_100);
    appendOutgoing("8", "late-mid");
    await vi.advanceTimersByTimeAsync(500);

    expect(await sending).toEqual({ status: "sent", messageId: "late-mid" });
    expect(click).toHaveBeenCalledOnce();
  });

  it("turns a confirmation timeout into reconciliation success", async () => {
    vi.useFakeTimers();
    const { button } = installTextSend("8", "fixture-text");
    const click = vi.spyOn(button, "click");
    let bubble: HTMLElement | null = null;
    button.addEventListener("click", () => { bubble = appendOutgoing("8", "pending-mid", true); });
    const sending = new TelegramSendAdapter().sendPrepared(
      { kind: "text", text: "fixture-text" },
      "8",
      new AbortController().signal,
      vi.fn(),
    );

    await vi.advanceTimersByTimeAsync(12_100);
    (bubble as unknown as HTMLElement).classList.remove("sending");
    await vi.advanceTimersByTimeAsync(500);

    expect(await sending).toEqual({ status: "sent", messageId: "pending-mid" });
    expect(click).toHaveBeenCalledOnce();
  });

  it("keeps reconciliation alive after cancellation once Send was clicked", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { button } = installTextSend("8", "fixture-text");
    const click = vi.spyOn(button, "click");
    const sending = new TelegramSendAdapter().sendPrepared(
      { kind: "text", text: "fixture-text" },
      "8",
      controller.signal,
      vi.fn(),
    );

    controller.abort();
    await vi.advanceTimersByTimeAsync(12_100);
    appendOutgoing("8", "after-cancel-mid");
    await vi.advanceTimersByTimeAsync(500);

    expect(await sending).toEqual({ status: "sent", messageId: "after-cancel-mid" });
    expect(click).toHaveBeenCalledOnce();
  });

  it("does not confirm a wrong observable payload for the expected peer", async () => {
    vi.useFakeTimers();
    const { button } = installTextSend("8", "fixture-text");
    const click = vi.spyOn(button, "click");
    button.addEventListener("click", () => {
      appendOutgoing("8", "unrelated-mid", false, "different text");
    });
    const sending = new TelegramSendAdapter().sendPrepared(
      { kind: "text", text: "fixture-text" },
      "8",
      new AbortController().signal,
      vi.fn(),
    );

    await vi.advanceTimersByTimeAsync(20_000);

    expect((await sending).status).toBe("unknown");
    expect(click).toHaveBeenCalledOnce();
  });

  it("does not confirm an unrelated outgoing without observable text", async () => {
    vi.useFakeTimers();
    const { button } = installTextSend("8", "fixture-text");
    button.addEventListener("click", () => {
      const bubble = appendOutgoing("8", "sticker-like-mid");
      bubble.querySelector(".message")?.remove();
    });
    const sending = new TelegramSendAdapter().sendPrepared(
      { kind: "text", text: "fixture-text" },
      "8",
      new AbortController().signal,
      vi.fn(),
    );

    await vi.advanceTimersByTimeAsync(20_000);
    expect((await sending).status).toBe("unknown");
  });
});
