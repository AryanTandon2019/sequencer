import type { MandateState, Millis, ObservableSubscription, PaymentMethod } from '../../domain/types.js';
import type { NormalizedRazorpayEvent } from './webhook.js';

/**
 * Merchant-owned state projected from a single webhook event.
 *
 * A webhook carries the failure and almost nothing else: no consent state, no
 * attempt history, no notice record, no billing past. Deliberation needs those,
 * which is why the shadow connector refuses to decide without a projection
 * rather than inventing one silently.
 *
 * This builder exists so there is a *visible*, labelled projection instead of an
 * invisible gap. It states exactly what it assumes, so a demo of a live event is
 * honest about the difference between what Razorpay sent and what we supplied.
 * A production deployment would replace this with durable merchant records.
 */

/** Payment method as Razorpay names it -> our internal method union. */
export function providerMethodToInternal(providerMethod: string): PaymentMethod | null {
  if (providerMethod === 'card') return 'card';
  if (providerMethod === 'upi') return 'upi_autopay';
  if (providerMethod === 'emandate' || providerMethod === 'netbanking') return 'emandate';
  return null;
}

export function buildDemoProjection(event: Extract<NormalizedRazorpayEvent, { kind: 'payment_failure' }>): {
  readonly subBeforeFailure: ObservableSubscription;
  readonly mandateState: MandateState;
} {
  const method = providerMethodToInternal(event.providerMethod);
  const at: Millis = event.failure.at;

  const subBeforeFailure: ObservableSubscription = {
    id: event.subscriptionId,
    customerId: event.customerId ?? 'cust_unprojected',
    method: method ?? 'card',
    amountPaise: event.amountPaise,
    chargeDate: at,
    // The failure just arrived; the cycle is pending recovery.
    state: 'pending',
    attempts: [
      { sequenceNo: 1, at, outcome: 'failure', failure: event.failure },
    ],
    contacts: [],
    // Unknown from the webhook. Left undefined on purpose: the compliance layer
    // will refuse any immediate debit citing the RBI notice rule, which is the
    // honest answer given what we actually know.
    lastPreDebitNotificationAt: undefined,
    history: {
      cyclesBilled: 0,
      cyclesPaidFirstAttempt: 0,
      cyclesRecoveredAfterRetry: 0,
      cyclesFailed: 0,
    },
  };

  const mandateState: MandateState = {
    authorisation: 'active',
    // No ceiling was delivered with the event. Headroom of 3 mirrors
    // MANDATE_CAP_HEADROOM in src/config.ts (kept inlined here so the connector
    // stays free of harness configuration); a real deployment reads the actual
    // mandate record instead.
    capPaise: Math.max(event.amountPaise * 3, 99_900),
    higherAfaCeiling: false,
  };

  return { subBeforeFailure, mandateState };
}
