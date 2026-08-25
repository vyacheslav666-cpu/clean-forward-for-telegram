import { describe, expect, it, vi } from "vitest";
import type { ImageDeliveryPayload } from "../../src/domain/TelegramDeliveryPayload";
import type { MediaGroupTransferUnit } from "../../src/domain/TransferUnit";
import { TelegramSendAdapter } from "../../src/telegram/TelegramSendAdapter";
import { observeDom } from "../../src/utils/observeDom";
import { installComposer } from "../helpers";

/**
 * Mirrors how Web K renders an outgoing message: an in-flight bubble carries `is-outgoing` and
 * `is-sending` and holds a temporary fractional mid until the server answers.
 */
function appendOutgoing(
  peerKey: string,
  messageId: string,
  pending = false,
  text = "fixture-text",
): HTMLElement {
  const bubble = document.createElement("div");
  bubble.className = `bubble is-out${pending ? " is-outgoing is-sending" : ""}`;
  bubble.dataset.peerId = peerKey;
  bubble.dataset.mid = messageId;
  const message = document.createElement("span");
  message.className = "message";
  message.textContent = text;
  bubble.append(message);
  document.body.append(bubble);
  return bubble;
}

/** Mirrors Web K's `message_sent`: the server id is written first, then the status classes swap. */
function acknowledgeOutgoing(bubble: HTMLElement, messageId: string): void {
  bubble.dataset.mid = messageId;
  bubble.classList.remove("is-outgoing", "is-sending", "sending");
  bubble.classList.add("is-sent");
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

  /**
   * The live failure: a delivered album reported "several messages after one Send".
   *
   * Web K gives the album bubble a `data-mid` of its own — the group's main message — so the
   * bubble and its first photo publish the same identity. Counting matched nodes turned an album
   * of N into N + 1 outgoing messages, and every successful album delivery ended as `unknown`.
   */
  it("confirms an album whose bubble repeats the mid of one of its photos", async () => {
    const { button } = installAlbumSend("8");
    const adapter = new TelegramSendAdapter();
    button.addEventListener("click", () => {
      const group = document.createElement("div");
      group.className = "bubble is-out";
      group.dataset.peerId = "8";
      group.dataset.mid = "9001";
      for (const mid of ["9001", "9002"]) {
        const item = document.createElement("div");
        item.className = "grouped-item";
        item.dataset.mid = mid;
        group.append(item);
      }
      document.body.append(group);
    });

    const sending = adapter.sendPreparedUnit(
      albumUnitFixture(),
      "8",
      new AbortController().signal,
      vi.fn(),
    );

    await expect(sending).resolves.toEqual({
      status: "sent",
      messageId: "9001",
      messageIds: ["9001", "9002"],
    });
  });

  it("still stops as unknown when a second unrelated message appears after one Send", async () => {
    vi.useFakeTimers();
    const { button } = installTextSend("8", "fixture-text");
    button.addEventListener("click", () => {
      appendOutgoing("8", "7001");
      appendOutgoing("8", "7002");
    });

    const sending = new TelegramSendAdapter().sendPrepared(
      { kind: "text", text: "fixture-text" },
      "8",
      new AbortController().signal,
      vi.fn(),
    );
    await vi.advanceTimersByTimeAsync(100);

    expect(await sending).toMatchObject({ status: "unknown" });
  });

  /**
   * Web K clears `is-outgoing` from the album bubble as soon as its first part is acknowledged,
   * so the bubble class alone would confirm an album whose remaining items are still uploading.
   */
  it("waits for every album item to lose its temporary mid", async () => {
    const { button } = installAlbumSend("8");
    const adapter = new TelegramSendAdapter();
    const items: HTMLElement[] = [];
    button.addEventListener("click", () => {
      const group = document.createElement("div");
      group.className = "bubble is-out is-outgoing is-sending";
      group.dataset.peerId = "8";
      ["7000.0001", "7000.0002"].forEach((mid) => {
        const item = document.createElement("div");
        item.className = "grouped-item";
        item.dataset.mid = mid;
        group.append(item);
        items.push(item);
      });
      document.body.append(group);
      group.classList.remove("is-outgoing", "is-sending");
      items[0]!.dataset.mid = "7001";
    });
    let settled = false;
    const sending = adapter.sendPreparedUnit(
      albumUnitFixture(),
      "8",
      new AbortController().signal,
      vi.fn(),
    ).then((result) => { settled = true; return result; });

    await Promise.resolve();
    adapter.notifyDomChanged();
    expect(settled).toBe(false);
    items[1]!.dataset.mid = "7002";
    adapter.notifyDomChanged();
    await expect(sending).resolves.toEqual({
      status: "sent",
      messageId: "7001",
      messageIds: ["7001", "7002"],
    });
  });

  it("does not advance success while the new outgoing bubble is still sending", async () => {
    const { button } = installTextSend("8", "fixture-text");
    const adapter = new TelegramSendAdapter();
    let bubble: HTMLElement | null = null;
    button.addEventListener("click", () => { bubble = appendOutgoing("8", "1000.0001", true); });
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
    acknowledgeOutgoing(bubble as unknown as HTMLElement, "1001");
    adapter.notifyDomChanged();
    expect(await sending).toEqual({ status: "sent", messageId: "1001" });
  });

  /**
   * The reordering this guards against: confirming the optimistic bubble released the next unit
   * while this upload was still running, and Telegram numbered the two by upload speed instead of
   * by the order they were captured in.
   */
  it("does not confirm a temporary mid even after Telegram drops the sending classes", async () => {
    const { button } = installTextSend("8", "fixture-text");
    const adapter = new TelegramSendAdapter();
    let bubble: HTMLElement | null = null;
    button.addEventListener("click", () => { bubble = appendOutgoing("8", "2000.0001"); });
    let settled = false;
    const sending = adapter.sendPrepared(
      { kind: "text", text: "fixture-text" },
      "8",
      new AbortController().signal,
      vi.fn(),
    ).then((result) => { settled = true; return result; });

    await Promise.resolve();
    adapter.notifyDomChanged();
    expect(settled).toBe(false);
    (bubble as unknown as HTMLElement).dataset.mid = "2001";
    adapter.notifyDomChanged();
    expect(await sending).toEqual({ status: "sent", messageId: "2001" });
  });

  it("reports unknown when Telegram rejects the message it accepted for sending", async () => {
    const { button } = installTextSend("8", "fixture-text");
    const adapter = new TelegramSendAdapter();
    let bubble: HTMLElement | null = null;
    button.addEventListener("click", () => { bubble = appendOutgoing("8", "3000.0001", true); });
    const sending = adapter.sendPrepared(
      { kind: "text", text: "fixture-text" },
      "8",
      new AbortController().signal,
      vi.fn(),
    );

    await Promise.resolve();
    const rejected = bubble as unknown as HTMLElement;
    rejected.classList.remove("is-outgoing", "is-sending");
    rejected.classList.add("is-error");
    adapter.notifyDomChanged();
    expect((await sending).status).toBe("unknown");
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
      (bubble as unknown as HTMLElement).classList.remove("is-outgoing", "is-sending");
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
    acknowledgeOutgoing(bubble as unknown as HTMLElement, "pending-mid");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await sending).toEqual({ status: "sent", messageId: "pending-mid" });
    expect(click).toHaveBeenCalledOnce();
  });

  it("keeps waiting past the confirmation timeout while Telegram is still uploading", async () => {
    vi.useFakeTimers();
    const { button } = installTextSend("8", "fixture-text");
    let bubble: HTMLElement | null = null;
    button.addEventListener("click", () => { bubble = appendOutgoing("8", "5000.0001", true); });
    let settled = false;
    const sending = new TelegramSendAdapter().sendPrepared(
      { kind: "text", text: "fixture-text" },
      "8",
      new AbortController().signal,
      vi.fn(),
    ).then((result) => { settled = true; return result; });

    // Well past the 12 s confirmation timeout and the whole reconciliation backoff: an upload of
    // the maximum captured size outlives both, and giving up would stop the batch over a message
    // Telegram is visibly still sending.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);
    acknowledgeOutgoing(bubble as unknown as HTMLElement, "5001");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await sending).toEqual({ status: "sent", messageId: "5001" });
  });

  it("returns unknown when the upload never leaves the sending state", async () => {
    vi.useFakeTimers();
    const { button } = installTextSend("8", "fixture-text");
    button.addEventListener("click", () => { appendOutgoing("8", "6000.0001", true); });
    const sending = new TelegramSendAdapter().sendPrepared(
      { kind: "text", text: "fixture-text" },
      "8",
      new AbortController().signal,
      vi.fn(),
    );

    await vi.advanceTimersByTimeAsync(301_000);

    expect((await sending).status).toBe("unknown");
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
