/**
 * Deterministic diagnosis.
 *
 * A table lookup over Razorpay's documented reason strings, plus mandate state and
 * charge amount. Resolves the large majority of failures at zero cost and with a
 * result a reviewer can check line by line.
 *
 * Confidence is not a number pulled from the air. It reflects how the cause was
 * arrived at: a mandate that reports itself revoked is a fact, a reason-string
 * lookup is near-certain, and inferring from Razorpay's `step` field alone is a
 * weaker signal that deserves a lower number.
 */

import { classify } from '../domain/taxonomy.js';
import type { Diagnosis } from '../domain/types.js';
import type { StrategyInput } from '../strategies/strategy.js';

/**
 * Confidence by basis of classification.
 *
 * These are ours, not measured. Their only real job is to sit above or below the
 * autonomous-action floor in the right cases, and the sensitivity of results to the
 * floor is worth reporting.
 */
const CONFIDENCE_BY_BASIS = {
  /** The mandate itself reports its authorisation. Not an inference. */
  mandate_state: 0.99,
  /** Arithmetic against the authorised ceiling. */
  mandate_cap: 0.99,
  /** Arithmetic against the AFA exemption ceiling. */
  afa_ceiling: 0.99,
  /** Direct lookup on a documented reason string. */
  reason_string: 0.95,
  /** Inferred from the failure stage alone, with no recognised reason string. */
  step_signal: 0.6,
} as const;

export type Diagnoser = (
  input: StrategyInput,
) => Diagnosis | null | Promise<Diagnosis | null>;

/**
 * Returns null when the failure cannot be classified from observable signals.
 *
 * Null is a real answer and the correct one here. Razorpay documents that it may
 * not have access to the underlying cause for some declines, so manufacturing a
 * confident guess would undermine every honest number elsewhere in the report.
 * Null routes to the model layer, and then to a human.
 */
export const deterministicDiagnoser: Diagnoser = (input) => {
  const result = classify({
    failure: input.failure,
    mandateState: input.mandateState,
    amountPaise: input.sub.amountPaise,
  });

  switch (result.kind) {
    case 'resolved':
      // An unexplained decline is not a diagnosis, it is the absence of one.
      //
      // Razorpay documents that it may not have access to the cause behind
      // `card_declined` and `payment_failed`, so mapping them to
      // AMBIGUOUS_BANK_DECLINE records what the payload says without establishing
      // anything about the customer. Returning it as a settled answer would also
      // close the door on the layer that exists precisely for these cases: a
      // reasoning layer would never be consulted, because a lookup table would have
      // already declared the matter resolved.
      //
      // The cause itself stays meaningful. A model may still conclude ambiguity after
      // weighing the history, and the oracle uses it for customers whose decline
      // genuinely has no determinable cause. Only this layer abstains.
      if (result.cause === 'AMBIGUOUS_BANK_DECLINE') return null;

      return {
        cause: result.cause,
        recoverability: result.recoverability,
        confidence: CONFIDENCE_BY_BASIS[result.basis],
        reasoning: `classified by ${result.basis} from reason "${input.failure.reason}"`,
        source: 'deterministic',
      };

    case 'out_of_scope':
      // A checkout-only failure on an unattended debit. Recognised rather than
      // silently mapped, and handed to a human because it means our model of what
      // can occur on a recurring charge is incomplete.
      return null;

    case 'unrecognised':
      return null;
  }
};
