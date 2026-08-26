import { buildDemoProjection } from "@/src/integrations/razorpay/projection";
import { processRazorpayShadowEvent } from "@/src/integrations/razorpay/shadow";
import {
  MAX_RAZORPAY_WEBHOOK_BYTES,
  normalizeRazorpayEvent,
  parseRazorpayWebhook,
  TestModeEventWindow,
} from "@/src/integrations/razorpay/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Adjudicate an arbitrary Razorpay-shaped envelope through the real pipeline.
 *
 * This is the playground twin of /api/razorpay/webhook, minus signature
 * verification: the webhook proves we accept what Razorpay sends; this endpoint
 * lets anyone feed a payload by hand and watch the same proposal ->
 * classification -> compliance path run. Shadow only, like everything here —
 * no action is ever executed, so there is nothing to authenticate against.
 */

export async function POST(request: Request) {
  let rawText: string;
  try {
    rawText = await request.text();
  } catch {
    return Response.json({ accepted: false, error: "unreadable request body" }, { status: 400 });
  }

  const rawBody = new Uint8Array(Buffer.from(rawText, "utf8"));
  if (rawBody.byteLength === 0) {
    return Response.json({ accepted: false, error: "empty body" }, { status: 400 });
  }
  if (rawBody.byteLength > MAX_RAZORPAY_WEBHOOK_BYTES) {
    return Response.json({ accepted: false, error: "body exceeds 256 KiB" }, { status: 413 });
  }

  const parsed = parseRazorpayWebhook(rawBody);
  if (!parsed.ok) {
    return Response.json({ accepted: false, error: parsed.reason }, { status: 400 });
  }

  const event = normalizeRazorpayEvent(parsed.envelope, `playground:${Date.now()}`);

  if (event.kind !== "payment_failure") {
    return Response.json(
      {
        accepted: false,
        error:
          event.kind === "unsupported" || event.kind === "incomplete"
            ? `not a usable payment failure (${event.reason})`
            : "this event kind carries no failure to deliberate",
      },
      { status: 422 },
    );
  }

  const result = await processRazorpayShadowEvent({
    event,
    idempotency: new TestModeEventWindow(),
    projection: buildDemoProjection(event),
  });

  if (result.status !== "decided") {
    return Response.json(
      { accepted: true, status: result.status, mode: "shadow", detail: result },
      { status: 200 },
    );
  }

  const { decision } = result;
  return Response.json(
    {
      accepted: true,
      status: "decided",
      mode: "shadow",
      projection: "demo (webhook-only state; labelled assumptions apply)",
      failure: event.failure,
      amountPaise: event.amountPaise,
      providerMethod: event.providerMethod,
      diagnosis: decision.diagnosis,
      enforcementCause: decision.enforcementCause,
      rulings: decision.rulings.map((ruling) => ({
        action: ruling.action.kind,
        scheduledFor: ruling.action.scheduledFor ?? null,
        rationale: ruling.action.rationale,
        rejections: ruling.rejections.map((r) => ({
          rule: r.rule,
          citation: r.citation,
          detail: r.detail,
        })),
      })),
      wouldExecute: decision.wouldExecute?.kind ?? null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
