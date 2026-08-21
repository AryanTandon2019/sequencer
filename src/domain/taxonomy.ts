/**
 * Razorpay `reason` string -> internal cause.
 *
 * Every string in the two maps below was read from Razorpay's live error
 * documentation:
 *   https://razorpay.com/docs/errors/payments/cards/
 *   https://razorpay.com/docs/errors/payments/upi/
 *   https://razorpay.com/docs/errors/codes
 *
 * The authoritative version of this mapping, with descriptions and per-row
 * provenance, is docs/decline-taxonomy.md §4. A test parses that document and
 * asserts this file agrees with it row for row, so the two cannot drift.
 */

import { recoverabilityOf } from './causes.js';
import { afaCeilingPaise } from './regulation.js';
import type {
  DeclineCause,
  MandateState,
  ObservedFailure,
  Paise,
  Recoverability,
} from './types.js';

/* ------------------------------------------------------------------ *
 * Reason strings
 * ------------------------------------------------------------------ */

/**
 * Failures that can occur on an unattended recurring debit.
 *
 * Shared across card and UPI where Razorpay uses the same string for both.
 */
export const REASON_TO_CAUSE: Readonly<Record<string, DeclineCause>> = {
  // --- balance and transient ---
  insufficient_funds: 'INSUFFICIENT_FUNDS',
  /** UPI: "funds could not be debited from the customer's bank account". */
  payment_declined: 'INSUFFICIENT_FUNDS',
  /** Downtime at the customer's bank, or at the UPI provider. */
  bank_technical_error: 'BANK_UNAVAILABLE',
  /** Downtime or technical issues at the partner bank. */
  gateway_technical_error: 'BANK_UNAVAILABLE',
  /** Daily card limit. Resets overnight - the one case a next-day retry fits. */
  transaction_limit_exceeded: 'LIMIT_EXCEEDED_TEMPORARY',

  // --- instrument is dead or unusable ---
  card_expired: 'CARD_EXPIRED',
  debit_instrument_blocked: 'INSTRUMENT_BLOCKED',
  debit_instrument_inactive: 'INSTRUMENT_NOT_ENABLED',
  card_not_enrolled: 'INSTRUMENT_NOT_ENABLED',
  card_disabled_for_online_payments: 'INSTRUMENT_NOT_ENABLED',

  // --- UPI-specific ---
  /** Customer used an account other than the one registered. */
  credit_failed: 'ACCOUNT_MISMATCH',
  invalid_vpa: 'VPA_INVALID',
  vpa_resolution_failed: 'VPA_INVALID',

  // --- risk ---
  /** Bank declined citing the transaction as fraudulent. */
  payment_risk_check_failed: 'FRAUD_SUSPECTED',

  // --- bank declined without explanation ---
  /** Razorpay documents that it may not have access to the underlying cause. */
  card_declined: 'AMBIGUOUS_BANK_DECLINE',
  payment_failed: 'AMBIGUOUS_BANK_DECLINE',
};

/**
 * Failures that require a human present at a payment screen.
 *
 * An unattended auto-debit cannot produce "customer pressed the back button" or
 * "incorrect CVV entered". Classifying these as out of scope is a deliberate
 * decision, recorded here rather than silently omitted.
 *
 * See docs/decline-taxonomy.md §6.
 */
export const OUT_OF_SCOPE_REASONS: Readonly<Record<string, string>> = {
  payment_timed_out:
    'Customer exceeded the processing time limit. Requires a human at checkout. ' +
    'Note: Razorpay also documents this string under partner bank downtime, so a ' +
    'recurring-context occurrence is not impossible - see decline-taxonomy.md §7.',
  payment_collect_request_expired:
    'Customer exceeded the collect-request time limit. Requires a human at checkout.',
  incorrect_cvv: 'Customer entered an incorrect CVV. Requires a human at checkout.',
  payment_cancelled:
    'Documented as the customer cancelling or pressing back during checkout. ' +
    'UNVERIFIED whether Razorpay also emits this for mandate cancellation; until ' +
    'confirmed it must not be treated as a revocation signal.',
  authentication_failed:
    'Documented as incorrect OTP or abandoned authentication at checkout. ' +
    'UNVERIFIED for recurring charges above the AFA ceiling, where an ' +
    'authentication step does legitimately exist.',
};

/* ------------------------------------------------------------------ *
 * Classification
 * ------------------------------------------------------------------ */

