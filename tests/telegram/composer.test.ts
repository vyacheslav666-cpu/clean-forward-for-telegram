import { describe, expect, it, vi } from "vitest";
import type { ImageMessagePayload } from "../../src/domain/MessagePayload";
import { ComposerAdapter } from "../../src/telegram/ComposerAdapter";
import type { ArmedMediaInput, MediaModeActivator } from "../../src/telegram/MediaModeActivator";
import { TelegramDomAdapter } from "../../src/telegram/TelegramDomAdapter";
import type { UploadPreviewAdapter as UploadPreviewAdapterType, UploadPreviewSession } from "../../src/telegram/UploadPreviewAdapter";
import { UploadPreviewAdapter } from "../../src/telegram/UploadPreviewAdapter";
import { readTelegramText } from "../../src/telegram/readTelegramText";
import { createLogger, installComposer } from "../helpers";

function imagePayload(caption?: string): ImageMessagePayload {
  return {
    kind: "image",
    image: new Blob(["png bytes"], { type: "image/png" }),
    fileName: "telegram source.jpeg",
    ...(caption ? { caption } : {}),
  };
}

function mockImagePipeline(overrides: {
  arm?: () => Promise<ArmedMediaInput>;
  waitUntilReady?: () => Promise<UploadPreviewSession>;
  hasActivePreview?: () => boolean;
  cancelActivePreview?: () => Promise<boolean>;
} = {}) {
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  const target: ArmedMediaInput = { fileInput, peerId: "8" };
  const session = {
    popup: document.createElement("div"),
    image: document.createElement("img"),
    captionEditor: document.createElement("div"),
    peerId: "8",
  };
  const mediaMode = {
    arm: vi.fn(overrides.arm ?? (async () => target)),
  } as unknown as MediaModeActivator;
  const preview = {
    selectFile: vi.fn(),
    waitUntilReady: vi.fn(overrides.waitUntilReady ?? (async () => session)),
    insertCaption: vi.fn(async () => undefined),
    hasActivePreview: vi.fn(overrides.hasActivePreview ?? (() => false)),
    cancelActivePreview: vi.fn(overrides.cancelActivePreview ?? (async () => true)),
  } as unknown as UploadPreviewAdapterType;
  const dom = { insertTextIntoComposer: vi.fn(() => true) } as unknown as TelegramDomAdapter;
  return { adapter: new ComposerAdapter(dom, mediaMode, preview), mediaMode, preview, target };
}

