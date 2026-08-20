/**
 * Keeps Web K's own furniture out of a copied message.
 *
 * The fixtures are shaped after the live DOM of a forwarded channel post: the reactions panel is a
 * child of `.message`, and once it exists Web K moves the timestamp inside it. Reading `.message`
 * naively therefore produced the reaction emoji and their counters as if the author had typed them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageExtractor } from "../../src/telegram/MessageExtractor";
import { TelegramDomAdapter } from "../../src/telegram/TelegramDomAdapter";
import { TelegramSendAdapter } from "../../src/telegram/TelegramSendAdapter";
import { readTelegramText } from "../../src/telegram/readTelegramText";
import { MESSAGE_TEXT_IGNORED_SELECTORS } from "../../src/telegram/domContract";
import { toTelegramDeliveryPayload } from "../../src/domain/MessagePayload";
import { createLogger, installComposer } from "../helpers";

const MESSAGE_TEXT = "Нюхаю электронные книги,\nа они почему-то не пахнут 🙂";

/**
 * The reactions panel as Web K renders it: emoji, counters, and the timestamp it absorbed.
 *
 * Written without formatting whitespace on purpose. Web K builds these nodes in script, so the
 * live DOM has no text nodes between them, and indenting the fixture would test a shape that never
 * reaches a real bubble.
 */
const REACTIONS_HTML =
  '<reactions-element class="reactions reactions-block reactions-like-block">' +
  '<div class="reaction"><img class="media-sticker" alt="✦"><span class="reaction-counter">1.28K</span></div>' +
  '<div class="reaction"><img class="media-sticker" alt="✦"><span class="reaction-counter">746</span></div>' +
  '<span class="time"><span class="time-inner">14:56</span></span>' +
  "</reactions-element>";

function messageElement(inner: string): HTMLElement {
  document.body.innerHTML = `<div class="message spoilers-container">${inner}</div>`;
  return document.querySelector<HTMLElement>(".message")!;
}

function read(inner: string): string {
  return readTelegramText(messageElement(inner), {
    ignoredSelectors: MESSAGE_TEXT_IGNORED_SELECTORS,
  });
}

describe("message text contract", () => {
  it("drops the reactions panel with its counters and keeps the message itself", () => {
    const text = read(
      `<span class="translatable-message">Нюхаю электронные книги,<br>а они почему-то не пахнут <img class="emoji" alt="🙂"></span>` +
        `<span class="clearfix"></span>${REACTIONS_HTML}`,
    );

    expect(text).toBe(MESSAGE_TEXT);
  });

  it.each([
    [
      "link preview",
      '<a class="webpage"><div class="webpage-title">Сайт</div><div class="webpage-text">Описание из превью</div></a>',
    ],
    [
      "quoted reply",
      '<div class="reply"><div class="reply-title">Автор</div><div class="reply-subtitle">Цитата чужого сообщения</div></div>',
    ],
    [
      "fact check",
      '<div class="bubble-fact-check quote-like"><div class="quote-like-border"></div>Проверка фактов Telegram</div>',
    ],
  ])("drops the %s Web K puts inside .message", (_label, furniture) => {
    const text = read(`<span class="translatable-message">fixture-text</span>${furniture}`);

    expect(text).toBe("fixture-text");
  });

  /** Only the header is furniture: the language label and copy button are Web K's, the code is not. */
  it("keeps the code of a block whose header is dropped", () => {
    const text = read(
      '<pre class="code"><div class="code-header"><span>TypeScript</span><button>Copy</button></div>' +
        "<code>const a = 1;</code></pre>",
    );

    expect(text).toBe("const a = 1;");
  });

  describe("capture", () => {
    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob(["x"]), { status: 200 })));
    });

    it("captures a reacted post without its reactions", async () => {
      const logger = createLogger();
      const extractor = new MessageExtractor(new TelegramDomAdapter(logger), logger);
      document.body.innerHTML =
        `<div class="bubble" data-mid="321" data-peer-id="20">` +
        `<div class="message spoilers-container">` +
        `<span class="translatable-message">Нюхаю электронные книги,<br>а они почему-то не пахнут <img class="emoji" alt="🙂"></span>` +
        `<span class="clearfix"></span>${REACTIONS_HTML}</div></div>`;

      const payload = await extractor.extract(document.querySelector<HTMLElement>(".bubble")!);

      expect(payload && toTelegramDeliveryPayload(payload)).toEqual({
        kind: "text",
        text: MESSAGE_TEXT,
      });
    });
  });

  describe("delivery confirmation", () => {
    /**
     * Capture and confirmation must read a bubble the same way. When they did not, a message that
     * collected a reaction between Send and confirmation compared unequal and stopped the batch as
     * `unknown` — the failure mode that makes a shared ignore set worth more than two local lists.
     */
    it("confirms a sent message that already carries reactions", async () => {
      document.body.innerHTML = "";
      const composer = installComposer("8", "fixture-text");
      const button = document.createElement("button");
      button.className = "btn-send";
      composer.parentElement!.append(button);
      const adapter = new TelegramSendAdapter();
      button.addEventListener("click", () => {
        const bubble = document.createElement("div");
        bubble.className = "bubble is-out is-sent";
        bubble.dataset.peerId = "8";
        bubble.dataset.mid = "5001";
        bubble.innerHTML =
          `<div class="message spoilers-container">` +
          `<span class="translatable-message">fixture-text</span>` +
          `<span class="clearfix"></span>${REACTIONS_HTML}</div>`;
        document.body.append(bubble);
      });

      const result = await adapter.sendPrepared(
        { kind: "text", text: "fixture-text" },
        "8",
        new AbortController().signal,
        vi.fn(),
      );

      expect(result).toEqual({ status: "sent", messageId: "5001" });
    });
  });
});
