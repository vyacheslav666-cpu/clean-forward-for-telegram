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
const IN_FLIGHT_SELECTOR = ".is-outgoing, .is-sending, .sending";
const FAILED_SELECTOR = ".is-error";
const OUTGOING_BUBBLE_SELECTOR = ".bubble.is-out";
/** A fractional mid is the only shape a temporary Web K id can take. */
const TEMPORARY_MESSAGE_ID_PATTERN = /\.\d/;

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

function hasTemporaryMessageId(element: HTMLElement): boolean {
  return TEMPORARY_MESSAGE_ID_PATTERN.test(element.dataset.mid ?? "");
}

/**
 * Album items are separate `data-mid` nodes, but Web K keeps send status on the bubble that owns
 * them, so state is always read from the bubble a matched element belongs to.
 */
function matchesOwningBubble(element: HTMLElement, selector: string): boolean {
  const bubble = element.closest<HTMLElement>(OUTGOING_BUBBLE_SELECTOR) ?? element;
  return bubble.matches(selector);
}
