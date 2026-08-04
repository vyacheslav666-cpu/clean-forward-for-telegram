/** Reconstructs readable text from Telegram rich-input and message DOM. */

const TEXT_NODE_TYPE = 3;
const ELEMENT_NODE_TYPE = 1;
const LINE_BREAK_TAG = "BR";
const IMAGE_TAG = "IMG";

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

  const readNode = (node: Node): string => {
    if (node.nodeType === TEXT_NODE_TYPE) {
      return node.nodeValue ?? "";
    }

    if (node.nodeType !== ELEMENT_NODE_TYPE) {
      return "";
    }

    const element = node as HTMLElement;
    if (ignoredSelectors.some((selector) => element.matches(selector))) {
      return "";
    }

    if (element.tagName === LINE_BREAK_TAG) {
      return "\n";
    }

    if (element.tagName === IMAGE_TAG) {
      return element.getAttribute("alt") ?? "";
    }

    return Array.from(element.childNodes, readNode).join("");
  };

  return Array.from(root.childNodes, readNode).join("");
}
