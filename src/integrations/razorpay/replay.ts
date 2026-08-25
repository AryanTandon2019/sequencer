#!/usr/bin/env node
/**
 * Replay a captured Razorpay webhook through the full shadow pipeline.
 *
 *   npm run replay -- runs/inbound/<captured>.json
 *
 * Takes a payload exactly as Razorpay signed it, recomputes the HMAC the way
 * Razorpay would, verifies it, and runs the same proposal -> independent
 * classification -> compliance adjudication path the simulator uses — printing
 * every ruling. Read-only: nothing is executed against any provider.
 *
 * If you do not have a captured payload yet, point your webhook at a deployment
 * (or localhost) with RAZORPAY_CAPTURE_DIR set; verified bodies land there.
 */

import 'dotenv/config';

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { buildDemoProjection } from './projection.js';
import { processRazorpayShadowEvent } from './shadow.js';
import {
  parseRazorpayWebhook,
  normalizeRazorpayEvent,
  TestModeEventWindow,
  verifyRazorpayWebhookSignature,
} from './webhook.js';

/* Presentation-only maps for the terminal report. Kept local: src/ does not
   import from app/, and this script prints once for one reader. */
const CAUSE_LABEL: Readonly<Record<string, string>> = {
  INSUFFICIENT_FUNDS: 'Insufficient funds',
  BANK_UNAVAILABLE: 'Bank unavailable',
  LIMIT_EXCEEDED_TEMPORARY: 'Daily limit reached',
  CARD_EXPIRED: 'Card expired',
  INSTRUMENT_BLOCKED: 'Instrument blocked',
  INSTRUMENT_NOT_ENABLED: 'Not enabled online',
  ACCOUNT_MISMATCH: 'Account mismatch',
  VPA_INVALID: 'Invalid UPI handle',
  FRAUD_SUSPECTED: 'Fraud suspected',
  AMOUNT_EXCEEDS_MANDATE: 'Above mandate cap',
  AUTH_REQUIRED_AFA: 'Authentication required',
  MANDATE_REVOKED: 'Mandate revoked',
  MANDATE_PAUSED: 'Mandate paused',
  AMBIGUOUS_BANK_DECLINE: 'Unexplained decline',
};

const RECOVERABILITY_LABEL: Readonly<Record<string, string>> = {
  RETRY_VIABLE: 'retry can work',
  RETRY_FUTILE: 'retry can never work',
  RETRY_FORBIDDEN: 'retry is not permitted',
  WAIT: 'resolves on its own',
  NEEDS_HUMAN: 'needs a human',
};

const ACTION_LABEL: Readonly<Record<string, string>> = {
  RETRY_NOW: 'Retry now',
  RETRY_SCHEDULED: 'Schedule retry',
  REQUEST_CARD_UPDATE: 'Ask for a new card',
  REQUEST_MANDATE_REAUTH: 'Ask to re-authorise',
  REQUEST_AFA: 'Ask to authenticate',
  SEND_PRE_DEBIT_NOTIFICATION: 'Send 24h notice',
  WAIT: 'Wait',
  STOP: 'Stop',
  ESCALATE_TO_MERCHANT: 'Escalate to a human',
};

const RULE_LABEL: Readonly<Record<string, string>> = {
  NPCI_ATTEMPT_CAP: 'NPCI attempt cap',
  RBI_PRE_DEBIT_NOTIFICATION: 'RBI 24h notice',
  CARD_NETWORK_NO_HARD_DECLINE_RETRY: 'No hard-decline retry',
  NPCI_EXECUTION_WINDOW: 'Autopay window',
  MANDATE_CAP: 'Mandate ceiling',
  AFA_REQUIRED_ABOVE_CEILING: 'AFA required',
  REVOKED_CONSENT_NO_CONTACT: 'Revoked consent',
  CONFIDENCE_FLOOR: 'Confidence floor',
};

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