/** How a cause was arrived at. Recorded for the ledger and the UI. */
export type ClassificationBasis =
  /** Mandate authorisation state overrode the payment reason. */
  | 'mandate_state'
  /** Charge exceeds the authorised mandate ceiling. */
  | 'mandate_cap'
  /** Charge exceeds the AFA exemption ceiling. */
  | 'afa_ceiling'
  /** Direct lookup on Razorpay's `reason` string. */
  | 'reason_string'
  /** Razorpay's `step` field disambiguated an otherwise unmapped failure. */
  | 'step_signal';

export type Classification =
  | {
      readonly kind: 'resolved';
      readonly cause: DeclineCause;
      readonly recoverability: Recoverability;
      readonly basis: ClassificationBasis;
    }
  | {
      /** A checkout-only failure. Not an error, and not something to act on. */
      readonly kind: 'out_of_scope';
      readonly reason: string;
      readonly note: string;
    }
  | {
      /**
       * Unknown to us. This is a real answer, not a failure: it routes to the
       * model layer and then, if still unresolved, to a human. It is never
       * coerced into a guess. See DECISIONS.md D7.
       */
      readonly kind: 'unrecognised';
      readonly reason: string;
    };

export interface ClassifyInput {
  readonly failure: ObservedFailure;
  readonly mandateState: MandateState;
  readonly amountPaise: Paise;
}

function resolved(cause: DeclineCause, basis: ClassificationBasis): Classification {
  return {
    kind: 'resolved',
    cause,
    recoverability: recoverabilityOf(cause),
    basis,
  };
}

/**
 * Deterministic classification.
 *
 * Precedence matters and is deliberate:
 *
 *   1. Mandate authorisation state wins over everything. If consent is revoked,
 *      no reason string can make a retry appropriate - and because Razorpay's
 *      error taxonomy carries no mandate information at all, this fact is only
 *      available from the second input. See DECISIONS.md D12.
 *   2. Consent boundaries next: a charge above the authorised cap, or above the
 *      AFA ceiling, cannot succeed as a silent debit regardless of why the last
 *      attempt failed.
 *   3. Then the reason string.
 *   4. Then `step` as a disambiguating signal.
 *   5. Otherwise unrecognised.
 */
export function classify(input: ClassifyInput): Classification {
  const { failure, mandateState, amountPaise } = input;

  // 1. Mandate authorisation overrides the payment reason.
  switch (mandateState.authorisation) {
    case 'revoked':
      return resolved('MANDATE_REVOKED', 'mandate_state');
    case 'paused':
      return resolved('MANDATE_PAUSED', 'mandate_state');
    case 'expired':
      // An expired mandate is withdrawn authorisation by lapse rather than by
      // choice. Treated as revoked: a debit is equally uncovered by consent.
      return resolved('MANDATE_REVOKED', 'mandate_state');
    case 'active':
      break;
  }

  // 2. Consent boundaries.
  if (amountPaise > mandateState.capPaise) {
    return resolved('AMOUNT_EXCEEDS_MANDATE', 'mandate_cap');
  }
  if (amountPaise > afaCeilingPaise(mandateState.higherAfaCeiling)) {
    return resolved('AUTH_REQUIRED_AFA', 'afa_ceiling');
  }

  // 3. Checkout-only failures are recognised and excluded, not guessed at.
  const outOfScope = OUT_OF_SCOPE_REASONS[failure.reason];
  if (outOfScope !== undefined) {
    return { kind: 'out_of_scope', reason: failure.reason, note: outOfScope };
  }

  // 4. The reason string.
  const cause = REASON_TO_CAUSE[failure.reason];
  if (cause !== undefined) {
    return resolved(cause, 'reason_string');
  }

  // 5. `step` as a last deterministic signal. A failure at the authentication
  //    stage is an authentication problem whatever the reason string says.
  if (failure.step === 'payment_authentication') {
    return resolved('AUTH_REQUIRED_AFA', 'step_signal');
  }

  return { kind: 'unrecognised', reason: failure.reason };
}

/** Every reason string this module knows how to act on. */
export const KNOWN_ACTIONABLE_REASONS: readonly string[] = Object.keys(REASON_TO_CAUSE);

/** Every reason string knowingly excluded as checkout-only. */
export const KNOWN_OUT_OF_SCOPE_REASONS: readonly string[] = Object.keys(OUT_OF_SCOPE_REASONS);
