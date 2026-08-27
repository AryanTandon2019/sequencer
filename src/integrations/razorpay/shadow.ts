import { deliberateFailure, type ShadowDeliberation } from '../../application/deliberate-failure.js';
import { deterministicDiagnoser } from '../../diagnosis/deterministic.js';
import type { MandateState, ObservableSubscription, PaymentMethod } from '../../domain/types.js';
import { createAgentStrategy } from '../../strategies/agent.js';
import { TestModeEventWindow, type NormalizedRazorpayEvent } from './webhook.js';

const deterministicShadowStrategy = createAgentStrategy(deterministicDiagnoser, {
  name: 'razorpay-test-shadow',
  description: 'Test Mode only: proposes and adjudicates actions without executing them.',
});

/**
 * Complete merchant-owned state immediately before this failure arrived.
 * A webhook cannot supply these consent, history and contact fields by itself.
 */
export interface ShadowProjection {
  readonly subBeforeFailure: ObservableSubscription;
  readonly mandateState: MandateState;
}

export type ShadowProcessingResult =
  | { readonly status: 'duplicate'; readonly mode: 'shadow' }
  | {
      readonly status: 'in_progress';
      readonly mode: 'shadow';
      readonly reason: string;
    }
  | { readonly status: 'ignored'; readonly mode: 'shadow'; readonly reason: string }
  | { readonly status: 'needs_context'; readonly mode: 'shadow'; readonly reason: string }
  | {
      readonly status: 'decided';
      readonly mode: 'shadow';
      readonly decision: ShadowDeliberation;
      readonly attemptsUsed: number;
    };

export type ClaimedProcessingResult = Exclude<
  ShadowProcessingResult,
  { readonly status: 'duplicate' | 'in_progress' }
>;

function methodMatches(providerMethod: string, projected: PaymentMethod): boolean {
  if (providerMethod === 'card') return projected === 'card';
  if (providerMethod === 'upi') return projected === 'upi_autopay';
  if (providerMethod === 'emandate' || providerMethod === 'netbanking') {
    return projected === 'emandate';
  }
  return false;
}

export async function processRazorpayEventWithoutIdempotency(options: {
  readonly event: NormalizedRazorpayEvent;
  readonly projection?: ShadowProjection | undefined;
}): Promise<ClaimedProcessingResult> {
  const { event, projection } = options;

  if (event.kind === 'unsupported' || event.kind === 'incomplete') {
    return { status: 'ignored', mode: 'shadow', reason: event.reason };
  }
  if (event.kind === 'subscription_pending') {
    return {
      status: 'needs_context',
      mode: 'shadow',
      reason: 'subscription state accepted; a durable merchant projection is required before deliberation',
    };
  }
  if (projection === undefined) {
    return {
      status: 'needs_context',
      mode: 'shadow',
      reason: 'signed failure accepted; consent, attempt, notice and billing context are still required',
    };
  }

  const before = projection.subBeforeFailure;
  if (
    before.id !== event.subscriptionId ||
    before.amountPaise !== event.amountPaise ||
    (event.customerId !== null && before.customerId !== event.customerId) ||
    !methodMatches(event.providerMethod, before.method)
  ) {
    return {
      status: 'needs_context',
      mode: 'shadow',
      reason: 'provider event does not match the projected subscription state',
    };
  }

  const sub: ObservableSubscription = {
    ...before,
    state: 'pending',
    attempts: [
      ...before.attempts,
      {
        sequenceNo: before.attempts.length + 1,
        at: event.failure.at,
        outcome: 'failure',
        failure: event.failure,
      },
    ],
  };
  const decision = await deliberateFailure(
    {
      sub,
      mandateState: projection.mandateState,
      failure: event.failure,
      now: event.occurredAt,
    },
    deterministicShadowStrategy,
  );

  return { status: 'decided', mode: 'shadow', decision, attemptsUsed: sub.attempts.length };
}

export async function processRazorpayShadowEvent(options: {
  readonly event: NormalizedRazorpayEvent;
  readonly idempotency: TestModeEventWindow;
  readonly projection?: ShadowProjection | undefined;
}): Promise<ShadowProcessingResult> {
  const { event, idempotency, projection } = options;
  if (!idempotency.claim(event.eventKey)) {
    return idempotency.isPending(event.eventKey)
      ? {
          status: 'in_progress',
          mode: 'shadow',
          reason: 'another delivery of this event is still being processed',
        }
      : { status: 'duplicate', mode: 'shadow' };
  }

  try {
    const result = await processRazorpayEventWithoutIdempotency({ event, projection });
    idempotency.commit(event.eventKey);
    return result;
  } catch (error) {
    idempotency.release(event.eventKey);
    throw error;
  }
}
