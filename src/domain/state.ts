/**
 * Helpers over observable subscription state.
 *
 * Shared by the policy and the compliance layer, which both need to answer the same
 * question: has the thing that caused the last failure actually been dealt with?
 *
 * That question turns out to be load-bearing. A failure reason is a fact about a
 * moment in the past, and treating it as a fact about the present is how a system
 * ends up refusing a debit against a card the customer replaced yesterday.
 */

import type { Millis, ObservableSubscription } from './types.js';

/** When the most recent failed attempt occurred, if any attempt has failed. */
export function lastFailureAt(sub: ObservableSubscription): Millis | undefined {
  let latest: Millis | undefined;
  for (const attempt of sub.attempts) {
    if (attempt.outcome !== 'failure') continue;
    if (latest === undefined || attempt.at > latest) latest = attempt.at;
  }
  return latest;
}

/**
 * Whether the customer has cleared the blocker since the last failure.
 *
 * True after a replaced card, a re-authorised mandate, or a completed
 * authentication. Once true, the previous failure reason describes a situation that
 * no longer exists, and both the policy and the guardrails must stop acting on it:
 *
 *   - the policy should propose a retry rather than asking again
 *   - the hard-decline rule should stop refusing that retry, because the decline it
 *     was protecting against has been addressed
 *
 * A remedy recorded before the failure does not count. Otherwise a card updated last
 * month would permanently excuse every future failure on that subscription.
 */
export function remedyClearedSinceLastFailure(sub: ObservableSubscription): boolean {
  const remedyAt = sub.remedyCompletedAt;
  if (remedyAt === undefined) return false;

  const failedAt = lastFailureAt(sub);
  return failedAt === undefined ? true : remedyAt > failedAt;
}
