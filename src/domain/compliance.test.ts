/**
 * Tests for the guardrails.
 *
 * Two categories matter here. First, that each rule refuses what it should and
 * permits what it should — a guardrail that never fires is decoration, and one
 * that always fires is a bug that would silently zero out the results.
 *
 * Second, and more important, the properties asserted at the end: that no debit
 * can ever pass without 24 hours notice, that no hard decline can ever be
 * reattempted, and that a withdrawn mandate can never be contacted. Those hold
 * across every combination the tests can construct, not just the scenarios
 * someone thought to write down.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { recoverabilityOf, HARD_DECLINE_CAUSES } from './causes.js';
import { GUARDRAILS, adjudicate, evaluate, isPermitted } from './compliance.js';
import { proposeActions } from './policy.js';
import {
  AFA_EXEMPT_CEILING_PAISE,
  MAX_ATTEMPTS_PER_MANDATE_CYCLE,
  MIN_CONFIDENCE_FOR_AUTONOMOUS_ACTION,
  PRE_DEBIT_NOTIFICATION_LEAD_MS,
} from './regulation.js';
import type {
  Action,
  ActionKind,
  Attempt,
  DeclineCause,
  Diagnosis,
  MandateState,
  Millis,
  ObservableSubscription,
} from './types.js';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** 2026-09-05 08:00 IST — inside a permitted Autopay window. */
const NOW: Millis = Date.UTC(2026, 8, 5, 2, 30);
const HOUR: Millis = 60 * 60 * 1000;
const DAY: Millis = 24 * HOUR;

/** Notice sent well over 24h ago, so debits are lawful unless a test says otherwise. */
const NOTICE_SENT: Millis = NOW - 2 * DAY;

function attempt(sequenceNo: number): Attempt {
  return { sequenceNo, at: NOW - DAY, outcome: 'failure' };
}

function sub(overrides: Partial<ObservableSubscription> = {}): ObservableSubscription {
  return {
    id: 'sub_test',
    customerId: 'cust_test',
    method: 'card',
    amountPaise: 499_00,
    chargeDate: NOW,
    state: 'pending',
    attempts: [attempt(1)],
    contacts: [],
    lastPreDebitNotificationAt: NOTICE_SENT,
    history: {
      cyclesBilled: 6,
      cyclesPaidFirstAttempt: 6,
      cyclesRecoveredAfterRetry: 0,
      cyclesFailed: 0,
    },
    ...overrides,
  };
}

function mandate(overrides: Partial<MandateState> = {}): MandateState {
  return {
    authorisation: 'active',
    capPaise: 10_000_00,
    higherAfaCeiling: false,
    ...overrides,
  };
}

function diagnosis(overrides: Partial<Diagnosis> = {}): Diagnosis {
  return {
    cause: 'INSUFFICIENT_FUNDS',
    recoverability: 'RETRY_VIABLE',
    confidence: 0.95,
    reasoning: 'fixture',
    source: 'deterministic',
    ...overrides,
  };
}

/**
 * Enforcement context defaults.
 *
 * `enforcementCause` is what the platform derived independently; `agentConfidence`
 * is the acting strategy's own claim, or null when it makes none. Keeping them
 * separate is the point of the refactor: a strategy that does not diagnose must
 * still be governed.
 */
const DEFAULT_ENFORCEMENT_CAUSE: DeclineCause = 'INSUFFICIENT_FUNDS';
const DEFAULT_AGENT_CONFIDENCE = 0.95;

function act(kind: ActionKind, scheduledFor?: Millis): Action {
  return scheduledFor === undefined
    ? { kind, rationale: 'fixture rationale long enough to be realistic' }
    : { kind, scheduledFor, rationale: 'fixture rationale long enough to be realistic' };
}

function check(opts: {
  action: Action;
  sub?: Partial<ObservableSubscription>;
  mandate?: Partial<MandateState>;
  cause?: DeclineCause | null;
  confidence?: number | null;
  now?: Millis;
}) {
  return evaluate({
    sub: sub(opts.sub),
    mandateState: mandate(opts.mandate),
    enforcementCause: opts.cause === undefined ? DEFAULT_ENFORCEMENT_CAUSE : opts.cause,
    agentConfidence: opts.confidence === undefined ? DEFAULT_AGENT_CONFIDENCE : opts.confidence,
    action: opts.action,
    now: opts.now ?? NOW,
  });
}

