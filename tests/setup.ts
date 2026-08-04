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

Object.defineProperty(document, "execCommand", {
  configurable: true,
  writable: true,
  value: vi.fn((_command: string, _showUi: boolean, value: string) => {
    const editor = document.activeElement;
    if (editor instanceof HTMLElement) {
      editor.textContent = value;
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
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
  document.body.replaceChildren();
  vi.useRealTimers();
});
