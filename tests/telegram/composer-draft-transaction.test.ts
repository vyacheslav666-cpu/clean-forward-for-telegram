import { describe, expect, it, vi } from "vitest";
import { TelegramDomAdapter } from "../../src/telegram/TelegramDomAdapter";
import { readTelegramText } from "../../src/telegram/readTelegramText";
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

  it("does not fail or erase Telegram-owned post-Send DOM when the captured draft was empty", async () => {
    const composer = installComposer("8");
    const started = new TelegramDomAdapter(createLogger()).beginDraftTransaction("8");
    expect(started.success).toBe(true);
    if (!started.success) return;

    const telegramAcknowledgement = document.createElement("span");
    telegramAcknowledgement.className = "telegram-post-send-placeholder";
    telegramAcknowledgement.textContent = "Telegram-owned transient state";
    composer.replaceChildren(telegramAcknowledgement);

    await expect(started.transaction.restore()).resolves.toEqual({
      success: true,
      message: "Исходный draft был пуст; восстановление не требуется.",
    });
    expect(composer.firstElementChild).toBe(telegramAcknowledgement);
    expect(composer.textContent).toBe("Telegram-owned transient state");
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  it.each([
    { label: "a br sentinel", install: (composer: HTMLElement) => composer.append(document.createElement("br")) },
    { label: "whitespace sentinels", install: (composer: HTMLElement) => composer.append(" \n\t ") },
  ])(
    "treats $label as an empty draft and tolerates a post-Send transient without erasing it",
    async ({ install }) => {
      const composer = installComposer("8");
      install(composer);
      const started = new TelegramDomAdapter(createLogger()).beginDraftTransaction("8");
      expect(started.success).toBe(true);
      if (!started.success) return;
      expect(started.transaction.hadDraft).toBe(false);

      const transient = document.createElement("span");
      transient.className = "telegram-post-send-placeholder";
      transient.textContent = "Telegram-owned transient state";
      composer.replaceChildren(transient);

      await expect(started.transaction.restore()).resolves.toEqual({
        success: true,
        message: "Исходный draft был пуст; восстановление не требуется.",
      });
      expect(composer.firstElementChild).toBe(transient);
      expect(document.execCommand).not.toHaveBeenCalled();
    },
  );

  it("temporarily clears and restores a simple text draft", async () => {
    const composer = installComposer("8", "user draft");
    const started = new TelegramDomAdapter(createLogger()).beginDraftTransaction("8");
    expect(started.success).toBe(true);
    if (!started.success) return;
    expect(composer.textContent).toBe("");
    expect((await started.transaction.restore()).success).toBe(true);
    expect(composer.textContent).toBe("user draft");
  });

  it("still refuses to overwrite a changed composer when the captured draft was non-empty", async () => {
    const composer = installComposer("8", "user draft");
    const started = new TelegramDomAdapter(createLogger()).beginDraftTransaction("8");
    expect(started.success).toBe(true);
    if (!started.success) return;

    composer.textContent = "changed after snapshot";
    const execCallsBeforeRestore = vi.mocked(document.execCommand).mock.calls.length;

    await expect(started.transaction.restore()).resolves.toEqual({
      success: false,
      message: "Draft не восстановлен: composer был изменён после snapshot.",
    });
    expect(composer.textContent).toBe("changed after snapshot");
    expect(document.execCommand).toHaveBeenCalledTimes(execCallsBeforeRestore);
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
    // Not `textContent`: Chrome restores the draft as `<div>` blocks, so the flattened property
    // reports "line oneline twoline three". The draft is only preserved if the value Telegram reads
    // back still has its line breaks.
    expect(readTelegramText(composer)).toBe("line one\nline two\nline three");
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
