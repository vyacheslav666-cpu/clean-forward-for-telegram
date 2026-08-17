import { describe, expect, it } from "vitest";

import { readTelegramText } from "../../src/telegram/readTelegramText";

/**
 * Every `html` below was produced by real Chrome, by running the project's own
 * `insertTextNatively()` against a contenteditable and dumping `innerHTML`. They are fixtures of
 * observed browser output, not of what the reader is assumed to receive.
 */
const CHROME_INSERTED = [
  { caption: "single line", html: "hello world", value: "hello world" },
  { caption: "double space", html: "hello  world", value: "hello  world" },
  { caption: "two lines", html: "line-a<div>line-b</div>", value: "line-a\nline-b" },
  {
    caption: "blank line between two lines",
    html: "line-a<div><br></div><div>line-b</div>",
    value: "line-a\n\nline-b",
  },
  {
    caption: "three lines",
    html: "line-a<div>line-b</div><div>line-c</div>",
    value: "line-a\nline-b\nline-c",
  },
  { caption: "non-latin lines", html: "привет<div>мир</div>", value: "привет\nмир" },
  { caption: "tab", html: "a\tb", value: "a\tb" },
] as const;

function editorWith(html: string): HTMLElement {
  const editor = document.createElement("div");
  editor.setAttribute("contenteditable", "true");
  editor.innerHTML = html;
  document.body.append(editor);
  return editor;
}

describe("readTelegramText", () => {
  it.each(CHROME_INSERTED)(
    "reads back exactly what was inserted: $caption",
    ({ html, value }) => {
      expect(readTelegramText(editorWith(html))).toBe(value);
    },
  );

  it("reads an emptied editor as an empty value", () => {
    expect(readTelegramText(editorWith(""))).toBe("");
    expect(readTelegramText(editorWith("<div><br></div>"))).toBe("");
  });

  it("still treats a message bubble <br> as a line break", () => {
    expect(readTelegramText(editorWith("line-a<br>line-b"))).toBe("line-a\nline-b");
    expect(readTelegramText(editorWith("line-a<br><br>line-b"))).toBe("line-a\n\nline-b");
  });

  it("keeps emoji that Telegram normalized into img[alt]", () => {
    const html = 'a <img class="emoji" alt="🙂"><div>b <img class="emoji" alt="🧪"></div>';
    expect(readTelegramText(editorWith(html))).toBe("a 🙂\nb 🧪");
  });

  it("does not invent a line break for inline formatting", () => {
    const html = "plain <b>bold</b> and <i>italic</i> stay on one line";
    expect(readTelegramText(editorWith(html))).toBe("plain bold and italic stay on one line");
  });

  it("separates block-level message structure the way Telegram reads it", () => {
    const html = "intro<blockquote>quoted</blockquote>outro";
    expect(readTelegramText(editorWith(html))).toBe("intro\nquoted\noutro");
  });

  it("drops only Chrome's trailing filler, not a real blank line", () => {
    expect(readTelegramText(editorWith("line-a<div><br></div>"))).toBe("line-a");
    expect(readTelegramText(editorWith("line-a<div><br></div><div>line-b</div>")))
      .toBe("line-a\n\nline-b");
  });

  it("honours ignoredSelectors for Telegram metadata nodes", () => {
    const html = 'text<span class="time">12:30</span><div>more</div>';
    expect(readTelegramText(editorWith(html), { ignoredSelectors: [".time"] })).toBe("text\nmore");
  });
});
