import { afterEach, describe, expect, it, vi } from "vitest";

import { UploadPreviewAdapter } from "../../src/telegram/UploadPreviewAdapter";
import type { UploadPreviewSession } from "../../src/telegram/UploadPreviewAdapter";
import { installComposer } from "../helpers";

const CAPTION = "fixture-line-a\nfixture-line-b";

function openPreview(): { session: UploadPreviewSession; popup: HTMLElement; editor: HTMLElement } {
  installComposer("8");
  const popup = document.createElement("div");
  popup.className = "popup-send-photo popup-new-media active";
  const editor = document.createElement("div");
  editor.className = "simple-message-input-input";
  editor.setAttribute("contenteditable", "true");
  popup.append(editor);
  document.body.append(popup);
  return {
    popup,
    editor,
    session: { popup, image: document.createElement("img"), captionEditor: editor, peerId: "8" },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("upload preview caption", () => {
  it("ignores an animation elsewhere in the popup", async () => {
    vi.useFakeTimers();
    const { session, popup } = openPreview();
    // Telegram animates many popup nodes through `SetTransition`. Only the caption editor's own
    // transition says anything about whether the caption settled.
    const unrelated = document.createElement("div");
    unrelated.className = "popup-item popup-item-media animating";
    popup.append(unrelated);

    const insertion = new UploadPreviewAdapter().insertCaption(session, CAPTION);
    await vi.advanceTimersByTimeAsync(64);

    await expect(insertion).resolves.toBeUndefined();
  });

  it("waits for the caption editor's own height transition", async () => {
    vi.useFakeTimers();
    const { session, editor } = openPreview();
    editor.classList.add("is-changing-height");

    const insertion = new UploadPreviewAdapter().insertCaption(session, CAPTION);
    const rejection = expect(insertion).rejects.toThrow(/анимаци/i);
    await vi.advanceTimersByTimeAsync(2_500);
    await rejection;
  });

  it("resolves once the caption editor stops animating", async () => {
    vi.useFakeTimers();
    const { session, editor } = openPreview();
    editor.classList.add("is-changing-height");

    const insertion = new UploadPreviewAdapter().insertCaption(session, CAPTION);
    await vi.advanceTimersByTimeAsync(64);
    editor.classList.remove("is-changing-height");
    await vi.advanceTimersByTimeAsync(64);

    await expect(insertion).resolves.toBeUndefined();
  });

  it("names a value mismatch instead of reporting one opaque timeout", async () => {
    vi.useFakeTimers();
    const { session, editor } = openPreview();
    vi.mocked(document.execCommand).mockImplementationOnce(() => {
      editor.replaceChildren(document.createTextNode("fixture-line-a"));
      return true;
    });

    const insertion = new UploadPreviewAdapter().insertCaption(session, CAPTION);
    const rejection = insertion.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2_500);
    const error = await rejection;

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/не то значение/);
    expect(message).toMatch(/2 строк/);
    expect(message).toMatch(/позиции 14/);
    // The panel this reaches ends up in screenshots and issues, so the caption itself must not.
    expect(message).not.toContain("fixture-line-a");
  });
});
