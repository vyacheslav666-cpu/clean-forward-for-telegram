import { afterEach, vi } from "vitest";

class TestDataTransferItemList {
  public constructor(private readonly owner: TestDataTransfer) {}

  public add(file: File): File {
    this.owner.addFile(file);
    return file;
  }
}

class TestDataTransfer {
  private storedFiles: File[] = [];
  public readonly items = new TestDataTransferItemList(this);

  public get files(): FileList {
    const files = this.storedFiles;
    const list = {
      length: files.length,
      item: (index: number) => files[index] ?? null,
      [Symbol.iterator]: () => files[Symbol.iterator](),
    } as unknown as FileList;
    files.forEach((file, index) => Object.defineProperty(list, index, { value: file }));
    return list;
  }

  public addFile(file: File): void {
    this.storedFiles.push(file);
  }
}

Object.defineProperty(globalThis, "DataTransfer", {
  configurable: true,
  writable: true,
  value: TestDataTransfer,
});

class TestMouseEvent extends window.MouseEvent {
  public constructor(type: string, init: MouseEventInit = {}) {
    const { view: _view, ...compatibleInit } = init;
    super(type, compatibleInit);
  }
}

Object.defineProperty(globalThis, "MouseEvent", {
  configurable: true,
  writable: true,
  value: TestMouseEvent,
});

/**
 * Reproduces how Chrome's `execCommand("insertText")` actually writes a value into a
 * contenteditable: the first line stays inline and every following line gets its own `<div>`, with
 * `<div><br></div>` standing for an empty one.
 *
 * jsdom has no editing pipeline, so this mock is the only contract the suite ever sees. Flattening
 * the value into `textContent` made every multi-line round-trip succeed here and fail in Telegram.
 */
function writeLikeChrome(editor: HTMLElement, value: string): void {
  editor.replaceChildren();
  if (value.length === 0) {
    return;
  }

  const [first, ...rest] = value.split("\n");
  if (first) {
    editor.append(document.createTextNode(first));
  }
  for (const line of rest) {
    const block = document.createElement("div");
    block.append(line ? document.createTextNode(line) : document.createElement("br"));
    editor.append(block);
  }
}

Object.defineProperty(document, "execCommand", {
  configurable: true,
  writable: true,
  value: vi.fn((command: string, _showUi: boolean, value: string) => {
    const editor = document.activeElement;
    if (editor instanceof HTMLElement) {
      writeLikeChrome(editor, command === "delete" ? "" : value);
      editor.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          data: command === "delete" ? null : value,
          inputType: command === "delete" ? "deleteContentBackward" : "insertText",
        }),
      );
    }
    return true;
  }),
});

Object.defineProperty(window, "requestAnimationFrame", {
  configurable: true,
  writable: true,
  value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 16),
});
Object.defineProperty(window, "cancelAnimationFrame", {
  configurable: true,
  writable: true,
  value: (handle: number) => window.clearTimeout(handle),
});

afterEach(() => {
  vi.clearAllTimers();
  document.body.replaceChildren();
  delete (window as Window & { ChatInput?: unknown }).ChatInput;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
