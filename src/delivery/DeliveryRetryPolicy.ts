/** One bounded policy shared by safe pre-Send retries and post-Send reconciliation. */
export const DELIVERY_RETRY_POLICY = Object.freeze({
  maxPreSendAttempts: 3,
  preSendBackoffMs: Object.freeze([100, 250] as const),
  outgoingConfirmationTimeoutMs: 12_000,
  reconciliationBackoffMs: Object.freeze([500, 1_500, 3_000] as const),
  /**
   * Separate budget for a message Telegram is observably still sending. Confirmation now waits for
   * the server identity instead of the optimistic bubble, and an upload of the maximum capture size
   * routinely outlives the reconciliation backoff, so a shared budget would report `unknown` for
   * messages that are on their way. It stays bounded because a stalled upload never resolves.
   */
  inFlightConfirmationTimeoutMs: 300_000,
  inFlightPollIntervalMs: 1_000,
});

/** Returns the delay before the next safe pre-Send attempt, or null when exhausted. */
export function getPreSendRetryDelay(attempt: number): number | null {
  if (attempt >= DELIVERY_RETRY_POLICY.maxPreSendAttempts) {
    return null;
  }
  return DELIVERY_RETRY_POLICY.preSendBackoffMs[attempt - 1] ?? 0;
}
