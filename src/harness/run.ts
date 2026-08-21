#!/usr/bin/env node
/**
 * CLI entry point.
 *
 *   npm run harness
 *   npm run harness -- --cohort=dev --size=60
 *   npm run harness -- --mix=churn_heavy
 *
 * Runs the baseline, the agent and the oracle over one cohort, checks the invariants,
 * prints the comparison, and writes the full run to runs/.
 *
 * Requires no API key and no network. The deterministic diagnoser resolves everything
 * it can and abstains on the rest, so a reviewer can reproduce every reported figure
 * with `npm install && npm run harness` and nothing else.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import 'dotenv/config';

import { COHORT_SIZE, DEV_SEED, HOLDOUT_SEED } from '../config.js';
import { deterministicDiagnoser } from '../diagnosis/deterministic.js';
import {
  createLlmDiagnoser,
  createOpenAiClient,
  type LlmDiagnoserStats,
} from '../diagnosis/llm.js';
import { generateCohort } from '../sim/cohort.js';
import type { MixName } from '../sim/personas.js';
import { createAgentStrategy } from '../strategies/agent.js';
import { baselineStrategy } from '../strategies/baseline.js';
import { createOracleStrategy } from '../strategies/oracle.js';
import { runStrategy, type RunResult } from './engine.js';
import {
  renderCohortHeader,
  renderComparison,
  renderConfusion,
  renderDiagnosisGap,
  renderInvariants,
  renderOutcomes,
  renderPersonaBreakdown,
  renderRestraint,
} from './report.js';
import { checkInvariants, scoreRun, type StrategyScore } from './score.js';

/* ------------------------------------------------------------------ *
 * Arguments
 * ------------------------------------------------------------------ */

interface Args {
  readonly cohort: 'dev' | 'holdout';
  readonly size: number;
  readonly mix: MixName;
  readonly write: boolean;
  readonly detail: boolean;
  /** Adds a fourth strategy: the agent with a reasoning layer behind the lookup table. */
  readonly llm: boolean;
}

const MIXES: readonly MixName[] = ['balanced', 'churn_heavy', 'funds_heavy'];

function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (match?.[1] === undefined) continue;
    flags.set(match[1], match[2] ?? 'true');
  }

  const cohortFlag = flags.get('cohort') ?? 'holdout';
  if (cohortFlag !== 'dev' && cohortFlag !== 'holdout') {
    throw new Error(`--cohort must be dev or holdout, got "${cohortFlag}"`);
  }

  const mixFlag = (flags.get('mix') ?? 'balanced') as MixName;
  if (!MIXES.includes(mixFlag)) {
    throw new Error(`--mix must be one of ${MIXES.join(', ')}, got "${mixFlag}"`);
  }

  const sizeFlag = Number(flags.get('size') ?? COHORT_SIZE);
  if (!Number.isInteger(sizeFlag) || sizeFlag <= 0) {
    throw new Error(`--size must be a positive integer, got "${flags.get('size')}"`);
  }

  return {
    cohort: cohortFlag,
    size: sizeFlag,
    mix: mixFlag,
    write: flags.get('no-write') === undefined,
    detail: flags.get('detail') !== undefined,
    llm: flags.get('llm') !== undefined,
  };
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const seed = args.cohort === 'dev' ? DEV_SEED : HOLDOUT_SEED;

  const cohort = generateCohort({ seed, size: args.size, mix: args.mix });
  const hiddenBySubscriptionId = new Map(
    cohort.subscriptions.map((s) => [s.observable.id, s.hidden]),
  );

  const strategies = [
    baselineStrategy,
    createAgentStrategy(deterministicDiagnoser),
    createOracleStrategy({ hiddenBySubscriptionId }),
  ];

  // The reasoning layer is opt-in, and that is the point. Without `--llm` the harness
  // needs no API key and no network, so anyone can reproduce the reported figures
  // with `npm install && npm run harness`. The model is measured as an addition to
  // that baseline rather than being required to produce it.
  let llmStats: LlmDiagnoserStats | null = null;
  if (args.llm) {
    const apiKey = process.env['OPENAI_API_KEY'];
    if (apiKey === undefined || apiKey.trim() === '') {
      throw new Error(
        '--llm needs OPENAI_API_KEY. Copy .env.example to .env and put your key there. ' +
          'Never paste a key into a chat or a commit.',
      );
    }

    const model = process.env['SEQUENCER_MODEL'] ?? 'gpt-5.4-mini';
    const layered = createLlmDiagnoser({
      client: createOpenAiClient({ apiKey, model }),
      fallbackTo: deterministicDiagnoser,
    });
    llmStats = layered.stats;

    strategies.splice(
      2,
      0,
      createAgentStrategy(layered.diagnose, {
        name: 'agent+llm',
        description: `Lookup table first, then ${model} on the failures it cannot classify.`,
      }),
    );
  }

  const runs: RunResult[] = [];
  const scores: StrategyScore[] = [];

  for (const strategy of strategies) {
    const run = await runStrategy({ strategy, cohort });
    runs.push(run);
    scores.push(scoreRun(run, cohort));
  }

  const violations = checkInvariants(scores, runs);

  const out: string[] = [
    '',
    renderCohortHeader(cohort),
    '',
    renderComparison(scores),
    '',
    renderRestraint(scores),
    '',
    renderOutcomes(scores),
  ];

  const gap = renderDiagnosisGap(scores);
  if (gap !== null) out.push('', gap);

  for (const score of scores) {
    if (score.strategy === 'baseline') continue;
    out.push('', renderConfusion(score));
  }

  if (args.detail) {
    for (const score of scores) out.push('', renderPersonaBreakdown(score));
  } else {
    const agent = scores.find((s) => s.strategy === 'agent');
    if (agent !== undefined) out.push('', renderPersonaBreakdown(agent));
  }

  if (llmStats !== null) {
    const total = llmStats.calls + llmStats.cacheHits;
    out.push(
      '',
      '──────────────────────────────────────────────────────────────────────────────',
      'MODEL USE',
      '──────────────────────────────────────────────────────────────────────────────',
      `  consultations reaching the model   ${total}`,
      `  actual calls made                  ${llmStats.calls}`,
      `  served from cache                  ${llmStats.cacheHits}`,
      `  replies rejected as invalid        ${llmStats.invalidReplies}`,
      `  calls that errored                 ${llmStats.errors}`,
      '',
      '  Caching collapses repeated consultations on unchanged evidence to one call.',
      '  Rejected replies and errors both escalate to a human rather than being',
      '  repaired into something actionable.',
    );
  }

  out.push('', renderInvariants(violations), '');
  console.log(out.join('\n'));

  if (args.write) {
    mkdirSync('runs', { recursive: true });
    for (let i = 0; i < runs.length; i += 1) {
      const run = runs[i];
      const score = scores[i];
      if (run === undefined || score === undefined) continue;

      const name = `${run.strategy}-${args.cohort}-${args.mix}.json`;
      writeFileSync(
        join('runs', name),
        `${JSON.stringify({ score, run, violations }, null, 2)}\n`,
        'utf8',
      );
    }
    console.log(`  Wrote ${runs.length} run files to runs/\n`);
  }

  // A non-zero exit on a violated invariant, so a broken run cannot be mistaken for
  // a passing one in a script or a screenshot.
  return violations.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  });
