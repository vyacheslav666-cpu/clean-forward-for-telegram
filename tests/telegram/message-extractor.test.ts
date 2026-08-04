import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageExtractor } from "../../src/telegram/MessageExtractor";
import { TelegramDomAdapter } from "../../src/telegram/TelegramDomAdapter";
import { createLogger } from "../helpers";

function messageFixture(contents: string): HTMLElement {
  document.body.innerHTML = `<div class="bubble" data-mid="10" data-peer-id="20">${contents}</div>`;
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

  it("extracts ordinary text", async () => {
    const payload = await extractor.extract(messageFixture('<div class="message">Обычный текст</div>'));
    expect(payload).toEqual({ kind: "text", text: "Обычный текст" });
  });

  it("preserves line breaks", async () => {
    const payload = await extractor.extract(messageFixture('<div class="message">Первая<br>Вторая\nТретья</div>'));
    expect(payload).toEqual({ kind: "text", text: "Первая\nВторая\nТретья" });
  });

  it("reads emoji from img.emoji alt", async () => {
    const payload = await extractor.extract(messageFixture('<div class="message">Привет <img class="emoji" alt="🙂"></div>'));
    expect(payload).toEqual({ kind: "text", text: "Привет 🙂" });
  });

  it("extracts a photo without caption", async () => {
    const payload = await extractor.extract(messageFixture('<img class="media-photo" src="blob:test-photo">'));
    expect(payload?.kind).toBe("image");
    expect(payload).not.toHaveProperty("caption");
  });

  it("extracts a photo with caption", async () => {
    const payload = await extractor.extract(messageFixture('<img class="media-photo" src="blob:test-photo"><div class="message">Подпись</div>'));
    expect(payload?.kind).toBe("image");
    expect(payload).toMatchObject({ fileName: "telegram-image.jpg", caption: "Подпись" });
  });

  it("excludes .time and .clearfix metadata", async () => {
    const payload = await extractor.extract(messageFixture('<div class="message">Текст<span class="time">12:30</span><span class="clearfix">layout</span></div>'));
    expect(payload).toEqual({ kind: "text", text: "Текст" });
  });

  it("rejects unsupported attachment types", async () => {
    const payload = await extractor.extract(messageFixture('<div class="attachment"><audio></audio></div><div class="message">voice</div>'));
    expect(payload).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects multiple photos instead of treating them as one", async () => {
    const payload = await extractor.extract(messageFixture('<img class="media-photo" src="blob:one"><img class="media-photo" src="blob:two">'));
    expect(payload).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
