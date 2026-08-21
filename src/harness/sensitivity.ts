#!/usr/bin/env node
/**
 * Sensitivity analysis.
 *
 *   npm run sensitivity
 *
 * Runs the same comparison over three deliberately different cohort compositions and
 * reports whether the conclusion survives.
 *
 * This exists to answer the sharpest objection to the whole project: that the persona
 * mix was chosen to flatter the result. It is a fair objection — the response rates and
 * the weights are ours, not data. So the claim being defended is narrower and more
 * durable than "the agent recovers 80%":
 *
 *   the ordering holds regardless of composition
 *
 * A result that only appears at one invented distribution is not a result. One that
 * holds when cancellations dominate, and again when transient failures dominate, is
 * telling you something about the policy rather than about the cohort.
 *
 * Deterministic diagnosis only, so this is free to run, needs no API key, and gives
 * identical numbers to anyone who runs it.
 */

import { COHORT_SIZE, HOLDOUT_SEED } from '../config.js';
import { deterministicDiagnoser } from '../diagnosis/deterministic.js';
import { generateCohort, personaBreakdown, type Cohort } from '../sim/cohort.js';
import type { MixName } from '../sim/personas.js';
import { createAgentStrategy } from '../strategies/agent.js';
import { baselineStrategy } from '../strategies/baseline.js';
import { createOracleStrategy } from '../strategies/oracle.js';
import { runStrategy } from './engine.js';
import { inr } from './report.js';
import { checkInvariants, scoreRun, type StrategyScore } from './score.js';

const MIXES: readonly MixName[] = ['balanced', 'churn_heavy', 'funds_heavy'];

const MIX_NOTES: Readonly<Record<MixName, string>> = {
  balanced: 'each persona at its declared weight',
  churn_heavy: 'cancellations and dead cards dominate — rewards restraint, punishes chasing',
  funds_heavy: 'transient and balance failures dominate — rewards good retry timing',
};

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

interface MixResult {
  readonly mix: MixName;
  readonly cohort: Cohort;
  readonly scores: readonly StrategyScore[];
  readonly violations: readonly string[];
}

async function runMix(mix: MixName): Promise<MixResult> {
  const cohort = generateCohort({ seed: HOLDOUT_SEED, size: COHORT_SIZE, mix });
  const hiddenBySubscriptionId = new Map(
    cohort.subscriptions.map((s) => [s.observable.id, s.hidden]),
  );

  const strategies = [
    baselineStrategy,
    createAgentStrategy(deterministicDiagnoser),
    createOracleStrategy({ hiddenBySubscriptionId }),
  ];

  const runs = [];
  const scores = [];
  for (const strategy of strategies) {
    const run = await runStrategy({ strategy, cohort });
    runs.push(run);
    scores.push(scoreRun(run, cohort));
  }

  return { mix, cohort, scores, violations: checkInvariants(scores, runs) };
}

function scoreFor(result: MixResult, name: string): StrategyScore {
  const score = result.scores.find((s) => s.strategy === name);
  if (score === undefined) throw new Error(`no score for ${name}`);
  return score;
}

