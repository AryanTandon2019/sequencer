/**
 * Tests for the action policy.
 *
 * The interesting assertions here are the ones about restraint: that a revoked
 * mandate produces STOP rather than a retry, that a paused mandate produces WAIT,
 * and that an unanswered request stops after the second ask. Those are the
 * behaviours a reviewer will probe, because they are the ones a system optimising
 * naively for collection would get wrong.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { recoverabilityOf } from './causes.js';
import { proposeActions, attemptsRemaining, nextFundingDay } from './policy.js';
import { MAX_ATTEMPTS_PER_MANDATE_CYCLE } from './regulation.js';
import type {
  Attempt,
  CustomerContact,
  DeclineCause,
  Diagnosis,
  MandateState,
  Millis,
  ObservableSubscription,
  ObservedFailure,
} from './types.js';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** 2026-09-05 10:00 IST, a Saturday. Arbitrary but fixed. */
const NOW: Millis = Date.UTC(2026, 8, 5, 4, 30);
const HOUR: Millis = 60 * 60 * 1000;
const DAY: Millis = 24 * HOUR;

function failedAttempt(sequenceNo: number, at: Millis): Attempt {
  const failure: ObservedFailure = {
    code: 'BAD_REQUEST_ERROR',
    reason: 'insufficient_funds',
    source: 'bank',
    step: 'payment_authorization',
    description: 'fixture',
    at,
  };
  return { sequenceNo, at, outcome: 'failure', failure };
}

