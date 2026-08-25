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

  it('records what the webhook actually carries and nothing it does not', () => {
    const { subBeforeFailure, mandateState } = buildDemoProjection(failureEvent('card_expired'));

    assert.equal(subBeforeFailure.id, 'sub_test_1');
    assert.equal(subBeforeFailure.attempts.length, 1);
    assert.equal(subBeforeFailure.attempts[0]?.failure?.reason, 'card_expired');
    // The webhook says nothing about notices, contacts or history; the projection
    // must not invent them.
    assert.equal(subBeforeFailure.lastPreDebitNotificationAt, undefined);
    assert.equal(subBeforeFailure.contacts.length, 0);
    assert.equal(subBeforeFailure.history.cyclesBilled, 0);
    assert.equal(mandateState.authorisation, 'active');
    assert.ok(mandateState.capPaise >= subBeforeFailure.amountPaise);
  });

  it('lets a live-shaped failure reach full adjudication through the shadow processor', () => {
    // The property the HTTP route depends on: a signed failure plus this
    // projection produces a complete deliberation, including the refusal a
    // missing notice earns.
    const event = failureEvent('insufficient_funds');
    const promise = processRazorpayShadowEvent({
      event,
      idempotency: new TestModeEventWindow(),
      projection: buildDemoProjection(event),
    });
    return promise.then((result) => {
      assert.equal(result.status, 'decided');
      if (result.status !== 'decided') return;
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
  });
});
