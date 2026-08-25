#!/usr/bin/env node
/**
 * Confidence-floor sensitivity.
 *
 *   npm run floors            deterministic, free, reproducible
 *   npm run floors -- --llm   adds the reasoning layer, needs OPENAI_API_KEY
 *
 * Runs the agent over the holdout cohort at three floors — 0.5, 0.7 and 0.9 —
 * against one baseline run and one oracle run for reference, and reports whether
 * the conclusion survives.
 *
 * This exists because the floor is the one guardrail with no external citation.
 * Every other rule is someone else's law; this one is our choice, and an unexamined
 * choice standing between a diagnosis and money is exactly the kind of number a
 * reviewer should ask about. The code comments said the sensitivity was worth
 * reporting before it was reported, which is the wrong way round — this closes that.
 *
 * Two regimes, stated separately rather than blurred:
 *
 *   Deterministic path. The lookup diagnoser emits only 0.95 and 0.99 on this
 *   cohort — its one low-confidence basis (`step_signal`, 0.6) requires an
 *   unrecognised reason string at the authentication step, which no persona
 *   produces. So the expected result here is that the floor NEVER fires and all
 *   three rows are identical. That identical table IS the finding: the shipped
 *   default does no silent work on the deterministic path, and the conclusion
 *   cannot depend on the knob. A connectivity probe below proves the zero is real
 *   rather than a disconnected option being reported as zeros.
 *
 *   Reasoning layer (--llm). Model confidences span 0..1, which is the regime the
 *   floor was built to govern. Here the rows are expected to differ, and what the
 *   strict floor costs in recoveries is measured in rupees. Nondeterministic at
 *   temperature 0.2, so figures move slightly between runs.
 */

import 'dotenv/config';

import { COHORT_SIZE, HOLDOUT_SEED } from '../config.js';
import { deliberateFailure } from '../application/deliberate-failure.js';
import { deterministicDiagnoser } from '../diagnosis/deterministic.js';
import { createLlmDiagnoser, createOpenAiClient } from '../diagnosis/llm.js';
import { MIN_CONFIDENCE_FOR_AUTONOMOUS_ACTION } from '../domain/regulation.js';
import type { MandateState, ObservableSubscription, ObservedFailure } from '../domain/types.js';
import { generateCohort, type Cohort } from '../sim/cohort.js';
import { createAgentStrategy } from '../strategies/agent.js';
import { baselineStrategy } from '../strategies/baseline.js';
import type { Strategy, StrategyInput } from '../strategies/strategy.js';
import { createOracleStrategy } from '../strategies/oracle.js';
import { runStrategy, type RunResult } from './engine.js';
import { inr } from './report.js';
import { checkInvariants, scoreRun, type StrategyScore } from './score.js';

