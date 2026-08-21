/**
 * The strategy contract.
 *
 * Every strategy sees the same inputs and returns the same shape, so the harness
 * cannot give one an advantage over another. Fair comparison is a property of the
 * types rather than a promise in the README.
 *
 * Two constraints are built into the shape deliberately:
 *
 *   1. A strategy PROPOSES. It never executes. It returns candidate actions and
 *      the engine adjudicates them against the compliance layer. There is no code
 *      path by which a strategy can act without being ruled on, which is a stronger
 *      guarantee than remembering to call the guardrails.
 *
 *   2. The input carries only observable state. No hidden persona appears on
 *      `StrategyInput`, and a test asserts that no file in this directory imports
 *      from src/sim/ — with one sanctioned exception, the oracle, whose entire
 *      purpose is to read the truth in order to establish a ceiling.
 */

import type {
  Action,
  Diagnosis,
  MandateState,
  Millis,
  ObservableSubscription,
  ObservedFailure,
} from '../domain/types.js';

export interface StrategyInput {
  /** Everything a merchant can see about this subscription. */
  readonly sub: ObservableSubscription;
  /**
   * Mandate authorisation and limits.
   *
   * A separate input because Razorpay's error taxonomy carries no mandate
   * information — it arrives by webhook. See DECISIONS.md D12.
   */
  readonly mandateState: MandateState;
  /** The failure being responded to, as the issuer reported it. */
  readonly failure: ObservedFailure;
  readonly now: Millis;
}

export interface StrategyProposal {
  /**
   * What the strategy believes is wrong, or null if it does not form a view.
   *
   * Null is not a failure state. It is the honest description of a calendar-driven
   * policy, and the confusion matrix skips strategies that make no claim rather
   * than crediting them with one.
   */
  readonly diagnosis: Diagnosis | null;
  /**
   * Candidate actions in preference order.
   *
   * Must never be empty: an empty list leaves the engine with nothing to record,
   * which is a silent gap rather than a visible decision.
   */
  readonly candidates: readonly Action[];
}

export interface Strategy {
  /** Short identifier used in filenames and report columns. */
  readonly name: string;
  /** One line for the report header, so a reader knows what they are comparing. */
  readonly description: string;
  propose(input: StrategyInput): StrategyProposal | Promise<StrategyProposal>;
}

/** Convenience for building an action without repeating the shape. */
export function action(
  kind: Action['kind'],
  rationale: string,
  scheduledFor?: Millis,
): Action {
  return scheduledFor === undefined
    ? { kind, rationale }
    : { kind, scheduledFor, rationale };
}
