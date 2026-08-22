import {
  MAX_RAZORPAY_WEBHOOK_BYTES,
  normalizeRazorpayEvent,
  parseRazorpayWebhook,
  razorpayBodyDigest,
  TestModeEventWindow,
  verifyRazorpayWebhookSignature,
} from '@/src/integrations/razorpay/webhook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const testModeEvents = new TestModeEventWindow();

function connectionStatus() {
  const mode = process.env.RAZORPAY_MODE === 'test' ? 'test' : 'disabled';
  return {
    provider: 'razorpay',
    mode,
    shadowOnly: true,
    apiCredentialsConfigured: Boolean(
      process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET,
    ),
    webhookSecretConfigured: Boolean(process.env.RAZORPAY_WEBHOOK_SECRET),
    idempotency: 'process-local-test-window',
  } as const;
}

export function GET() {
  return Response.json(connectionStatus(), {
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function POST(request: Request) {
  if (process.env.RAZORPAY_MODE !== 'test') {
    return Response.json(
      { accepted: false, error: 'Razorpay connector is disabled' },
      { status: 503 },
    );
  }

  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (secret === undefined || secret.length === 0) {
    return Response.json(
      { accepted: false, error: 'Razorpay webhook is not configured' },
      { status: 503 },
    );
  }

  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const bytes = Number(contentLength);
    if (!Number.isFinite(bytes) || bytes < 0 || bytes > MAX_RAZORPAY_WEBHOOK_BYTES) {
      return Response.json(
        { accepted: false, error: 'Webhook body is too large' },
        { status: 413 },
      );
    }
  }

  const rawBody = new Uint8Array(await request.arrayBuffer());
  if (rawBody.byteLength > MAX_RAZORPAY_WEBHOOK_BYTES) {
    return Response.json(
      { accepted: false, error: 'Webhook body is too large' },
      { status: 413 },
    );
  }

  const signature = request.headers.get('x-razorpay-signature') ?? '';
  if (!verifyRazorpayWebhookSignature(rawBody, signature, secret)) {
    return Response.json(
      { accepted: false, error: 'Invalid webhook signature' },
      { status: 401 },
    );
  }

  const parsed = parseRazorpayWebhook(rawBody);
  if (!parsed.ok) {
    return Response.json(
      { accepted: false, error: parsed.reason },
      { status: 400 },
    );
  }

  const eventKey =
    request.headers.get('x-razorpay-event-id') ?? `sha256:${razorpayBodyDigest(rawBody)}`;
  const event = normalizeRazorpayEvent(parsed.envelope, eventKey);
  const result = !testModeEvents.claim(event.eventKey)
    ? { status: 'duplicate' as const, mode: 'shadow' as const }
    : event.kind === 'unsupported' || event.kind === 'incomplete'
      ? { status: 'ignored' as const, mode: 'shadow' as const, reason: event.reason }
      : {
          status: 'needs_context' as const,
          mode: 'shadow' as const,
          reason:
            event.kind === 'subscription_pending'
              ? 'subscription state accepted; a durable merchant projection is required before deliberation'
              : 'signed failure accepted; consent, attempt, notice and billing context are still required',
        };

  return Response.json(
    {
      accepted: true,
      provider: 'razorpay',
      providerEvent: parsed.envelope.event,
      ...result,
    },
    {
      status: result.status === 'needs_context' ? 202 : 200,
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}
