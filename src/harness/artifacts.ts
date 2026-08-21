/**
 * Run artefacts: what gets written to disk for the UI to read.
 *
 * A run is split into two files rather than one, because the two have completely
 * different access patterns. The summary is small and needed by every screen; the
 * ledger is large and needed by one case at a time.
 *
 *   <name>.summary.json   one row per case, no decision trails. Tens of KB.
 *   <name>.ledger.json    every decision, keyed by case id. Over a megabyte.
 *
 * Writing them together produced a 1.3 MB file that a list view had to load in full to
 * show three hundred rows.
 *
 * This module also fixes a real serialisation bug. `ConfusionMatrix.counts` is a `Map`,
 * and `JSON.stringify` turns a Map into `{}` — so the confusion matrix was silently
 * absent from every file written before this existed. It looked fine in the terminal,
 * which is exactly how that kind of thing survives.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DeclineCause } from '../domain/types.js';
import type { CaseResult, RunResult } from './engine.js';
import type { StrategyScore } from './score.js';

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */

/** One case without its decision trail. Everything a list or chart needs. */
export type CaseSummary = Omit<CaseResult, 'decisions'> & {
  /** How many deliberations this case took, so the UI can show it without the trail. */
  readonly decisionCount: number;
  /** Whether any guardrail refused something here, for filtering. */
  readonly hadRefusal: boolean;
};

/** JSON-safe confusion matrix. A Map cannot survive `JSON.stringify`. */
export interface ConfusionRowJson {
  readonly actual: DeclineCause;
  readonly predictions: readonly { readonly predicted: DeclineCause | null; readonly count: number }[];
}

export interface ConfusionJson {
  readonly rows: readonly ConfusionRowJson[];
  readonly correct: number;
  readonly total: number;
  readonly abstained: number;
}

/** The score with its Map replaced by something JSON can represent. */
export type StrategyScoreJson = Omit<StrategyScore, 'confusion'> & {
  readonly confusion: ConfusionJson | null;
};

export interface RunSummary {
  readonly strategy: string;
  readonly description: string;
  readonly seed: number;
  readonly mix: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly score: StrategyScoreJson;
  readonly cases: readonly CaseSummary[];
  /** Empty when the run is trustworthy. Non-empty means do not quote these figures. */
  readonly violations: readonly string[];
}

/** Decision trails, keyed by case id. Loaded only when one case is opened. */
export type RunLedger = Readonly<Record<string, RunResult['cases'][number]['decisions']>>;

/* ------------------------------------------------------------------ *
 * Conversion
 * ------------------------------------------------------------------ */

export function confusionToJson(score: StrategyScore): ConfusionJson | null {
  const c = score.confusion;
  if (c === null) return null;

  const rows: ConfusionRowJson[] = [];
  for (const [actual, predictions] of c.counts) {
    rows.push({
      actual,
      predictions: [...predictions.entries()]
        .map(([predicted, count]) => ({ predicted, count }))
        .sort((a, b) => b.count - a.count),
    });
  }
  rows.sort((a, b) => a.actual.localeCompare(b.actual));

  return { rows, correct: c.correct, total: c.total, abstained: c.abstained };
}

export function toCaseSummary(c: CaseResult): CaseSummary {
  const { decisions, ...rest } = c;
  return {
    ...rest,
    decisionCount: decisions.length,
    hadRefusal: decisions.some((d) => d.rulings.some((r) => r.rejections.length > 0)),
  };
}

export function splitRun(
  run: RunResult,
  score: StrategyScore,
  violations: readonly string[],
): { readonly summary: RunSummary; readonly ledger: RunLedger } {
  const ledger: Record<string, RunResult['cases'][number]['decisions']> = {};
  for (const c of run.cases) ledger[c.id] = c.decisions;

  return {
    summary: {
      strategy: run.strategy,
      description: run.strategyDescription,
      seed: run.seed,
      mix: run.mix,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      score: { ...score, confusion: confusionToJson(score) },
      cases: run.cases.map(toCaseSummary),
      violations,
    },
    ledger,
  };
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

export interface WrittenArtifact {
  readonly summaryPath: string;
  readonly ledgerPath: string;
  readonly summaryBytes: number;
  readonly ledgerBytes: number;
}

export function writeRunArtifacts(options: {
  readonly dir: string;
  readonly name: string;
  readonly run: RunResult;
  readonly score: StrategyScore;
  readonly violations: readonly string[];
}): WrittenArtifact {
  const { summary, ledger } = splitRun(options.run, options.score, options.violations);

  mkdirSync(options.dir, { recursive: true });

  const summaryPath = join(options.dir, `${options.name}.summary.json`);
  const ledgerPath = join(options.dir, `${options.name}.ledger.json`);

  // Summary is indented because a human may well open it. The ledger is not, because
  // nobody reads a megabyte of JSON by eye and the indentation roughly doubles it.
  const summaryJson = `${JSON.stringify(summary, null, 2)}\n`;
  const ledgerJson = `${JSON.stringify(ledger)}\n`;

  writeFileSync(summaryPath, summaryJson, 'utf8');
  writeFileSync(ledgerPath, ledgerJson, 'utf8');

  return {
    summaryPath,
    ledgerPath,
    summaryBytes: Buffer.byteLength(summaryJson),
    ledgerBytes: Buffer.byteLength(ledgerJson),
  };
}

/** Human-readable size, for the CLI's closing line. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
