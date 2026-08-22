import { adjudicate } from '../domain/compliance.js';
import { classify } from '../domain/taxonomy.js';
import type { Action, DeclineCause, Diagnosis, Millis, Ruling } from '../domain/types.js';
import type { Strategy, StrategyInput } from '../strategies/strategy.js';

/**
 * A complete policy deliberation that deliberately stops before execution.
 *
 * `wouldExecute` is not an action receipt. It is the first candidate that passed
 * every guardrail at this instant. Only an integration-specific executor may turn
 * it into an external side effect, and the Razorpay connector never imports one.
 */
export interface ShadowDeliberation {
  readonly mode: 'shadow';
  readonly subscriptionId: string;
  readonly at: Millis;
  readonly diagnosis: Diagnosis | null;
  readonly enforcementCause: DeclineCause | null;
  readonly rulings: readonly Ruling[];
  readonly wouldExecute: Action | null;
}

/**
 * Run the same proposal, independent classification and compliance adjudication
 * used by the simulator without touching a payment provider or synthetic world.
 */
export async function deliberateFailure(
  input: StrategyInput,
  strategy: Strategy,
): Promise<ShadowDeliberation> {
  const proposal = await strategy.propose(input);
  const classification = classify({
    failure: input.failure,
    mandateState: input.mandateState,
    amountPaise: input.sub.amountPaise,
  });
  const enforcementCause =
    classification.kind === 'resolved' ? classification.cause : null;
  const { rulings, executed } = adjudicate(proposal.candidates, {
    sub: input.sub,
    mandateState: input.mandateState,
    enforcementCause,
    agentConfidence: proposal.diagnosis?.confidence ?? null,
    now: input.now,
  });

  return {
    mode: 'shadow',
    subscriptionId: input.sub.id,
    at: input.now,
    diagnosis: proposal.diagnosis,
    enforcementCause,
    rulings,
    wouldExecute: executed,
  };
}
