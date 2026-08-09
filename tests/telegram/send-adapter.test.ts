import { describe, expect, it, vi } from "vitest";
import type { ImageMessagePayload } from "../../src/domain/MessagePayload";
import { TelegramSendAdapter } from "../../src/telegram/TelegramSendAdapter";
import { observeDom } from "../../src/utils/observeDom";
import { installComposer } from "../helpers";

function appendOutgoing(peerKey: string, messageId: string, pending = false): HTMLElement {
  const bubble = document.createElement("div");
  bubble.className = `bubble is-out${pending ? " sending" : ""}`;
  bubble.dataset.peerId = peerKey;
  bubble.dataset.mid = messageId;
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
    const payload: ImageMessagePayload = {
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

  it("marks the result unknown when the chat changes after Send", async () => {
    const { composer, button } = installTextSend("8", "fixture-text");
    button.addEventListener("click", () => { composer.dataset.peerId = "9"; });
    const result = await new TelegramSendAdapter().sendPrepared(
      { kind: "text", text: "fixture-text" },
      "8",
      new AbortController().signal,
      vi.fn(),
    );
    expect(result.status).toBe("unknown");
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
    await vi.advanceTimersByTimeAsync(12_000);
    expect(click).toHaveBeenCalledOnce();
    expect(await sending).toMatchObject({ status: "unknown" });
  });
});
