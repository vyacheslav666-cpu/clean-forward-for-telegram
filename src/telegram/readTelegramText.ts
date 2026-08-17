/** Reconstructs readable text from Telegram rich-input and message DOM. */

const TEXT_NODE_TYPE = 3;
const ELEMENT_NODE_TYPE = 1;
const LINE_BREAK_TAG = "BR";
const IMAGE_TAG = "IMG";

/**
 * Tags Telegram itself treats as line boundaries in `getRichElementValue`.
 *
 * `BR` is deliberately absent: it ends a line unconditionally, while these only start one when the
 * current line already has content. Chrome writes multi-line `execCommand("insertText")` values as
 * sibling `<div>` blocks rather than `<br>`, so a reader that knows only `<br>` silently drops every
 * line break — and every multi-line verification then compares against text it never really read.
 */
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  "DIV",
  "P",
  "LI",
  "SECTION",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "TR",
  "OL",
  "UL",
  "BLOCKQUOTE",
]);

/** Options for excluding Telegram metadata nodes from the reconstructed value. */
export interface ReadTelegramTextOptions {
  readonly ignoredSelectors?: readonly string[];
}

/**
 * Reads text nodes, line breaks, and emoji image alt text into the value a user perceives.
 */
export function readTelegramText(
  root: HTMLElement,
  options: ReadTelegramTextOptions = {},
): string {
  const ignoredSelectors = options.ignoredSelectors ?? [];
  const lines: string[] = [];
  let current = "";
  let produced = false;

  const pushLine = (): void => {
    lines.push(current);
    current = "";
  };

  const append = (value: string): void => {
    current += value;
    produced ||= value.length > 0;
  };

  const readNode = (node: Node): void => {
    if (node.nodeType === TEXT_NODE_TYPE) {
      append(node.nodeValue ?? "");
      return;
    }

    if (node.nodeType !== ELEMENT_NODE_TYPE) {
      return;
    }

    const element = node as HTMLElement;
    if (ignoredSelectors.some((selector) => element.matches(selector))) {
      return;
    }

    if (element.tagName === LINE_BREAK_TAG) {
      pushLine();
      return;
    }

    if (element.tagName === IMAGE_TAG) {
      append(element.getAttribute("alt") ?? "");
      return;
    }

    if (!BLOCK_TAGS.has(element.tagName)) {
      element.childNodes.forEach(readNode);
      return;
    }

    // A block opens its own line, so an empty one contributes only the break its `<br>` filler
    // already pushed. That is what separates Chrome's blank line `<div><br></div>` from the
    // trailing filler it appends after the last real line.
    if (current.length > 0) {
      pushLine();
    }
    const outerProduced = produced;
    produced = false;
    element.childNodes.forEach(readNode);
    const blockHadContent = produced;
    produced = outerProduced || blockHadContent;
    if (blockHadContent) {
      pushLine();
    }
  };

  root.childNodes.forEach(readNode);
  lines.push(current);
  // Telegram drops the same trailing filler when it reads the value it is about to send, so keeping
  // it here would fail every comparison against a captured value that was trimmed at capture time.
  while (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.join("\n");
}