async function main(): Promise<number> {
  const file = process.argv[2];
  if (file === undefined || file.length === 0) {
    fail('usage: npm run replay -- <captured-payload.json>');
  }

  const secret = process.env['RAZORPAY_WEBHOOK_SECRET'];
  if (secret === undefined || secret.trim() === '') {
    fail('RAZORPAY_WEBHOOK_SECRET is not set; cannot recompute the signature');
  }

  const rawBody = new Uint8Array(readFileSync(file));
  const signature = createHmac('sha256', secret).update(rawBody).digest('hex');

  if (!verifyRazorpayWebhookSignature(rawBody, signature, secret)) {
    fail('signature check failed — this file was not signed by RAZORPAY_WEBHOOK_SECRET');
  }
  console.log('✓ signature valid (recomputed the way Razorpay signs)');

  const parsed = parseRazorpayWebhook(rawBody);
  if (!parsed.ok) fail(parsed.reason);
  console.log(`✓ envelope parsed — event: ${parsed.envelope.event}`);

  const event = normalizeRazorpayEvent(parsed.envelope, `replay:${file}`);
  if (event.kind !== 'payment_failure') {
    fail(`event kind "${event.kind}" is not a payment failure; nothing to deliberate`);
  }

  console.log(
    `\nFAILURE\n  payment      ${event.paymentId}\n  subscription ${event.subscriptionId}` +
      `\n  amount       ₹${(event.amountPaise / 100).toLocaleString('en-IN')}` +
      `\n  method       ${event.providerMethod}` +
      `\n  reason       ${event.failure.reason}\n  step         ${event.failure.step}`,
  );

  const result = await processRazorpayShadowEvent({
    event,
    // A fresh window per replay: a file is a first occurrence by definition.
    idempotency: new TestModeEventWindow(),
    projection: buildDemoProjection(event),
  });

  if (result.status !== 'decided') {
    fail(
      `shadow processor returned "${result.status}"` +
        ('reason' in result ? ` (${result.reason})` : ''),
    );
  }

  const { decision } = result;
  console.log('\nDIAGNOSIS (policy proposal)');
  if (decision.diagnosis === null) {
    console.log('  no diagnosis — the failure could not be classified from observable signals');
  } else {
    console.log(
      `  cause           ${decision.diagnosis.cause} (${CAUSE_LABEL[decision.diagnosis.cause] ?? ''})` +
        `\n  recoverability  ${decision.diagnosis.recoverability} — ${RECOVERABILITY_LABEL[decision.diagnosis.recoverability] ?? ''}` +
        `\n  confidence      ${decision.diagnosis.confidence.toFixed(2)} via ${decision.diagnosis.source}` +
        `\n  reasoning       ${decision.diagnosis.reasoning}`,
    );
  }
  console.log(`\nENFORCEMENT (platform-derived): ${decision.enforcementCause ?? 'unclassifiable'}`);

  console.log('\nADJUDICATION');
  for (const [i, ruling] of decision.rulings.entries()) {
    const label = ACTION_LABEL[ruling.action.kind] ?? ruling.action.kind;
    if (ruling.rejections.length === 0) {
      console.log(`  ${i + 1}. ${label} — permitted`);
    } else {
      console.log(`     ${label} — refused:`);
      for (const r of ruling.rejections) {
        console.log(`        · [${RULE_LABEL[r.rule] ?? r.rule}] ${r.detail}`);
      }
    }
  }

  console.log(
    decision.wouldExecute === null
      ? '\nWOULD EXECUTE: nothing — every candidate was refused (a legitimate outcome)'
      : `\nWOULD EXECUTE: ${ACTION_LABEL[decision.wouldExecute.kind] ?? decision.wouldExecute.kind}` +
          (decision.wouldExecute.scheduledFor !== undefined
            ? ` at ${new Date(decision.wouldExecute.scheduledFor).toISOString()}`
            : ''),
  );
  console.log('\nShadow only. Nothing was debited, sent, or written back.');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  });
