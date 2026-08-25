import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  MAX_RAZORPAY_WEBHOOK_BYTES,
  normalizeRazorpayEvent,
  parseRazorpayWebhook,
  razorpayBodyDigest,
  TestModeEventWindow,
  verifyRazorpayWebhookSignature,
} from "@/src/integrations/razorpay/webhook";
import { buildDemoProjection } from "@/src/integrations/razorpay/projection";
import { processRazorpayShadowEvent } from "@/src/integrations/razorpay/shadow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const testModeEvents = new TestModeEventWindow();

function connectionStatus() {
  const mode = process.env.RAZORPAY_MODE === "test" ? "test" : "disabled";
  return {
    provider: "razorpay",
    mode,
    shadowOnly: true,
    apiCredentialsConfigured: Boolean(
      process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET,
    ),
    webhookSecretConfigured: Boolean(process.env.RAZORPAY_WEBHOOK_SECRET),
    idempotency: "process-local-test-window",
  } as const;
}

export function GET() {
  return Response.json(connectionStatus(), {
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Persist a verified payload when RAZORPAY_CAPTURE_DIR is set.
 *
 * Capture is opt-in because a webhook endpoint's job is to answer, not to keep
 * data. Setting the variable turns the deployment into a shape-fidelity harness:
 * every signed body lands on disk exactly as received, which is what a fixture
 * needs to be. Best-effort — a capture failure must never fail the webhook.
 */
function captureVerifiedBody(rawBody: Uint8Array, digest: string): void {
  const dir = process.env.RAZORPAY_CAPTURE_DIR;
  if (dir === undefined || dir.length === 0) return;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${digest.slice(0, 16)}.json`), Buffer.from(rawBody));
  } catch {
    // Capturing must never break answering.
  }
}

export async function POST(request: Request) {
  if (process.env.RAZORPAY_MODE !== "test") {
    return Response.json(
      { accepted: false, error: "Razorpay connector is disabled" },
      { status: 503 },
    );
  }

  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (secret === undefined || secret.length === 0) {
    return Response.json(
      { accepted: false, error: "Razorpay webhook is not configured" },
      { status: 503 },
    );
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const bytes = Number(contentLength);
    if (
      !Number.isFinite(bytes) ||
      bytes < 0 ||
      bytes > MAX_RAZORPAY_WEBHOOK_BYTES
    ) {
      return Response.json(
        { accepted: false, error: "Webhook body is too large" },
        { status: 413 },
      );
    }
  }

  const rawBody = new Uint8Array(await request.arrayBuffer());
  if (rawBody.byteLength > MAX_RAZORPAY_WEBHOOK_BYTES) {
    return Response.json(
      { accepted: false, error: "Webhook body is too large" },
      { status: 413 },
    );
  }

  const signature = request.headers.get("x-razorpay-signature") ?? "";
  if (!verifyRazorpayWebhookSignature(rawBody, signature, secret)) {
    return Response.json(
      { accepted: false, error: "Invalid webhook signature" },
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
    request.headers.get("x-razorpay-event-id") ??
    `sha256:${razorpayBodyDigest(rawBody)}`;
  const event = normalizeRazorpayEvent(parsed.envelope, eventKey);

  if (event.kind !== "payment_failure") {
    const result =
      !testModeEvents.claim(event.eventKey)
        ? { status: "duplicate" as const, mode: "shadow" as const }
        : event.kind === "unsupported" || event.kind === "incomplete"
          ? {
              status: "ignored" as const,
              mode: "shadow" as const,
              reason: event.reason,
            }
          : {
              status: "needs_context" as const,
              mode: "shadow" as const,
              reason:
                "subscription state accepted; a durable merchant projection is required before deliberation",
            };
    return Response.json(
      { accepted: true, provider: "razorpay", providerEvent: parsed.envelope.event, ...result },
      { status: result.status === "needs_context" ? 202 : 200, headers: { "Cache-Control": "no-store" } },
    );
  }

  // A signed payment failure goes all the way through the same proposal ->
  // independent classification -> compliance adjudication path the simulator
  // uses. Still shadow-only: nothing here debits, contacts, or writes back.
  captureVerifiedBody(rawBody, razorpayBodyDigest(rawBody));

  const result = await processRazorpayShadowEvent({
    event,
    idempotency: testModeEvents,
    projection: buildDemoProjection(event),
  });

  if (result.status === "decided") {
    const { decision } = result;
    return Response.json(
      {
        accepted: true,
        provider: "razorpay",
        providerEvent: parsed.envelope.event,
        status: "decided",
        mode: "shadow",
        projection: "demo (webhook-only state; labelled assumptions apply)",
        diagnosis: decision.diagnosis,
        enforcementCause: decision.enforcementCause,
        rulings: decision.rulings.map((ruling) => ({
          action: ruling.action.kind,
          scheduledFor: ruling.action.scheduledFor ?? null,
          rejections: ruling.rejections.map((r) => ({ rule: r.rule, detail: r.detail })),
        })),
        wouldExecute: decision.wouldExecute?.kind ?? null,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }

  return Response.json(
    { accepted: true, provider: "razorpay", providerEvent: parsed.envelope.event, ...result },
    {
      status: result.status === "needs_context" ? 202 : 200,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
