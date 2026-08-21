/**
 * Cause -> action.
 *
 * Given a diagnosis, propose candidate actions in preference order. The compliance
 * layer decides which are permitted; this file only decides what is *sensible*.
 *
 * There is no model in this path. Once the cause is known, the right response is a
 * matter of rule, not judgement — and a rule that can be read in one screen is
 * worth more than a model that usually agrees with it.
 *
 * The whole file is one pure function plus its helpers. Time is a parameter.
 */

import { recoverabilityOf } from './causes.js';
import {
  MAX_ATTEMPTS_PER_MANDATE_CYCLE,
  PRE_DEBIT_NOTIFICATION_LEAD_MS,
} from './regulation.js';
import { lastFailureAt, remedyClearedSinceLastFailure } from './state.js';
import type {
  Action,
  DeclineCause,
  Diagnosis,
  MandateState,
  Millis,
  ObservableSubscription,
} from './types.js';

/* ------------------------------------------------------------------ *
 * Policy constants
 *
 * These are OUR choices, not external rules. Kept apart from regulation.ts
 * precisely so the distinction stays obvious: nothing here can be cited, and
 * every value is a tuning knob whose effect on results should be reported.
 * ------------------------------------------------------------------ */

const HOUR: Millis = 60 * 60 * 1000;
const DAY: Millis = 24 * HOUR;

/** Transient bank failures clear quickly. Long enough to matter, short enough to be cheap. */
const BANK_RETRY_DELAY: Millis = 6 * HOUR;

/** A daily limit resets overnight, so tomorrow is genuinely the right answer. */
const DAILY_LIMIT_RETRY_DELAY: Millis = 1 * DAY;

/** Fallback wait for a balance shortfall when the funding day is unknown. */
const UNKNOWN_FUNDING_RETRY_DELAY: Millis = 3 * DAY;

/** Land the attempt a little after funds arrive rather than racing the credit. */
const POST_FUNDING_BUFFER: Millis = 6 * HOUR;

/**
 * How many times we will ask a customer to fix an instrument before stopping.
 *
 * Asking twice is persistence. Asking five times is harassment, and the second
 * unanswered request already tells you most of what the third would.
 */
const MAX_INSTRUMENT_REQUESTS = 2;

/**
 * How long to leave a request unanswered before asking again.
 *
 * Without this the ask cadence is set by however often the policy happens to be
 * consulted, which has nothing to do with how long a person takes to find their new
 * card. Re-asking every few hours would exhaust the two-request allowance inside a
 * day and abandon customers who were about to comply — losing recoverable money to
 * impatience and looking like harassment on the way.
 */
const REQUEST_PATIENCE: Millis = 5 * DAY;

/** A paused mandate is given this long to resume on its own before escalating. */
const PAUSE_PATIENCE: Millis = 10 * DAY;

/* ------------------------------------------------------------------ *
 * Timing helpers
 * ------------------------------------------------------------------ */

const IST_OFFSET_MS: Millis = (5 * 60 + 30) * 60 * 1000;

/**
 * The next time the given day-of-month occurs, at midnight IST, strictly after
 * `after`.
 *
 * Months are uneven, so a customer funded on the 31st simply has no funding day
 * in February. Clamping to the last day of the month is the only sane reading of
 * "paid at month end".
 */
export function nextFundingDay(after: Millis, dayOfMonth: number): Millis {
  const ist = new Date(after + IST_OFFSET_MS);
  let year = ist.getUTCFullYear();
  let month = ist.getUTCMonth();

  for (let i = 0; i < 3; i += 1) {
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const clamped = Math.min(dayOfMonth, daysInMonth);
    const candidate = Date.UTC(year, month, clamped) - IST_OFFSET_MS;
    if (candidate > after) return candidate;

    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }

  // Unreachable for any sane dayOfMonth, but returning a definite value beats
  // throwing inside a pure planning function.
  return after + UNKNOWN_FUNDING_RETRY_DELAY;
}

