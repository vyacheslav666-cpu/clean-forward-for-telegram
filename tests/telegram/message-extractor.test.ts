import { beforeEach, describe, expect, it, vi } from "vitest";
import { toTelegramDeliveryPayload } from "../../src/domain/MessagePayload";
import { MessageExtractor } from "../../src/telegram/MessageExtractor";
import { PendingTransfer } from "../../src/domain/PendingTransfer";
import { TelegramDomAdapter } from "../../src/telegram/TelegramDomAdapter";
import { createLogger, createTextMessagePayload } from "../helpers";

function messageFixture(contents: string): HTMLElement {
  document.body.innerHTML = `<div class="bubble" data-mid="321" data-peer-id="20">${contents}</div>`;
  return document.querySelector<HTMLElement>(".bubble")!;
}

describe("MessageExtractor", () => {
  const logger = createLogger();
  const extractor = new MessageExtractor(new TelegramDomAdapter(logger), logger);

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Blob(["photo"], { type: "image/jpeg" }), { status: 200 })),
    );
  });

  async function extractDelivery(contents: string) {
    const payload = await extractor.extract(messageFixture(contents));
    return payload ? toTelegramDeliveryPayload(payload) : null;
  }

  it("extracts ordinary text", async () => {
    const payload = await extractDelivery('<div class="message">fixture-text</div>');
    expect(payload).toEqual({ kind: "text", text: "fixture-text" });
  });

  it("preserves line breaks", async () => {
    const payload = await extractDelivery('<div class="message">fixture-line-a<br>fixture-line-b\nfixture-line-c</div>');
    expect(payload).toEqual({ kind: "text", text: "fixture-line-a\nfixture-line-b\nfixture-line-c" });
  });

  it("reads emoji from img.emoji alt", async () => {
    const payload = await extractDelivery('<div class="message">fixture-emoji <img class="emoji" alt="🙂"></div>');
    expect(payload).toEqual({ kind: "text", text: "fixture-emoji 🙂" });
  });

  it("extracts a photo without caption", async () => {
    const payload = await extractDelivery('<img class="media-photo" src="blob:test-photo">');
    expect(payload?.kind).toBe("image");
    expect(payload).not.toHaveProperty("caption");
  });

  it("extracts a photo with caption", async () => {
    const payload = await extractDelivery('<img class="media-photo" src="blob:test-photo"><div class="message">fixture-caption</div>');
    expect(payload?.kind).toBe("image");
    expect(payload).toMatchObject({ fileName: "telegram-image.jpg", caption: "fixture-caption" });
  });

  it("excludes .time and .clearfix metadata", async () => {
    const payload = await extractDelivery('<div class="message">fixture-text<span class="time">12:30</span><span class="clearfix">layout</span></div>');
    expect(payload).toEqual({ kind: "text", text: "fixture-text" });
  });

  it("excludes .time independently", async () => {
    const payload = await extractDelivery('<div class="message">fixture-text<span class="time">09:00</span></div>');
    expect(payload).toEqual({ kind: "text", text: "fixture-text" });
  });

  it("excludes .clearfix independently", async () => {
    const payload = await extractDelivery('<div class="message">fixture-text<span class="clearfix">layout</span></div>');
    expect(payload).toEqual({ kind: "text", text: "fixture-text" });
  });

  it("omits an empty photo caption", async () => {
    const payload = await extractDelivery('<img class="media-photo" src="blob:empty-caption"><div class="message">  </div>');
    expect(payload?.kind).toBe("image");
    expect(payload).not.toHaveProperty("caption");
  });

  it("loads the exact browser-owned Blob URL", async () => {
    await extractDelivery('<img class="media-photo" src="blob:exact-url">');
    expect(fetch).toHaveBeenCalledWith("blob:exact-url");
  });

  it("does not destroy an earlier pending payload when image loading fails", async () => {
    const pending = new PendingTransfer();
    const previous = createTextMessagePayload("keep me");
    pending.select(previous);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("blob unavailable"); }));
    const payload = await extractor.extract(messageFixture('<img class="media-photo" src="blob:failure">'));
    expect(payload).toBeNull();
    expect(pending.peek()).toBe(previous);
  });

  it("rejects unsupported attachment types", async () => {
    const payload = await extractor.extract(messageFixture('<div class="attachment"><audio></audio></div><div class="message">unsupported-fixture</div>'));
    expect(payload).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects multiple photos instead of treating them as one", async () => {
    const payload = await extractor.extract(messageFixture('<img class="media-photo" src="blob:one"><img class="media-photo" src="blob:two">'));
    expect(payload).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
