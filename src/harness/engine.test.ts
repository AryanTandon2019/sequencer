/**
 * Tests for the engine and the scorer.
 *
 * This is the largest piece of state-transition code in the project and the one where
 * a mistake is least visible. Nothing here crashes when it goes wrong — an off-by-one
 * in the attempt counter, or a recovery credited twice, produces a believable number
 * and a passing run.
 *
 * So the tests are mostly about accounting rather than features: that the original
 * charge consumes exactly one of the four permitted attempts, that money is credited
 * once, that a terminal case stops being consulted, and that the invariant checks
 * actually fire when handed a corrupted result.
 *
 * Strategies are scripted stubs, so each behaviour can be driven directly rather than
 * hoped for.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAX_ATTEMPTS_PER_MANDATE_CYCLE } from '../domain/regulation.js';
import type { Action, MandateState, Millis, ObservableSubscription } from '../domain/types.js';
import type { Cohort, SimulatedSubscription } from '../sim/cohort.js';
import { personaById, type PersonaId } from '../sim/personas.js';
import { deriveRng } from '../sim/rng.js';
import { createAgentStrategy } from '../strategies/agent.js';
import { baselineStrategy } from '../strategies/baseline.js';
import { createOracleStrategy } from '../strategies/oracle.js';
import { action, type Strategy, type StrategyProposal } from '../strategies/strategy.js';
import { deterministicDiagnoser } from '../diagnosis/deterministic.js';
import { runStrategy, type CaseResult, type RunResult } from './engine.js';
import { checkInvariants, scoreRun } from './score.js';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const START: Millis = Date.UTC(2026, 8, 5, 4, 30);
const HOUR: Millis = 60 * 60 * 1000;
const DAY: Millis = 24 * HOUR;
const END: Millis = START + 40 * DAY;

/**
 * A cohort of chosen personas rather than a random draw.
 *
 * Random cohorts are right for measuring; scripted ones are right for testing, because
 * a test that only sometimes exercises the branch it names is not a test.
 */
function cohortOf(
  entries: readonly { personaId: PersonaId; amountPaise?: number }[],
): Cohort {
  const subscriptions: SimulatedSubscription[] = entries.map((entry, i) => {
    const id = `sub_${String(i + 1).padStart(4, '0')}`;
    const persona = personaById(entry.personaId);
    const rng = deriveRng(1234, id);
    const shape = persona.shape(rng);
    const hidden = persona.materialise(rng, START, shape);

    const amountPaise = entry.amountPaise ?? shape.amountPaise ?? 999_00;
    const observable: ObservableSubscription = {
      id,
      customerId: `cust_${i}`,
      method: shape.method ?? 'card',
      amountPaise,
      chargeDate: START,
      state: 'active',
      attempts: [],
      contacts: [],
      history: {
        cyclesBilled: 8,
        cyclesPaidFirstAttempt: 6,
        cyclesRecoveredAfterRetry: 2,
        cyclesFailed: 0,
        ...(shape.fundingDayOfMonth === undefined
          ? {}
          : { observedFundingDayOfMonth: shape.fundingDayOfMonth }),
      },
    };

    const mandateState: MandateState = {
      authorisation: hidden.authorisation,
      capPaise: shape.capPaise ?? amountPaise * 3,
      higherAfaCeiling: shape.higherAfaCeiling ?? false,
    };

    return { observable, mandateState, hidden, personaLabel: persona.label };
  });

  return { seed: 1234, mix: 'balanced', subscriptions };
}

/** A strategy that always proposes the same thing, and counts consultations. */
function scripted(
  candidates: readonly Action[] | ((n: number) => readonly Action[]),
  name = 'scripted',
): Strategy & { consultations: number } {
  const s = {
    name,
    description: 'scripted stub for tests, long enough to satisfy the interface',
    consultations: 0,
    propose(): StrategyProposal {
      s.consultations += 1;
      return {
        diagnosis: null,
        candidates: typeof candidates === 'function' ? candidates(s.consultations) : candidates,
      };
    },
  };
  return s;
}

function only(run: RunResult): CaseResult {
  const first = run.cases[0];
  assert.ok(first !== undefined, 'expected at least one case');
  return first;
}

