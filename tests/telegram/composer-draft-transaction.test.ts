import { describe, expect, it, vi } from "vitest";
import { TelegramDomAdapter } from "../../src/telegram/TelegramDomAdapter";
import { createLogger, installComposer } from "../helpers";

describe("composer draft transaction", () => {
  it("accepts an empty draft without changing the composer", async () => {
    const composer = installComposer("8");
    const started = new TelegramDomAdapter(createLogger()).beginDraftTransaction("8");
    expect(started.success).toBe(true);
    if (!started.success) return;
    expect(started.transaction.hadDraft).toBe(false);
    expect((await started.transaction.restore()).success).toBe(true);
    expect(composer.textContent).toBe("");
  });

  it("temporarily clears and restores a simple text draft", async () => {
    const composer = installComposer("8", "user draft");
    const started = new TelegramDomAdapter(createLogger()).beginDraftTransaction("8");
    expect(started.success).toBe(true);
    if (!started.success) return;
    expect(composer.textContent).toBe("");
    expect((await started.transaction.restore()).success).toBe(true);
    expect(composer.textContent).toBe("user draft");
  });

  it("clears a real contenteditable selection with delete instead of empty insertText", () => {
    const composer = installComposer("8", "user draft");
    vi.mocked(document.execCommand).mockImplementationOnce((command) => {
      expect(command).toBe("delete");
      expect(window.getSelection()?.isCollapsed).toBe(false);
      composer.replaceChildren();
      composer.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }),
      );
      return true;
    });

    const started = new TelegramDomAdapter(createLogger()).beginDraftTransaction("8");

    expect(started.success).toBe(true);
    expect(composer.textContent).toBe("");
  });

  it("preserves multiline draft line breaks", async () => {
    const composer = installComposer("8", "line one\nline two\nline three");
    const started = new TelegramDomAdapter(createLogger()).beginDraftTransaction("8");
    expect(started.success).toBe(true);
    if (!started.success) return;
    await started.transaction.restore();
    expect(composer.textContent).toBe("line one\nline two\nline three");
  });

  it("restores into a fresh same-peer composer after Telegram rerenders", async () => {
    const composer = installComposer("8", "rerendered draft");
    const started = new TelegramDomAdapter(createLogger()).beginDraftTransaction("8");
    expect(started.success).toBe(true);
    if (!started.success) return;
    composer.parentElement!.remove();
    const rerendered = installComposer("8");
    expect((await started.transaction.restore()).success).toBe(true);
    expect(rerendered.textContent).toBe("rerendered draft");
  });

  it("never restores a snapshot into another peer", async () => {
    const composer = installComposer("8", "peer eight draft");
    const started = new TelegramDomAdapter(createLogger()).beginDraftTransaction("8");
    expect(started.success).toBe(true);
    if (!started.success) return;
    composer.parentElement!.remove();
    const otherPeer = installComposer("9", "peer nine draft");
    expect((await started.transaction.restore()).success).toBe(false);
    expect(otherPeer.textContent).toBe("peer nine draft");
  });

  it("refuses formatted entities before clearing anything", () => {
    const composer = installComposer("8");
    const bold = document.createElement("span");
    bold.className = "text-bold";
    bold.textContent = "formatted draft";
    composer.append(bold);
    const started = new TelegramDomAdapter(createLogger()).beginDraftTransaction("8");
    expect(started.success).toBe(false);
    expect(composer.innerHTML).toContain("formatted draft");
  });
});
