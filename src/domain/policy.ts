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
import { MAX_ATTEMPTS_PER_MANDATE_CYCLE } from './regulation.js';
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

/** When a balance-shortfall retry should land. */
function fundsLikelyAvailableAt(sub: ObservableSubscription, now: Millis): Millis {
  const fundingDay = sub.history.observedFundingDayOfMonth;
  if (fundingDay === undefined) return now + UNKNOWN_FUNDING_RETRY_DELAY;
  return nextFundingDay(now, fundingDay) + POST_FUNDING_BUFFER;
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

/**
 * Whether the customer has cleared the blocker since the most recent failure.
 *
 * This is the hinge of every futile-cause flow: before it is true, a retry cannot
 * succeed; after it is true, a retry is the correct next move. Applies equally to
 * a replaced card, a re-authorised mandate and a completed authentication.
 */
function remedyCompletedSinceLastFailure(sub: ObservableSubscription): boolean {
  const updatedAt = sub.remedyCompletedAt;
  if (updatedAt === undefined) return false;

  const lastFailure = [...sub.attempts]
    .reverse()
    .find((a) => a.outcome === 'failure');

  return lastFailure === undefined ? true : updatedAt > lastFailure.at;
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
      // A cleared blocker turns a futile cause into a viable one. Check that
      // before concluding there is nothing to be done.
      return remedyCompletedSinceLastFailure(sub)
        ? retryCandidates(input, 'blocker cleared since the last failure')
        : remedyCandidates(input);
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
 * We believe an attempt can succeed. Two things can still stand in the way: the
 * attempt budget, and the 24-hour notification requirement.
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

  const when = retryTimeFor(cause, input);
  const suffix = note === undefined ? '' : `; ${note}`;

  const debit: Action =
    when <= now
      ? action('RETRY_NOW', `${describeTiming(cause)}${suffix}`)
      : action('RETRY_SCHEDULED', `${describeTiming(cause)}${suffix}`, when);

  // Preferred: debit. Fallback: send the notification that makes a debit lawful,
  // and come back to it. The compliance layer decides which of these we get.
  return [
    debit,
    action(
      'SEND_PRE_DEBIT_NOTIFICATION',
      'a debit requires 24 hours notice; sending it now so the attempt can follow',
      now,
    ),
  ];
}

function retryTimeFor(cause: DeclineCause, { sub, now }: PolicyInput): Millis {
  switch (cause) {
    case 'BANK_UNAVAILABLE':
      return now + BANK_RETRY_DELAY;
    case 'LIMIT_EXCEEDED_TEMPORARY':
      return now + DAILY_LIMIT_RETRY_DELAY;
    case 'INSUFFICIENT_FUNDS':
      return fundsLikelyAvailableAt(sub, now);
    default:
      // Reached when a previously futile cause became viable because the
      // instrument was replaced. Nothing to wait for.
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
function remedyCandidates({ sub, diagnosis }: PolicyInput): readonly Action[] {
  const remedy = remedyFor(diagnosis.cause);

  if (remedy === null) {
    return [
      action('ESCALATE_TO_MERCHANT', `no automated remedy defined for ${diagnosis.cause}`),
    ];
  }

  const alreadyAsked = timesRequested(sub, [remedy.kind]);

  if (alreadyAsked >= MAX_INSTRUMENT_REQUESTS) {
    return [
      action(
        'STOP',
        `asked ${alreadyAsked} times without response; further contact is harassment ` +
          'rather than recovery',
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
