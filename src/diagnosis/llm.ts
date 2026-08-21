/**
 * The reasoning layer.
 *
 * Only reached for failures the deterministic classifier cannot resolve — in practice
 * the cases where the bank declined and told nobody why. Razorpay documents that it
 * may not have access to the underlying cause for `card_declined` and
 * `payment_failed`, so these are genuinely thin evidence, and they are exactly where
 * a lookup table has nothing left to offer.
 *
 * Four constraints, each deliberate:
 *
 *   1. The model sees only observable evidence. The leakage boundary extends into the
 *      prompt: no persona, no true cause, no hint of the answer. A model shown the
 *      answer would score wonderfully and mean nothing.
 *
 *   2. The model never does arithmetic. It returns a cause, a confidence and a
 *      sentence of reasoning. Attempt budgets, notice windows and every rupee are
 *      computed in code.
 *
 *   3. A reply that fails validation returns null rather than being coerced into
 *      something usable. Null escalates to a human. Guessing here would undermine
 *      every honest number elsewhere.
 *
 *   4. Diagnoses are cached per distinct body of evidence. The failure has not changed
 *      between consultations, so re-asking would be both wasteful and incoherent —
 *      the same facts producing different answers on different ticks.
 */

import { z } from 'zod';

import { ALL_DECLINE_CAUSES, recoverabilityOf } from '../domain/causes.js';
import type { DeclineCause, Diagnosis } from '../domain/types.js';
import type { StrategyInput } from '../strategies/strategy.js';
import type { Diagnoser } from './deterministic.js';

/* ------------------------------------------------------------------ *
 * Client
 * ------------------------------------------------------------------ */

/**
 * The narrowest possible surface onto a model.
 *
 * Injected rather than constructed here so the whole layer — prompt, parsing,
 * validation, caching, fallback — is testable with a stub and no API key and no
 * spend. Only one small adapter actually touches the network.
 */
export interface LlmClient {
  readonly name: string;
  complete(request: { system: string; user: string }): Promise<string>;
}

