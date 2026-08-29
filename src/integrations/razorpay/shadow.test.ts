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

  it('produces and commits a shadow decision with matching context', async () => {
    const idempotency = new TestModeEventWindow();
    const event = paymentFailure();
    const result = await processRazorpayShadowEvent({
      event,
      idempotency,
      projection: projection(),
    });
    const duplicate = await processRazorpayShadowEvent({
      event,
      idempotency,
      projection: projection(),
    });

    assert.equal(result.status, 'decided');
    if (result.status === 'decided') {
      assert.equal(result.decision.mode, 'shadow');
      assert.equal(result.attemptsUsed, 1);
      assert.equal(result.decision.wouldExecute?.kind, 'RETRY_SCHEDULED');
    }
    assert.equal(duplicate.status, 'duplicate');
  });

  it('quarantines a provider event that does not match the projected subscription', async () => {
    const result = await processRazorpayShadowEvent({
      event: paymentFailure(),
      idempotency: new TestModeEventWindow(),
      projection: projection({ amountPaise: 50_000 }),
    });
    assert.equal(result.status, 'needs_context');
  });

  it('commits every normal non-payment event outcome', async () => {
    const cases: readonly {
      readonly event: NormalizedRazorpayEvent;
      readonly expected: 'ignored' | 'needs_context';
    }[] = [
      {
        event: {
          kind: 'unsupported',
          eventKey: 'event_unsupported',
          occurredAt: NOW,
          providerEvent: 'payment.captured',
          reason: 'unsupported event',
        },
        expected: 'ignored',
      },
      {
        event: {
          kind: 'incomplete',
          eventKey: 'event_incomplete',
          occurredAt: NOW,
          providerEvent: 'payment.failed',
          reason: 'missing recurring payment context',
        },
        expected: 'ignored',
      },
      {
        event: {
          kind: 'subscription_pending',
          eventKey: 'event_subscription_pending',
          occurredAt: NOW,
          subscriptionId: 'sub_shadow_001',
          customerId: 'cust_shadow_001',
          providerStatus: 'pending',
        },
        expected: 'needs_context',
      },
    ];

    for (const testCase of cases) {
      const idempotency = new TestModeEventWindow();
      const first = await processRazorpayShadowEvent({
        event: testCase.event,
        idempotency,
      });
      const second = await processRazorpayShadowEvent({
        event: testCase.event,
        idempotency,
      });
      assert.equal(first.status, testCase.expected);
      assert.equal(second.status, 'duplicate');
    }
  });

  it('releases a failed event reservation so delivery can be retried', async () => {
    const idempotency = new TestModeEventWindow();
    const event = paymentFailure('event_retryable');
    const validProjection = projection();
    const brokenProjection: ShadowProjection = {
      ...validProjection,
      subBeforeFailure: {
        ...validProjection.subBeforeFailure,
        get attempts(): never {
          throw new Error('projection read failed');
        },
      },
    };

    await assert.rejects(
      processRazorpayShadowEvent({ event, idempotency, projection: brokenProjection }),
      /projection read failed/,
    );

    const retried = await processRazorpayShadowEvent({
      event,
      idempotency,
      projection: validProjection,
    });
    assert.equal(retried.status, 'decided');
  });

  it('does not acknowledge a delivery while another owner is still processing it', async () => {
    const idempotency = new TestModeEventWindow();
    const event = paymentFailure('event_in_progress');
    assert.equal(idempotency.claim(event.eventKey), true);

    const concurrent = await processRazorpayShadowEvent({
      event,
      idempotency,
      projection: projection(),
    });
    assert.equal(concurrent.status, 'in_progress');

    idempotency.release(event.eventKey);
    const retried = await processRazorpayShadowEvent({
      event,
      idempotency,
      projection: projection(),
    });
    assert.equal(retried.status, 'decided');
  });

  it('reserves, commits and releases event keys explicitly', () => {
    const window = new TestModeEventWindow();
    assert.equal(window.claim('released'), true);
    assert.equal(window.isPending('released'), true);
    window.release('released');
    assert.equal(window.isPending('released'), false);
    assert.equal(window.claim('released'), true);
    window.commit('released');
    assert.equal(window.isPending('released'), false);
    assert.equal(window.claim('released'), false);
  });

  it('bounds the process-local Test Mode idempotency window', () => {
    const window = new TestModeEventWindow(2);
    for (const key of ['a', 'b', 'c']) {
      assert.equal(window.claim(key), true);
      window.commit(key);
    }
    assert.equal(window.claim('a'), true);
    window.commit('a');
  });
});
