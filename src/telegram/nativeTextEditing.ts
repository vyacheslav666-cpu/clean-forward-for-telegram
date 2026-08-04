/** Applies text through the browser editing pipeline observed by Telegram rich inputs. */

/** Controls whether native insertion replaces the current editor value. */
export interface NativeTextInsertionOptions {
  readonly replaceContents: boolean;
}

/**
 * Inserts text with execCommand so Telegram receives a coherent beforeinput/DOM/input sequence.
 */
export function insertTextNatively(
  editor: HTMLElement,
  text: string,
  options: NativeTextInsertionOptions,
): boolean {
  editor.focus();
  const selection = window.getSelection();
  if (!selection) {
    return false;
  }

  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(!options.replaceContents);
  selection.removeAllRanges();
  selection.addRange(range);

  // A non-collapsed range lets one insertText operation replace the old value while preserving
  // Telegram's coherent beforeinput → DOM change → input sequence.
  return document.execCommand("insertText", false, text);
}
