/**
 * Externally-sourced constants.
 *
 * Every value here comes from a published rule, not from our judgement. They live
 * in one file so that each can be checked against its source in one sitting, and
 * so that no magic number appears anywhere else in the codebase.
 *
 * Provenance is graded honestly:
 *   PRIMARY   - read from the issuing body's own document
 *   SECONDARY - reported consistently by credible outlets, primary not yet read
 *   UNVERIFIED - the rule exists, the exact value is a working assumption
 *
 * Anything still SECONDARY or UNVERIFIED at submission time must be labelled as
 * such in the README. A guardrail that cannot be traced is worse than none.
 */

import type { Millis, Paise } from './types.js';

/* ------------------------------------------------------------------ *
 * NPCI - mandate execution
 * ------------------------------------------------------------------ */

/**
 * One original debit attempt plus a maximum of three retries per mandate, i.e.
 * four attempts total. In force since 1 August 2025.
 *
 * PROVENANCE: SECONDARY. Reported consistently by multiple outlets; the NPCI
 * circular itself has not yet been read end to end.
 *   https://ibsintelligence.com/ibsi-news/npci-tightens-upi-api-rules-to-boost-resilience-fraud-controls/
 *   https://economictimes.indiatimes.com/wealth/save/big-changes-to-upi-from-august-1-daily-limits-api-rules-and-penalties-introduced/fixed-time-windows-for-auto-debits-mandate-execution-limit/slideshow/123118019.cms
 *
 * This constant is the scarce resource the entire project is about.
 */
export const MAX_ATTEMPTS_PER_MANDATE_CYCLE = 4;

/**
 * NPCI restricts Autopay mandate execution to non-peak windows, introduced in
 * the same August 2025 rule set to keep UPI peak capacity clear.
 *
 * PROVENANCE: UNVERIFIED. The existence of the restriction is well established.
 * The specific hours below are a working assumption and secondary reporting of
 * the boundaries varies. Reconcile against the NPCI circular before claiming
 * these numbers in the pitch.
 *
 * Hours are IST, half-open intervals [startHour, endHour).
 */
export const AUTOPAY_EXECUTION_WINDOWS = [
  { startHour: 0, endHour: 10 },
  { startHour: 13, endHour: 17 },
  { startHour: 21, endHour: 24 },
] as const;

/* ------------------------------------------------------------------ *
 * RBI - Digital Payments, E-mandate Framework, 2026
 * ------------------------------------------------------------------ */

/**
 * The customer must be notified at least 24 hours before the actual debit.
 *
 * PROVENANCE: SECONDARY. From KPMG's summary of the framework notified
 * 21 April 2026, effective immediately. The RBI document itself is linked below
 * and should be read directly before submission.
 *   https://kpmg.com/in/en/insights/2026/06/reserve-bank-of-india-rbi-digital-payments-e-mandate-framework-2026.html
 *   https://website.rbi.org.in/documents/87730/39710850/Processing+of+e-mandates+for+recurring+transactions.pdf
 */
export const PRE_DEBIT_NOTIFICATION_LEAD_MS: Millis = 24 * 60 * 60 * 1000;

/**
 * Additional Factor of Authentication is not required at or below this value.
 * Above it, each recurring debit must go through AFA.
 *
 * PROVENANCE: SECONDARY, same source as above.
 */
export const AFA_EXEMPT_CEILING_PAISE: Paise = 15_000_00;

/**
 * A higher exemption ceiling applies to specified categories such as insurance
 * premiums, SIP instalments and credit card bill payments.
 *
 * PROVENANCE: SECONDARY, same source as above.
 */
export const AFA_EXEMPT_CEILING_HIGHER_PAISE: Paise = 1_00_000_00;

/* ------------------------------------------------------------------ *
 * Card networks - reattempt limits
 * ------------------------------------------------------------------ */

/**
 * Visa permits no reattempts on hard declines, and charges per-transaction fees
 * for exceeding reattempt limits under its excessive reattempts / processing
 * integrity programmes. Mastercard applies a lower cap.
 *
 * PROVENANCE: SECONDARY.
 *   https://www.paypal.com/us/brc/article/avoid-excessive-retries-penalties
 *   https://developers.getevolved.com/enterprise/docs/visas-processing-integrity-fee-program
 *
 * Recorded for the fine-exposure metric. The operative rule Sequencer enforces
 * is the categorical one: never reattempt a hard decline.
 */
export const VISA_MAX_REATTEMPTS_PER_30_DAYS = 15;

/* ------------------------------------------------------------------ *
 * Internal policy - ours, and labelled as such
 * ------------------------------------------------------------------ */

/**
 * Below this diagnosis confidence, no autonomous action touching money or the
 * customer is permitted; the case goes to the triage queue.
 *
 * PROVENANCE: internal choice, not external rule. Tunable, and the sensitivity
 * of results to this value is worth reporting.
 */
export const MIN_CONFIDENCE_FOR_AUTONOMOUS_ACTION = 0.7;

/** Returns the AFA exemption ceiling applicable to a subscription. */
export function afaCeilingPaise(higherCeiling: boolean): Paise {
  return higherCeiling ? AFA_EXEMPT_CEILING_HIGHER_PAISE : AFA_EXEMPT_CEILING_PAISE;
}

/**
 * IST is UTC+5:30 with no daylight saving, so a fixed offset is correct.
 * Kept here rather than pulling in a timezone library for one arithmetic step.
 */
const IST_OFFSET_MS: Millis = (5 * 60 + 30) * 60 * 1000;

export function hourOfDayIST(at: Millis): number {
  return new Date(at + IST_OFFSET_MS).getUTCHours();
}

/** Whether a mandate execution at this instant falls inside a permitted window. */
export function isWithinAutopayWindow(at: Millis): boolean {
  const hour = hourOfDayIST(at);
  return AUTOPAY_EXECUTION_WINDOWS.some((w) => hour >= w.startHour && hour < w.endHour);
}
