/** Defines immutable recipient data exposed to the project UI. */

const SIMPLE_PEER_KEY_PATTERN = /^-?\d+$/;

/** One already-loaded Telegram dialog that may be shown in the recipient picker. */
export interface Recipient {
  readonly peerKey: string;
  readonly title: string;
  /** Exact native query that resolved this peer; display title is only a fallback locator. */
  readonly searchQuery?: string;
  readonly subtitle?: string;
  readonly avatarUrl?: string;
  readonly supported: boolean;
  readonly unsupportedReason?: string;
}

/** Reports whether a Telegram peer key represents one plain chat without a topic suffix. */
export function isSimplePeerKey(peerKey: string): boolean {
  return SIMPLE_PEER_KEY_PATTERN.test(peerKey);
}

/** Freezes a recipient selection so later Telegram rerenders cannot mutate the chosen target. */
export function snapshotRecipient(recipient: Recipient): Readonly<Recipient> {
  return Object.freeze({ ...recipient });
}
