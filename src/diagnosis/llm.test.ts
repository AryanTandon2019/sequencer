/**
 * Tests for the reasoning layer.
 *
 * All of it runs against a stub client, so the prompt, parsing, validation, caching
 * and fallback behaviour are verified with no API key and no spend. Only one thin
 * adapter touches the network, and it is deliberately too small to hold logic.
 *
 * The assertions that matter are the refusals: a malformed reply, an unknown cause or
 * an out-of-range confidence must all escalate rather than be repaired into something
 * actionable. A layer that quietly salvages bad model output is worse than no layer,
 * because its numbers look the same as a working one's.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SIMULATION_START } from '../config.js';
import type { MandateState, ObservableSubscription, ObservedFailure } from '../domain/types.js';
import type { StrategyInput } from '../strategies/strategy.js';
import { deterministicDiagnoser } from './deterministic.js';
import { buildEvidence, createLlmDiagnoser, parseReply, type LlmClient } from './llm.js';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const DAY = 24 * 60 * 60 * 1000;

function failure(reason: string): ObservedFailure {
  return {
    code: 'BAD_REQUEST_ERROR',
    reason,
    source: 'bank',
    step: 'payment_authorization',
    description: `issuer declined: ${reason}`,
    at: SIMULATION_START,
  };
}

function input(overrides: {
  reason?: string;
  sub?: Partial<ObservableSubscription>;
  mandate?: Partial<MandateState>;
} = {}): StrategyInput {
  const sub: ObservableSubscription = {
    id: 'sub_0001',
    customerId: 'cust_0001',
    method: 'card',
    amountPaise: 999_00,
    chargeDate: SIMULATION_START,
    state: 'pending',
    attempts: [
      { sequenceNo: 1, at: SIMULATION_START, outcome: 'failure', failure: failure('payment_failed') },
    ],
    contacts: [],
    lastPreDebitNotificationAt: SIMULATION_START,
    history: {
      cyclesBilled: 9,
      cyclesPaidFirstAttempt: 6,
      cyclesRecoveredAfterRetry: 3,
      cyclesFailed: 0,
      observedFundingDayOfMonth: 3,
    },
    ...overrides.sub,
  };

  return {
    sub,
    mandateState: {
      authorisation: 'active',
      capPaise: 5_000_00,
      higherAfaCeiling: false,
      ...overrides.mandate,
    },
    failure: failure(overrides.reason ?? 'payment_failed'),
    now: SIMULATION_START + DAY,
  };
}

/** A client that always returns the same canned string, and counts its calls. */
function stubClient(reply: string | (() => string)): LlmClient & { calls: number } {
  const client = {
    name: 'stub',
    calls: 0,
    async complete(): Promise<string> {
      client.calls += 1;
      return typeof reply === 'function' ? reply() : reply;
    },
  };
  return client;
}

function throwingClient(): LlmClient {
  return {
    name: 'throwing-stub',
    complete(): Promise<string> {
      return Promise.reject(new Error('model unavailable'));
    },
  };
}

const VALID_REPLY = JSON.stringify({
  cause: 'INSUFFICIENT_FUNDS',
  confidence: 0.72,
  reasoning: 'Regular funding day on the 3rd and three prior recoveries after retry.',
});

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

