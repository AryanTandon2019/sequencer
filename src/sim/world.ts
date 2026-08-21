/**
 * The world model: what actually happens when a strategy acts.
 *
 * This file plays the part of the bank. When a debit is attempted it decides
 * whether the money moves, and if not, which reason string the issuer returns.
 * That is the honest framing of the whole simulator — it supplies the bank's
 * *response*, never information a real merchant would not have.
 *
 * Every function here is pure and contains no randomness. All dice were rolled at
 * generation time and recorded in `HiddenState`, so a run is reproducible and each
 * rule below can be tested in isolation.
 */

import type {
  ActionKind,
  MandateState,
  Millis,
  ObservableSubscription,
  ObservedFailure,
  Paise,
} from '../domain/types.js';
import type { HiddenState } from './personas.js';

/* ------------------------------------------------------------------ *
 * Debits
 * ------------------------------------------------------------------ */

export interface DebitOutcome {
  readonly outcome: 'success' | 'failure';
  /** Present only on failure. */
  readonly failure: ObservedFailure | undefined;
}

function issuerResponse(hidden: HiddenState, at: Millis): ObservedFailure {
  return {
    code: 'BAD_REQUEST_ERROR',
    reason: hidden.failureReason,
    source: 'bank',
    step: 'payment_authorization',
    description: `issuer declined: ${hidden.failureReason}`,
    at,
  };
}

/**
 * Attempt a debit.
 *
 * Succeeds when either the underlying obstacle has passed on its own — funds
 * arrived, the outage ended — or the customer cleared the blocker we asked them
 * about. Otherwise the issuer declines with the same reason as before, which is
 * exactly why repeating a futile attempt is repeating a mistake.
 */
export function resolveDebit(
  hidden: HiddenState,
  sub: ObservableSubscription,
  at: Millis,
): DebitOutcome {
  const succeedsFrom = hidden.retrySucceedsFrom;
  if (succeedsFrom !== undefined && at >= succeedsFrom) {
    return { outcome: 'success', failure: undefined };
  }

  const remedyAt = sub.remedyCompletedAt;
  if (remedyAt !== undefined && at >= remedyAt) {
    return { outcome: 'success', failure: undefined };
  }

  return { outcome: 'failure', failure: issuerResponse(hidden, at) };
}

/**
 * The original scheduled charge.
 *
 * Identical to any other debit. Kept as its own name because it is the attempt
 * that consumes the first of four, and reading `resolveOriginalCharge` at the
 * call site makes the budget accounting obvious.
 */
export const resolveOriginalCharge = resolveDebit;

/* ------------------------------------------------------------------ *
 * Customer responses
 * ------------------------------------------------------------------ */

/**
 * When the customer would act on a request of this kind, if ever.
 *
 * `null` means they never will — either because this persona ignores everything,
 * or because the request is not the one that would help them.
 *
 * Timing is measured from the moment they were asked, so asking sooner genuinely
 * recovers sooner. That is what makes the timing of a request matter rather than
 * just its existence.
 */
export function customerResponseAt(
  hidden: HiddenState,
  requestKind: ActionKind,
  requestedAt: Millis,
): Millis | null {
  if (!hidden.respondsTo.includes(requestKind)) return null;
  return requestedAt + hidden.responseDelay;
}

/** Whether a request of this kind could ever produce a response. */
export function wouldRespondTo(hidden: HiddenState, requestKind: ActionKind): boolean {
  return hidden.respondsTo.includes(requestKind);
}

/* ------------------------------------------------------------------ *
 * Effects of a completed remedy
 * ------------------------------------------------------------------ */

/**
 * Update mandate state once the customer has done what was asked.
 *
 * Re-authorisation raises the authorised ceiling; completing authentication
 * records that the additional factor was supplied. Both are necessary: without
 * them the guardrails would keep refusing the debit and the request we sent would
 * have accomplished nothing, which would look like the agent failing when in fact
 * the model was incomplete.
 */
export function applyRemedyToMandate(
  mandateState: MandateState,
  requestKind: ActionKind,
  amountPaise: Paise,
  at: Millis,
): MandateState {
  switch (requestKind) {
    case 'REQUEST_MANDATE_REAUTH':
      return {
        ...mandateState,
        // Authorised generously, as a customer re-authorising after a price rise
        // would, so a later modest increase does not break the mandate again.
        capPaise: Math.max(mandateState.capPaise, amountPaise * 2),
      };

    case 'REQUEST_AFA':
      return { ...mandateState, afaCompletedAt: at };

    case 'REQUEST_CARD_UPDATE':
      // A replacement card is recorded on the subscription rather than the
      // mandate. Under RBI's 2026 framework an existing mandate may be mapped to
      // a reissued card, so the authorisation itself is untouched.
      return mandateState;

    default:
      return mandateState;
  }
}

/* ------------------------------------------------------------------ *
 * Autonomous events
 * ------------------------------------------------------------------ */

/**
 * Whether a paused mandate has resumed of its own accord by this time.
 *
 * The case that punishes doing something. Any attempt or message spent before
 * this moment was waste, because the money was always going to arrive.
 */
export function hasSelfResolved(hidden: HiddenState, at: Millis): boolean {
  const resolvesAt = hidden.selfResolvesAt;
  return resolvesAt !== undefined && at >= resolvesAt;
}

/** Mandate authorisation at a given time, accounting for a pause that has ended. */
export function authorisationAt(hidden: HiddenState, at: Millis): MandateState['authorisation'] {
  if (hidden.authorisation === 'paused' && hasSelfResolved(hidden, at)) {
    return 'active';
  }
  return hidden.authorisation;
}

/* ------------------------------------------------------------------ *
 * Ground truth for scoring
 * ------------------------------------------------------------------ */

/**
 * Whether this money was recoverable at all, by any correct sequence of actions.
 *
 * The denominator that turns a bare recovery percentage into "captured X% of what
 * was achievable". Read straight from the persona rather than inferred, so the
 * ceiling cannot drift away from what the world will actually permit.
 */
export function wasRecoverable(hidden: HiddenState): boolean {
  return hidden.recoverable;
}

/** Whether contacting this customer is damage rather than merely noise. */
export function contactIsHarmful(hidden: HiddenState): boolean {
  return hidden.harmOnContact;
}