/** Wraps the OpenAI Responses API. The only networked code in the project. */
export function createOpenAiClient(options: {
  apiKey: string;
  model: string;
}): LlmClient {
  return {
    name: options.model,
    async complete({ system, user }) {
      // Imported lazily so a run without a key never loads the SDK at all, which
      // keeps `npm run harness` free of any network dependency.
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({ apiKey: options.apiKey });

      const response = await client.responses.create({
        model: options.model,
        instructions: system,
        input: user,
        // Low but not zero. Some of these calls are genuinely judgement under
        // uncertainty; zero would make the model overconfident on thin evidence.
        temperature: 0.2,
        max_output_tokens: 400,
      });

      return response.output_text;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Reply schema
 * ------------------------------------------------------------------ */

const CAUSE_VALUES = ALL_DECLINE_CAUSES as readonly [DeclineCause, ...DeclineCause[]];

/**
 * What a valid reply looks like.
 *
 * Validated rather than trusted. A model that returns an unknown cause, a confidence
 * outside 0..1, or prose where a number belongs has produced nothing usable, and the
 * correct handling is to escalate rather than to repair it.
 */
const DiagnosisReply = z.object({
  cause: z.enum(CAUSE_VALUES),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(15).max(500),
});

export type DiagnosisReply = z.infer<typeof DiagnosisReply>;

/* ------------------------------------------------------------------ *
 * Prompt
 * ------------------------------------------------------------------ */

const SYSTEM_PROMPT = `You diagnose failed recurring payments for an Indian merchant on Razorpay.

You are given only what the merchant can see: the issuer's failure payload, the
mandate's state, the attempts already made this cycle, and the customer's billing
history. You will not be told the real cause. Some issuers decline without stating a
reason, so part of your job is inferring from history rather than from the payload.

Pick exactly one cause from this list:

  INSUFFICIENT_FUNDS        balance was short; an attempt can succeed once money lands
  BANK_UNAVAILABLE          transient downtime at the bank or partner bank
  LIMIT_EXCEEDED_TEMPORARY  daily transaction limit hit; resets overnight
  CARD_EXPIRED              card is finished; no retry can ever succeed
  INSTRUMENT_BLOCKED        blocked by customer or bank
  INSTRUMENT_NOT_ENABLED    never enabled for online or recurring use
  ACCOUNT_MISMATCH          paid from an account other than the registered one
  VPA_INVALID               UPI handle invalid or unresolvable
  FRAUD_SUSPECTED           issuer declined citing fraud
  AMOUNT_EXCEEDS_MANDATE    charge above the authorised ceiling
  AUTH_REQUIRED_AFA         charge above the authentication exemption ceiling
  MANDATE_REVOKED           customer withdrew consent
  MANDATE_PAUSED            consent suspended, not withdrawn
  AMBIGUOUS_BANK_DECLINE    genuinely not determinable from the evidence

Guidance that matters:

- A retry is a scarce, regulated resource: one original attempt plus at most three
  retries per mandate. Concluding INSUFFICIENT_FUNDS when the instrument is actually
  dead wastes that budget on something that can never approve.
- Repeated identical declines against the same card, with no history of recovering
  after a retry, point at the instrument rather than the moment.
- A customer with a regular funding day and a history of recovering after retries,
  who fails shortly before that day, points at timing.
- AMBIGUOUS_BANK_DECLINE is the right answer when the evidence genuinely does not
  support a specific cause. Choosing it sends the case to a human. That is a real and
  sometimes correct outcome. Do not invent a specific cause to avoid it.
- Your confidence should reflect the evidence, not your fluency. Thin evidence
  deserves a low number even when your reasoning sounds plausible.

Reply with JSON only, no prose or code fences:
{"cause":"<CAUSE>","confidence":<0..1>,"reasoning":"<one or two sentences>"}`;

const DAY = 24 * 60 * 60 * 1000;

function rupees(paise: number): string {
  return `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;
}

/**
 * The evidence, as a merchant would see it.
 *
 * Every line here is a field on `ObservableSubscription`, `MandateState` or
 * `ObservedFailure`. Nothing is derived from hidden state.
 */
export function buildEvidence(input: StrategyInput): string {
  const { sub, mandateState, failure, now } = input;
  const h = sub.history;

  const attempts = sub.attempts
    .map((a, i) => {
      const outcome = a.outcome === 'success' ? 'succeeded' : `failed (${a.failure?.reason ?? '?'})`;
      const daysAgo = Math.round((now - a.at) / DAY);
      return `    ${i + 1}. ${outcome}, ${daysAgo}d ago`;
    })
    .join('\n');

  const contacts =
    sub.contacts.length === 0
      ? '    none'
      : sub.contacts
          .map((c) => `    ${c.kind}, ${Math.round((now - c.at) / DAY)}d ago`)
          .join('\n');

  return `FAILURE PAYLOAD
    code:        ${failure.code}
    reason:      ${failure.reason}
    source:      ${failure.source}
    step:        ${failure.step}
    description: ${failure.description}

SUBSCRIPTION
    amount:            ${rupees(sub.amountPaise)}
    method:            ${sub.method}
    days since charge: ${Math.round((now - sub.chargeDate) / DAY)}

MANDATE
    authorisation:   ${mandateState.authorisation}
    authorised cap:  ${rupees(mandateState.capPaise)}
    higher AFA tier: ${mandateState.higherAfaCeiling ? 'yes' : 'no'}

ATTEMPTS THIS CYCLE (${sub.attempts.length} of 4 permitted)
${attempts === '' ? '    none' : attempts}

CUSTOMER CONTACTS THIS CYCLE
${contacts}

BILLING HISTORY
    cycles billed:              ${h.cyclesBilled}
    paid on first attempt:      ${h.cyclesPaidFirstAttempt}
    recovered after a retry:    ${h.cyclesRecoveredAfterRetry}
    failed outright:            ${h.cyclesFailed}
    observed funding day:       ${h.observedFundingDayOfMonth ?? 'none discernible'}`;
}

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

/**
 * Extract JSON from a reply, tolerating a code fence but nothing more creative.
 *
 * Returns null on anything unparseable. Deliberately not a repair function: a model
 * that cannot follow a two-line format has not produced a diagnosis worth acting on.
 */
export function parseReply(raw: string): DiagnosisReply | null {
  const withoutFence = raw
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let candidate: unknown;
  try {
    candidate = JSON.parse(withoutFence.slice(start, end + 1));
  } catch {
    return null;
  }

  const result = DiagnosisReply.safeParse(candidate);
  return result.success ? result.data : null;
}

/* ------------------------------------------------------------------ *
 * The diagnoser
 * ------------------------------------------------------------------ */

/** Stable key over the evidence, so identical situations cost one call. */
function evidenceKey(input: StrategyInput): string {
  const { sub, mandateState, failure } = input;
  return [
    failure.reason,
    failure.step,
    failure.source,
    sub.method,
    sub.amountPaise,
    mandateState.authorisation,
    mandateState.capPaise,
    sub.attempts.length,
    sub.attempts.map((a) => a.failure?.reason ?? a.outcome).join('|'),
    sub.history.observedFundingDayOfMonth ?? 'none',
    sub.history.cyclesRecoveredAfterRetry,
    sub.history.cyclesBilled,
  ].join('~');
}

export interface LlmDiagnoserStats {
  /** Model calls actually made. */
  calls: number;
  /** Answers served from cache. */
  cacheHits: number;
  /** Replies that failed validation and were escalated instead. */
  invalidReplies: number;
  /** Calls that threw. The run continues; the case escalates. */
  errors: number;
}

export interface LlmDiagnoserOptions {
  readonly client: LlmClient;
  /** Consulted first. Only its nulls reach the model. */
  readonly fallbackTo: Diagnoser;
}

/**
 * Deterministic first, model second.
 *
 * This ordering is the whole architecture. It resolves the large majority of cases at
 * zero cost with an auditable rule, sends only genuine ambiguity to a model, and keeps
 * the reported numbers reproducible for anyone without an API key. It is also, not
 * coincidentally, the cheap option.
 */
export function createLlmDiagnoser(options: LlmDiagnoserOptions): {
  readonly diagnose: Diagnoser;
  readonly stats: LlmDiagnoserStats;
} {
  const cache = new Map<string, Diagnosis | null>();
  const stats: LlmDiagnoserStats = { calls: 0, cacheHits: 0, invalidReplies: 0, errors: 0 };

  const diagnose: Diagnoser = async (input) => {
    const deterministic = await options.fallbackTo(input);
    if (deterministic !== null) return deterministic;

    const key = evidenceKey(input);
    const cached = cache.get(key);
    if (cached !== undefined) {
      stats.cacheHits += 1;
      return cached;
    }

    let reply: DiagnosisReply | null = null;
    try {
      stats.calls += 1;
      const raw = await options.client.complete({
        system: SYSTEM_PROMPT,
        user: buildEvidence(input),
      });
      reply = parseReply(raw);
      if (reply === null) stats.invalidReplies += 1;
    } catch {
      // A model being unavailable must not fail a run. The case escalates, which is
      // the same thing that happens when the model is merely unsure.
      stats.errors += 1;
      reply = null;
    }

    const diagnosis: Diagnosis | null =
      reply === null
        ? null
        : {
            cause: reply.cause,
            recoverability: recoverabilityOf(reply.cause),
            confidence: reply.confidence,
            reasoning: reply.reasoning,
            source: 'llm',
          };

    cache.set(key, diagnosis);
    return diagnosis;
  };

  return { diagnose, stats };
}
