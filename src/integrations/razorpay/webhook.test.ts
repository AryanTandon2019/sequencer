import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  MAX_RAZORPAY_WEBHOOK_BYTES,
  normalizeRazorpayEvent,
  parseRazorpayWebhook,
  verifyRazorpayWebhookSignature,
} from './webhook.js';

const SECRET = 'test-webhook-secret-never-used-outside-tests';

function paymentFailedPayload(overrides: Record<string, unknown> = {}) {
  return {
    event: 'payment.failed',
    created_at: 1_725_000_000,
    payload: {
      payment: {
        entity: {
          id: 'pay_test_001',
          customer_id: 'cust_test_001',
          subscription_id: 'sub_test_001',
          amount: 49_900,
          method: 'card',
          created_at: 1_725_000_000,
          error_code: 'BAD_REQUEST_ERROR',
          error_description: 'Payment failed because the account had insufficient funds.',
          error_source: 'customer',
          error_step: 'payment_authorization',
          error_reason: 'insufficient_funds',
          ...overrides,
        },
      },
    },
  };
}

function bytes(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value));
}

describe('Razorpay webhook signature verification', () => {
  it('accepts the HMAC of the exact raw body', () => {
    const body = bytes(paymentFailedPayload());
    const signature = createHmac('sha256', SECRET).update(body).digest('hex');
    assert.equal(verifyRazorpayWebhookSignature(body, signature, SECRET), true);
  });

  it('rejects a one-byte mutation, malformed signatures and an empty secret', () => {
    const body = bytes(paymentFailedPayload());
    const signature = createHmac('sha256', SECRET).update(body).digest('hex');
    const changed = Buffer.concat([body, Buffer.from(' ')]);

    assert.equal(verifyRazorpayWebhookSignature(changed, signature, SECRET), false);
    assert.equal(verifyRazorpayWebhookSignature(body, 'not-hex', SECRET), false);
    assert.equal(verifyRazorpayWebhookSignature(body, signature, ''), false);
  });
});

describe('Razorpay webhook parsing and normalization', () => {
  it('maps a recurring payment failure without changing paise or timestamps', () => {
    const parsed = parseRazorpayWebhook(bytes(paymentFailedPayload()));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;

    const event = normalizeRazorpayEvent(parsed.envelope, 'event_001');
    assert.equal(event.kind, 'payment_failure');
    if (event.kind !== 'payment_failure') return;

    assert.equal(event.subscriptionId, 'sub_test_001');
    assert.equal(event.amountPaise, 49_900);
    assert.equal(event.failure.reason, 'insufficient_funds');
    assert.equal(event.failure.at, 1_725_000_000_000);
  });

  it('maps subscription.pending as lifecycle context, not as a payment failure', () => {
    const body = bytes({
      event: 'subscription.pending',
      created_at: 1_725_000_100,
      payload: {
        subscription: {
          entity: {
            id: 'sub_test_001',
            customer_id: 'cust_test_001',
            status: 'pending',
          },
        },
      },
    });
    const parsed = parseRazorpayWebhook(body);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;

    const event = normalizeRazorpayEvent(parsed.envelope, 'event_002');
    assert.equal(event.kind, 'subscription_pending');
    if (event.kind === 'subscription_pending') {
      assert.equal(event.providerStatus, 'pending');
    }
  });

  it('quarantines missing error evidence instead of manufacturing a cause', () => {
    const parsed = parseRazorpayWebhook(
      bytes(paymentFailedPayload({ error_reason: null })),
    );
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;

    const event = normalizeRazorpayEvent(parsed.envelope, 'event_003');
    assert.equal(event.kind, 'incomplete');
  });

  it('ignores non-subscription payment failures', () => {
    const parsed = parseRazorpayWebhook(
      bytes(paymentFailedPayload({ subscription_id: null })),
    );
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;

    const event = normalizeRazorpayEvent(parsed.envelope, 'event_004');
    assert.equal(event.kind, 'unsupported');
  });

  it('rejects malformed JSON, unsupported envelopes and oversized bodies', () => {
    assert.equal(parseRazorpayWebhook(Buffer.from('{')).ok, false);
    assert.equal(parseRazorpayWebhook(bytes({ event: 'payment.failed' })).ok, false);
    assert.equal(
      parseRazorpayWebhook(new Uint8Array(MAX_RAZORPAY_WEBHOOK_BYTES + 1)).ok,
      false,
    );
  });
});