const run = (strategy: Strategy, cohort: Cohort) =>
  runStrategy({ strategy, cohort, startAt: START, endAt: END });

/* ------------------------------------------------------------------ *
 * The original charge
 * ------------------------------------------------------------------ */

describe('the original charge', () => {
  it('consumes exactly one of the four permitted attempts', async () => {
    // The budget starts at the scheduled debit, not at the first retry. Getting this
    // wrong would silently hand every strategy a fifth attempt.
    const result = await run(scripted([action('WAIT', 'do nothing at all, ever')]), cohortOf([
      { personaId: 'SILENT_CHURNER' },
    ]));
    assert.equal(only(result).attemptsUsed, 1);
  });

  it('records that recovery was needed once it fails', async () => {
    const result = await run(scripted([action('WAIT', 'do nothing at all, ever')]), cohortOf([
      { personaId: 'SILENT_CHURNER' },
    ]));
    assert.equal(only(result).neededRecovery, true);
  });

  it('issues the pre-debit notice as platform behaviour', async () => {
    // Not a strategy decision. Both the default and the agent operate on top of it,
    // and a strategy that never asked for one must still be able to debit lawfully.
    const strategy = scripted([action('RETRY_NOW', 'charge immediately, notice or not')]);
    const result = await run(strategy, cohortOf([{ personaId: 'BANK_OUTAGE' }]));

    // A retry landed at all, which is only possible if a notice existed and matured.
    assert.ok(only(result).attemptsUsed > 1, 'no retry ever landed, so no notice was issued');
  });
});

/* ------------------------------------------------------------------ *
 * The attempt budget
 * ------------------------------------------------------------------ */

describe('the attempt budget', () => {
  it('never exceeds four however hard a strategy pushes', async () => {
    // The single most important accounting property. A strategy that asks for a debit
    // on every consultation must still be capped.
    const greedy = scripted([action('RETRY_NOW', 'retry relentlessly, forever, always')]);
    const result = await run(
      greedy,
      cohortOf([
        { personaId: 'CHRONIC_SHORTFALL' },
        { personaId: 'SILENT_CHURNER' },
        { personaId: 'SALARY_CYCLE_SHORTFALL' },
      ]),
    );

    for (const c of result.cases) {
      assert.ok(
        c.attemptsUsed <= MAX_ATTEMPTS_PER_MANDATE_CYCLE,
        `${c.id} used ${c.attemptsUsed} attempts`,
      );
    }
    assert.ok(greedy.consultations > 10, 'strategy should have been consulted repeatedly');
  });

  it('spends nothing on a hard decline, because the guardrail refuses every retry', async () => {
    // A greedy strategy asking to retry a dead card gets nowhere. The budget is
    // preserved not by the strategy's restraint but by the rule, which is the point of
    // having the rule — and the reason a cause-blind policy still cannot burn attempts
    // on instruments that can never approve.
    const greedy = scripted([action('RETRY_NOW', 'retry relentlessly, forever, always')]);
    const result = await run(greedy, cohortOf([{ personaId: 'SILENT_CHURNER' }]));
    const c = only(result);

    assert.equal(c.attemptsUsed, 1, 'only the original charge should have landed');
    assert.equal(c.recoveredPaise, 0);
    assert.ok(c.blockedHardDeclineRetries > 0, 'refusals should be recorded');
  });

  it('exhausts the budget when retries are permitted but keep failing', async () => {
    // A soft decline is retryable, so a greedy strategy really can spend all four.
    const greedy = scripted([action('RETRY_NOW', 'retry relentlessly, forever, always')]);
    const result = await run(greedy, cohortOf([{ personaId: 'CHRONIC_SHORTFALL' }]));
    const c = only(result);

    assert.equal(
      c.attemptsUsed,
      MAX_ATTEMPTS_PER_MANDATE_CYCLE,
      'a permitted retry loop should reach the cap exactly',
    );
  });
});

/* ------------------------------------------------------------------ *
 * Money
 * ------------------------------------------------------------------ */