/** Base context for adjudicate, which takes everything except the action. */
function base(overrides: {
  sub?: Partial<ObservableSubscription>;
  mandate?: Partial<MandateState>;
  cause?: DeclineCause | null;
  confidence?: number | null;
  now?: Millis;
} = {}) {
  return {
    sub: sub(overrides.sub),
    mandateState: mandate(overrides.mandate),
    enforcementCause:
      overrides.cause === undefined ? DEFAULT_ENFORCEMENT_CAUSE : overrides.cause,
    agentConfidence:
      overrides.confidence === undefined ? DEFAULT_AGENT_CONFIDENCE : overrides.confidence,
    now: overrides.now ?? NOW,
  };
}

function refusedBy(rejections: readonly { rule: string }[], rule: string): boolean {
  return rejections.some((r) => r.rule === rule);
}

/* ------------------------------------------------------------------ *
 * Rule hygiene
 * ------------------------------------------------------------------ */

describe('rule hygiene', () => {
  it('gives every rule a unique id', () => {
    const ids = GUARDRAILS.map((g) => g.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('gives every rule a citation substantial enough to check', () => {
    for (const rail of GUARDRAILS) {
      assert.ok(rail.citation.length > 40, `${rail.id} has a stub citation`);
    }
  });

  it('labels the one internal rule as internal', () => {
    const internal = GUARDRAILS.find((g) => g.id === 'CONFIDENCE_FLOOR');
    assert.ok(internal !== undefined);
    assert.match(internal.citation, /INTERNAL POLICY/);
  });

  it('permits an ordinary, well-formed debit', () => {
    // If this ever fails, every result in the project silently collapses to zero.
    assert.deepEqual(check({ action: act('RETRY_NOW') }), []);
  });
});

/* ------------------------------------------------------------------ *
 * The attempt budget
 * ------------------------------------------------------------------ */

describe('NPCI attempt cap', () => {
  it('permits a debit while attempts remain', () => {
    assert.ok(!refusedBy(check({ action: act('RETRY_NOW') }), 'NPCI_ATTEMPT_CAP'));
  });

  it('refuses a debit once four attempts are used', () => {
    const attempts = Array.from({ length: MAX_ATTEMPTS_PER_MANDATE_CYCLE }, (_, i) =>
      attempt(i + 1),
    );
    assert.ok(refusedBy(check({ action: act('RETRY_NOW'), sub: { attempts } }), 'NPCI_ATTEMPT_CAP'));
  });

  it('still permits non-debit actions once the budget is spent', () => {
    // Asking a customer to update a card costs no attempt, so exhausting the
    // budget must not also silence the one message that could still recover it.
    const attempts = Array.from({ length: MAX_ATTEMPTS_PER_MANDATE_CYCLE }, (_, i) =>
      attempt(i + 1),
    );
    const rejections = check({ action: act('REQUEST_CARD_UPDATE'), sub: { attempts } });
    assert.ok(!refusedBy(rejections, 'NPCI_ATTEMPT_CAP'));
  });
});

/* ------------------------------------------------------------------ *
 * Pre-debit notification
 * ------------------------------------------------------------------ */

describe('RBI pre-debit notification', () => {
  it('refuses a debit when no notice has been sent', () => {
    const rejections = check({
      action: act('RETRY_NOW'),
      sub: { lastPreDebitNotificationAt: undefined },
    });
    assert.ok(refusedBy(rejections, 'RBI_PRE_DEBIT_NOTIFICATION'));
  });

  it('refuses a debit when the notice is younger than 24 hours', () => {
    const rejections = check({
      action: act('RETRY_NOW'),
      sub: { lastPreDebitNotificationAt: NOW - 5 * HOUR },
    });
    assert.ok(refusedBy(rejections, 'RBI_PRE_DEBIT_NOTIFICATION'));
  });

  it('permits a debit exactly 24 hours after the notice', () => {
    const rejections = check({
      action: act('RETRY_NOW'),
      sub: { lastPreDebitNotificationAt: NOW - PRE_DEBIT_NOTIFICATION_LEAD_MS },
    });
    assert.ok(!refusedBy(rejections, 'RBI_PRE_DEBIT_NOTIFICATION'));
  });

  it('judges a scheduled debit by when it lands, not when it is planned', () => {
    // Notice sent an hour ago, debit scheduled three days out. By the time it
    // fires the notice is three days old, so it is lawful.
    const rejections = check({
      action: act('RETRY_SCHEDULED', NOW + 3 * DAY),
      sub: { lastPreDebitNotificationAt: NOW - HOUR },
    });
    assert.ok(!refusedBy(rejections, 'RBI_PRE_DEBIT_NOTIFICATION'));
  });

  it('does not require notice for sending the notice itself', () => {
    const rejections = check({
      action: act('SEND_PRE_DEBIT_NOTIFICATION'),
      sub: { lastPreDebitNotificationAt: undefined },
    });
    assert.deepEqual(rejections, []);
  });
});

/* ------------------------------------------------------------------ *
 * Hard declines
 * ------------------------------------------------------------------ */

describe('card network hard declines', () => {
  it('refuses a reattempt on every hard decline cause', () => {
    for (const cause of HARD_DECLINE_CAUSES) {
      const rejections = check({ action: act('RETRY_NOW'), cause });
      assert.ok(
        refusedBy(rejections, 'CARD_NETWORK_NO_HARD_DECLINE_RETRY'),
        `${cause} should not be reattemptable`,
      );
    }
  });

  it('still permits asking the customer to fix a hard-declined instrument', () => {
    const rejections = check({ action: act('REQUEST_CARD_UPDATE'), cause: 'CARD_EXPIRED' });
    assert.deepEqual(rejections, []);
  });
});

/* ------------------------------------------------------------------ *
 * Consent boundaries
 * ------------------------------------------------------------------ */

describe('consent boundaries', () => {
  it('refuses a debit above the authorised cap', () => {
    const rejections = check({
      action: act('RETRY_NOW'),
      sub: { amountPaise: 20_000_00 },
      mandate: { capPaise: 10_000_00 },
    });
    assert.ok(refusedBy(rejections, 'MANDATE_CAP'));
  });

  it('refuses a silent debit above the AFA ceiling', () => {
    const rejections = check({
      action: act('RETRY_NOW'),
      sub: { amountPaise: AFA_EXEMPT_CEILING_PAISE + 1 },
      mandate: { capPaise: 99_00_000_00 },
    });
    assert.ok(refusedBy(rejections, 'AFA_REQUIRED_ABOVE_CEILING'));
  });

  it('permits the same amount under the higher category ceiling', () => {
    const rejections = check({
      action: act('RETRY_NOW'),
      sub: { amountPaise: AFA_EXEMPT_CEILING_PAISE + 1 },
      mandate: { capPaise: 99_00_000_00, higherAfaCeiling: true },
    });
    assert.ok(!refusedBy(rejections, 'AFA_REQUIRED_ABOVE_CEILING'));
  });
});

/* ------------------------------------------------------------------ *
 * Withdrawn consent
 * ------------------------------------------------------------------ */

describe('withdrawn consent', () => {
  const revoked = { authorisation: 'revoked' as const };

  it('refuses a debit against a revoked mandate', () => {
    const rejections = check({ action: act('RETRY_NOW'), mandate: revoked });
    assert.ok(refusedBy(rejections, 'REVOKED_CONSENT_NO_CONTACT'));
  });

  it('refuses dunning against a revoked mandate', () => {
    // Not contacting them is the point. A system that stops debiting but keeps
    // emailing has missed what revocation means.
    for (const kind of [
      'REQUEST_CARD_UPDATE',
      'REQUEST_MANDATE_REAUTH',
      'REQUEST_AFA',
      'SEND_PRE_DEBIT_NOTIFICATION',
    ] as const) {
      const rejections = check({ action: act(kind), mandate: revoked });
      assert.ok(refusedBy(rejections, 'REVOKED_CONSENT_NO_CONTACT'), `${kind} should be refused`);
    }
  });

  it('permits stopping and escalating', () => {
    for (const kind of ['STOP', 'ESCALATE_TO_MERCHANT', 'WAIT'] as const) {
      assert.deepEqual(check({ action: act(kind), mandate: revoked }), []);
    }
  });

  it('treats a lapsed mandate the same as a revoked one', () => {
    const rejections = check({
      action: act('RETRY_NOW'),
      mandate: { authorisation: 'expired' },
    });
    assert.ok(refusedBy(rejections, 'REVOKED_CONSENT_NO_CONTACT'));
  });

  it('treats a cancelled subscription the same way', () => {
    const rejections = check({ action: act('REQUEST_CARD_UPDATE'), sub: { state: 'cancelled' } });
    assert.ok(refusedBy(rejections, 'REVOKED_CONSENT_NO_CONTACT'));
  });
});

/* ------------------------------------------------------------------ *
 * Confidence floor
 * ------------------------------------------------------------------ */

describe('confidence floor', () => {
  it('refuses money and contact actions on a low-confidence diagnosis', () => {
    const low = MIN_CONFIDENCE_FOR_AUTONOMOUS_ACTION - 0.01;
    for (const kind of ['RETRY_NOW', 'REQUEST_CARD_UPDATE'] as const) {
      assert.ok(refusedBy(check({ action: act(kind), confidence: low }), 'CONFIDENCE_FLOOR'));
    }
  });

  it('does not apply the floor to a strategy that makes no claim', () => {
    // The baseline forms no view about the cause. Refusing it for low confidence
    // would be refusing it for a claim it never made, and would quietly stop the
    // comparison from measuring the default's actual behaviour.
    for (const kind of ['RETRY_NOW', 'REQUEST_CARD_UPDATE'] as const) {
      assert.ok(
        !refusedBy(check({ action: act(kind), confidence: null }), 'CONFIDENCE_FLOOR'),
        `${kind} was refused for a diagnosis the strategy never offered`,
      );
    }
  });

  it('still enforces cause-based rules on a strategy that makes no claim', () => {
    // The platform classifies independently, so a non-diagnosing strategy is
    // governed on facts rather than escaping the rules by staying silent.
    const rejections = check({
      action: act('RETRY_NOW'),
      cause: 'CARD_EXPIRED',
      confidence: null,
    });
    assert.ok(refusedBy(rejections, 'CARD_NETWORK_NO_HARD_DECLINE_RETRY'));
  });

  it('abstains from cause-based rules when even the platform cannot classify', () => {
    const rejections = check({ action: act('RETRY_NOW'), cause: null, confidence: null });
    assert.ok(!refusedBy(rejections, 'CARD_NETWORK_NO_HARD_DECLINE_RETRY'));
    // Cause-independent rules still apply.
    assert.ok(
      refusedBy(
        check({
          action: act('RETRY_NOW'),
          cause: null,
          confidence: null,
          sub: { lastPreDebitNotificationAt: undefined },
        }),
        'RBI_PRE_DEBIT_NOTIFICATION',
      ),
    );
  });

  it('does not block an action justified by a cleared remedy', () => {
    // Regression. A retry after the customer has replaced their card is justified by
    // the remedy, not by any claim about the cause, so distrust of the cause must not
    // refuse it.
    //
    // Without this, an honest low-confidence answer was strictly worse than silence: a
    // strategy reporting 0.34 confidence got refused where one reporting nothing
    // proceeded. It cost five real recoveries and made the reasoning layer look
    // actively harmful.
    const rejections = check({
      action: act('RETRY_NOW'),
      confidence: 0.34,
      sub: {
        attempts: [attempt(1)],
        remedyCompletedAt: NOW - HOUR,
      },
    });
    assert.ok(!refusedBy(rejections, 'CONFIDENCE_FLOOR'));
  });

  it('still blocks a low-confidence action when no remedy has been cleared', () => {
    const rejections = check({ action: act('RETRY_NOW'), confidence: 0.34 });
    assert.ok(refusedBy(rejections, 'CONFIDENCE_FLOOR'));
  });

  it('permits escalation regardless of confidence', () => {
    // Low confidence is precisely the reason to hand it to a human, so the floor
    // must not block the escape hatch.
    assert.deepEqual(check({ action: act('ESCALATE_TO_MERCHANT'), confidence: 0.1 }), []);
  });
});

/* ------------------------------------------------------------------ *
 * Autopay execution windows
 * ------------------------------------------------------------------ */

describe('Autopay execution windows', () => {
  /** 2026-09-05 11:30 IST — outside the permitted windows. */
  const PEAK: Millis = Date.UTC(2026, 8, 5, 6, 0);

  it('refuses a UPI Autopay debit outside a permitted window', () => {
    const rejections = check({
      action: act('RETRY_NOW'),
      sub: { method: 'upi_autopay' },
      now: PEAK,
    });
    assert.ok(refusedBy(rejections, 'NPCI_EXECUTION_WINDOW'));
  });

  it('does not apply the window restriction to card debits', () => {
    const rejections = check({ action: act('RETRY_NOW'), sub: { method: 'card' }, now: PEAK });
    assert.ok(!refusedBy(rejections, 'NPCI_EXECUTION_WINDOW'));
  });
});

/* ------------------------------------------------------------------ *
 * Adjudication
 * ------------------------------------------------------------------ */

describe('adjudicate', () => {
  it('takes the first permitted candidate and records the refusals before it', () => {
    // The Priya moment: the agent wants to charge, has no notice, and falls back
    // to sending one. Both rulings are retained.
    const result = adjudicate(
      [act('RETRY_NOW'), act('SEND_PRE_DEBIT_NOTIFICATION')],
      base({ sub: { lastPreDebitNotificationAt: undefined } }),
    );

    assert.equal(result.rulings.length, 2);
    assert.equal(result.rulings[0]?.action.kind, 'RETRY_NOW');
    assert.ok(refusedBy(result.rulings[0]?.rejections ?? [], 'RBI_PRE_DEBIT_NOTIFICATION'));
    assert.deepEqual(result.rulings[1]?.rejections, []);
    assert.equal(result.executed?.kind, 'SEND_PRE_DEBIT_NOTIFICATION');
  });

  it('stops evaluating once something is permitted', () => {
    const result = adjudicate(
      [act('RETRY_NOW'), act('SEND_PRE_DEBIT_NOTIFICATION')],
      base(),
    );
    assert.equal(result.rulings.length, 1);
    assert.equal(result.executed?.kind, 'RETRY_NOW');
  });

  it('reports null when every candidate is refused', () => {
    const result = adjudicate(
      [act('RETRY_NOW')],
      base({ sub: { lastPreDebitNotificationAt: undefined } }),
    );
    assert.equal(result.executed, null);
    assert.equal(result.rulings.length, 1);
  });
});

/* ------------------------------------------------------------------ *
 * Properties across the whole cause space
 * ------------------------------------------------------------------ */

describe('properties that must hold for every cause', () => {
  const allCauses: readonly DeclineCause[] = [
    'INSUFFICIENT_FUNDS',
    'BANK_UNAVAILABLE',
    'LIMIT_EXCEEDED_TEMPORARY',
    'CARD_EXPIRED',
    'INSTRUMENT_BLOCKED',
    'INSTRUMENT_NOT_ENABLED',
    'ACCOUNT_MISMATCH',
    'VPA_INVALID',
    'FRAUD_SUSPECTED',
    'AMOUNT_EXCEEDS_MANDATE',
    'AUTH_REQUIRED_AFA',
    'MANDATE_REVOKED',
    'MANDATE_PAUSED',
    'AMBIGUOUS_BANK_DECLINE',
  ];

  it('never permits a debit without valid notice, for any cause', () => {
    for (const cause of allCauses) {
      const permitted = isPermitted({
        ...base({ sub: { lastPreDebitNotificationAt: undefined }, cause }),
        action: act('RETRY_NOW'),
      });
      assert.equal(permitted, false, `${cause} slipped a debit through without notice`);
    }
  });

  it('never permits a debit on a hard decline, for any amount or method', () => {
    for (const cause of HARD_DECLINE_CAUSES) {
      for (const method of ['card', 'upi_autopay', 'emandate'] as const) {
        const permitted = isPermitted({
          ...base({ sub: { method }, cause }),
          action: act('RETRY_NOW'),
        });
        assert.equal(permitted, false, `${cause} on ${method} was reattemptable`);
      }
    }
  });

  it('lets every policy plan reach some permitted action, for every cause', () => {
    // Policy and compliance have to agree well enough that the pair never
    // deadlocks. If a plan has no lawful step, the case stalls silently and the
    // money is lost to a bug rather than to a decision.
    for (const cause of allCauses) {
      const ctx = base({ sub: { lastPreDebitNotificationAt: undefined }, cause });

      const candidates = proposeActions({
        sub: ctx.sub,
        mandateState: ctx.mandateState,
        diagnosis: diagnosis({ cause, recoverability: recoverabilityOf(cause) }),
        now: ctx.now,
      });
      const { executed } = adjudicate(candidates, ctx);

      assert.notEqual(executed, null, `${cause} produced a plan with no permitted step`);
    }
  });
});
