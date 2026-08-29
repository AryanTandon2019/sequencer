import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ObservedFailure } from '../../domain/types.js';
import { providerMethodToInternal, buildDemoProjection } from './projection.js';
import { processRazorpayShadowEvent } from './shadow.js';
import { TestModeEventWindow } from './webhook.js';

const AT = Date.UTC(2026, 8, 5, 4, 30);

function failure(reason: string): ObservedFailure {
  return {
    code: 'BAD_REQUEST_ERROR',
    reason,
    source: 'bank',
    step: 'payment_authorization',
    description: 'projection fixture',
    at: AT,
  };
}

function failureEvent(reason: string, providerMethod = 'card') {
  return {
    kind: 'payment_failure' as const,
    eventKey: 'test:event-1',
    occurredAt: AT,
    paymentId: 'pay_test_1',
    subscriptionId: 'sub_test_1',
    customerId: 'cust_test_1',
    amountPaise: 499_00,
    providerMethod,
    failure: failure(reason),
  };
}

describe('demo projection', () => {
  it('maps provider method names onto internal methods', () => {
    assert.equal(providerMethodToInternal('card'), 'card');
    assert.equal(providerMethodToInternal('upi'), 'upi_autopay');
    assert.equal(providerMethodToInternal('emandate'), 'emandate');
    assert.equal(providerMethodToInternal('netbanking'), 'emandate');
    assert.equal(providerMethodToInternal('wallet'), null);
  });

  it('records pre-event state and nothing the webhook does not carry', () => {
    const { subBeforeFailure, mandateState } = buildDemoProjection(failureEvent('card_expired'));

    assert.equal(subBeforeFailure.id, 'sub_test_1');
    assert.equal(subBeforeFailure.state, 'active');
    assert.equal(subBeforeFailure.attempts.length, 0);
    // The webhook says nothing about notices, contacts or history; the projection
    // must not invent them.
    assert.equal(subBeforeFailure.lastPreDebitNotificationAt, undefined);
    assert.equal(subBeforeFailure.contacts.length, 0);
    assert.equal(subBeforeFailure.history.cyclesBilled, 0);
    assert.equal(mandateState.authorisation, 'active');
    assert.ok(mandateState.capPaise >= subBeforeFailure.amountPaise);
  });

  it('lets one live-shaped failure reach adjudication as exactly one attempt', async () => {
    // The property the HTTP route depends on: a signed failure plus this
    // projection produces one applied provider event and a complete deliberation.
    const event = failureEvent('insufficient_funds');
    const result = await processRazorpayShadowEvent({
      event,
      idempotency: new TestModeEventWindow(),
      projection: buildDemoProjection(event),
    });

    assert.equal(result.status, 'decided');
    if (result.status !== 'decided') return;
    assert.equal(result.attemptsUsed, 1);
    assert.ok(result.decision.rulings.length >= 2);
    const debit = result.decision.rulings[0];
    // Unknown funding day -> the retry lands three days after the failure.
    assert.equal(debit?.action.kind, 'RETRY_SCHEDULED');
    assert.ok(
      debit?.rejections.some((r) => r.rule === 'RBI_PRE_DEBIT_NOTIFICATION'),
      'a debit whose notice would not have matured must be refused citing the RBI rule',
    );
    assert.equal(result.decision.wouldExecute?.kind, 'ESCALATE_TO_MERCHANT');
  });

  it('keeps an explicit demo mandate cap separate from the provider payload', async () => {
    const event = failureEvent('payment_failed');
    const projection = buildDemoProjection(event, { mandateCapPaise: 10_000 });
    assert.equal(projection.mandateState.capPaise, 10_000);

    const result = await processRazorpayShadowEvent({
      event,
      idempotency: new TestModeEventWindow(),
      projection,
    });
    assert.equal(result.status, 'decided');
    if (result.status !== 'decided') return;
    assert.equal(result.decision.enforcementCause, 'AMOUNT_EXCEEDS_MANDATE');
  });
});