describe('recovery accounting', () => {
  it('credits the full charge exactly once', async () => {
    const cohort = cohortOf([{ personaId: 'BANK_OUTAGE', amountPaise: 1_499_00 }]);
    const result = await run(scripted([action('RETRY_NOW', 'retry until it works, please')]), cohort);
    const c = only(result);

    assert.equal(c.recoveredPaise, 1_499_00);
    assert.equal(c.outcome, 'recovered');
    assert.equal(c.finalState, 'recovered');
  });

  it('stops consulting a case once it is terminal', async () => {
    // Otherwise a recovered case could be credited again on a later tick.
    const strategy = scripted([action('RETRY_NOW', 'retry until it works, please')]);
    const result = await run(strategy, cohortOf([{ personaId: 'BANK_OUTAGE' }]));

    const c = only(result);
    assert.equal(c.recoveredPaise, c.amountPaise);
    // A 40-day window at 12-hour reconsideration would be ~80 consultations if the
    // case never closed.
    assert.ok(strategy.consultations < 20, `kept consulting after recovery: ${strategy.consultations}`);
  });

  it('never credits money on a case the world says is unrecoverable', async () => {
    const result = await run(
      scripted([action('RETRY_NOW', 'retry relentlessly, forever, always')]),
      cohortOf([
        { personaId: 'SILENT_CHURNER' },
        { personaId: 'DELIBERATE_CANCELLER' },
        { personaId: 'FRAUD_FLAGGED' },
      ]),
    );

    for (const c of result.cases) {
      assert.equal(c.recoveredPaise, 0, `${c.personaId} was credited money it never had`);
    }
  });
});

/* ------------------------------------------------------------------ *
 * World events
 * ------------------------------------------------------------------ */

describe('world events', () => {
  it('recovers a paused mandate without any action being taken', async () => {
    // The case that punishes acting. Doing literally nothing collects the money.
    const passive = scripted([action('WAIT', 'deliberately do nothing whatsoever')]);
    const result = await run(passive, cohortOf([{ personaId: 'TEMPORARY_PAUSE' }]));
    const c = only(result);

    assert.equal(c.outcome, 'recovered');
    assert.equal(c.attemptsUsed, 1, 'no attempt should have been spent');
    assert.equal(c.contactsSent, 0);
  });

  it('turns a request into a recovery once the customer responds', async () => {
    // The full remedy loop: ask, wait, customer acts, retry succeeds.
    const strategy = createAgentStrategy(deterministicDiagnoser);
    const result = await run(strategy, cohortOf([{ personaId: 'REISSUED_CARD' }]));
    const c = only(result);

    assert.equal(c.outcome, 'recovered');
    assert.ok(c.contactsSent >= 1, 'should have asked for a card update');
  });

  it('raises the authorised ceiling after re-authorisation', async () => {
    // Without the mandate actually changing, the guardrail would keep refusing and the
    // request we sent would have achieved nothing.
    const strategy = createAgentStrategy(deterministicDiagnoser);
    const result = await run(strategy, cohortOf([{ personaId: 'PLAN_UPGRADE_OVER_CAP' }]));
    assert.equal(only(result).outcome, 'recovered');
  });
});

/* ------------------------------------------------------------------ *
 * Adjudication
 * ------------------------------------------------------------------ */

describe('every proposal is adjudicated', () => {
  it('refuses a debit against a revoked mandate and records why', async () => {
    const strategy = scripted([action('RETRY_NOW', 'charge them regardless of consent')]);
    const result = await run(strategy, cohortOf([{ personaId: 'DELIBERATE_CANCELLER' }]));
    const c = only(result);

    assert.ok(c.refusedProposals > 0, 'the guardrails should have refused this');
    assert.equal(c.recoveredPaise, 0);
  });

  it('counts a blocked message to a withdrawn-consent customer', async () => {
    const strategy = scripted([action('REQUEST_CARD_UPDATE', 'email them about their card')]);
    const result = await run(strategy, cohortOf([{ personaId: 'DELIBERATE_CANCELLER' }]));
    const c = only(result);

    assert.ok(c.blockedHarmfulProposals > 0);
    assert.equal(c.harmfulContacts, 0, 'nothing should have actually reached them');
  });

  it('counts a blocked reattempt on a hard decline', async () => {
    const strategy = scripted([action('RETRY_NOW', 'retry the dead card anyway please')]);
    const result = await run(strategy, cohortOf([{ personaId: 'REISSUED_CARD' }]));
    assert.ok(only(result).blockedHardDeclineRetries > 0);
  });

  it('records a decision even when every candidate is refused', async () => {
    // "There was nothing we were permitted to do" is a result, not a gap.
    const strategy = scripted([action('RETRY_NOW', 'charge them regardless of consent')]);
    const result = await run(strategy, cohortOf([{ personaId: 'DELIBERATE_CANCELLER' }]));
    const decisions = only(result).decisions;

    assert.ok(decisions.length > 0);
    assert.ok(decisions.some((d) => d.executed === null && d.rulings.length > 0));
  });

  it('derives an enforcement cause even for a strategy that does not diagnose', async () => {
    // A strategy cannot escape a cause-based rule by staying silent.
    const strategy = scripted([action('RETRY_NOW', 'retry the dead card anyway please')]);
    const result = await run(strategy, cohortOf([{ personaId: 'REISSUED_CARD' }]));
    const decision = only(result).decisions[0];

    assert.ok(decision !== undefined);
    assert.equal(decision.diagnosis, null, 'this stub forms no view');
    assert.equal(decision.enforcementCause, 'CARD_EXPIRED', 'the platform classified it anyway');
  });
});