/**
 * When a balance-shortfall retry should land.
 *
 * Anchored to the charge date rather than to now, which matters more than it looks.
 * Anchoring to now means that each time the policy is consulted it searches for the
 * next *future* funding day — so on waking at the scheduled moment it would find the
 * day has just passed, jump a month ahead, and defer again. The retry would never
 * fire. Anchoring to the fixed charge date gives a stable target that arrives.
 */
function fundsLikelyAvailableAt(sub: ObservableSubscription, now: Millis): Millis {
  const fundingDay = sub.history.observedFundingDayOfMonth;
  if (fundingDay === undefined) {
    // No discernible funding day. Anchored to the failure so the target arrives.
    const failedAt = lastFailureAt(sub) ?? sub.chargeDate;
    const target = failedAt + UNKNOWN_FUNDING_RETRY_DELAY;
    return target <= now ? now : target;
  }

  const target = nextFundingDay(sub.chargeDate, fundingDay) + POST_FUNDING_BUFFER;
  // Already past it: funds should be there, so there is nothing left to wait for.
  return target <= now ? now : target;
}

/* ------------------------------------------------------------------ *
 * Small helpers over observable state
 * ------------------------------------------------------------------ */

export function attemptsUsed(sub: ObservableSubscription): number {
  return sub.attempts.length;
}

export function attemptsRemaining(sub: ObservableSubscription): number {
  return Math.max(0, MAX_ATTEMPTS_PER_MANDATE_CYCLE - attemptsUsed(sub));
}

function timesRequested(sub: ObservableSubscription, kinds: readonly Action['kind'][]): number {
  return sub.contacts.filter((c) => kinds.includes(c.kind)).length;
}

/** When we last asked this customer for something, if we have. */
function lastRequestedAt(
  sub: ObservableSubscription,
  kind: Action['kind'],
): Millis | undefined {
  let latest: Millis | undefined;
  for (const contact of sub.contacts) {
    if (contact.kind !== kind) continue;
    if (latest === undefined || contact.at > latest) latest = contact.at;
  }
  return latest;
}

function action(kind: Action['kind'], rationale: string, scheduledFor?: Millis): Action {
  return scheduledFor === undefined
    ? { kind, rationale }
    : { kind, scheduledFor, rationale };
}

/* ------------------------------------------------------------------ *
 * Which request fixes which cause
 * ------------------------------------------------------------------ */

/**
 * For a futile cause, the one thing the customer can do that makes a later
 * attempt viable.
 */