async function main(): Promise<number> {
  const results: MixResult[] = [];
  for (const mix of MIXES) results.push(await runMix(mix));

  const out: string[] = ['', RULE, 'SENSITIVITY TO COHORT COMPOSITION', RULE];

  out.push(
    '',
    '  The persona weights and response rates in this simulator are ours, not measured',
    '  data. So the claim worth defending is not a particular percentage but whether the',
    '  ordering survives when the composition changes underneath it.',
    '',
  );

  for (const mix of MIXES) {
    out.push(`  ${pad(mix, 14)}${MIX_NOTES[mix]}`);
  }

  // Composition, so a reader can see the mixes genuinely differ rather than taking it
  // on trust.
  out.push('', RULE, 'COMPOSITION (cases per persona)', RULE);
  const personaIds = [
    ...new Set(results.flatMap((r) => Object.keys(personaBreakdown(r.cohort)))),
  ].sort();

  out.push(`  ${pad('PERSONA', 26)}${MIXES.map((m) => padLeft(m, 14)).join('')}`);
  for (const id of personaIds) {
    const cells = results.map((r) => padLeft(String(personaBreakdown(r.cohort)[id] ?? 0), 14));
    out.push(`  ${pad(id, 26)}${cells.join('')}`);
  }

  out.push('', RULE, 'CAPTURE OF THE ACHIEVABLE CEILING', RULE);
  out.push(
    `  ${pad('MIX', 14)}${padLeft('CEILING', 12)}${padLeft('BASELINE', 11)}` +
      `${padLeft('AGENT', 10)}${padLeft('ORACLE', 10)}${padLeft('AGENT GAIN', 13)}`,
  );

  for (const result of results) {
    const baseline = scoreFor(result, 'baseline');
    const agent = scoreFor(result, 'agent');
    const oracle = scoreFor(result, 'oracle');
    const gain = agent.captureOfCeiling - baseline.captureOfCeiling;

    out.push(
      `  ${pad(result.mix, 14)}${padLeft(inr(agent.recoverablePaise), 12)}` +
        `${padLeft(pct(baseline.captureOfCeiling), 11)}${padLeft(pct(agent.captureOfCeiling), 10)}` +
        `${padLeft(pct(oracle.captureOfCeiling), 10)}${padLeft(`+${pct(gain)}`, 13)}`,
    );
  }

  out.push('', RULE, 'ATTEMPT EFFICIENCY', RULE);
  out.push(
    `  ${pad('MIX', 14)}${padLeft('BASE ATT', 11)}${padLeft('AGENT ATT', 12)}` +
      `${padLeft('BASE ₹/ATT', 13)}${padLeft('AGENT ₹/ATT', 14)}`,
  );

  for (const result of results) {
    const baseline = scoreFor(result, 'baseline');
    const agent = scoreFor(result, 'agent');
    out.push(
      `  ${pad(result.mix, 14)}${padLeft(String(baseline.attemptsUsed), 11)}` +
        `${padLeft(String(agent.attemptsUsed), 12)}${padLeft(inr(baseline.paisePerAttempt), 13)}` +
        `${padLeft(inr(agent.paisePerAttempt), 14)}`,
    );
  }

  out.push('', RULE, 'RESTRAINT', RULE);
  out.push(
    `  ${pad('MIX', 14)}${padLeft('BASE BLOCKED', 15)}${padLeft('AGENT BLOCKED', 16)}` +
      `${padLeft('BASE REACHED', 15)}${padLeft('AGENT REACHED', 16)}`,
  );

  for (const result of results) {
    const baseline = scoreFor(result, 'baseline');
    const agent = scoreFor(result, 'agent');
    out.push(
      `  ${pad(result.mix, 14)}${padLeft(String(baseline.blockedHarmfulProposals), 15)}` +
        `${padLeft(String(agent.blockedHarmfulProposals), 16)}` +
        `${padLeft(String(baseline.harmfulContacts), 15)}` +
        `${padLeft(String(agent.harmfulContacts), 16)}`,
    );
  }

  /* -------------------------------------------------------------- *
   * The claims, checked
   * -------------------------------------------------------------- */

  const failures: string[] = [];

  for (const result of results) {
    const baseline = scoreFor(result, 'baseline');
    const agent = scoreFor(result, 'agent');
    const oracle = scoreFor(result, 'oracle');

    if (!(agent.captureOfCeiling > baseline.captureOfCeiling)) {
      failures.push(`${result.mix}: agent did not beat the baseline`);
    }
    if (!(oracle.captureOfCeiling >= agent.captureOfCeiling)) {
      failures.push(`${result.mix}: agent exceeded the oracle, which cannot happen`);
    }
    if (!(agent.attemptsUsed < baseline.attemptsUsed)) {
      failures.push(`${result.mix}: agent spent at least as many attempts as the baseline`);
    }
    if (agent.blockedHarmfulProposals > baseline.blockedHarmfulProposals) {
      failures.push(`${result.mix}: agent proposed more no-consent contact than the baseline`);
    }
    if (agent.harmfulContacts > 0 || baseline.harmfulContacts > 0) {
      failures.push(`${result.mix}: a message reached a withdrawn-consent customer`);
    }
    for (const violation of result.violations) {
      failures.push(`${result.mix}: ${violation}`);
    }
  }

  out.push('', RULE);
  if (failures.length === 0) {
    out.push('CONCLUSION HOLDS ACROSS ALL THREE COMPOSITIONS', RULE);
    out.push(
      '',
      '  In every mix the agent recovers a larger share of the achievable ceiling than',
      "  Razorpay's documented default, on strictly fewer attempts, without proposing",
      '  more contact to customers who withdrew consent, and without ever exceeding the',
      '  oracle.',
      '',
      '  The magnitudes move with the composition, as they should — a churn-heavy cohort',
      '  simply has less to win. The ordering does not.',
    );
  } else {
    out.push(`CONCLUSION DOES NOT HOLD — ${failures.length} FAILURE(S)`, RULE);
    out.push('', ...failures.map((f) => `  ✗ ${f}`));
    out.push(
      '',
      '  The result depends on the cohort composition, which means it is a property of',
      '  the mix rather than of the policy. Reporting it as a finding would be wrong.',
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
