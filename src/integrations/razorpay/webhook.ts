import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import type { Millis, ObservedFailure, Paise } from '../../domain/types.js';

export const MAX_RAZORPAY_WEBHOOK_BYTES = 256 * 1024;

/**
 * Bounded process-local deduplication for Test Mode demonstrations.
 * Live Mode requires a durable idempotency store before acknowledgement.
 */
export class TestModeEventWindow {
  readonly #keys = new Set<string>();
  readonly #order: string[] = [];

  constructor(readonly maxEntries = 1_000) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error('maxEntries must be a positive integer');
    }
  }

  claim(key: string): boolean {
    if (this.#keys.has(key)) return false;
    this.#keys.add(key);
    this.#order.push(key);

    if (this.#order.length > this.maxEntries) {
      const oldest = this.#order.shift();
      if (oldest !== undefined) this.#keys.delete(oldest);
    }
    return true;
  }
}

const SafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const NullableString = z.string().nullable().optional();

const PaymentEntitySchema = z
  .object({
    id: z.string().min(1),
    customer_id: NullableString,
    subscription_id: NullableString,
    amount: SafeInteger,
    method: z.string().min(1),
    created_at: SafeInteger,
    error_code: NullableString,
    error_description: NullableString,
    error_source: NullableString,
    error_step: NullableString,
    error_reason: NullableString,
  })
  .passthrough();

const SubscriptionEntitySchema = z
  .object({
    id: z.string().min(1),
    customer_id: NullableString,
    status: z.string().min(1),
    current_start: SafeInteger.nullable().optional(),
    current_end: SafeInteger.nullable().optional(),
    charge_at: SafeInteger.nullable().optional(),
  })
  .passthrough();

const RazorpayEnvelopeSchema = z
  .object({
    event: z.string().min(1),
    created_at: SafeInteger,
    payload: z
      .object({
        payment: z.object({ entity: PaymentEntitySchema }).optional(),
        subscription: z.object({ entity: SubscriptionEntitySchema }).optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type RazorpayEnvelope = z.infer<typeof RazorpayEnvelopeSchema>;

export type NormalizedRazorpayEvent =
  | {
      readonly kind: 'payment_failure';
      readonly eventKey: string;
      readonly occurredAt: Millis;
      readonly paymentId: string;
      readonly subscriptionId: string;
      readonly customerId: string | null;
      readonly amountPaise: Paise;
      readonly providerMethod: string;
      readonly failure: ObservedFailure;
    }
  | {
      readonly kind: 'subscription_pending';
      readonly eventKey: string;
      readonly occurredAt: Millis;
      readonly subscriptionId: string;
      readonly customerId: string | null;
      readonly providerStatus: string;
    }
  | {
      readonly kind: 'unsupported';
      readonly eventKey: string;
      readonly occurredAt: Millis;
      readonly providerEvent: string;
      readonly reason: string;
    }
  | {
      readonly kind: 'incomplete';
      readonly eventKey: string;
      readonly occurredAt: Millis;
      readonly providerEvent: string;
      readonly reason: string;
    };

export type RazorpayParseResult =
  | { readonly ok: true; readonly envelope: RazorpayEnvelope }
  | { readonly ok: false; readonly reason: string };

/** Verify the exact bytes received from Razorpay. Never parse before this step. */
export function verifyRazorpayWebhookSignature(
  rawBody: Uint8Array,
  signature: string,
  secret: string,
): boolean {
  if (secret.length === 0 || !/^[a-f\d]{64}$/i.test(signature)) return false;

  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const received = Buffer.from(signature, 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function razorpayBodyDigest(rawBody: Uint8Array): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

export function parseRazorpayWebhook(rawBody: Uint8Array): RazorpayParseResult {
  if (rawBody.byteLength === 0) return { ok: false, reason: 'empty request body' };
  if (rawBody.byteLength > MAX_RAZORPAY_WEBHOOK_BYTES) {
    return { ok: false, reason: 'request body exceeds the 256 KiB limit' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(rawBody).toString('utf8')) as unknown;
  } catch {
    return { ok: false, reason: 'request body is not valid JSON' };
  }

  const validated = RazorpayEnvelopeSchema.safeParse(parsed);
  if (!validated.success) return { ok: false, reason: 'unsupported Razorpay payload shape' };
  return { ok: true, envelope: validated.data };
}

function requiredErrorField(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value.trim().length === 0) return null;
  return value;
}

function secondsToMillis(seconds: number): Millis | null {
  const millis = seconds * 1000;
  return Number.isSafeInteger(millis) ? millis : null;
}

export function normalizeRazorpayEvent(
  envelope: RazorpayEnvelope,
  eventKey: string,
): NormalizedRazorpayEvent {
  const occurredAt = secondsToMillis(envelope.created_at);
  if (occurredAt === null) {
    return {
      kind: 'incomplete',
      eventKey,
      occurredAt: 0,
      providerEvent: envelope.event,
      reason: 'event timestamp is outside the supported range',
    };
  }

  if (envelope.event === 'payment.failed') {
    const payment = envelope.payload.payment?.entity;
    if (payment === undefined) {
      return {
        kind: 'incomplete',
        eventKey,
        occurredAt,
        providerEvent: envelope.event,
        reason: 'payment.failed did not include a payment entity',
      };
    }
    if (payment.subscription_id === undefined || payment.subscription_id === null) {
      return {
        kind: 'unsupported',
        eventKey,
        occurredAt,
        providerEvent: envelope.event,
        reason: 'payment is not associated with a recurring subscription',
      };
    }

    const code = requiredErrorField(payment.error_code);
    const description = requiredErrorField(payment.error_description);
    const source = requiredErrorField(payment.error_source);
    const step = requiredErrorField(payment.error_step);
    const reason = requiredErrorField(payment.error_reason);
    const failedAt = secondsToMillis(payment.created_at);
    if (
      code === null ||
      description === null ||
      source === null ||
      step === null ||
      reason === null ||
      failedAt === null
    ) {
      return {
        kind: 'incomplete',
        eventKey,
        occurredAt,
        providerEvent: envelope.event,
        reason: 'payment failure is missing required error evidence',
      };
    }

    return {
      kind: 'payment_failure',
      eventKey,
      occurredAt,
      paymentId: payment.id,
      subscriptionId: payment.subscription_id,
      customerId: payment.customer_id ?? null,
      amountPaise: payment.amount,
      providerMethod: payment.method,
      failure: { code, description, source, step, reason, at: failedAt },
    };
  }

  if (envelope.event === 'subscription.pending') {
    const subscription = envelope.payload.subscription?.entity;
    if (subscription === undefined) {
      return {
        kind: 'incomplete',
        eventKey,
        occurredAt,
        providerEvent: envelope.event,
        reason: 'subscription.pending did not include a subscription entity',
      };
    }

    return {
      kind: 'subscription_pending',
      eventKey,
      occurredAt,
      subscriptionId: subscription.id,
      customerId: subscription.customer_id ?? null,
      providerStatus: subscription.status,
    };
  }

  return {
    kind: 'unsupported',
    eventKey,
    occurredAt,
    providerEvent: envelope.event,
    reason: 'event is authenticated but is not used by the shadow connector',
  };
}
