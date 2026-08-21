/**
 * Scoring.
 *
 * Turns a run into the numbers that get reported, and — more importantly — checks the
 * invariants that must hold for those numbers to mean anything.
 *
 * The invariant checks matter more than the metrics. A bug in this project does not
 * crash; it prints a plausible wrong figure. So the harness refuses to report at all
 * if the agent has somehow beaten the ceiling, or a case has spent five of four
 * permitted attempts, or a message reached someone who withdrew consent.
 */

import { MAX_ATTEMPTS_PER_MANDATE_CYCLE } from '../domain/regulation.js';
import type { DeclineCause, Paise } from '../domain/types.js';
import { recoverableAtRiskPaise, totalAtRiskPaise, type Cohort } from '../sim/cohort.js';
import type { PersonaId } from '../sim/personas.js';
import type { CaseOutcome, CaseResult, RunResult } from './engine.js';

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */

export interface PersonaScore {
  readonly personaId: PersonaId;
  readonly label: string;
  readonly cases: number;
  readonly recoverableCases: number;
  readonly recoveredCases: number;
  readonly recoverablePaise: Paise;
  readonly recoveredPaise: Paise;
  readonly attemptsUsed: number;
  readonly contactsSent: number;
}

export interface ConfusionMatrix {
  /** actual -> predicted -> count. `predicted` is null when nothing was diagnosed. */
  readonly counts: ReadonlyMap<DeclineCause, ReadonlyMap<DeclineCause | null, number>>;
  readonly correct: number;
  readonly total: number;
  /** Cases where no diagnosis was reached at all, rather than a wrong one. */
  readonly abstained: number;
}

export interface StrategyScore {
  readonly strategy: string;
  readonly description: string;
  readonly seed: number;
  readonly mix: string;

  readonly cases: number;
  readonly casesNeedingRecovery: number;

  readonly atRiskPaise: Paise;
  readonly recoverablePaise: Paise;
  readonly recoveredPaise: Paise;
  readonly recoveredCases: number;

  /** Recovered money as a share of recoverable money. */
  readonly captureOfCeiling: number;
  /**
   * Recovered cases as a share of recoverable cases.
   *
   * Reported beside the money figure, never instead of it. Money capture is the
   * business-relevant number but it is the more distortable of the two, since a few
   * large cases can carry it. When these two diverge, the divergence is the finding.
   */
  readonly captureOfCeilingByCase: number;
  readonly recoverableCases: number;

  readonly attemptsUsed: number;
  /**
   * Attempts spent beyond the original charge on cases that were never recoverable.
   *
   * The original charge is excluded: it happens regardless of any policy, so
   * counting it would charge every strategy for something none of them chose.
   */
  readonly attemptsWasted: number;
  readonly paisePerAttempt: Paise;

  readonly contactsSent: number;
  readonly harmfulContacts: number;
  readonly blockedHarmfulProposals: number;
  readonly blockedHardDeclineRetries: number;
  readonly refusedProposals: number;

  readonly outcomes: Readonly<Record<CaseOutcome, number>>;
  readonly byPersona: readonly PersonaScore[];
  /** Null when the strategy forms no view about causes. */
  readonly confusion: ConfusionMatrix | null;
}

/* ------------------------------------------------------------------ *
 * Scoring
 * ------------------------------------------------------------------ */

const OUTCOMES: readonly CaseOutcome[] = [
  'recovered',
  'stopped',
  'escalated',
  'halted',
  'unresolved',
];

function sum<T>(items: readonly T[], f: (item: T) => number): number {
  return items.reduce((total, item) => total + f(item), 0);
}

/**
 * The cause a strategy first settled on for a case.
 *
 * The first diagnosis rather than the last: a later one may follow a remedy the
 * strategy itself obtained, so crediting that would score it for information its own
 * earlier decision produced.
 */
function firstDiagnosedCause(c: CaseResult): DeclineCause | null {
  for (const decision of c.decisions) {
    if (decision.diagnosis !== null) return decision.diagnosis.cause;
  }
  return null;
}

function buildConfusion(cases: readonly CaseResult[]): ConfusionMatrix | null {
  const diagnosing = cases.some((c) => c.decisions.some((d) => d.diagnosis !== null));
  // A strategy that never diagnoses has no matrix. Fabricating one would credit a
  // calendar with an opinion it does not hold.
  if (!diagnosing) return null;

  const counts = new Map<DeclineCause, Map<DeclineCause | null, number>>();
  let correct = 0;
  let abstained = 0;

  for (const c of cases) {
    if (!c.neededRecovery) continue;

    const predicted = firstDiagnosedCause(c);
    const row = counts.get(c.trueCause) ?? new Map<DeclineCause | null, number>();
    row.set(predicted, (row.get(predicted) ?? 0) + 1);
    counts.set(c.trueCause, row);

    if (predicted === c.trueCause) correct += 1;
    if (predicted === null) abstained += 1;
  }

  const total = cases.filter((c) => c.neededRecovery).length;
  return { counts, correct, total, abstained };
}

function byPersona(cohort: Cohort, cases: readonly CaseResult[]): readonly PersonaScore[] {
  const labels = new Map<PersonaId, string>();
  for (const s of cohort.subscriptions) labels.set(s.hidden.personaId, s.personaLabel);

  const ids = [...new Set(cases.map((c) => c.personaId))].sort();

  return ids.map((personaId) => {
    const group = cases.filter((c) => c.personaId === personaId);
    return {
      personaId,
      label: labels.get(personaId) ?? personaId,
      cases: group.length,
      recoverableCases: group.filter((c) => c.recoverable).length,
      recoveredCases: group.filter((c) => c.recoveredPaise > 0).length,
      recoverablePaise: sum(group.filter((c) => c.recoverable), (c) => c.amountPaise),
      recoveredPaise: sum(group, (c) => c.recoveredPaise),
      attemptsUsed: sum(group, (c) => c.attemptsUsed),
      contactsSent: sum(group, (c) => c.contactsSent),
    };
  });
}