describe('parsing a reply', () => {
  it('accepts clean JSON', () => {
    const parsed = parseReply(VALID_REPLY);
    assert.equal(parsed?.cause, 'INSUFFICIENT_FUNDS');
    assert.equal(parsed?.confidence, 0.72);
  });

  it('tolerates a code fence', () => {
    assert.equal(parseReply('```json\n' + VALID_REPLY + '\n```')?.cause, 'INSUFFICIENT_FUNDS');
  });

  it('tolerates surrounding chatter', () => {
    const parsed = parseReply(`Here is my assessment:\n${VALID_REPLY}\nHope that helps.`);
    assert.equal(parsed?.cause, 'INSUFFICIENT_FUNDS');
  });

  it('rejects a cause that is not in the taxonomy', () => {
    // A model inventing a category must not have it silently adopted.
    const reply = JSON.stringify({
      cause: 'CUSTOMER_SEEMS_ANNOYED',
      confidence: 0.9,
      reasoning: 'a long enough sentence to pass the minimum length check',
    });
    assert.equal(parseReply(reply), null);
  });

  it('rejects a confidence outside 0..1', () => {
    for (const confidence of [-0.1, 1.4, 42]) {
      const reply = JSON.stringify({
        cause: 'CARD_EXPIRED',
        confidence,
        reasoning: 'a long enough sentence to pass the minimum length check',
      });
      assert.equal(parseReply(reply), null, `confidence ${confidence} should be rejected`);
    }
  });

  it('rejects a confidence that is not a number', () => {
    const reply = '{"cause":"CARD_EXPIRED","confidence":"high","reasoning":"long enough sentence here"}';
    assert.equal(parseReply(reply), null);
  });

  it('rejects a stub reasoning', () => {
    const reply = JSON.stringify({ cause: 'CARD_EXPIRED', confidence: 0.8, reasoning: 'dunno' });
    assert.equal(parseReply(reply), null);
  });

  it('rejects prose, empty output and broken JSON', () => {
    for (const raw of ['', '   ', 'I think the card expired.', '{"cause":', 'null', '[]']) {
      assert.equal(parseReply(raw), null, `should reject: ${JSON.stringify(raw)}`);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Evidence
 * ------------------------------------------------------------------ */

describe('the evidence given to the model', () => {
  const evidence = buildEvidence(input());

  it('includes the payload and the history it needs to reason from', () => {
    assert.match(evidence, /reason:\s+payment_failed/);
    assert.match(evidence, /observed funding day:\s+3/);
    assert.match(evidence, /recovered after a retry:\s+3/);
    assert.match(evidence, /authorisation:\s+active/);
    assert.match(evidence, /ATTEMPTS THIS CYCLE \(1 of 4 permitted\)/);
  });

  it('never mentions the persona, the true cause, or recoverability', () => {
    // The leakage boundary extends into the prompt. A model shown the answer would
    // score beautifully and prove nothing at all.
    for (const forbidden of [
      /persona/i,
      /trueCause/i,
      /true cause/i,
      /recoverab/i,
      /MASKED/,
      /SALARY_CYCLE/,
      /hidden/i,
    ]) {
      assert.ok(!forbidden.test(evidence), `evidence leaks ${forbidden}`);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Layering
 * ------------------------------------------------------------------ */

describe('deterministic first, model second', () => {
  it('never calls the model when the reason string is recognised', () => {
    // The point of the architecture, and the reason a run costs pennies.
    const client = stubClient(VALID_REPLY);
    const { diagnose } = createLlmDiagnoser({ client, fallbackTo: deterministicDiagnoser });

    return Promise.all([
      diagnose(input({ reason: 'card_expired' })),
      diagnose(input({ reason: 'insufficient_funds' })),
      diagnose(input({ reason: 'payment_risk_check_failed' })),
    ]).then((results) => {
      assert.equal(client.calls, 0);
      assert.equal(results[0]?.cause, 'CARD_EXPIRED');
      assert.equal(results[0]?.source, 'deterministic');
    });
  });

  it('calls the model when the deterministic layer abstains', async () => {
    const client = stubClient(VALID_REPLY);
    const { diagnose, stats } = createLlmDiagnoser({
      client,
      fallbackTo: deterministicDiagnoser,
    });

    // A reason string the taxonomy deliberately does not map.
    const result = await diagnose(input({ reason: 'some_reason_added_last_tuesday' }));

    assert.equal(client.calls, 1);
    assert.equal(stats.calls, 1);
    assert.equal(result?.cause, 'INSUFFICIENT_FUNDS');
    assert.equal(result?.source, 'llm');
    assert.equal(result?.confidence, 0.72);
  });

  it('derives recoverability in code rather than trusting the model for it', async () => {
    // The model names a cause. What that cause implies is our table, not its opinion.
    const client = stubClient(
      JSON.stringify({
        cause: 'MANDATE_REVOKED',
        confidence: 0.8,
        reasoning: 'a long enough sentence to pass the minimum length requirement',
      }),
    );
    const { diagnose } = createLlmDiagnoser({ client, fallbackTo: deterministicDiagnoser });
    const result = await diagnose(input({ reason: 'unknown_to_us' }));
    assert.equal(result?.recoverability, 'RETRY_FORBIDDEN');
  });
});

/* ------------------------------------------------------------------ *
 * Caching
 * ------------------------------------------------------------------ */

describe('caching', () => {
  it('asks once for identical evidence', async () => {
    // The failure has not changed between consultations, so re-asking would be both
    // wasteful and incoherent: the same facts yielding different answers per tick.
    const client = stubClient(VALID_REPLY);
    const { diagnose, stats } = createLlmDiagnoser({
      client,
      fallbackTo: deterministicDiagnoser,
    });

    for (let i = 0; i < 12; i += 1) {
      await diagnose(input({ reason: 'unknown_to_us' }));
    }

    assert.equal(client.calls, 1);
    assert.equal(stats.cacheHits, 11);
  });

  it('asks again when the evidence has genuinely changed', async () => {
    const client = stubClient(VALID_REPLY);
    const { diagnose } = createLlmDiagnoser({ client, fallbackTo: deterministicDiagnoser });

    await diagnose(input({ reason: 'unknown_to_us' }));
    await diagnose(input({ reason: 'unknown_to_us', sub: { method: 'upi_autopay' } }));
    assert.equal(client.calls, 2);
  });

  it('caches an escalation too, so a bad reply is not retried forever', async () => {
    const client = stubClient('not json at all');
    const { diagnose, stats } = createLlmDiagnoser({
      client,
      fallbackTo: deterministicDiagnoser,
    });

    for (let i = 0; i < 5; i += 1) {
      assert.equal(await diagnose(input({ reason: 'unknown_to_us' })), null);
    }
    assert.equal(client.calls, 1);
    assert.equal(stats.invalidReplies, 1);
  });
});

/* ------------------------------------------------------------------ *
 * Failure handling
 * ------------------------------------------------------------------ */

describe('when the model misbehaves', () => {
  it('escalates rather than repairing a malformed reply', async () => {
    const { diagnose, stats } = createLlmDiagnoser({
      client: stubClient('{"cause":"NONSENSE","confidence":2}'),
      fallbackTo: deterministicDiagnoser,
    });

    assert.equal(await diagnose(input({ reason: 'unknown_to_us' })), null);
    assert.equal(stats.invalidReplies, 1);
  });

  it('survives the model being unavailable', async () => {
    // An outage must not fail a run. The case escalates, exactly as it would if the
    // model had answered and been unsure.
    const { diagnose, stats } = createLlmDiagnoser({
      client: throwingClient(),
      fallbackTo: deterministicDiagnoser,
    });

    assert.equal(await diagnose(input({ reason: 'unknown_to_us' })), null);
    assert.equal(stats.errors, 1);
  });

  it('still resolves recognised reasons when the model is down', async () => {
    // The deterministic layer is not merely a cost optimisation; it is what keeps the
    // system useful when the model is not there.
    const { diagnose } = createLlmDiagnoser({
      client: throwingClient(),
      fallbackTo: deterministicDiagnoser,
    });

    const result = await diagnose(input({ reason: 'card_expired' }));
    assert.equal(result?.cause, 'CARD_EXPIRED');
  });
});
