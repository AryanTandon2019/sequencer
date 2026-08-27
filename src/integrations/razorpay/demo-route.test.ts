import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

type PostHandler = (request: Request) => Promise<Response>;

// Keep the core tsconfig independent of Next's @/ path alias while still loading
// the real App Router handler at runtime under tsx.
const demoRoutePath: string = '../../../app/api/demo/adjudicate/route.js';
const { POST } = (await import(demoRoutePath)) as { readonly POST: PostHandler };

const CREATED_AT_SECONDS = 1_788_582_600;

function paymentFailureBody(): string {
  return JSON.stringify({
    event: 'payment.failed',
    created_at: CREATED_AT_SECONDS,
    payload: {
      payment: {
        entity: {
          id: 'pay_demo_cap',
          customer_id: 'cust_demo_cap',
          subscription_id: 'sub_demo_cap',
          amount: 149_900,
          method: 'card',
          created_at: CREATED_AT_SECONDS,
          error_code: 'BAD_REQUEST_ERROR',
          error_description: 'The provider did not supply a specific decline cause.',
          error_source: 'bank',
          error_step: 'payment_authorization',
          error_reason: 'payment_failed',
        },
      },
    },
  });
}

async function adjudicate(url: string): Promise<Record<string, unknown>> {
  const response = await POST(
    new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: paymentFailureBody(),
    }),
  );
  assert.equal(response.status, 200);
  return (await response.json()) as Record<string, unknown>;
}

describe('demo adjudication route merchant context', () => {
  it('applies an authorised cap supplied outside the Razorpay envelope', async () => {
    const result = await adjudicate(
      'http://localhost/api/demo/adjudicate?mandateCapPaise=99900',
    );

    assert.equal(result.accepted, true);
    assert.equal(result.status, 'decided');
    assert.equal(result.amountPaise, 149_900);
    assert.equal(result.enforcementCause, 'AMOUNT_EXCEEDS_MANDATE');
  });

  it('does not invent the consent boundary when demo context is omitted', async () => {
    const result = await adjudicate('http://localhost/api/demo/adjudicate');
    assert.notEqual(result.enforcementCause, 'AMOUNT_EXCEEDS_MANDATE');
  });

  it('rejects malformed merchant cap context before deliberation', async () => {
    const response = await POST(
      new Request('http://localhost/api/demo/adjudicate?mandateCapPaise=not-a-number', {
        method: 'POST',
        body: paymentFailureBody(),
      }),
    );
    assert.equal(response.status, 400);
  });
});
