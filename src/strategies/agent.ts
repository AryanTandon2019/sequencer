/**
 * The agent: diagnose the cause, then allocate a scarce attempt budget accordingly.
 *
 * The whole strategy is three steps, and none of them is clever:
 *
 *   1. Ask a diagnoser what is wrong.
 *   2. Look up whether an attempt can possibly succeed for that cause.
 *   3. Propose the action that follows.
 *
 * Step 2 is a table and step 3 is a rule. The only judgement in the system sits in
 * step 1, and even there most cases are resolved by lookup. That is deliberate: a
 * rule a reviewer can read beats a model that usually agrees with it.
 *
 * The diagnoser is injected rather than hardcoded, so the same policy can be run
 * with deterministic classification only, with a model layer added, or with perfect
 * knowledge. Holding the policy fixed across all three is what separates diagnosis
 * error from policy error in the results.
 */

import { proposeActions } from '../domain/policy.js';
import type { Diagnoser } from '../diagnosis/deterministic.js';
import { action, type Strategy, type StrategyInput, type StrategyProposal } from './strategy.js';

export interface AgentOptions {
  readonly name?: string;
  readonly description?: string;
}

export function createAgentStrategy(diagnose: Diagnoser, options: AgentOptions = {}): Strategy {
  return {
    name: options.name ?? 'agent',
    description:
      options.description ??
      'Reason-aware: diagnoses the cause, then spends attempts only where one can succeed.',

    async propose(input: StrategyInput): Promise<StrategyProposal> {
      const diagnosis = await diagnose(input);

      // A null diagnosis is passed straight through rather than handled here.
      //
      // The policy owns every branch, including the one where no cause was determined,
      // because some of those cases are still actionable — a customer who has just
      // replaced their card is retryable whether or not the stale failure reason is
      // still classifiable. An earlier version escalated here instead, and silently
      // lost every case whose blocker had just been cleared.
      return {
        diagnosis,
        candidates: proposeActions({
          sub: input.sub,
          mandateState: input.mandateState,
          diagnosis,
          now: input.now,
        }),
      };
    },
  };
}
