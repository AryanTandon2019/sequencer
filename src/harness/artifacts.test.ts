/**
 * Tests for run artefacts.
 *
 * The assertion that matters is the round trip through `JSON.stringify`. The confusion
 * matrix is stored as a `Map`, and a Map serialises to `{}` — so before this module
 * existed the matrix was silently missing from every file written, while looking
 * perfectly fine in the terminal. That is the shape of bug this project keeps producing:
 * not a crash, just a quiet absence nobody notices.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deterministicDiagnoser } from '../diagnosis/deterministic.js';
import { generateCohort } from '../sim/cohort.js';
import { createAgentStrategy } from '../strategies/agent.js';
import { baselineStrategy } from '../strategies/baseline.js';
import { confusionToJson, splitRun, formatBytes, toCaseSummary } from './artifacts.js';
import { runStrategy } from './engine.js';
import { scoreRun } from './score.js';

const cohort = generateCohort({ seed: 4242, size: 40, mix: 'balanced' });

async function agentRun() {
  const run = await runStrategy({ strategy: createAgentStrategy(deterministicDiagnoser), cohort });
  return { run, score: scoreRun(run, cohort) };
}

describe('splitting a run', () => {
  it('keeps decision trails out of the summary', async () => {
    // The whole point: every screen needs the summary, only one needs a trail.
    const { run, score } = await agentRun();
    const { summary } = splitRun(run, score, []);

    for (const c of summary.cases) {
      assert.ok(!('decisions' in c), `${c.id} still carries its decision trail`);
      assert.equal(typeof c.decisionCount, 'number');
    }
  });

  it('makes the summary substantially smaller than the ledger', async () => {
    const { run, score } = await agentRun();
    const { summary, ledger } = splitRun(run, score, []);

    const summaryBytes = JSON.stringify(summary).length;
    const ledgerBytes = JSON.stringify(ledger).length;
    assert.ok(
      summaryBytes < ledgerBytes,
      `summary ${summaryBytes} should be smaller than ledger ${ledgerBytes}`,
    );
  });

  it('keys the ledger by case id, losing nothing', async () => {
    const { run, score } = await agentRun();
    const { ledger } = splitRun(run, score, []);

    assert.equal(Object.keys(ledger).length, run.cases.length);
    for (const c of run.cases) {
      assert.equal(ledger[c.id]?.length, c.decisions.length);
    }
  });

  it('carries violations through, so a bad run cannot be quoted as clean', async () => {
    const { run, score } = await agentRun();
    const { summary } = splitRun(run, score, ['something went wrong']);
    assert.deepEqual(summary.violations, ['something went wrong']);
  });
});

describe('the confusion matrix survives serialisation', () => {
  it('round-trips through JSON without losing rows', async () => {
    const { score } = await agentRun();
    assert.ok(score.confusion !== null, 'the agent should have produced a matrix');

    const json = confusionToJson(score);
    assert.ok(json !== null);
    assert.ok(json.rows.length > 0, 'no rows survived');

    // The regression: a Map goes to {} here, taking the whole matrix with it.
    const revived = JSON.parse(JSON.stringify(json)) as typeof json;
    assert.equal(revived.rows.length, json.rows.length);
    assert.equal(revived.correct, json.correct);

    const counted = revived.rows.reduce(
      (total, row) => total + row.predictions.reduce((n, p) => n + p.count, 0),
      0,
    );
    assert.equal(counted, json.total, 'predictions do not sum to the case count');
  });

  it('represents an abstention as an explicit null prediction', async () => {
    // An abstention is a deliberate outcome, not a missing value, and the UI needs to be
    // able to tell it apart from a wrong answer.
    const { score } = await agentRun();
    const json = confusionToJson(score);
    assert.ok(json !== null);

    const hasAbstention = json.rows.some((r) => r.predictions.some((p) => p.predicted === null));
    assert.ok(hasAbstention, 'expected at least one abstention in this cohort');
  });

  it('is null for a strategy that forms no view', async () => {
    const run = await runStrategy({ strategy: baselineStrategy, cohort });
    const score = scoreRun(run, cohort);
    assert.equal(confusionToJson(score), null);

    const { summary } = splitRun(run, score, []);
    assert.equal(summary.score.confusion, null);
  });
});

describe('case summaries', () => {
  it('flags whether anything was refused, for filtering', async () => {
    const { run } = await agentRun();
    const withRefusal = run.cases.find((c) =>
      c.decisions.some((d) => d.rulings.some((r) => r.rejections.length > 0)),
    );

    if (withRefusal !== undefined) {
      assert.equal(toCaseSummary(withRefusal).hadRefusal, true);
    }

    const clean = run.cases.find(
      (c) => !c.decisions.some((d) => d.rulings.some((r) => r.rejections.length > 0)),
    );
    if (clean !== undefined) {
      assert.equal(toCaseSummary(clean).hadRefusal, false);
    }
  });

  it('preserves every field a screen needs', async () => {
    const { run } = await agentRun();
    const first = run.cases[0];
    assert.ok(first !== undefined);

    const summary = toCaseSummary(first);
    for (const field of [
      'id',
      'personaId',
      'amountPaise',
      'trueCause',
      'recoverable',
      'outcome',
      'recoveredPaise',
      'attemptsUsed',
      'contactsSent',
      'finalState',
    ] as const) {
      assert.ok(field in summary, `summary lost ${field}`);
    }
  });
});

describe('formatBytes', () => {
  it('reads sensibly across magnitudes', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(2048), '2 KB');
    assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  });
});