/** Permissive / shipped default / strict, relative to the confidences each layer emits. */
const FLOORS: readonly number[] = [0.5, MIN_CONFIDENCE_FOR_AUTONOMOUS_ACTION, 0.9];

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function padLeft(text: string, width: number): string {
  return text.length >= width ? text : ' '.repeat(width - text.length) + text;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

const RULE = '─'.repeat(78);

/* ------------------------------------------------------------------ *
 * Connectivity probe
 *
 * A table of zeros proves nothing on its own — a silently dropped option
 * produces the same table as a knob that genuinely never binds. One fixed,
 * deliberately mediocre proposal, adjudicated through the same entry point the
 * engine uses, must clear the lax floor and be refused by the strict one. If
 * it is not, the option did not reach the guardrail and every row above it is
 * decoration.
 * ------------------------------------------------------------------ */

const PROBE_CONFIDENCE = 0.8;

const probeStrategy: Strategy = {
  name: 'floor-probe',
  description: 'fixed-confidence proposal used only to verify the floor is connected',
  propose: (): ReturnType<Strategy['propose']> => ({
    diagnosis: {
      cause: 'INSUFFICIENT_FUNDS',
      recoverability: 'RETRY_VIABLE',
      confidence: PROBE_CONFIDENCE,
      reasoning: 'connectivity probe, not a clinical opinion',
      source: 'deterministic',
    },
    candidates: [
      { kind: 'RETRY_NOW', rationale: 'probe candidate; adjudication of this action is the point' },
    ],
  }),
};

function probeInput(): StrategyInput {
  const NOW = Date.UTC(2026, 8, 5, 4, 30);
  const DAY = 24 * 60 * 60 * 1000;
  const failure: ObservedFailure = {
    code: 'BAD_REQUEST_ERROR',
    reason: 'insufficient_funds',
    source: 'bank',
    step: 'payment_authorization',
    description: 'connectivity probe',
    at: NOW,
  };
  const sub: ObservableSubscription = {
    id: 'sub_floor_probe',
    customerId: 'cust_floor_probe',
    method: 'card',
    amountPaise: 49_900,
    chargeDate: NOW,
    state: 'pending',
    attempts: [{ sequenceNo: 1, at: NOW, outcome: 'failure', failure }],
    contacts: [],
    lastPreDebitNotificationAt: NOW - 2 * DAY,
    history: {
      cyclesBilled: 6,
      cyclesPaidFirstAttempt: 6,
      cyclesRecoveredAfterRetry: 0,
      cyclesFailed: 0,
    },
  };
  const mandateState: MandateState = {
    authorisation: 'active',
    capPaise: 99_900,
    higherAfaCeiling: false,
  };
  return { sub, mandateState, failure, now: NOW };
}

async function probeConnected(): Promise<boolean> {
  const lax = await deliberateFailure(probeInput(), probeStrategy, { confidenceFloor: 0.5 });
  const strict = await deliberateFailure(probeInput(), probeStrategy, { confidenceFloor: 0.9 });
  return lax.wouldExecute?.kind === 'RETRY_NOW' && strict.wouldExecute === null;
}

/* ------------------------------------------------------------------ *
 * The analysis
 * ------------------------------------------------------------------ */

interface FloorResult {
  readonly floor: number;
  readonly score: StrategyScore;
  readonly run: RunResult;
  /** Proposals refused by the confidence floor specifically, at any ruling. */
  readonly floorRefusals: number;
}

function countFloorRefusals(run: RunResult): number {
  let n = 0;
  for (const c of run.cases) {
    for (const d of c.decisions) {
      for (const ruling of d.rulings) {
        n += ruling.rejections.filter((r) => r.rule === 'CONFIDENCE_FLOOR').length;
      }
    }
  }
  return n;
}

async function main(): Promise<number> {
  const useLlm = process.argv.slice(2).includes('--llm');

  const cohort: Cohort = generateCohort({ seed: HOLDOUT_SEED, size: COHORT_SIZE, mix: 'balanced' });
  const hiddenBySubscriptionId = new Map(
    cohort.subscriptions.map((s) => [s.observable.id, s.hidden]),
  );

  // Reference rows. Neither the baseline nor the oracle forms diagnoses whose
  // confidence varies with the floor, so both are floor-invariant by construction;
  // each is run once rather than once per floor.
  const baselineRun = await runStrategy({ strategy: baselineStrategy, cohort });
  const baseline = scoreRun(baselineRun, cohort);

  const oracleRun = await runStrategy({
    strategy: createOracleStrategy({ hiddenBySubscriptionId }),
    cohort,
  });
  const oracle = scoreRun(oracleRun, cohort);

  let llmModel: string | null = null;
  const llmStats: ReturnType<typeof createLlmDiagnoser>['stats'][] = [];

  const results: FloorResult[] = [];
  for (const floor of FLOORS) {
    let diagnose = deterministicDiagnoser;
    if (useLlm) {
      const apiKey = process.env['OPENAI_API_KEY'];
      if (apiKey === undefined || apiKey.trim() === '') {
        throw new Error(
          '--llm needs OPENAI_API_KEY. Copy .env.example to .env and put your key there.',
        );
      }
      llmModel = process.env['SEQUENCER_MODEL'] ?? 'gpt-5.4-mini';
      // A fresh layer per floor, so call counts describe one floor each rather
      // than being entangled through a shared cache. Stats are read after the
      // run, since they are accumulated by it.
      const layered = createLlmDiagnoser({
        client: createOpenAiClient({ apiKey, model: llmModel }),
        fallbackTo: deterministicDiagnoser,
      });
      llmStats.push(layered.stats);
      diagnose = layered.diagnose;
    }

    const run = await runStrategy({
      strategy: createAgentStrategy(diagnose),
      cohort,
      confidenceFloor: floor,
    });
    results.push({
      floor,
      score: scoreRun(run, cohort),
      run,
      floorRefusals: countFloorRefusals(run),
    });
  }

  const totalLlmCalls = llmStats.reduce((a, s) => a + s.calls, 0);
  const totalCacheHits = llmStats.reduce((a, s) => a + s.cacheHits, 0);

  /* -------------------------------------------------------------- *
   * Report
   * -------------------------------------------------------------- */

  const out: string[] = ['', RULE, 'SENSITIVITY TO THE CONFIDENCE FLOOR', RULE];
  out.push(
    '',
    "  The floor is the only guardrail that is ours rather than a regulator's, so its",
    '  effect on the headline number is measured rather than assumed.',
    '',
    `  Mode: ${useLlm ? `reasoning layer enabled (${llmModel})` : 'deterministic diagnosis only'}.`,
    '',
    `  Floors: ${FLOORS.map((f) => f.toFixed(2)).join(', ')}. ${FLOORS[0]} permits everything`,
    '  either diagnoser will ever claim; 0.90 refuses every stage-inferred deterministic',
    '  diagnosis outright and challenges most of what a model claims; 0.70 sits between',
    '  them as the shipped default.',
    ...(useLlm
      ? [`  Model use across the three runs: ${totalLlmCalls} calls, ${totalCacheHits} cached.`]
      : []),
  );

  out.push('', RULE, 'AGENT AT EACH FLOOR vs FLOOR-INVARIANT REFERENCES', RULE);
  out.push(
    `  ${pad('FLOOR', 8)}${padLeft('CAPTURE', 10)}${padLeft('CASES', 9)}${padLeft('ATTEMPTS', 11)}` +
      `${padLeft('₹/ATT', 9)}${padLeft('FLOOR REFUSALS', 17)}${padLeft('VS BASELINE', 14)}${padLeft('VS ORACLE', 12)}`,
  );

  for (const r of results) {
    const marker = r.floor === MIN_CONFIDENCE_FOR_AUTONOMOUS_ACTION ? '*' : ' ';
    const gain = r.score.captureOfCeiling - baseline.captureOfCeiling;
    const gapToCeiling = oracle.captureOfCeiling - r.score.captureOfCeiling;
    out.push(
      ` ${marker}${r.floor.toFixed(2)}${padLeft(pct(r.score.captureOfCeiling), 10)}` +
        `${padLeft(String(r.score.recoveredCases), 9)}${padLeft(String(r.score.attemptsUsed), 11)}` +
        `${padLeft(inr(r.score.paisePerAttempt), 9)}${padLeft(String(r.floorRefusals), 17)}` +
        `${padLeft(`+${pct(gain)}`, 14)}${padLeft(`-${pct(gapToCeiling)}`, 12)}`,
    );
  }
  for (const ref of [baseline, oracle]) {
    out.push(
      `  ${pad('(ref)', 8)}${padLeft(pct(ref.captureOfCeiling), 10)}` +
        `${padLeft(String(ref.recoveredCases), 9)}${padLeft(String(ref.attemptsUsed), 11)}` +
        `${padLeft(inr(ref.paisePerAttempt), 9)}${padLeft('—', 17)}` +
        `${padLeft('—', 14)}${padLeft('—', 12)}  ${ref.strategy}`,
    );
  }
  out.push('', '  * shipped default');

  /* -------------------------------------------------------------- *
   * The claims, checked
   * -------------------------------------------------------------- */

  const failures: string[] = [];

  for (const r of results) {
    if (!(r.score.captureOfCeiling > baseline.captureOfCeiling)) {
      failures.push(`floor ${r.floor}: agent did not beat the baseline`);
    }
    if (!(r.score.attemptsUsed < baseline.attemptsUsed)) {
      failures.push(`floor ${r.floor}: agent spent at least as many attempts as the baseline`);
    }
    if (r.score.captureOfCeiling > oracle.captureOfCeiling) {
      failures.push(`floor ${r.floor}: agent exceeded the oracle, which cannot happen`);
    }
    if (r.score.harmfulContacts > 0) {
      failures.push(`floor ${r.floor}: a message reached a withdrawn-consent customer`);
    }
    for (const violation of checkInvariants([r.score], [r.run])) {
      failures.push(`floor ${r.floor}: ${violation}`);
    }
  }
  if (baseline.harmfulContacts > 0 || oracle.harmfulContacts > 0) {
    failures.push('a reference run reached a withdrawn-consent customer');
  }

  // The knob must reach the guardrail, or every number above is decoration.
  if (!(await probeConnected())) {
    failures.push(
      `a ${PROBE_CONFIDENCE.toFixed(2)}-confidence proposal was not refused at floor 0.90 ` +
        'while permitted at 0.50, so the floor option is not reaching adjudication',
    );
  }

  out.push('', RULE);
  if (failures.length === 0) {
    out.push('CONCLUSION HOLDS AT EVERY FLOOR MEASURED', RULE);
    out.push(
      '',
      '  Across floors the policy was never tuned against — including 0.50, where the',
      '  floor cannot fire at all — the agent recovers a larger share of the achievable',
      "  ceiling than Razorpay's documented default, on strictly fewer attempts, and",
      '  never exceeds the oracle.',
      '',
    );
    if (!useLlm) {
      const allZero = results.every((r) => r.floorRefusals === 0);
      out.push(
        allZero
          ? '  On this path the floor never fired: the deterministic diagnoser claims only'
          : '  On this path the floor fired only rarely: the deterministic diagnoser claims',
        allZero
          ? '  0.95 and 0.99 on this cohort, so the shipped default is doing no silent work.'
          : '  little below the default floor, so the shipped default is doing little silent work.',
        '  The conclusion is therefore independent of the internal threshold, not lucky',
        '  under it. Run with --llm to measure the regime the floor exists for, where a',
        '  model may claim any confidence and the knob genuinely trades recoveries',
        '  against restraint.',
      );
    } else {
      out.push(
        '  With the reasoning layer active, the floor binds: stricter floors refuse',
        '  more proposals and give up recoveries for restraint. The rupee cost of that',
        '  trade at each floor is the column to read when choosing the value.',
      );
    }
  } else {
    out.push(`CONCLUSION DOES NOT HOLD — ${failures.length} FAILURE(S)`, RULE);
    out.push('', ...failures.map((f) => `  ✗ ${f}`));
    out.push(
      '',
      '  The result depends on the internal floor value, which means the README would',
      '  have to say so rather than presenting the default as if it were free.',
    );
  }

  out.push('');
  console.log(out.join('\n'));
  return failures.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  });