/* ------------------------------------------------------------------ *
 * Safety
 * ------------------------------------------------------------------ */

describe('safety valves', () => {
  it('fails loudly on a strategy that never resolves anything', async () => {
    // A silent hang or an unresolved case would be worse: the run would finish and the
    // numbers would quietly be wrong.
    await assert.rejects(
      () =>
        runStrategy({
          strategy: scripted([action('WAIT', 'wait forever and ever and ever')]),
          cohort: cohortOf([{ personaId: 'SILENT_CHURNER' }]),
          startAt: START,
          endAt: END,
          maxDecisionsPerCase: 5,
        }),
      /looping rather than deciding/,
    );
  });

  it('rejects an oracle built from a different cohort', async () => {
    // A silent mismatch would turn the ceiling into a guess.
    const oracle = createOracleStrategy({ hiddenBySubscriptionId: new Map() });
    await assert.rejects(
      () => run(oracle, cohortOf([{ personaId: 'BANK_OUTAGE' }])),
      /same cohort/,
    );
  });
});

/* ------------------------------------------------------------------ *
 * Determinism
 * ------------------------------------------------------------------ */

describe('determinism', () => {
  it('produces identical results for identical inputs', async () => {
    // Without this no reported figure is checkable by anyone.
    const build = () =>
      cohortOf([
        { personaId: 'SALARY_CYCLE_SHORTFALL' },
        { personaId: 'REISSUED_CARD' },
        { personaId: 'BANK_OUTAGE' },
        { personaId: 'DELIBERATE_CANCELLER' },
      ]);

    const a = await run(createAgentStrategy(deterministicDiagnoser), build());
    const b = await run(createAgentStrategy(deterministicDiagnoser), build());
    assert.deepEqual(a.cases, b.cases);
  });
});

/* ------------------------------------------------------------------ *
 * Scoring
 * ------------------------------------------------------------------ */

describe('scoring', () => {
  const cohort = cohortOf([
    { personaId: 'SALARY_CYCLE_SHORTFALL' },
    { personaId: 'REISSUED_CARD' },
    { personaId: 'BANK_OUTAGE' },
    { personaId: 'SILENT_CHURNER' },
    { personaId: 'DELIBERATE_CANCELLER' },
  ]);

  it('accounts for every case exactly once across outcomes', async () => {
    const score = scoreRun(await run(createAgentStrategy(deterministicDiagnoser), cohort), cohort);
    const total = Object.values(score.outcomes).reduce((a, b) => a + b, 0);
    assert.equal(total, score.cases);
  });

  it('never reports capture above one', async () => {
    const score = scoreRun(await run(createAgentStrategy(deterministicDiagnoser), cohort), cohort);
    assert.ok(score.captureOfCeiling <= 1);
    assert.ok(score.captureOfCeilingByCase <= 1);
  });

  it('gives a non-diagnosing strategy no confusion matrix', async () => {
    // Fabricating one would credit a calendar with an opinion it does not hold.
    const score = scoreRun(await run(baselineStrategy, cohort), cohort);
    assert.equal(score.confusion, null);
  });

  it('scores diagnosis for a strategy that does form a view', async () => {
    const score = scoreRun(await run(createAgentStrategy(deterministicDiagnoser), cohort), cohort);
    assert.ok(score.confusion !== null);
    assert.ok(score.confusion.total > 0);
  });

  it('excludes the original charge from wasted attempts', async () => {
    // It happens regardless of any policy, so charging a strategy for it would penalise
    // every one of them for something none of them chose.
    const passive = scripted([action('WAIT', 'deliberately do nothing whatsoever')]);
    const score = scoreRun(
      await run(passive, cohortOf([{ personaId: 'SILENT_CHURNER' }])),
      cohortOf([{ personaId: 'SILENT_CHURNER' }]),
    );
    assert.equal(score.attemptsWasted, 0);
  });
});

