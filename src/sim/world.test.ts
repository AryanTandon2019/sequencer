/**
 * Tests for the world model and the cohort generator.
 *
 * The two that matter most:
 *
 *   "delivers on every recoverable claim" — for each persona that says its money
 *   was recoverable, the world must actually contain a route by which a debit
 *   succeeds. If a persona claims recoverable and no sequence of actions can
 *   collect it, the achievable ceiling is a fiction and the agent is measured
 *   against a number nobody could ever hit.
 *
 *   "keeps earlier subscriptions stable when the cohort grows" — otherwise every
 *   figure shifts whenever the generator is touched, and two runs cannot be
 *   compared.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MANDATE_CAP_HEADROOM, SIMULATION_START } from '../config.js';
import { afaCeilingPaise } from '../domain/regulation.js';
import type { MandateState, Millis, ObservableSubscription } from '../domain/types.js';
import {
  generateCohort,
  largestCaseShare,
  personaBreakdown,
  recoverableAtRiskPaise,
  recoverableCaseCount,
  totalAtRiskPaise,
} from './cohort.js';
import { PERSONAS, personaById } from './personas.js';
import { deriveRng, hashSeed } from './rng.js';
import {
  applyRemedyToMandate,
  authorisationAt,
  customerResponseAt,
  hasSelfResolved,
  resolveDebit,
  wouldRespondTo,
} from './world.js';

const HOUR: Millis = 60 * 60 * 1000;
const DAY: Millis = 24 * HOUR;

function bareSub(overrides: Partial<ObservableSubscription> = {}): ObservableSubscription {
  return {
    id: 'sub_0001',
    customerId: 'cust_0001',
    method: 'card',
    amountPaise: 499_00,
    chargeDate: SIMULATION_START,
    state: 'pending',
    attempts: [],
    contacts: [],
    history: {
      cyclesBilled: 5,
      cyclesPaidFirstAttempt: 5,
      cyclesRecoveredAfterRetry: 0,
      cyclesFailed: 0,
    },
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * Debits
 * ------------------------------------------------------------------ */

describe('resolving a debit', () => {
  const salary = personaById('SALARY_CYCLE_SHORTFALL');

  it('fails before the obstacle clears and succeeds after', () => {
    const hidden = salary.materialise(deriveRng(1, 'a'), SIMULATION_START);
    const clearsAt = hidden.retrySucceedsFrom;
    assert.ok(clearsAt !== undefined);

    assert.equal(resolveDebit(hidden, bareSub(), clearsAt - HOUR).outcome, 'failure');
    assert.equal(resolveDebit(hidden, bareSub(), clearsAt).outcome, 'success');
    assert.equal(resolveDebit(hidden, bareSub(), clearsAt + DAY).outcome, 'success');
  });

  it('reports the issuer reason on failure, and nothing on success', () => {
    const hidden = salary.materialise(deriveRng(2, 'b'), SIMULATION_START);
    const failed = resolveDebit(hidden, bareSub(), SIMULATION_START);
    assert.equal(failed.failure?.reason, hidden.failureReason);
    assert.equal(failed.failure?.source, 'bank');

    const clearsAt = hidden.retrySucceedsFrom ?? SIMULATION_START;
    assert.equal(resolveDebit(hidden, bareSub(), clearsAt).failure, undefined);
  });

  it('never succeeds for a customer with no route at all', () => {
    // The silent churner. No number of attempts collects this, which is the point.
    const hidden = personaById('SILENT_CHURNER').materialise(deriveRng(3, 'c'), SIMULATION_START);
    for (let day = 0; day <= 60; day += 1) {
      const at = SIMULATION_START + day * DAY;
      assert.equal(resolveDebit(hidden, bareSub(), at).outcome, 'failure');
    }
  });

  it('succeeds once the customer has cleared the blocker', () => {
    // The reissued card: futile until she updates, viable immediately after.
    const hidden = personaById('REISSUED_CARD').materialise(deriveRng(4, 'd'), SIMULATION_START);
    assert.equal(hidden.retrySucceedsFrom, undefined);

    const remedyAt = SIMULATION_START + 2 * DAY;
    const sub = bareSub({ remedyCompletedAt: remedyAt });

    assert.equal(resolveDebit(hidden, sub, remedyAt - HOUR).outcome, 'failure');
    assert.equal(resolveDebit(hidden, sub, remedyAt).outcome, 'success');
  });
});

/* ------------------------------------------------------------------ *
 * Customer responses
 * ------------------------------------------------------------------ */

