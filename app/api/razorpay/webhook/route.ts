import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { deriveDurableEventKey, type QueuedActionSummary } from "@/src/application/test-mode-action-queue";
import {
  assertNonProductionDatabase,
  assertNonProductionTestMode,
} from "@/src/application/test-mode-runtime";
import { getPostgresTestModeStore } from "@/src/infrastructure/postgres-test-mode-store";
import { processDurableRazorpayEvent } from "@/src/integrations/razorpay/durable-shadow";
import { buildDemoProjection } from "@/src/integrations/razorpay/projection";
import { getRazorpayConnectorStatus } from "@/src/integrations/razorpay/status";
import {
  MAX_RAZORPAY_WEBHOOK_BYTES,
  normalizeRazorpayEvent,
  parseRazorpayWebhook,
  razorpayBodyDigest,
  verifyRazorpayWebhookSignature,
} from "@/src/integrations/razorpay/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function connectionStatus() {
  const status = getRazorpayConnectorStatus();
  return {
    provider: "razorpay",
    ...status,
    shadowOnly: true,
    execution: status.mockRunnerConfigured ? "durable-mock-only" : "disabled",
    idempotency: status.signedWebhookConfigured
      ? "durable-postgres-event-receipt"
      : "disabled",
  } as const;
}

export function GET() {
  return Response.json(connectionStatus(), {
    headers: { "Cache-Control": "no-store" },
  });
}

/** Best-effort fixture capture after signature verification. */
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

function publicQueuedAction(action: QueuedActionSummary | null) {
  return action === null
    ? null
    : {
        id: action.actionKey,
        status: action.status,
        dueAt: new Date(action.dueAt).toISOString(),
      };
}

export async function POST(request: Request) {
  try {
    assertNonProductionTestMode();
  } catch {
    return Response.json(
      { accepted: false, error: "Razorpay connector is disabled in production" },
      { status: 503 },
    );
  }

  if (process.env.RAZORPAY_MODE !== "test") {
    return Response.json(
      { accepted: false, error: "Razorpay connector is disabled" },
      { status: 503 },
    );
  }

  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (secret === undefined || secret.trim().length === 0) {
    return Response.json(
      { accepted: false, error: "Razorpay webhook is not configured" },
      { status: 503 },
    );
  }

  try {
    assertNonProductionDatabase();
  } catch {
    return Response.json(
      { accepted: false, error: "Non-production Test Mode database is not confirmed" },
      { status: 503 },
    );
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const bytes = Number(contentLength);
    if (!Number.isFinite(bytes) || bytes < 0 || bytes > MAX_RAZORPAY_WEBHOOK_BYTES) {
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

  const bodySha256 = razorpayBodyDigest(rawBody);
  const rawProviderEventId = request.headers.get("x-razorpay-event-id");
  const providerEventId =
    rawProviderEventId === null || rawProviderEventId.trim().length === 0
      ? null
      : rawProviderEventId.trim();
  let eventKey: string;
  try {
    eventKey = deriveDurableEventKey({ providerEventId, bodySha256 });
  } catch {
    return Response.json(
      { accepted: false, error: "Invalid Razorpay event identifier" },
      { status: 400 },
    );
  }

  const event = normalizeRazorpayEvent(parsed.envelope, eventKey);
  if (event.kind === "payment_failure") captureVerifiedBody(rawBody, bodySha256);

  let store;
  try {
    store = getPostgresTestModeStore();
  } catch {
    return Response.json(
      { accepted: false, error: "Durable Test Mode queue is not configured" },
      { status: 503 },
    );
  }

  let result: Awaited<ReturnType<typeof processDurableRazorpayEvent>>;
  try {
    result = await processDurableRazorpayEvent({
      event,
      projection: event.kind === "payment_failure" ? buildDemoProjection(event) : undefined,
      providerEventId,
      providerEvent: parsed.envelope.event,
      bodySha256,
      store,
    });
  } catch {
    return Response.json(
      {
        accepted: false,
        durable: true,
        provider: "razorpay",
        providerEvent: parsed.envelope.event,
        status: "failed",
      },
      {
        status: 503,
        headers: { "Cache-Control": "no-store", "Retry-After": "5" },
      },
    );
  }

  if (result.status === "conflict") {
    return Response.json(
      {
        accepted: false,
        durable: true,
        status: "idempotency_conflict",
        error: "Provider event id was previously received with a different body",
      },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (result.status === "in_progress" || result.status === "failed") {
    return Response.json(
      {
        accepted: false,
        durable: true,
        provider: "razorpay",
        providerEvent: parsed.envelope.event,
        status: result.status,
        retryAt:
          result.status === "in_progress" && result.retryAt !== null
            ? new Date(result.retryAt).toISOString()
            : null,
      },
      {
        status: 503,
        headers: { "Cache-Control": "no-store", "Retry-After": "5" },
      },
    );
  }

  if (result.status === "duplicate") {
    return Response.json(
      {
        accepted: true,
        durable: true,
        duplicate: true,
        provider: "razorpay",
        providerEvent: parsed.envelope.event,
        status: result.eventStatus,
        queuedAction: publicQueuedAction(result.queuedAction),
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (result.status === "decided") {
    const { decision } = result;
    return Response.json(
      {
        accepted: true,
        durable: true,
        duplicate: false,
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
          rejections: ruling.rejections.map((rejection) => ({
            rule: rejection.rule,
            detail: rejection.detail,
          })),
        })),
        wouldExecute: decision.wouldExecute?.kind ?? null,
        queuedAction: publicQueuedAction(result.queuedAction),
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }

  return Response.json(
    {
      accepted: true,
      durable: true,
      duplicate: false,
      provider: "razorpay",
      providerEvent: parsed.envelope.event,
      status: result.status,
      reason: result.reason,
      queuedAction: null,
    },
    {
      status: result.status === "needs_context" ? 202 : 200,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
