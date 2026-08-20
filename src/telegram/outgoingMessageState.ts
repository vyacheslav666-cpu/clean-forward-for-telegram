/** Verified Web K contract for telling an acknowledged outgoing message from one still in flight. */

/**
 * Web K renders an outgoing message optimistically, long before the server has accepted it. While
 * the message is in flight its bubble carries `is-outgoing` plus the `is-sending` status class,
 * and its `data-mid` is a temporary id built as `serverId + 0.0001`
 * ([`appMessagesIdsManager.generateTempMessageId`](https://github.com/morethanwords/tweb/blob/master/src/lib/appManagers/appMessagesIdsManager.ts)).
 * On acknowledgement the `message_sent` handler writes the final integer mid and only then swaps
 * the status class for `is-sent`/`is-read`; a rejected send keeps its temporary mid and gets
 * `is-error` ([`bubbles.ts`](https://github.com/morethanwords/tweb/blob/master/src/components/chat/bubbles.ts)).
 *
 * Both signals are checked because either one alone has already proven fragile. The class this
 * project waited for used to be `sending`, which current Web K never sets, so every send was
 * confirmed on the optimistic bubble; `sending` stays in the selector only for older builds. And
 * an album bubble loses `is-outgoing` as soon as its first part is acknowledged, while the
 * remaining grouped items still hold temporary mids.
 */
import {
  FAILED_SELECTOR,
  IN_FLIGHT_SELECTOR,
  OUTGOING_BUBBLE_SELECTOR,
} from "./domContract";
/**
 * Cheap DOM-level prefilter for the two shapes an unconfirmed send can take: a status class, or
 * the fractional `data-mid` Web K hands out before the server answers. It only narrows which nodes
 * a scan has to inspect; the decision itself still belongs to {@link isOutgoingInFlight}.
 */
const IN_FLIGHT_MARKER_SELECTOR = '.is-outgoing, .is-sending, [data-mid*="."]';

/**
 * Reports whether Telegram has accepted this outgoing element and given it a server identity.
 *
 * Sending the next unit before this holds is what reordered a bundle: two uploads started together
 * are numbered by whichever finished first, not by the order they were captured in.
 */
export function isOutgoingAcknowledged(element: HTMLElement): boolean {
  return !hasTemporaryMessageId(element) && !matchesOwningBubble(element, IN_FLIGHT_SELECTOR);
}

/** Reports whether Telegram is still sending this outgoing element. */
export function isOutgoingInFlight(element: HTMLElement): boolean {
  return hasTemporaryMessageId(element) || matchesOwningBubble(element, IN_FLIGHT_SELECTOR);
}

/** Reports whether Telegram rejected this outgoing element after it was handed over. */
export function isOutgoingRejected(element: HTMLElement): boolean {
  return matchesOwningBubble(element, FAILED_SELECTOR);
}

/**
 * Reports whether a `data-mid` is one of Web K's local placeholders rather than a server id.
 *
 * A fractional mid is the only shape a temporary id can take, and a mid that is not a number at
 * all proves nothing either way, so it is never read as temporary.
 */
export function isTemporaryMessageId(messageId: string | null | undefined): boolean {
  if (!messageId) {
    return false;
  }
  const value = Number(messageId);
  return Number.isFinite(value) && !Number.isInteger(value);
}

function hasTemporaryMessageId(element: HTMLElement): boolean {
  return isTemporaryMessageId(element.dataset.mid);
}

/**
 * Album items are separate `data-mid` nodes, but Web K keeps send status on the bubble that owns
 * them, so state is always read from the bubble a matched element belongs to.
 */
function matchesOwningBubble(element: HTMLElement, selector: string): boolean {
  return owningBubble(element).matches(selector);
}

function owningBubble(element: Element): HTMLElement {
  return element.closest<HTMLElement>(OUTGOING_BUBBLE_SELECTOR) ?? (element as HTMLElement);
}

/** Reads the id of a message, falling back to the bubble that owns a grouped album item. */
function readMessageId(element: Element): string | null {
  return ownMessageId(element) ?? ownMessageId(owningBubble(element));
}

function ownMessageId(element: Element): string | null {
  const messageId = (element as HTMLElement).dataset?.mid?.trim();
  return messageId ? messageId : null;
}

/**
 * Returns every distinct message inside `scope` that Telegram is still sending.
 *
 * A rejected send is left out on purpose: Telegram has already stopped working on it, so waiting
 * for it to finish would wait forever. Results are deduplicated by the bubble that owns the state,
 * because one message renders as many marker nodes.
 */
export function findOutgoingInFlight(scope: ParentNode): HTMLElement[] {
  const found = new Set<HTMLElement>();
  for (const marker of scope.querySelectorAll<HTMLElement>(IN_FLIGHT_MARKER_SELECTOR)) {
    const bubble = owningBubble(marker);
    if (isOutgoingInFlight(bubble) && !isOutgoingRejected(bubble)) {
      found.add(bubble);
    }
  }
  return Array.from(found);
}

/**
 * Remembers the sends that were already running when an operation started.
 *
 * Blocking on any in-flight message in a chat is not safe: a send left over from an offline
 * session stays in flight indefinitely, and a check that never clears stops being a delay and
 * becomes a permanent refusal — for source restore, a safety failure of the whole batch. Only
 * traffic that appears after the snapshot can say anything about what this operation caused.
 */
export class OutgoingInFlightBaseline {
  /**
   * Web K rebuilds bubbles whenever a chat is rerendered, so node identity alone does not survive
   * a chat switch. `data-mid` does — including the temporary fractional id of a stuck message —
   * and node identity stays as the fallback for markup that carries no id at all.
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

  /** Returns the in-flight messages in `scope` that were not part of the snapshot. */
  public findNew(scope: ParentNode): HTMLElement[] {
    return findOutgoingInFlight(scope).filter((node) => {
      const messageId = readMessageId(node);
      return messageId ? !this.messageIds.has(messageId) : !this.nodes.has(node);
    });
  }
}
