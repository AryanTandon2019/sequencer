import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { MandateState, Millis, ObservableSubscription } from '../../domain/types.js';
import {
  processRazorpayShadowEvent,
  type ShadowProjection,
} from './shadow.js';
import { TestModeEventWindow, type NormalizedRazorpayEvent } from './webhook.js';

const NOW: Millis = Date.UTC(2026, 7, 20, 2, 30);
const DAY: Millis = 24 * 60 * 60 * 1000;

function paymentFailure(eventKey = 'event_shadow_001'): NormalizedRazorpayEvent {
  return {
    kind: 'payment_failure',
    eventKey,
    occurredAt: NOW,
    paymentId: 'pay_shadow_001',
    subscriptionId: 'sub_shadow_001',
    customerId: 'cust_shadow_001',
    amountPaise: 49_900,
    providerMethod: 'card',
    failure: {
      code: 'BAD_REQUEST_ERROR',
      reason: 'insufficient_funds',
      source: 'bank',
      step: 'payment_authorization',
      description: 'Payment failed because the account had insufficient funds.',
      at: NOW,
    },
  };
}

function projection(overrides: Partial<ObservableSubscription> = {}): ShadowProjection {
  const subBeforeFailure: ObservableSubscription = {
    id: 'sub_shadow_001',
    customerId: 'cust_shadow_001',
    method: 'card',
    amountPaise: 49_900,
    chargeDate: NOW,
    state: 'active',
    attempts: [],
    contacts: [],
    lastPreDebitNotificationAt: NOW - 2 * DAY,
    history: {
      cyclesBilled: 6,
      cyclesPaidFirstAttempt: 5,
      cyclesRecoveredAfterRetry: 1,
      cyclesFailed: 0,
    },
    ...overrides,
  };
  const mandateState: MandateState = {
    authorisation: 'active',
    capPaise: 99_900,
    higherAfaCeiling: false,
  };
  return { subBeforeFailure, mandateState };
}

describe('Razorpay Test Mode shadow processing', () => {
  it('deduplicates the same provider event id', async () => {
    const idempotency = new TestModeEventWindow();
    const event = paymentFailure();

    const first = await processRazorpayShadowEvent({ event, idempotency });
    const second = await processRazorpayShadowEvent({ event, idempotency });

    assert.equal(first.status, 'needs_context');
    assert.equal(second.status, 'duplicate');
  });

  it('requires merchant-owned context instead of inventing consent or history', async () => {
    const result = await processRazorpayShadowEvent({
      event: paymentFailure(),
      idempotency: new TestModeEventWindow(),
    });
    assert.equal(result.status, 'needs_context');
  });

  it('produces a shadow decision when a complete matching projection is supplied', async () => {
    const result = await processRazorpayShadowEvent({
      event: paymentFailure(),
      idempotency: new TestModeEventWindow(),
      projection: projection(),
    });

    assert.equal(result.status, 'decided');
    if (result.status === 'decided') {
      assert.equal(result.decision.mode, 'shadow');
      assert.equal(result.decision.wouldExecute?.kind, 'RETRY_SCHEDULED');
    }
  });

  it('quarantines a provider event that does not match the projected subscription', async () => {
    const result = await processRazorpayShadowEvent({
      event: paymentFailure(),
      idempotency: new TestModeEventWindow(),
      projection: projection({ amountPaise: 50_000 }),
    });
    assert.equal(result.status, 'needs_context');
  });

  it('bounds the process-local Test Mode idempotency window', () => {
    const window = new TestModeEventWindow(2);
    assert.equal(window.claim('a'), true);
    assert.equal(window.claim('b'), true);
    assert.equal(window.claim('c'), true);
    assert.equal(window.claim('a'), true);
  });
});
