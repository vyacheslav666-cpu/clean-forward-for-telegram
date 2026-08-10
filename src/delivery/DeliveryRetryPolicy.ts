/** One bounded policy shared by safe pre-Send retries and post-Send reconciliation. */
export const DELIVERY_RETRY_POLICY = Object.freeze({
  maxPreSendAttempts: 3,
  preSendBackoffMs: Object.freeze([100, 250] as const),
  outgoingConfirmationTimeoutMs: 12_000,
  reconciliationBackoffMs: Object.freeze([500, 1_500, 3_000] as const),
});

/** Returns the delay before the next safe pre-Send attempt, or null when exhausted. */
export function getPreSendRetryDelay(attempt: number): number | null {
  if (attempt >= DELIVERY_RETRY_POLICY.maxPreSendAttempts) {
    return null;
  }
  return DELIVERY_RETRY_POLICY.preSendBackoffMs[attempt - 1] ?? 0;
}
