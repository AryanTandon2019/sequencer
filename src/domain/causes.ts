/**
 * The recoverability table.
 *
 * This is the decision Razorpay's built-in subscription retry does not make.
 * Its documentation names four distinct failure causes - expired card, blocked
 * card, insufficient balance, cancelled mandate - and then applies one calendar
 * policy to all four: retry the next day, shifted for bank holidays.
 *   https://razorpay.com/docs/payments/subscriptions/payment-retries/
 *
 * Those four do not have the same recoverability. Each row below is a claim
 * about whether spending one of four regulated attempts can possibly succeed.
 */

import type { DeclineCause, Recoverability } from './types.js';

/**
 * Cause -> recoverability.
 *
 * Typed as a total Record, which means adding a cause to `DeclineCause` without
 * classifying it here is a compile error rather than a silent gap. That matters:
 * an unclassified cause would otherwise fall through to some default and produce
 * a plausible-looking wrong number.
 */
export const RECOVERABILITY: Readonly<Record<DeclineCause, Recoverability>> = {
  /**
   * Balance was short at the moment of debit. Money may well arrive later, so
   * an attempt is rational - but *when* decides everything, and Razorpay's
   * next-day default is indifferent to the customer's funding cycle.
   */
  INSUFFICIENT_FUNDS: 'RETRY_VIABLE',

  /**
   * Downtime at the customer's bank or the partner bank. Transient by
   * definition, and the cheapest recovery available.
   */
  BANK_UNAVAILABLE: 'RETRY_VIABLE',

  /**
   * Daily card transaction limit reached.
   *
   * NOTE: this is the one cause where Razorpay's next-day retry is exactly
   * correct, because the limit resets overnight. Documented deliberately - a
   * critique claiming the incumbent is always wrong invites the reviewer to go
   * looking for the counterexample. See DECISIONS.md D13.
   */
  LIMIT_EXCEEDED_TEMPORARY: 'RETRY_VIABLE',

  /**
   * The card is past expiry. No number of retries revives it; the instrument
   * must change. RBI's E-mandate Framework 2026 permits mapping an existing
   * mandate to a reissued card, so a compliant non-retry path exists.
   */
  CARD_EXPIRED: 'RETRY_FUTILE',

  /** Blocked by the customer or their bank. Requires their action, not repetition. */
  INSTRUMENT_BLOCKED: 'RETRY_FUTILE',

  /**
   * Never enabled for online or recurring use. Repeating the debit cannot
   * change a setting that lives in the customer's banking app.
   */
  INSTRUMENT_NOT_ENABLED: 'RETRY_FUTILE',

  /**
   * Customer paid from an account other than the one registered. The mismatch
   * persists until they act, so retrying reproduces the same failure.
   */
  ACCOUNT_MISMATCH: 'RETRY_FUTILE',

  /** UPI ID invalid or unresolvable. Retrying resolves the same broken handle. */
  VPA_INVALID: 'RETRY_FUTILE',

  /** Above the authorised ceiling. Needs a new mandate, not another attempt. */
  AMOUNT_EXCEEDS_MANDATE: 'RETRY_FUTILE',

  /**
   * Above the AFA exemption ceiling. A silent retry cannot supply an additional
   * authentication factor, so it cannot succeed by construction.
   */
  AUTH_REQUIRED_AFA: 'RETRY_FUTILE',

  /**
   * The bank declined citing suspected fraud. Retrying does not merely fail, it
   * pushes against a risk decision the issuer already made, and card networks
   * charge for reattempting declines that will never approve.
   */
  FRAUD_SUSPECTED: 'RETRY_FORBIDDEN',

  /**
   * The customer withdrew consent. A retry here is a debit against a revoked
   * authorisation - a consent problem, not a wasted attempt. Hard stop, and
   * dunning is equally inappropriate.
   */
  MANDATE_REVOKED: 'RETRY_FORBIDDEN',

  /**
   * Consent suspended, not withdrawn. It will resume. Attempts spent in the
   * meantime are simply burned, and contact is an irritation.
   */
  MANDATE_PAUSED: 'WAIT',

  /**
   * The bank declined and supplied no reason. Razorpay documents that it may
   * not have access to the underlying cause for `card_declined` and
   * `payment_failed`. Genuinely unknowable from the payload, so it is never
   * guessed at. See DECISIONS.md D7.
   */
  AMBIGUOUS_BANK_DECLINE: 'NEEDS_HUMAN',
};

/**
 * Every cause, derived from the table above rather than maintained separately,
 * so the two cannot drift apart.
 */
export const ALL_DECLINE_CAUSES = Object.keys(RECOVERABILITY) as readonly DeclineCause[];

/**
 * Hard declines: reattempting these is chargeable, not just futile.
 *
 * Visa's excessive reattempts programme permits no reattempts on hard declines
 * and applies per-transaction fees for exceeding reattempt limits.
 *   https://developers.getevolved.com/enterprise/docs/visas-processing-integrity-fee-program
 *   https://www.paypal.com/us/brc/article/avoid-excessive-retries-penalties
 */
export const HARD_DECLINE_CAUSES = [
  'CARD_EXPIRED',
  'INSTRUMENT_BLOCKED',
  'INSTRUMENT_NOT_ENABLED',
  'FRAUD_SUSPECTED',
  'MANDATE_REVOKED',
] as const satisfies readonly DeclineCause[];

export function recoverabilityOf(cause: DeclineCause): Recoverability {
  return RECOVERABILITY[cause];
}

export function isHardDecline(cause: DeclineCause): boolean {
  return (HARD_DECLINE_CAUSES as readonly DeclineCause[]).includes(cause);
}

/**
 * True only when spending one of the four permitted attempts can possibly
 * succeed. This single predicate is the difference between Sequencer and a
 * calendar.
 */
export function isAttemptWorthSpending(cause: DeclineCause): boolean {
  return recoverabilityOf(cause) === 'RETRY_VIABLE';
}

/**
 * Causes that are terminal for the current cycle: no further automated action
 * should be attempted, whether because consent is gone or because a human owns
 * it now.
 */
export function isTerminalForCycle(cause: DeclineCause): boolean {
  const r = recoverabilityOf(cause);
  return r === 'RETRY_FORBIDDEN' || r === 'NEEDS_HUMAN';
}