describe('customer responses', () => {
  it('answers only the request that would actually help', () => {
    const hidden = personaById('REISSUED_CARD').materialise(deriveRng(5, 'e'), SIMULATION_START);
    assert.ok(wouldRespondTo(hidden, 'REQUEST_CARD_UPDATE'));
    assert.ok(!wouldRespondTo(hidden, 'REQUEST_AFA'));
    assert.equal(customerResponseAt(hidden, 'REQUEST_AFA', SIMULATION_START), null);
  });

  it('responds later when asked later, so timing of the ask matters', () => {
    const hidden = personaById('REISSUED_CARD').materialise(deriveRng(6, 'f'), SIMULATION_START);
    const early = customerResponseAt(hidden, 'REQUEST_CARD_UPDATE', SIMULATION_START);
    const late = customerResponseAt(hidden, 'REQUEST_CARD_UPDATE', SIMULATION_START + 5 * DAY);
    assert.ok(early !== null && late !== null);
    assert.equal(late - early, 5 * DAY);
  });

  it('never responds for a persona that ignores everything', () => {
    for (const id of ['SILENT_CHURNER', 'DELIBERATE_CANCELLER', 'FRAUD_FLAGGED'] as const) {
      const hidden = personaById(id).materialise(deriveRng(7, id), SIMULATION_START);
      for (const kind of ['REQUEST_CARD_UPDATE', 'REQUEST_MANDATE_REAUTH', 'REQUEST_AFA'] as const) {
        assert.equal(customerResponseAt(hidden, kind, SIMULATION_START), null);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * Remedy effects
 * ------------------------------------------------------------------ */

describe('effects of a completed remedy', () => {
  const mandate: MandateState = {
    authorisation: 'active',
    capPaise: 999_00,
    higherAfaCeiling: false,
  };

  it('raises the ceiling above the charge on re-authorisation', () => {
    // Without this the charge stays above the cap and the guardrail keeps
    // refusing, so the request we sent would achieve nothing.
    const updated = applyRemedyToMandate(mandate, 'REQUEST_MANDATE_REAUTH', 1_999_00, SIMULATION_START);
    assert.ok(updated.capPaise > 1_999_00);
  });

  it('never lowers an existing ceiling', () => {
    const generous: MandateState = { ...mandate, capPaise: 90_000_00 };
    const updated = applyRemedyToMandate(generous, 'REQUEST_MANDATE_REAUTH', 499_00, SIMULATION_START);
    assert.equal(updated.capPaise, 90_000_00);
  });

  it('records completed authentication', () => {
    const updated = applyRemedyToMandate(mandate, 'REQUEST_AFA', 20_000_00, SIMULATION_START);
    assert.equal(updated.afaCompletedAt, SIMULATION_START);
  });

  it('leaves the mandate untouched for a card replacement', () => {
    // RBI's 2026 framework permits mapping an existing mandate to a reissued card,
    // so the authorisation itself does not change.
    assert.deepEqual(
      applyRemedyToMandate(mandate, 'REQUEST_CARD_UPDATE', 499_00, SIMULATION_START),
      mandate,
    );
  });
});

/* ------------------------------------------------------------------ *
 * Pauses
 * ------------------------------------------------------------------ */

describe('a paused mandate', () => {
  const paused = personaById('TEMPORARY_PAUSE');

  it('reports paused until it resumes, then active', () => {
    const hidden = paused.materialise(deriveRng(8, 'g'), SIMULATION_START);
    const resumesAt = hidden.selfResolvesAt;
    assert.ok(resumesAt !== undefined);

    assert.equal(authorisationAt(hidden, resumesAt - HOUR), 'paused');
    assert.ok(!hasSelfResolved(hidden, resumesAt - HOUR));

    assert.equal(authorisationAt(hidden, resumesAt), 'active');
    assert.ok(hasSelfResolved(hidden, resumesAt));
  });

  it('becomes collectable at the moment it resumes', () => {
    const hidden = paused.materialise(deriveRng(9, 'h'), SIMULATION_START);
    const resumesAt = hidden.selfResolvesAt;
    assert.ok(resumesAt !== undefined);

    assert.equal(resolveDebit(hidden, bareSub(), resumesAt - HOUR).outcome, 'failure');
    assert.equal(resolveDebit(hidden, bareSub(), resumesAt).outcome, 'success');
  });

  it('leaves other personas unaffected by self-resolution', () => {
    const hidden = personaById('SILENT_CHURNER').materialise(deriveRng(10, 'i'), SIMULATION_START);
    assert.ok(!hasSelfResolved(hidden, SIMULATION_START + 90 * DAY));
    assert.equal(authorisationAt(hidden, SIMULATION_START + 90 * DAY), 'active');
  });
});

/* ------------------------------------------------------------------ *
 * The world must honour every recoverable claim
 * ------------------------------------------------------------------ */

describe('the world delivers on every recoverable claim', () => {
  it('provides a route by which each recoverable case actually succeeds', () => {
    for (const persona of PERSONAS) {
      for (let i = 0; i < 25; i += 1) {
        const rng = deriveRng(hashSeed(persona.id), `route_${i}`);
        const hidden = persona.materialise(rng, SIMULATION_START);
        if (!hidden.recoverable) continue;

        const viaTime = hidden.retrySucceedsFrom;
        if (viaTime !== undefined) {
          assert.equal(
            resolveDebit(hidden, bareSub(), viaTime).outcome,
            'success',
            `${persona.id} claims a time-based route that does not collect`,
          );
          continue;
        }

        // Otherwise it must be recoverable by asking. Simulate the ask landing,
        // the customer acting, and a debit following.
        const requestKind = hidden.respondsTo[0];
        assert.ok(requestKind !== undefined, `${persona.id} claims recoverable with no route`);

        const respondsAt = customerResponseAt(hidden, requestKind, SIMULATION_START);
        assert.ok(respondsAt !== null);

        const outcome = resolveDebit(
          hidden,
          bareSub({ remedyCompletedAt: respondsAt }),
          respondsAt,
        );
        assert.equal(
          outcome.outcome,
          'success',
          `${persona.id} claims a request-based route that does not collect`,
        );
      }
    }
  });

  it('provides no route at all for unrecoverable cases', () => {
    for (const persona of PERSONAS) {
      for (let i = 0; i < 25; i += 1) {
        const rng = deriveRng(hashSeed(persona.id), `noroute_${i}`);
        const hidden = persona.materialise(rng, SIMULATION_START);
        if (hidden.recoverable) continue;

        assert.equal(hidden.retrySucceedsFrom, undefined, `${persona.id} has a hidden time route`);
        assert.equal(hidden.respondsTo.length, 0, `${persona.id} has a hidden request route`);
        assert.equal(hidden.selfResolvesAt, undefined, `${persona.id} self-resolves after all`);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * The cohort
 * ------------------------------------------------------------------ */

describe('cohort generation', () => {
  const opts = { seed: 12345, size: 120, mix: 'balanced' } as const;

  it('is identical for the same seed', () => {
    const a = generateCohort(opts);
    const b = generateCohort(opts);
    assert.deepEqual(a, b);
  });

  it('differs for a different seed', () => {
    const a = generateCohort(opts);
    const b = generateCohort({ ...opts, seed: 999 });
    assert.notDeepEqual(a, b);
  });

  it('produces the requested size and rejects a nonsensical one', () => {
    assert.equal(generateCohort(opts).subscriptions.length, 120);
    assert.throws(() => generateCohort({ ...opts, size: 0 }));
  });

  it('keeps earlier subscriptions stable when the cohort grows', () => {
    // Each subscription draws from a stream keyed by its own id, so extending the
    // cohort must not reshuffle the ones already in it. Otherwise every reported
    // figure moves whenever the generator is touched.
    const small = generateCohort({ ...opts, size: 20 });
    const large = generateCohort({ ...opts, size: 200 });
    assert.deepEqual(small.subscriptions, large.subscriptions.slice(0, 20));
  });

  it('starts every subscription with a clean slate', () => {
    // The engine fires the original charge, which consumes the first of four
    // attempts. Pre-loading an attempt here would quietly shrink the budget.
    for (const s of generateCohort(opts).subscriptions) {
      assert.equal(s.observable.attempts.length, 0);
      assert.equal(s.observable.contacts.length, 0);
      assert.equal(s.observable.state, 'active');
      assert.equal(s.observable.remedyCompletedAt, undefined);
      assert.equal(s.observable.lastPreDebitNotificationAt, undefined);
    }
  });

  it('spreads charge dates rather than stacking them on one instant', () => {
    const dates = new Set(generateCohort(opts).subscriptions.map((s) => s.observable.chargeDate));
    assert.ok(dates.size > 20, `expected varied charge dates, got ${dates.size} distinct`);
  });

  it('gives the mandate room above the charge by default', () => {
    for (const s of generateCohort(opts).subscriptions) {
      if (s.hidden.personaId === 'PLAN_UPGRADE_OVER_CAP') continue;
      assert.ok(
        s.mandateState.capPaise >= s.observable.amountPaise,
        `${s.observable.id} was born already over its cap`,
      );
    }
  });

  it('honours the shapes personas require', () => {
    const cohort = generateCohort({ seed: 777, size: 600, mix: 'balanced' });

    for (const s of cohort.subscriptions) {
      if (s.hidden.personaId === 'PLAN_UPGRADE_OVER_CAP') {
        assert.ok(
          s.observable.amountPaise > s.mandateState.capPaise,
          'plan upgrade must exceed its authorised cap',
        );
      }
      if (s.hidden.personaId === 'AFA_THRESHOLD') {
        assert.ok(
          s.observable.amountPaise > afaCeilingPaise(s.mandateState.higherAfaCeiling),
          'AFA persona must sit above the exemption ceiling',
        );
        assert.ok(s.observable.amountPaise <= s.mandateState.capPaise);
      }
      if (s.hidden.personaId === 'REISSUED_CARD' || s.hidden.personaId === 'SILENT_CHURNER') {
        assert.equal(s.observable.method, 'card');
      }
    }
  });

  it('keeps a discernible funding day only where the persona grants one', () => {
    for (const s of generateCohort(opts).subscriptions) {
      const day = s.observable.history.observedFundingDayOfMonth;
      if (day !== undefined) {
        assert.ok(day >= 1 && day <= 28);
      }
    }
  });

  it('reports a coherent billing history', () => {
    for (const s of generateCohort(opts).subscriptions) {
      const h = s.observable.history;
      assert.equal(
        h.cyclesPaidFirstAttempt + h.cyclesRecoveredAfterRetry + h.cyclesFailed,
        h.cyclesBilled,
      );
      assert.ok(h.cyclesPaidFirstAttempt >= 0);
    }
  });

  it('applies the cap headroom it advertises', () => {
    const cohort = generateCohort(opts);
    const plain = cohort.subscriptions.find(
      (s) => s.hidden.personaId === 'SALARY_CYCLE_SHORTFALL',
    );
    assert.ok(plain !== undefined);
    assert.equal(plain.mandateState.capPaise, plain.observable.amountPaise * MANDATE_CAP_HEADROOM);
  });
});

/* ------------------------------------------------------------------ *
 * Cohort summaries
 * ------------------------------------------------------------------ */

describe('cohort summaries', () => {
  const cohort = generateCohort({ seed: 4242, size: 300, mix: 'balanced' });

  it('never claims more is recoverable than is at risk', () => {
    assert.ok(recoverableAtRiskPaise(cohort) <= totalAtRiskPaise(cohort));
    assert.ok(recoverableAtRiskPaise(cohort) > 0);
  });

  it('leaves a real share unrecoverable, as any honest cohort must', () => {
    // If everything were recoverable the comparison would be meaningless: any
    // strategy that hammered every case would look perfect. Checked by case count
    // rather than by value, since value is the more easily distorted of the two.
    const ratio = recoverableCaseCount(cohort) / cohort.subscriptions.length;
    assert.ok(ratio > 0.4 && ratio < 0.8, `recoverable share ${ratio.toFixed(2)} looks implausible`);
  });

  it('is not dominated by a single large case', () => {
    // Some concentration is structural and cannot be engineered away: the AFA
    // exemption ceiling is Rs 15,000 by regulation, so a persona defined by
    // crossing it is necessarily around thirty times a typical Rs 499
    // subscription. A merchant with mixed price points genuinely looks like this.
    //
    // The threshold is therefore set to catch real pathology - one case carrying a
    // fifth of the cohort - rather than to enforce an artificially flat
    // distribution. The reported figures include case counts alongside money for
    // exactly this reason.
    const share = largestCaseShare(cohort);
    assert.ok(share < 0.1, `largest case holds ${(share * 100).toFixed(1)}% of at-risk money`);
  });

  it('counts every case exactly once across personas', () => {
    const counts = personaBreakdown(cohort);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    assert.equal(total, cohort.subscriptions.length);
  });

  it('shifts the composition when the mix changes', () => {
    const churn = generateCohort({ seed: 4242, size: 300, mix: 'churn_heavy' });
    const funds = generateCohort({ seed: 4242, size: 300, mix: 'funds_heavy' });

    const cancellers = (c: typeof churn) => personaBreakdown(c)['DELIBERATE_CANCELLER'] ?? 0;
    assert.ok(
      cancellers(churn) > cancellers(funds),
      'churn-heavy should contain more deliberate cancellers',
    );
  });
});