export function scoreRun(run: RunResult, cohort: Cohort): StrategyScore {
  const cases = run.cases;
  const recoverablePaise = recoverableAtRiskPaise(cohort);
  const recoveredPaise = sum(cases, (c) => c.recoveredPaise);
  const attemptsUsed = sum(cases, (c) => c.attemptsUsed);
  const recoverableCases = cases.filter((c) => c.recoverable).length;

  const outcomes = Object.fromEntries(
    OUTCOMES.map((o) => [o, cases.filter((c) => c.outcome === o).length]),
  ) as Record<CaseOutcome, number>;

  return {
    strategy: run.strategy,
    description: run.strategyDescription,
    seed: run.seed,
    mix: run.mix,

    cases: cases.length,
    casesNeedingRecovery: cases.filter((c) => c.neededRecovery).length,

    atRiskPaise: totalAtRiskPaise(cohort),
    recoverablePaise,
    recoveredPaise,
    recoveredCases: cases.filter((c) => c.recoveredPaise > 0).length,

    captureOfCeiling: recoverablePaise === 0 ? 0 : recoveredPaise / recoverablePaise,
    captureOfCeilingByCase:
      recoverableCases === 0
        ? 0
        : cases.filter((c) => c.recoverable && c.recoveredPaise > 0).length / recoverableCases,
    recoverableCases,

    attemptsUsed,
    attemptsWasted: sum(
      cases.filter((c) => !c.recoverable),
      (c) => Math.max(0, c.attemptsUsed - 1),
    ),
    paisePerAttempt: attemptsUsed === 0 ? 0 : Math.round(recoveredPaise / attemptsUsed),

    contactsSent: sum(cases, (c) => c.contactsSent),
    harmfulContacts: sum(cases, (c) => c.harmfulContacts),
    blockedHarmfulProposals: sum(cases, (c) => c.blockedHarmfulProposals),
    blockedHardDeclineRetries: sum(cases, (c) => c.blockedHardDeclineRetries),
    refusedProposals: sum(cases, (c) => c.refusedProposals),

    outcomes,
    byPersona: byPersona(cohort, cases),
    confusion: buildConfusion(cases),
  };
}

/* ------------------------------------------------------------------ *
 * Invariants
 * ------------------------------------------------------------------ */

/**
 * Properties that must hold for the reported numbers to mean anything.
 *
 * Returns a list of violations; empty means the run is trustworthy. These are checked
 * on every run and the harness refuses to print results if any fail, because the
 * failure mode of this project is not a crash — it is a believable wrong number.
 */
export function checkInvariants(
  scores: readonly StrategyScore[],
  runs: readonly RunResult[],
): readonly string[] {
  const violations: string[] = [];

  for (const run of runs) {
    for (const c of run.cases) {
      if (c.attemptsUsed > MAX_ATTEMPTS_PER_MANDATE_CYCLE) {
        violations.push(
          `${run.strategy}/${c.id}: used ${c.attemptsUsed} attempts, ` +
            `but NPCI permits ${MAX_ATTEMPTS_PER_MANDATE_CYCLE}`,
        );
      }
      if (c.recoveredPaise > c.amountPaise) {
        violations.push(
          `${run.strategy}/${c.id}: recovered ${c.recoveredPaise} paise from a ` +
            `${c.amountPaise} paise charge`,
        );
      }
      if (c.recoveredPaise > 0 && !c.recoverable) {
        violations.push(
          `${run.strategy}/${c.id}: collected money the simulator says was ` +
            'unrecoverable, so ground truth and the world disagree',
        );
      }
    }
  }

  for (const s of scores) {
    if (s.recoveredPaise > s.recoverablePaise) {
      violations.push(
        `${s.strategy}: recovered more than the achievable ceiling ` +
          `(${s.recoveredPaise} > ${s.recoverablePaise})`,
      );
    }
    if (s.harmfulContacts > 0) {
      violations.push(
        `${s.strategy}: ${s.harmfulContacts} messages reached a customer who had ` +
          'withdrawn consent; the consent guardrail failed',
      );
    }
    const counted = Object.values(s.outcomes).reduce((a, b) => a + b, 0);
    if (counted !== s.cases) {
      violations.push(`${s.strategy}: ${counted} outcomes recorded for ${s.cases} cases`);
    }
  }

  // The oracle shares the agent's policy and differs only in having perfect
  // diagnosis, so it is an upper bound by construction. An agent above it means
  // either the oracle is not reading truth or the two are no longer comparable.
  const oracle = scores.find((s) => s.strategy === 'oracle');
  if (oracle !== undefined) {
    for (const s of scores) {
      if (s.strategy === 'oracle' || s.strategy === 'baseline') continue;
      if (s.recoveredPaise > oracle.recoveredPaise) {
        violations.push(
          `${s.strategy} recovered more than the oracle ` +
            `(${s.recoveredPaise} > ${oracle.recoveredPaise}), which cannot happen if the ` +
            'oracle has perfect diagnosis and the same policy',
        );
      }
    }
  }

  return violations;
}
