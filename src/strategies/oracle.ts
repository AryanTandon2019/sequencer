/**
 * The oracle: perfect diagnosis, identical policy.
 *
 * THIS IS THE ONE FILE IN src/strategies/ PERMITTED TO IMPORT FROM src/sim/.
 *
 * It reads the hidden truth on purpose. Its job is not to compete but to establish
 * the ceiling, which does two things no other measurement can:
 *
 *   1. It converts a bare "68% recovered" - a number with no reference point - into
 *      "captured 68% of what was recoverable at all". Without a ceiling, a reader
 *      has no way to know whether the remaining 32% was a policy failure or simply
 *      money that was never collectable.
 *
 *   2. Because it shares the agent's policy and differs only in diagnosis, the gap
 *      between the two is attributable: oracle-minus-agent is diagnosis error, and
 *      ceiling-minus-oracle is the limit of the policy itself. A single combined
 *      number would hide which of the two to go and fix.
 *
 * The leakage test asserts that no other strategy imports from src/sim/, and names
 * this file as the sanctioned exception. Keeping the exception to one clearly
 * labelled file is what makes it verifiable rather than something a reader has to
 * take on trust.
 */

import { recoverabilityOf } from '../domain/causes.js';
import { proposeActions } from '../domain/policy.js';
import type { Diagnosis } from '../domain/types.js';
import type { HiddenState } from '../sim/personas.js';
import { action, type Strategy, type StrategyInput, type StrategyProposal } from './strategy.js';

export interface OracleSource {
  /** Hidden state by subscription id. */
  readonly hiddenBySubscriptionId: ReadonlyMap<string, HiddenState>;
}

/**
 * Build an oracle over a known cohort.
 *
 * Truth is supplied at construction rather than through `StrategyInput`, so the
 * shared strategy contract stays free of any hidden field. No other strategy could
 * read truth even if it wanted to, because there is nowhere on the input for it to
 * come from.
 */
export function createOracleStrategy(source: OracleSource): Strategy {
  return {
    name: 'oracle',
    description:
      'Perfect diagnosis with the same policy as the agent. Establishes the achievable ' +
      'ceiling; not a competitor.',

    propose(input: StrategyInput): StrategyProposal {
      const hidden = source.hiddenBySubscriptionId.get(input.sub.id);

      // A cohort mismatch would silently turn the ceiling into a guess, so it fails
      // loudly instead.
      if (hidden === undefined) {
        throw new Error(
          `oracle has no hidden state for ${input.sub.id}; ` +
            'the oracle must be constructed from the same cohort being run',
        );
      }

      const diagnosis: Diagnosis = {
        cause: hidden.trueCause,
        recoverability: recoverabilityOf(hidden.trueCause),
        confidence: 1,
        reasoning: `ground truth from persona ${hidden.personaId}`,
        source: 'oracle',
      };

      const candidates = proposeActions({
        sub: input.sub,
        mandateState: input.mandateState,
        diagnosis,
        now: input.now,
      });

      // Should be unreachable - the policy always returns something - but an empty
      // list would leave the engine with nothing to record, and a silent gap in the
      // ceiling is worse than a crash.
      if (candidates.length === 0) {
        return {
          diagnosis,
          candidates: [action('ESCALATE_TO_MERCHANT', 'policy produced no candidate')],
        };
      }

      return { diagnosis, candidates };
    },
  };
}