function sub(overrides: Partial<ObservableSubscription> = {}): ObservableSubscription {
  return {
    id: 'sub_test',
    customerId: 'cust_test',
    method: 'card',
    amountPaise: 499_00,
    chargeDate: NOW,
    state: 'pending',
    attempts: [failedAttempt(1, NOW)],
    contacts: [],
    // The engine issues a pre-debit notice when a case enters recovery, so by the
    // time a policy is consulted one always exists. Matured here, since the
    // interesting scheduling questions are about cause and timing rather than about
    // waiting out a notice.
    lastPreDebitNotificationAt: NOW - 2 * DAY,
    history: {
      cyclesBilled: 7,
      cyclesPaidFirstAttempt: 7,
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

function diagnosisFor(cause: DeclineCause): Diagnosis {
  return {
    cause,
    recoverability: recoverabilityOf(cause),
    confidence: 0.95,
    reasoning: 'fixture',
    source: 'deterministic',
  };
}

function propose(
  cause: DeclineCause,
  overrides: {
    sub?: Partial<ObservableSubscription>;
    mandate?: Partial<MandateState>;
    now?: Millis;
  } = {},
) {
  return proposeActions({
    sub: sub(overrides.sub),
    mandateState: mandate(overrides.mandate),
    diagnosis: diagnosisFor(cause),
    now: overrides.now ?? NOW,
  });
}

function contact(kind: CustomerContact['kind'], at: Millis = NOW): CustomerContact {
  return { kind, at };
}

/* ------------------------------------------------------------------ *
 * Universal properties
 * ------------------------------------------------------------------ */

describe('every cause produces a usable plan', () => {
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

  it('never returns an empty candidate list', () => {
    // An empty list would leave the engine with nothing to record, which is a
    // silent gap rather than a visible decision.
    for (const cause of allCauses) {
      assert.ok(propose(cause).length > 0, `${cause} produced no candidates`);
    }
  });

  it('gives every candidate a non-trivial rationale', () => {
    for (const cause of allCauses) {
      for (const candidate of propose(cause)) {
        assert.ok(
          candidate.rationale.length > 25,
          `${cause} -> ${candidate.kind} has a stub rationale`,
        );
      }
    }
  });

  it('never proposes a debit for a cause where an attempt cannot succeed', () => {
    // The single most important property in the file. A retry against a dead card
    // or a revoked mandate is the exact waste this project exists to remove.
    for (const cause of allCauses) {
      if (recoverabilityOf(cause) === 'RETRY_VIABLE') continue;

      for (const candidate of propose(cause)) {
        assert.notEqual(candidate.kind, 'RETRY_NOW', `${cause} proposed an immediate debit`);
        assert.notEqual(
          candidate.kind,
          'RETRY_SCHEDULED',
          `${cause} proposed a scheduled debit`,
        );
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * Restraint
 * ------------------------------------------------------------------ */

describe('restraint', () => {
  it('stops on a revoked mandate and does not contact the customer', () => {
    const candidates = propose('MANDATE_REVOKED');
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.kind, 'STOP');
  });

  it('stops on a fraud-flagged decline', () => {
    const candidates = propose('FRAUD_SUSPECTED');
    assert.equal(candidates[0]?.kind, 'STOP');
  });

  it('waits on a paused mandate rather than spending an attempt', () => {
    const candidates = propose('MANDATE_PAUSED');
    assert.equal(candidates[0]?.kind, 'WAIT');
  });

  it('escalates a mandate that has stayed paused too long', () => {
    const candidates = propose('MANDATE_PAUSED', { now: NOW + 20 * DAY });
    assert.equal(candidates[0]?.kind, 'ESCALATE_TO_MERCHANT');
  });

  it('escalates rather than guesses when the bank gave no reason', () => {
    const candidates = propose('AMBIGUOUS_BANK_DECLINE');
    assert.equal(candidates[0]?.kind, 'ESCALATE_TO_MERCHANT');
  });

  it('waits for an answer before asking a second time', () => {
    // Re-asking at whatever pace the policy happens to be consulted would burn the
    // two-request allowance within a day and abandon customers who were about to
    // comply. Waiting is the action here, not the absence of one.
    const candidates = propose('CARD_EXPIRED', {
      sub: { contacts: [contact('REQUEST_CARD_UPDATE', NOW)] },
      now: NOW + 6 * HOUR,
    });
    assert.equal(candidates[0]?.kind, 'WAIT');
  });

  it('asks twice, spaced out, then stops', () => {
    const first = propose('CARD_EXPIRED');
    assert.equal(first[0]?.kind, 'REQUEST_CARD_UPDATE');

    // Patience elapsed with no response: ask once more.
    const second = propose('CARD_EXPIRED', {
      sub: { contacts: [contact('REQUEST_CARD_UPDATE', NOW)] },
      now: NOW + 6 * DAY,
    });
    assert.equal(second[0]?.kind, 'REQUEST_CARD_UPDATE');

    // Two unanswered requests over eleven days. Stop.
    const third = propose('CARD_EXPIRED', {
      sub: {
        contacts: [
          contact('REQUEST_CARD_UPDATE', NOW),
          contact('REQUEST_CARD_UPDATE', NOW + 6 * DAY),
        ],
      },
      now: NOW + 12 * DAY,
    });
    assert.equal(third[0]?.kind, 'STOP', 'a third unanswered request is harassment');
  });
});

/* ------------------------------------------------------------------ *
 * Remedies
 * ------------------------------------------------------------------ */

describe('remedies match the cause', () => {
  it('asks for a card update when the card is dead', () => {
    assert.equal(propose('CARD_EXPIRED')[0]?.kind, 'REQUEST_CARD_UPDATE');
  });

  it('asks for re-authorisation when the charge exceeds the mandate ceiling', () => {
    assert.equal(propose('AMOUNT_EXCEEDS_MANDATE')[0]?.kind, 'REQUEST_MANDATE_REAUTH');
  });

  it('asks for authentication when the charge is above the AFA ceiling', () => {
    assert.equal(propose('AUTH_REQUIRED_AFA')[0]?.kind, 'REQUEST_AFA');
  });

  it('asks for re-registration when the account does not match', () => {
    assert.equal(propose('ACCOUNT_MISMATCH')[0]?.kind, 'REQUEST_MANDATE_REAUTH');
  });
});

/* ------------------------------------------------------------------ *
 * The card-expiry hinge
 * ------------------------------------------------------------------ */

describe('a cleared blocker turns futile into viable', () => {
  it('retries once the customer has supplied a new card', () => {
    // This is the Priya case: futile at first, viable after she updates.
    const candidates = propose('CARD_EXPIRED', {
      sub: {
        attempts: [failedAttempt(1, NOW)],
        remedyCompletedAt: NOW + 2 * DAY,
        contacts: [contact('REQUEST_CARD_UPDATE')],
      },
      now: NOW + 2 * DAY + HOUR,
    });

    assert.equal(candidates[0]?.kind, 'RETRY_NOW');
    assert.match(candidates[0]?.rationale ?? '', /blocker cleared/);
  });

  it('ignores a remedy that predates the failure', () => {
    const candidates = propose('CARD_EXPIRED', {
      sub: {
        attempts: [failedAttempt(1, NOW)],
        remedyCompletedAt: NOW - 5 * DAY,
      },
    });
    assert.equal(candidates[0]?.kind, 'REQUEST_CARD_UPDATE');
  });

  it('applies equally to a re-authorised mandate', () => {
    const candidates = propose('AMOUNT_EXCEEDS_MANDATE', {
      sub: {
        attempts: [failedAttempt(1, NOW)],
        remedyCompletedAt: NOW + DAY,
        contacts: [contact('REQUEST_MANDATE_REAUTH')],
      },
      now: NOW + DAY + HOUR,
    });
    assert.equal(candidates[0]?.kind, 'RETRY_NOW');
  });
});

/* ------------------------------------------------------------------ *
 * Timing
 * ------------------------------------------------------------------ */

describe('retry timing depends on the cause', () => {
  it('retries a transient bank failure the same day', () => {
    const candidates = propose('BANK_UNAVAILABLE');
    const scheduled = candidates[0]?.scheduledFor;
    assert.ok(scheduled !== undefined && scheduled - NOW < DAY);
  });

  it('waits for tomorrow on a daily limit, which is what the limit requires', () => {
    const candidates = propose('LIMIT_EXCEEDED_TEMPORARY');
    const scheduled = candidates[0]?.scheduledFor;
    assert.ok(scheduled !== undefined && scheduled - NOW >= DAY);
  });

  it('times a balance shortfall to the observed funding day', () => {
    // Funded on the 1st. From 5 September that means 1 October, not 6 September.
    const candidates = propose('INSUFFICIENT_FUNDS', {
      sub: {
        history: {
          cyclesBilled: 7,
          cyclesPaidFirstAttempt: 5,
          cyclesRecoveredAfterRetry: 2,
          cyclesFailed: 0,
          observedFundingDayOfMonth: 1,
        },
      },
    });

    const scheduled = candidates[0]?.scheduledFor;
    assert.ok(scheduled !== undefined, 'expected a scheduled retry');
    assert.equal(new Date(scheduled + (5 * 60 + 30) * 60 * 1000).getUTCDate(), 1);
  });

  it('falls back to a fixed delay when the funding day is unknown', () => {
    const candidates = propose('INSUFFICIENT_FUNDS');
    const scheduled = candidates[0]?.scheduledFor;
    assert.ok(scheduled !== undefined && scheduled > NOW);
  });

  it('never schedules a debit before the notice has matured', () => {
    // Sending the notice is platform infrastructure, not a policy choice. The
    // policy's job is to schedule around its maturity, and a retry timed sooner
    // would simply be refused.
    const noticeAt = NOW - 2 * HOUR;
    const candidates = propose('BANK_UNAVAILABLE', {
      sub: { lastPreDebitNotificationAt: noticeAt },
    });

    const scheduled = candidates[0]?.scheduledFor;
    assert.ok(scheduled !== undefined, 'expected a scheduled retry');
    assert.ok(
      scheduled >= noticeAt + 24 * HOUR,
      'retry was scheduled before the pre-debit notice matures',
    );
  });

  it('ends every retry plan with a hand-over rather than a blind repeat', () => {
    const candidates = propose('INSUFFICIENT_FUNDS');
    assert.equal(candidates.at(-1)?.kind, 'ESCALATE_TO_MERCHANT');
  });
});

describe('nextFundingDay', () => {
  it('finds the coming occurrence within the same month', () => {
    const from = Date.UTC(2026, 8, 5, 4, 30);
    const result = nextFundingDay(from, 20);
    assert.equal(new Date(result + (5 * 60 + 30) * 60 * 1000).getUTCDate(), 20);
    assert.equal(new Date(result + (5 * 60 + 30) * 60 * 1000).getUTCMonth(), 8);
  });

  it('rolls into next month when the day has passed', () => {
    const from = Date.UTC(2026, 8, 25, 4, 30);
    const result = nextFundingDay(from, 3);
    assert.equal(new Date(result + (5 * 60 + 30) * 60 * 1000).getUTCMonth(), 9);
  });

  it('clamps to the last day of a short month', () => {
    // Funded on the 31st, asked in February. There is no 31 February.
    const from = Date.UTC(2027, 1, 5, 4, 30);
    const result = nextFundingDay(from, 31);
    const ist = new Date(result + (5 * 60 + 30) * 60 * 1000);
    assert.equal(ist.getUTCMonth(), 1);
    assert.equal(ist.getUTCDate(), 28);
  });
});

/* ------------------------------------------------------------------ *
 * The attempt budget
 * ------------------------------------------------------------------ */

describe('the attempt budget', () => {
  it('counts down from four', () => {
    assert.equal(attemptsRemaining(sub({ attempts: [] })), MAX_ATTEMPTS_PER_MANDATE_CYCLE);
    assert.equal(attemptsRemaining(sub()), MAX_ATTEMPTS_PER_MANDATE_CYCLE - 1);
  });

  it('never reports a negative remainder', () => {
    const attempts = Array.from({ length: 9 }, (_, i) => failedAttempt(i + 1, NOW));
    assert.equal(attemptsRemaining(sub({ attempts })), 0);
  });

  it('hands over to a human once the budget is spent', () => {
    const attempts = Array.from({ length: MAX_ATTEMPTS_PER_MANDATE_CYCLE }, (_, i) =>
      failedAttempt(i + 1, NOW),
    );
    const candidates = propose('INSUFFICIENT_FUNDS', { sub: { attempts } });
    assert.equal(candidates[0]?.kind, 'ESCALATE_TO_MERCHANT');
    assert.match(candidates[0]?.rationale ?? '', /budget exhausted/);
  });
});