describe("ComposerAdapter", () => {
  it("inserts text without clicking Send", async () => {
    const composer = installComposer("8");
    const send = document.createElement("button");
    send.className = "btn-send";
    const sendClick = vi.spyOn(send, "click");
    composer.parentElement!.append(send);
    const adapter = new ComposerAdapter(
      new TelegramDomAdapter(createLogger()),
      {} as MediaModeActivator,
      {} as UploadPreviewAdapterType,
    );
    const result = await adapter.insert({ kind: "text", text: "fixture-text" }, "8");
    expect(result.success).toBe(true);
    expect(composer.textContent).toBe("fixture-text");
    expect(sendClick).not.toHaveBeenCalled();
  });

  it("creates an image File with the Blob MIME type", async () => {
    const { adapter, preview } = mockImagePipeline();
    await adapter.insert(imagePayload(), "8");
    const selectedFile = vi.mocked(preview.selectFile).mock.calls[0]?.[1];
    expect(selectedFile).toBeInstanceOf(File);
    expect(selectedFile?.type).toBe("image/png");
    expect(selectedFile?.name).toBe("telegram-source.png");
  });

  it("dispatches one bubbling change event after assigning the file", () => {
    installComposer("8");
    const input = document.createElement("input");
    input.type = "file";
    let assigned: FileList | null = null;
    Object.defineProperty(input, "files", {
      configurable: true,
      get: () => assigned,
      set: (value: FileList) => { assigned = value; },
    });
    const change = vi.fn();
    input.addEventListener("change", change);
    new UploadPreviewAdapter().selectFile(
      { fileInput: input, peerId: "8" },
      new File(["data"], "photo.png", { type: "image/png" }),
    );
    expect(change).toHaveBeenCalledOnce();
    expect((change.mock.calls[0]?.[0] as Event).bubbles).toBe(true);
    expect(input.files?.length).toBe(1);
    expect(input.files?.item(0)?.name).toBe("photo.png");
  });

  it("does not dispatch input or beforeinput to the file input", () => {
    installComposer("8");
    const input = document.createElement("input");
    input.type = "file";
    let assigned: FileList | null = null;
    Object.defineProperty(input, "files", {
      configurable: true,
      get: () => assigned,
      set: (value: FileList) => { assigned = value; },
    });
    const inputEvent = vi.fn();
    const beforeInput = vi.fn();
    input.addEventListener("input", inputEvent);
    input.addEventListener("beforeinput", beforeInput);
    new UploadPreviewAdapter().selectFile(
      { fileInput: input, peerId: "8" },
      new File(["data"], "photo.png", { type: "image/png" }),
    );
    expect(inputEvent).not.toHaveBeenCalled();
    expect(beforeInput).not.toHaveBeenCalled();
  });

  it("waits for the complete readiness predicate instead of a fixed delay", async () => {
    vi.useFakeTimers();
    installComposer("8");
    const adapter = new UploadPreviewAdapter();
    let settled = false;
    const waiting = adapter.waitUntilReady("8").then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(32);
    expect(settled).toBe(false);

    const popup = document.createElement("div");
    popup.className = "popup-send-photo popup-new-media active";
    const item = document.createElement("div");
    item.className = "popup-item popup-item-media";
    const image = document.createElement("img");
    image.src = "blob:test-preview";
    Object.defineProperties(image, {
      complete: { configurable: true, value: false },
      naturalWidth: { configurable: true, value: 0 },
      naturalHeight: { configurable: true, value: 0 },
    });
    const caption = document.createElement("div");
    caption.className = "simple-message-input-input";
    caption.setAttribute("contenteditable", "true");
    const confirm = document.createElement("button");
    confirm.className = "simple-message-input-confirm";
    confirm.disabled = true;
    item.append(image);
    popup.append(item, caption, confirm);
    document.body.append(popup);
    await vi.advanceTimersByTimeAsync(32);
    expect(settled).toBe(false);

    Object.defineProperties(image, {
      complete: { configurable: true, value: true },
      naturalWidth: { configurable: true, value: 640 },
      naturalHeight: { configurable: true, value: 480 },
    });
    confirm.disabled = false;
    await vi.advanceTimersByTimeAsync(32);
    expect((await waiting).popup).toBe(popup);
  });

  it("uses timeout only as the upper boundary for preview appearance", async () => {
    vi.useFakeTimers();
    installComposer("8");
    let rejected = false;
    const waiting = new UploadPreviewAdapter().waitUntilReady("8").catch((error: unknown) => {
      rejected = true;
      throw error;
    });
    const rejection = expect(waiting).rejects.toMatchObject({ code: "preview-timeout" });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(rejected).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
  });

  it("inserts a caption exactly once", async () => {
    const { adapter, preview } = mockImagePipeline();
    const result = await adapter.insert(imagePayload("fixture-caption"), "8");
    expect(result.success).toBe(true);
    expect(preview.insertCaption).toHaveBeenCalledOnce();
    expect(preview.insertCaption).toHaveBeenCalledWith(expect.any(Object), "fixture-caption");
  });

  it("preserves caption line breaks in one native insertion", async () => {
    vi.useFakeTimers();
    installComposer("8");
    const popup = document.createElement("div");
    popup.className = "popup-send-photo popup-new-media active";
    const editor = document.createElement("div");
    editor.className = "simple-message-input-input";
    editor.setAttribute("contenteditable", "true");
    popup.append(editor);
    document.body.append(popup);
    const session = { popup, image: document.createElement("img"), captionEditor: editor, peerId: "8" };
    const insertion = new UploadPreviewAdapter().insertCaption(session, "fixture-line-a\r\nfixture-line-b");
    await vi.advanceTimersByTimeAsync(16);
    await insertion;
    expect(document.execCommand).toHaveBeenCalledOnce();
    expect(readTelegramText(editor)).toBe("fixture-line-a\nfixture-line-b");
  });

  it("verifies normalized caption emoji through img[alt]", async () => {
    vi.useFakeTimers();
    installComposer("8");
    const popup = document.createElement("div");
    popup.className = "popup-send-photo popup-new-media active";
    const editor = document.createElement("div");
    editor.className = "simple-message-input-input";
    editor.setAttribute("contenteditable", "true");
    popup.append(editor);
    document.body.append(popup);
    vi.mocked(document.execCommand).mockImplementationOnce(() => {
      editor.append("fixture-caption ");
      const emoji = document.createElement("img");
      emoji.className = "emoji";
      emoji.alt = "🙂";
      editor.append(emoji);
      return true;
    });
    const session = { popup, image: document.createElement("img"), captionEditor: editor, peerId: "8" };
    const insertion = new UploadPreviewAdapter().insertCaption(session, "fixture-caption 🙂");
    await vi.advanceTimersByTimeAsync(16);
    await insertion;
    expect(readTelegramText(editor)).toBe("fixture-caption 🙂");
    expect(editor.querySelector("img.emoji")?.getAttribute("alt")).toBe("🙂");
  });

  it("safely cancels an active preview after a readiness error", async () => {
    const { adapter, preview } = mockImagePipeline({
      waitUntilReady: async () => { throw new Error("preview failed"); },
      hasActivePreview: () => true,
      cancelActivePreview: async () => true,
    });
    const result = await adapter.insert(imagePayload(), "8");
    expect(result.success).toBe(false);
    expect(preview.cancelActivePreview).toHaveBeenCalledOnce();
  });

  it("uses only the scoped preview close control during cleanup", async () => {
    const unrelatedClose = document.createElement("button");
    unrelatedClose.className = "popup-close";
    const unrelatedClick = vi.spyOn(unrelatedClose, "click");
    document.body.append(unrelatedClose);
    const popup = document.createElement("div");
    popup.className = "popup-send-photo popup-new-media active";
    const scopedClose = document.createElement("button");
    scopedClose.className = "popup-close";
    const scopedClick = vi.spyOn(scopedClose, "click");
    scopedClose.addEventListener("click", () => popup.remove());
    popup.append(scopedClose);
    document.body.append(popup);
    expect(await new UploadPreviewAdapter().cancelActivePreview()).toBe(true);
    expect(scopedClick).toHaveBeenCalledOnce();
    expect(unrelatedClick).not.toHaveBeenCalled();
  });

  it("preserves a ready preview when the caption editor is unavailable", async () => {
    vi.useFakeTimers();
    installComposer("8");
    const popup = document.createElement("div");
    popup.className = "popup-send-photo popup-new-media active";
    const item = document.createElement("div");
    item.className = "popup-item popup-item-media";
    const image = document.createElement("img");
    image.src = "blob:no-caption";
    Object.defineProperties(image, {
      complete: { configurable: true, value: true },
      naturalWidth: { configurable: true, value: 100 },
      naturalHeight: { configurable: true, value: 100 },
    });
    const confirm = document.createElement("button");
    confirm.className = "simple-message-input-confirm";
    item.append(image);
    popup.append(item, confirm);
    document.body.append(popup);
    const waiting = new UploadPreviewAdapter().waitUntilReady("8");
    const rejection = expect(waiting).rejects.toEqual(
      expect.objectContaining({
        code: "caption-unavailable",
        preservePreview: true,
      }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    expect(popup.isConnected).toBe(true);
  });

  it("refuses image preparation when the peer changes", async () => {
    const { adapter, preview } = mockImagePipeline({
      arm: async () => ({ fileInput: document.createElement("input"), peerId: "9" }),
    });
    const result = await adapter.insert(imagePayload(), "8");
    expect(result.success).toBe(false);
    expect(result.message).toContain("другой чат");
    expect(preview.selectFile).not.toHaveBeenCalled();
  });

  it("blocks a second image insertion while the first operation is active", async () => {
    let releaseArm: ((target: ArmedMediaInput) => void) | null = null;
    const arm = () => new Promise<ArmedMediaInput>((resolve) => { releaseArm = resolve; });
    const { adapter, target } = mockImagePipeline({ arm });
    const first = adapter.insert(imagePayload(), "8");
    const second = await adapter.insert(imagePayload(), "8");
    expect(second).toEqual({ success: false, message: "Подготовка картинки уже выполняется." });
    releaseArm!(target);
    expect((await first).success).toBe(true);
  });

  it("never invokes Telegram's internal forward sender", async () => {
    const sendMessageWithForward = vi.fn();
    Object.assign(window, { ChatInput: { sendMessageWithForward } });
    const { adapter } = mockImagePipeline();
    await adapter.insert(imagePayload(), "8");
    expect(sendMessageWithForward).not.toHaveBeenCalled();
  });

  it("does not click the preview confirm control", async () => {
    const confirm = document.createElement("button");
    confirm.className = "simple-message-input-confirm";
    const click = vi.spyOn(confirm, "click");
    document.body.append(confirm);
    const { adapter } = mockImagePipeline();
    await adapter.insert(imagePayload(), "8");
    expect(click).not.toHaveBeenCalled();
  });
});
