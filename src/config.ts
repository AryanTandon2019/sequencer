/**
 * Run configuration.
 *
 * Every tunable in one place, so a reviewer can see exactly what produced the
 * numbers and change one thing at a time.
 */

import type { Millis, Paise } from './domain/types.js';

const HOUR: Millis = 60 * 60 * 1000;
const DAY: Millis = 24 * HOUR;

/* ------------------------------------------------------------------ *
 * Seeds
 * ------------------------------------------------------------------ */

/**
 * The cohort used while building and tuning.
 *
 * Anything learned from staring at this cohort risks being fitted to it.
 */
export const DEV_SEED = 20260905;

/**
 * The cohort reported in the README.
 *
 * Generated from a different seed and never used for tuning, so the headline
 * figures are measured on data the policy was not shaped against. Track 02 asks
 * for a held-out test set; offering one here unprompted costs nothing.
 */
export const HOLDOUT_SEED = 19980417;

/* ------------------------------------------------------------------ *
 * Cohort
 * ------------------------------------------------------------------ */

export const COHORT_SIZE = 300;

/** Typical Indian subscription prices, in paise. */
export const SUBSCRIPTION_AMOUNTS_PAISE: readonly Paise[] = [
  149_00, 199_00, 299_00, 399_00, 499_00, 699_00, 999_00, 1_499_00,
];

/**
 * Headroom between the charge amount and the authorised mandate ceiling.
 *
 * Real mandates are usually authorised above the current price so a modest
 * increase does not break the mandate. Personas that need the charge to exceed
 * the cap override this.
 */
export const MANDATE_CAP_HEADROOM = 3;

/* ------------------------------------------------------------------ *
 * Simulation
 * ------------------------------------------------------------------ */

/**
 * How long each run covers.
 *
 * Long enough for a four-attempt budget spread across a funding cycle to play out,
 * and for a paused mandate to resume. Short enough that a run is instant.
 */
export const SIMULATION_DAYS = 45;

/**
 * Clock granularity.
 *
 * One hour, because the Autopay execution windows are hour-of-day rules and the
 * pre-debit notification requirement is measured in hours. A coarser tick would
 * make those constraints untestable.
 */
export const TICK_MS: Millis = HOUR;

/** Start of the simulated window. Fixed, so runs are comparable. */
export const SIMULATION_START: Millis = Date.UTC(2026, 8, 5, 4, 30);

export const SIMULATION_END: Millis = SIMULATION_START + SIMULATION_DAYS * DAY;