function remedyFor(cause: DeclineCause): { kind: Action['kind']; ask: string } | null {
  switch (cause) {
    case 'CARD_EXPIRED':
      return {
        kind: 'REQUEST_CARD_UPDATE',
        ask: 'card has expired; the mandate needs mapping to the reissued card',
      };
    case 'INSTRUMENT_BLOCKED':
      return {
        kind: 'REQUEST_CARD_UPDATE',
        ask: 'instrument is blocked; customer must unblock it or supply another',
      };
    case 'INSTRUMENT_NOT_ENABLED':
      return {
        kind: 'REQUEST_CARD_UPDATE',
        ask: 'instrument is not enabled for online use; customer must enable it',
      };
    case 'ACCOUNT_MISMATCH':
      return {
        kind: 'REQUEST_MANDATE_REAUTH',
        ask: 'debit attempted against an unregistered account; mandate must be re-registered',
      };
    case 'VPA_INVALID':
      return {
        kind: 'REQUEST_MANDATE_REAUTH',
        ask: 'UPI handle cannot be resolved; mandate must be re-registered',
      };
    case 'AMOUNT_EXCEEDS_MANDATE':
      return {
        kind: 'REQUEST_MANDATE_REAUTH',
        ask: 'charge exceeds the authorised ceiling; a higher mandate must be authorised',
      };
    case 'AUTH_REQUIRED_AFA':
      return {
        kind: 'REQUEST_AFA',
        ask: 'charge is above the AFA exemption ceiling and requires authentication',
      };
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ *
 * The policy
 * ------------------------------------------------------------------ */

export interface PolicyInput {
  readonly sub: ObservableSubscription;
  readonly mandateState: MandateState;
  readonly diagnosis: Diagnosis;
  readonly now: Millis;
}

/**
 * Candidate actions in preference order.
 *
 * The first entry is what we would most like to do. Later entries are fallbacks
 * for when the compliance layer refuses an earlier one — most commonly because a
 * debit needs a 24-hour pre-debit notification that has not been sent yet.
 *
 * The list always ends in something terminal, so there is no case where every
 * candidate is refused and the engine has nothing to record.
 */
export function proposeActions(input: PolicyInput): readonly Action[] {
  const { sub, diagnosis, now } = input;
  const { cause } = diagnosis;

  // Checked before anything else, and deliberately before the cause is consulted.
  //
  // Once the customer has replaced the card, re-authorised the mandate or completed
  // authentication, the previous failure reason describes a situation that no longer
  // exists. Reaching this check only inside the RETRY_FUTILE branch meant that a
  // remedied case whose stale reason happened to classify as ambiguous was escalated
  // instead of retried - losing money that had just been made collectable.
  if (remedyClearedSinceLastFailure(sub) && attemptsRemaining(sub) > 0) {
    return retryCandidates(input, 'blocker cleared since the last failure');
  }

  switch (recoverabilityOf(cause)) {
    case 'RETRY_FORBIDDEN':
      // Consent withdrawn, or the issuer flagged risk. Not a retry we are
      // choosing to skip - a retry we are not entitled to make.
      return [
        action(
          'STOP',
          cause === 'MANDATE_REVOKED'
            ? 'consent withdrawn; neither debit nor dunning is appropriate'
            : 'issuer declined citing fraud risk; reattempting pushes against their decision',
        ),
      ];

    case 'NEEDS_HUMAN':
      return [
        action(
          'ESCALATE_TO_MERCHANT',
          'bank declined without supplying a cause; not determinable from the payload',
        ),
      ];

    case 'WAIT':
      return waitCandidates(input);

    case 'RETRY_VIABLE':
      return retryCandidates(input);

    case 'RETRY_FUTILE':
      // The cleared-blocker case is handled above, so reaching here means the
      // blocker is still in place and only the customer can shift it.
      return remedyCandidates(input);
  }
}

/** A paused mandate resumes on its own. Give it room, then hand it over. */
function waitCandidates({ sub, now }: PolicyInput): readonly Action[] {
  const firstFailure = sub.attempts.find((a) => a.outcome === 'failure');
  const waitingSince = firstFailure?.at ?? now;

  if (now - waitingSince < PAUSE_PATIENCE) {
    return [
      action(
        'WAIT',
        'mandate is paused rather than revoked; it resumes without intervention, ' +
          'and attempts spent meanwhile are simply burned',
      ),
    ];
  }

  return [
    action('ESCALATE_TO_MERCHANT', 'mandate has stayed paused long enough to need a decision'),
  ];
}

/**
 * The earliest moment a debit could lawfully land.
 *
 * RBI requires 24 hours notice before a debit. Sending that notice is platform
 * infrastructure rather than a policy choice — the engine issues it when a case
 * enters recovery — so the policy's job is not to send it but to schedule around
 * it. A retry timed before the notice matures would simply be refused.
 */
function earliestLawfulDebit(sub: ObservableSubscription, now: Millis): Millis {
  const noticeAt = sub.lastPreDebitNotificationAt;
  if (noticeAt === undefined) return now + PRE_DEBIT_NOTIFICATION_LEAD_MS;
  return noticeAt + PRE_DEBIT_NOTIFICATION_LEAD_MS;
}

/**
 * We believe an attempt can succeed. Two things can still stand in the way: the
 * attempt budget, and the maturity of the pre-debit notice.
 */
function retryCandidates(input: PolicyInput, note?: string): readonly Action[] {
  const { sub, diagnosis, now } = input;
  const { cause } = diagnosis;

  if (attemptsRemaining(sub) === 0) {
    return [
      action(
        'ESCALATE_TO_MERCHANT',
        `attempt budget exhausted (${MAX_ATTEMPTS_PER_MANDATE_CYCLE} of ` +
          `${MAX_ATTEMPTS_PER_MANDATE_CYCLE} used); recovery now needs a manual charge`,
      ),
    ];
  }

  // Whichever is later: when the cause suggests the money will be there, and when
  // a debit becomes lawful. Retrying before either is pointless.
  const desired = retryTimeFor(cause, input);
  const when = Math.max(desired, earliestLawfulDebit(sub, now));
  const suffix = note === undefined ? '' : `; ${note}`;

  const debit: Action =
    when <= now
      ? action('RETRY_NOW', `${describeTiming(cause)}${suffix}`)
      : action('RETRY_SCHEDULED', `${describeTiming(cause)}${suffix}`, when);

  // A trailing hand-over so there is always a lawful step. Reached when the debit
  // is refused for a reason the policy could not anticipate, which is better
  // surfaced to a human than silently retried.
  return [
    debit,
    action(
      'ESCALATE_TO_MERCHANT',
      'the intended attempt was refused; handing over rather than trying again blindly',
    ),
  ];
}

/**
 * When the cause suggests the money will be available.
 *
 * Every branch anchors to the failure rather than to now, and that is not a detail.
 * A delay measured from now is recomputed on every consultation, so waking at the
 * scheduled moment produces a fresh delay and the retry recedes for ever. Anchoring
 * to the fixed moment of failure gives a target that actually arrives.
 */
function retryTimeFor(cause: DeclineCause, { sub, now }: PolicyInput): Millis {
  const failedAt = lastFailureAt(sub) ?? sub.chargeDate;

  switch (cause) {
    case 'BANK_UNAVAILABLE':
      return failedAt + BANK_RETRY_DELAY;
    case 'LIMIT_EXCEEDED_TEMPORARY':
      return failedAt + DAILY_LIMIT_RETRY_DELAY;
    case 'INSUFFICIENT_FUNDS':
      return fundsLikelyAvailableAt(sub, now);
    default:
      // Reached when a blocker has been cleared, so there is nothing to wait for.
      return now;
  }
}

function describeTiming(cause: DeclineCause): string {
  switch (cause) {
    case 'BANK_UNAVAILABLE':
      return 'transient bank failure; retrying after a short delay';
    case 'LIMIT_EXCEEDED_TEMPORARY':
      return 'daily transaction limit resets overnight, so tomorrow is the correct attempt';
    case 'INSUFFICIENT_FUNDS':
      return 'balance shortfall; timing the attempt to when funds are expected';
    default:
      return 'attempt is viable now';
  }
}

/**
 * Nothing we do alone can make this succeed. Ask the customer for the one thing
 * that would — but only twice.
 */
function remedyCandidates({ sub, diagnosis, now }: PolicyInput): readonly Action[] {
  const remedy = remedyFor(diagnosis.cause);

  if (remedy === null) {
    return [
      action('ESCALATE_TO_MERCHANT', `no automated remedy defined for ${diagnosis.cause}`),
    ];
  }

  const alreadyAsked = timesRequested(sub, [remedy.kind]);
  const askedAt = lastRequestedAt(sub, remedy.kind);

  // A request is outstanding and has not had time to land. Waiting is the action
  // here, not a lack of one.
  if (askedAt !== undefined && now - askedAt < REQUEST_PATIENCE) {
    return [
      action(
        'WAIT',
        `asked ${Math.round((now - askedAt) / (60 * 60 * 1000))}h ago; leaving the ` +
          'customer time to act before asking again',
      ),
    ];
  }

  if (alreadyAsked >= MAX_INSTRUMENT_REQUESTS) {
    return [
      action(
        'STOP',
        `asked ${alreadyAsked} times over ${Math.round(
          (REQUEST_PATIENCE * alreadyAsked) / (24 * 60 * 60 * 1000),
        )} days without response; further contact is harassment rather than recovery`,
      ),
    ];
  }

  return [
    action(
      remedy.kind,
      `${remedy.ask}; retrying cannot succeed, so no attempt is spent (request ` +
        `${alreadyAsked + 1} of ${MAX_INSTRUMENT_REQUESTS})`,
    ),
  ];
}