/* ------------------------------------------------------------------ *
 * Invariants must actually fire
 * ------------------------------------------------------------------ */

describe('the invariant checks catch corruption', () => {
  const cohort = cohortOf([{ personaId: 'BANK_OUTAGE' }, { personaId: 'SILENT_CHURNER' }]);

  it('passes a clean run', async () => {
    const r = await run(createAgentStrategy(deterministicDiagnoser), cohort);
    assert.deepEqual(checkInvariants([scoreRun(r, cohort)], [r]), []);
  });

  it('catches a case that overspent its attempt budget', async () => {
    const r = await run(createAgentStrategy(deterministicDiagnoser), cohort);
    const first = r.cases[0];
    assert.ok(first !== undefined);

    const corrupted: RunResult = {
      ...r,
      cases: [{ ...first, attemptsUsed: 9 }, ...r.cases.slice(1)],
    };
    const violations = checkInvariants([scoreRun(corrupted, cohort)], [corrupted]);
    assert.ok(violations.some((v) => /9 attempts/.test(v)), violations.join('; '));
  });

  it('catches money credited beyond the charge', async () => {
    const r = await run(createAgentStrategy(deterministicDiagnoser), cohort);
    const first = r.cases[0];
    assert.ok(first !== undefined);

    const corrupted: RunResult = {
      ...r,
      cases: [{ ...first, recoveredPaise: first.amountPaise * 3 }, ...r.cases.slice(1)],
    };
    const violations = checkInvariants([scoreRun(corrupted, cohort)], [corrupted]);
    assert.ok(violations.length > 0);
  });

  it('catches money collected from an unrecoverable case', async () => {
    const r = await run(createAgentStrategy(deterministicDiagnoser), cohort);
    const churner = r.cases.find((c) => !c.recoverable);
    assert.ok(churner !== undefined);

    const corrupted: RunResult = {
      ...r,
      cases: r.cases.map((c) =>
        c.id === churner.id ? { ...c, recoveredPaise: c.amountPaise } : c,
      ),
    };
    const violations = checkInvariants([scoreRun(corrupted, cohort)], [corrupted]);
    assert.ok(violations.some((v) => /unrecoverable/.test(v)), violations.join('; '));
  });

  it('catches an agent that beat the oracle', async () => {
    // Impossible if the oracle has perfect diagnosis and the same policy, so it means
    // one of those two things has stopped being true.
    const hiddenBySubscriptionId = new Map(
      cohort.subscriptions.map((s) => [s.observable.id, s.hidden]),
    );
    const agentRun = await run(createAgentStrategy(deterministicDiagnoser), cohort);
    const oracleRun = await run(createOracleStrategy({ hiddenBySubscriptionId }), cohort);

    const inflatedAgent = scoreRun(agentRun, cohort);
    const oracleScore = scoreRun(oracleRun, cohort);
    const violations = checkInvariants(
      [{ ...inflatedAgent, recoveredPaise: oracleScore.recoveredPaise + 1 }, oracleScore],
      [],
    );
    assert.ok(violations.some((v) => /more than the oracle/.test(v)), violations.join('; '));
  });

  it('catches a message that reached a withdrawn-consent customer', async () => {
    const r = await run(createAgentStrategy(deterministicDiagnoser), cohort);
    const score = scoreRun(r, cohort);
    const violations = checkInvariants([{ ...score, harmfulContacts: 3 }], []);
    assert.ok(violations.some((v) => /withdrawn consent/.test(v)), violations.join('; '));
  });
});
