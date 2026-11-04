export interface BackoffPolicy {
  baseMs: number;
  maxMs: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = { baseMs: 1000, maxMs: 60_000 };

/** Delay before retry number `retry` (1-based): 1s, 2s, 4s, ... capped at 60s by default. */
export function backoffDelayMs(retry: number, policy: BackoffPolicy = DEFAULT_BACKOFF): number {
  return Math.min(policy.baseMs * 2 ** (retry - 1), policy.maxMs);
}

export function nextAttemptAfter(now: Date, retry: number, policy?: BackoffPolicy): Date {
  return new Date(now.getTime() + backoffDelayMs(retry, policy));
}
