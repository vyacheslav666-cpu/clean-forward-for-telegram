/** Reads Telegram Web K's outgoing-message lifecycle from the markup it actually renders. */

/**
 * Web K marks a message it has not yet confirmed with `is-sending`, keeps `is-outgoing` on the
 * bubble until the server assigns a real id, and switches a rejected one to `is-error`
 * (`setBubbleSendingStatus`). The bare `.sending` class this project used to look for belongs to a
 * much older build, so every check written against it silently matched nothing. It stays accepted
 * here so older Web K shells keep working, but it is no longer the contract.
 */
const PENDING_CLASSES = ["is-sending", "is-outgoing", "sending"] as const;
const REJECTED_CLASS = "is-error";
const BUBBLE_SELECTOR = ".bubble";
/**
 * Cheap DOM-level prefilter for the two pending shapes: an explicit class, or the fractional
 * `data-mid` Web K hands out before the server answers (`appMessagesIdsManager.generateTempMessageId`
 * returns `serverId + fraction`). The exact decision is still made by {@link isOutgoingInFlight};
 * this selector only narrows which nodes have to be inspected on a hot polling path.
 */
const IN_FLIGHT_MARKER_SELECTOR = '.is-sending, .is-outgoing, .sending, [data-mid*="."]';

/** Reports whether Telegram is still trying to deliver this outgoing message. */
export function isOutgoingInFlight(element: Element): boolean {
  const node = resolveMessageNode(element);
  // A rejected send is terminal even if Web K has not yet dropped its pending classes: Telegram
  // has stopped on its own, so nothing may keep waiting on it.
  if (isOutgoingRejected(node)) {
    return false;
  }
  return isPendingNode(node) ||
    Array.from(node.querySelectorAll(IN_FLIGHT_MARKER_SELECTOR)).some(isPendingNode);
}

/** Reports whether Telegram gave this outgoing message a server id and stopped working on it. */
export function isOutgoingAcknowledged(element: Element): boolean {
  const messageId = readMessageId(element);
  return Boolean(messageId) &&
    !isTemporaryMessageId(messageId) &&
    !isOutgoingRejected(element) &&
    !isOutgoingInFlight(element);
}

/** Reports whether Telegram marked this outgoing message as failed. */
export function isOutgoingRejected(element: Element): boolean {
  const node = resolveMessageNode(element);
  return node.classList.contains(REJECTED_CLASS) ||
    node.querySelector(`.${REJECTED_CLASS}`) !== null;
}

/** Returns every distinct outgoing message inside `scope` that Telegram has not confirmed yet. */
export function findOutgoingInFlight(scope: ParentNode): HTMLElement[] {
  const found = new Set<HTMLElement>();
  for (const marker of scope.querySelectorAll<HTMLElement>(IN_FLIGHT_MARKER_SELECTOR)) {
    const node = resolveMessageNode(marker);
    if (isOutgoingInFlight(node)) {
      found.add(node);
    }
  }
  return Array.from(found);
}

/**
 * Remembers the outgoing messages that were already in flight when an operation started.
 *
 * Blocking on any `is-sending` in a chat is not safe: one message stuck from an offline session
 * stays in flight indefinitely, and a check that never clears turns into a permanent stop — for
 * source restore, into a safety failure of the whole batch. Only traffic that appears after the
 * snapshot can say anything about what this operation is doing.
 */
export class OutgoingInFlightBaseline {
  /**
   * Web K rebuilds bubbles when a chat is (re)rendered, so node identity alone does not survive a
   * chat switch. `data-mid` does — including the temporary fractional id of a stuck message —
   * and node identity remains as the fallback for markup that carries no id at all.
   */
  private readonly messageIds = new Set<string>();
  private readonly nodes = new WeakSet<Element>();

  public constructor(scope: ParentNode) {
    for (const node of findOutgoingInFlight(scope)) {
      const messageId = readMessageId(node);
      if (messageId) {
        this.messageIds.add(messageId);
      } else {
        this.nodes.add(node);
      }
    }
  }

  /** Returns the in-flight outgoing messages in `scope` that were not part of the snapshot. */
  public findNew(scope: ParentNode): HTMLElement[] {
    return findOutgoingInFlight(scope).filter((node) => {
      const messageId = readMessageId(node);
      return messageId ? !this.messageIds.has(messageId) : !this.nodes.has(node);
    });
  }
}

/** Reports whether a `data-mid` is one of Web K's local placeholders rather than a server id. */
export function isTemporaryMessageId(messageId: string | null | undefined): boolean {
  if (!messageId) {
    return false;
  }
  const value = Number(messageId);
  return Number.isFinite(value) && !Number.isInteger(value);
}

function isPendingNode(node: Element): boolean {
  return PENDING_CLASSES.some((name) => node.classList.contains(name)) ||
    isTemporaryMessageId(ownMessageId(node));
}

/** Resolves the bubble that owns a marker, because Web K keeps the state on the bubble itself. */
function resolveMessageNode(element: Element): HTMLElement {
  return element.closest<HTMLElement>(BUBBLE_SELECTOR) ?? (element as HTMLElement);
}

/** Reads the message id of a node, falling back to the bubble for grouped album items. */
function readMessageId(element: Element): string | null {
  return ownMessageId(element) ?? ownMessageId(resolveMessageNode(element));
}

function ownMessageId(element: Element): string | null {
  const messageId = (element as HTMLElement).dataset?.mid?.trim();
  return messageId ? messageId : null;
}
