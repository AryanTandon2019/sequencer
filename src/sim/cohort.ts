/**
 * Cohort generation.
 *
 * Builds a set of simulated subscriptions from the personas. Deterministic given a
 * seed and a mix, so `npm run harness` reproduces the figures in the README to the
 * rupee.
 *
 * Each subscription draws from its own named stream, which means adding a persona
 * or changing the cohort size leaves the earlier subscriptions untouched. Without
 * that, every result would shift whenever the generator changed and comparing two
 * runs would be meaningless.
 */

import {
  MANDATE_CAP_HEADROOM,
  SIMULATION_START,
  SUBSCRIPTION_AMOUNTS_PAISE,
} from '../config.js';
import type {
  BillingHistory,
  MandateState,
  Millis,
  ObservableSubscription,
  Paise,
  PaymentMethod,
} from '../domain/types.js';
import { weightsFor, type HiddenState, type MixName, type Persona } from './personas.js';
import { deriveRng, type Rng } from './rng.js';

const HOUR: Millis = 60 * 60 * 1000;

/**
 * One simulated subscription.
 *
 * The three fields are deliberately separate, and the separation is the leakage
 * boundary in physical form:
 *
 *   `observable`   — what a merchant sees. Strategies read this.
 *   `mandateState` — also visible; arrives by webhook rather than in the payment
 *                    error object, which is the whole point of DECISIONS.md D12.
 *   `hidden`       — the persona. Only the world model and the scorer may read it.
 *                    A test asserts no file in src/strategies/ imports from here.
 */
export interface SimulatedSubscription {
  readonly observable: ObservableSubscription;
  readonly mandateState: MandateState;
  readonly hidden: HiddenState;
  /** Recorded so reports can group by persona without re-deriving it. */
  readonly personaLabel: string;
}

export interface CohortOptions {
  readonly seed: number;
  readonly size: number;
  readonly mix: MixName;
  /** Overridable so tests can pin a window without rewriting config. */
  readonly startAt?: Millis;
}

export interface Cohort {
  readonly seed: number;
  readonly mix: MixName;
  readonly subscriptions: readonly SimulatedSubscription[];
}

const METHODS: readonly PaymentMethod[] = ['card', 'upi_autopay', 'emandate'];

/**
 * A plausible payment record for a customer who has been billed a while and is
 * now failing for the first time in this cycle.
 *
 * Legitimate diagnostic signal: a customer who has paid on the first attempt for
 * a year is a different proposition from one who has failed repeatedly, and a
 * strategy is entitled to use that.
 */
function billingHistory(rng: Rng, fundingDayOfMonth: number | undefined): BillingHistory {
  const cyclesBilled = rng.int(2, 24);
  const failed = rng.int(0, Math.min(2, cyclesBilled - 1));
  const recovered = rng.int(0, Math.min(3, cyclesBilled - failed));
  const base: BillingHistory = {
    cyclesBilled,
    cyclesPaidFirstAttempt: cyclesBilled - failed - recovered,
    cyclesRecoveredAfterRetry: recovered,
    cyclesFailed: failed,
  };

  return fundingDayOfMonth === undefined
    ? base
    : { ...base, observedFundingDayOfMonth: fundingDayOfMonth };
}

function buildOne(
  id: string,
  persona: Persona,
  rng: Rng,
  startAt: Millis,
): SimulatedSubscription {
  const shape = persona.shape(rng);

  const amountPaise: Paise = shape.amountPaise ?? rng.pick(SUBSCRIPTION_AMOUNTS_PAISE);
  const capPaise: Paise = shape.capPaise ?? amountPaise * MANDATE_CAP_HEADROOM;
  const method: PaymentMethod = shape.method ?? rng.pick(METHODS);

  // Charge dates are spread over the first two days rather than landing on one
  // instant. Real merchants bill across the month, and a single instant would
  // make the Autopay window rule either always bite or never bite.
  const chargeDate = startAt + rng.int(0, 47) * HOUR;

  // The persona's clock starts at its own charge date, and it receives the shape so
  // hidden truth stays consistent with the observable signals derived from it.
  const hidden: HiddenState = persona.materialise(rng, chargeDate, shape);

  const observable: ObservableSubscription = {
    id,
    customerId: `cust_${id.slice(4)}`,
    method,
    amountPaise,
    chargeDate,
    // Nothing has been attempted yet. The engine fires the original charge, which
    // consumes the first of the four attempts NPCI permits.
    state: 'active',
    attempts: [],
    contacts: [],
    history: billingHistory(rng, shape.fundingDayOfMonth),
  };

  const mandateState: MandateState = {
    authorisation: hidden.authorisation,
    capPaise,
    higherAfaCeiling: shape.higherAfaCeiling ?? false,
  };

  return { observable, mandateState, hidden, personaLabel: persona.label };
}

export function generateCohort(options: CohortOptions): Cohort {
  const { seed, size, mix } = options;
  const startAt = options.startAt ?? SIMULATION_START;

  if (size <= 0) throw new Error(`cohort size must be positive, got ${size}`);

  const weights = weightsFor(mix);
  const subscriptions: SimulatedSubscription[] = [];

  for (let i = 0; i < size; i += 1) {
    const id = `sub_${String(i + 1).padStart(4, '0')}`;
    const rng = deriveRng(seed, id);
    const persona = rng.weighted(weights);
    subscriptions.push(buildOne(id, persona, rng, startAt));
  }

  return { seed, mix, subscriptions };
}

/* ------------------------------------------------------------------ *
 * Summaries
 * ------------------------------------------------------------------ */

/** Total money at risk in this cohort. The ceiling on anything recoverable. */
export function totalAtRiskPaise(cohort: Cohort): Paise {
  return cohort.subscriptions.reduce((sum, s) => sum + s.observable.amountPaise, 0);
}

/**
 * Money recoverable by some correct sequence of actions.
 *
 * The honest denominator. Reporting recovery against total-at-risk would flatter
 * nothing and mislead everyone, because a good part of any real cohort is simply
 * gone.
 */
export function recoverableAtRiskPaise(cohort: Cohort): Paise {
  return cohort.subscriptions
    .filter((s) => s.hidden.recoverable)
    .reduce((sum, s) => sum + s.observable.amountPaise, 0);
}

/** Case counts per persona, for reports and for checking a mix did what it claimed. */
export function personaBreakdown(cohort: Cohort): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const s of cohort.subscriptions) {
    counts[s.hidden.personaId] = (counts[s.hidden.personaId] ?? 0) + 1;
  }
  return counts;
}

/** Cases recoverable by some correct sequence, as a count rather than a value. */
export function recoverableCaseCount(cohort: Cohort): number {
  return cohort.subscriptions.filter((s) => s.hidden.recoverable).length;
}

/**
 * Share of at-risk money held by the single largest case.
 *
 * Reported because a value-weighted result dominated by a few large cases is
 * fragile: it moves on the outcome of a handful of decisions rather than on the
 * quality of the policy. Anything above a few percent here means the money figures
 * should be read alongside the case counts, not instead of them.
 */
export function largestCaseShare(cohort: Cohort): number {
  const total = totalAtRiskPaise(cohort);
  if (total === 0) return 0;
  const largest = cohort.subscriptions.reduce(
    (max, s) => Math.max(max, s.observable.amountPaise),
    0,
  );
  return largest / total;
}
