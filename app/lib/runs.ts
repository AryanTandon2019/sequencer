/**
 * Server-side access to run artefacts.
 *
 * Everything here runs on the server. A ledger is most of a megabyte and has no business
 * in a client bundle, so pages read what they need and send rendered markup.
 *
 * Only `import type` crosses the boundary from src/. The harness owns the domain; the app
 * owns presentation, and keeping runtime imports out avoids coupling the UI build to the
 * harness's module resolution.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { CaseSummary, RunLedger, RunSummary } from '../../src/harness/artifacts.js';
import type { Decision } from '../../src/domain/types.js';

const RUNS_DIR = join(process.cwd(), 'runs');

export type { CaseSummary, RunSummary, Decision };

/** Strategy names in the order they should always appear. */
const STRATEGY_ORDER = ['baseline', 'agent', 'agent+llm', 'oracle'] as const;

function orderOf(strategy: string): number {
  const index = (STRATEGY_ORDER as readonly string[]).indexOf(strategy);
  return index === -1 ? STRATEGY_ORDER.length : index;
}

export interface RunSet {
  readonly cohort: string;
  readonly mix: string;
  readonly seed: number;
  readonly summaries: readonly RunSummary[];
}

async function listSummaryFiles(): Promise<readonly string[]> {
  try {
    const entries = await readdir(RUNS_DIR);
    return entries.filter((f) => f.endsWith('.summary.json')).sort();
  } catch {
    // No runs directory yet. The pages render an instruction rather than an error,
    // because the fix is one command and the reader should be told which.
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reject malformed or failed runs before any screen can call them verified. */
function isTrustedSummary(value: unknown): value is RunSummary {
  if (!isRecord(value) || !isRecord(value.score)) return false;
  if (
    typeof value.strategy !== 'string' ||
    typeof value.seed !== 'number' ||
    typeof value.mix !== 'string' ||
    typeof value.startedAt !== 'number' ||
    typeof value.endedAt !== 'number' ||
    !Array.isArray(value.cases) ||
    !Array.isArray(value.violations) ||
    value.violations.length > 0
  ) {
    return false;
  }

  const score = value.score;
  if (
    typeof score.cases !== 'number' ||
    typeof score.recoveredPaise !== 'number' ||
    typeof score.recoverablePaise !== 'number' ||
    typeof score.atRiskPaise !== 'number' ||
    score.cases !== value.cases.length
  ) {
    return false;
  }

  return value.cases.every(
    (item) =>
      isRecord(item) &&
      typeof item.id === 'string' &&
      typeof item.amountPaise === 'number' &&
      typeof item.outcome === 'string' &&
      typeof item.recoveredPaise === 'number' &&
      typeof item.attemptsUsed === 'number' &&
      typeof item.contactsSent === 'number',
  );
}

async function readSummary(file: string): Promise<RunSummary | null> {
  try {
    const raw = await readFile(join(RUNS_DIR, file), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return isTrustedSummary(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Load every summary on disk, newest cohort/mix first.
 *
 * Grouped by cohort and mix so a reader is never shown a baseline from one cohort beside
 * an agent from another — a comparison across different cohorts would be meaningless and
 * would look exactly like a real one.
 */
export async function loadRunSets(): Promise<readonly RunSet[]> {
  const files = await listSummaryFiles();
  const summaries = (await Promise.all(files.map(readSummary))).filter(
    (s): s is RunSummary => s !== null,
  );

  const groups = new Map<string, RunSummary[]>();
  for (const summary of summaries) {
    // Filenames are `<strategy>-<cohort>-<mix>.summary.json`, so cohort and mix are
    // recoverable, but the summary carries seed and mix directly. Cohort comes from the
    // filename because it is a label rather than data.
    const key = `${summary.seed}|${summary.mix}`;
    const list = groups.get(key) ?? [];
    list.push(summary);
    groups.set(key, list);
  }

  const sets: RunSet[] = [];
  for (const [key, list] of groups) {
    const [seedText, mix] = key.split('|');
    list.sort((a, b) => orderOf(a.strategy) - orderOf(b.strategy));
    sets.push({
      cohort: Number(seedText) === 19980417 ? 'holdout' : 'dev',
      mix: mix ?? 'balanced',
      seed: Number(seedText),
      summaries: list,
    });
  }

  // Holdout first: it is the cohort the reported figures come from.
  sets.sort((a, b) => (a.cohort === 'holdout' ? -1 : 1) - (b.cohort === 'holdout' ? -1 : 1));
  return sets;
}

/** The set a reader should see by default. */
export async function loadPrimaryRunSet(): Promise<RunSet | null> {
  const sets = await loadRunSets();
  return sets[0] ?? null;
}

export async function loadSummary(strategy: string): Promise<RunSummary | null> {
  const set = await loadPrimaryRunSet();
  return set?.summaries.find((s) => s.strategy === strategy) ?? null;
}

/**
 * Shape-check a parsed ledger rather than trusting the cast.
 *
 * A ledger is `Record<caseId, Decision[]>`. Full field-level validation of every
 * decision is deliberately not repeated here — the timeline renderer narrows fields
 * again — but the container shape is checked so a truncated or foreign JSON file
 * degrades to "no trail" instead of throwing inside a page render.
 */
function isTrustedLedger(value: unknown): value is RunLedger {
  if (!isRecord(value)) return false;
  return Object.values(value).every((trail) => Array.isArray(trail) && trail.every(isRecord));
}

/** Decision trail for one case. Read only when a case is opened. */
export async function loadCaseDecisions(
  strategy: string,
  caseId: string,
): Promise<readonly Decision[]> {
  const set = await loadPrimaryRunSet();
  if (set === null) return [];

  const name = `${strategy}-${set.cohort}-${set.mix}.ledger.json`;
  try {
    const raw = await readFile(join(RUNS_DIR, name), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isTrustedLedger(parsed)) return [];
    const trail = parsed[caseId];
    return Array.isArray(trail) ? (trail as readonly Decision[]) : [];
  } catch {
    return [];
  }
}

export async function loadCase(
  strategy: string,
  caseId: string,
): Promise<{ readonly summary: CaseSummary; readonly decisions: readonly Decision[] } | null> {
  const summary = await loadSummary(strategy);
  const found = summary?.cases.find((c) => c.id === caseId);
  if (summary === undefined || summary === null || found === undefined) return null;

  return { summary: found, decisions: await loadCaseDecisions(strategy, caseId) };
}

/** Same case, every strategy — summaries only, so the comparison strip stays cheap. */
export interface CaseAcrossStrategies {
  readonly id: string;
  readonly amountPaise: number;
  readonly personaId: string;
  readonly personaLabel: string;
  readonly trueCause: string;
  readonly recoverable: boolean;
  readonly outcomes: readonly { readonly strategy: string; readonly case: CaseSummary }[];
}

export async function loadCaseAcrossStrategies(
  caseId: string,
): Promise<CaseAcrossStrategies | null> {
  const set = await loadPrimaryRunSet();
  if (set === null) return null;

  const outcomes: { strategy: string; case: CaseSummary }[] = [];
  for (const summary of set.summaries) {
    const found = summary.cases.find((c) => c.id === caseId);
    if (found !== undefined) outcomes.push({ strategy: summary.strategy, case: found });
  }
  const first = outcomes[0]?.case;
  if (first === undefined) return null;

  return {
    id: first.id,
    amountPaise: first.amountPaise,
    personaId: first.personaId,
    personaLabel: first.personaLabel,
    trueCause: first.trueCause,
    recoverable: first.recoverable,
    outcomes,
  };
}
