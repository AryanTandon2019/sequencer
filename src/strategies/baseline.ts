/**
 * The baseline: Razorpay's documented subscription retry behaviour.
 *
 * This is the thing we are measured against, so it is modelled as faithfully as the
 * documentation allows. Strawmanning it would make every comparison worthless, and
 * a reviewer who works on this system would spot it immediately.
 *
 * From https://razorpay.com/docs/payments/subscriptions/payment-retries/ :
 *
 *   - a failed charge moves the subscription to `pending`
 *   - "We automatically retry the payment on the following day"
 *   - retries only fire once the previous attempt is confirmed or rejected
 *   - the charge date shifts backwards if it lands on a bank holiday
 *   - after retries are exhausted the subscription moves to `halted`
 *   - a failure email goes to the customer containing a link to change the card
 *   - for halted subscriptions invoices keep being created but are not charged;
 *     the merchant must charge them manually
 *
 * Two things follow that matter for fairness.
 *
 * First, the baseline DOES contact the customer. Razorpay sends a card-change link
 * on failure. Modelling this as retry-only would hand our agent a free win on every
 * expired-card case, which would be dishonest — the shipped default already has a
 * route to recovering those.
 *
 * Second, it forms no view about the cause. Its `diagnosis` is null, and that is the
 * whole point: the same documentation page names four distinct failure causes and
 * then applies this one policy to all of them.
 *
 * Deliberately not modelled: the bank-holiday shift. Encoding an Indian bank holiday
 * calendar would add noise to both strategies equally without changing the
 * comparison, and inventing a holiday list would be a fabricated input.
 */

import type { Millis } from '../domain/types.js';
import { action, type Strategy, type StrategyInput, type StrategyProposal } from './strategy.js';
import { MAX_ATTEMPTS_PER_MANDATE_CYCLE } from '../domain/regulation.js';

const HOUR: Millis = 60 * 60 * 1000;
const DAY: Millis = 24 * HOUR;

function attemptsUsed(input: StrategyInput): number {
  return input.sub.attempts.length;
}

function hasSentCardChangeEmail(input: StrategyInput): boolean {
  return input.sub.contacts.some((c) => c.kind === 'REQUEST_CARD_UPDATE');
}

/** The following day, measured from the most recent attempt. */
function nextRetryAt(input: StrategyInput): Millis {
  const last = input.sub.attempts.reduce((latest, a) => Math.max(latest, a.at), 0);
  const from = last === 0 ? input.sub.chargeDate : last;
  return from + DAY;
}

export const baselineStrategy: Strategy = {
  name: 'baseline',
  description:
    "Razorpay's documented default: next-day retry, one card-change email, identical " +
    'for every failure cause.',

  propose(input: StrategyInput): StrategyProposal {
    const candidates = [];

    // Budget spent. The docs are explicit that a halted subscription still raises
    // invoices but stops charging them, and the merchant charges manually - so
    // handing it to a human is the faithful model, not giving up.
    if (attemptsUsed(input) >= MAX_ATTEMPTS_PER_MANDATE_CYCLE) {
      return {
        diagnosis: null,
        candidates: [
          action(
            'ESCALATE_TO_MERCHANT',
            `retries exhausted (${MAX_ATTEMPTS_PER_MANDATE_CYCLE} attempts); the ` +
              'subscription halts and remaining invoices must be charged manually',
          ),
        ],
      };
    }

    // The documented failure email, sent once, carrying a card-change link. Offered
    // first because it consumes no attempt.
    if (!hasSentCardChangeEmail(input)) {
      candidates.push(
        action(
          'REQUEST_CARD_UPDATE',
          'documented failure email with a card-change link, sent on any failure ' +
            'regardless of cause',
        ),
      );
    }

    // Next day, as documented. The engine issues the pre-debit notice when a case
    // enters recovery, so by the following day it has matured and the debit is
    // lawful. The default policy is not asked to reason about notices.
    const retryAt = nextRetryAt(input);
    candidates.push(
      retryAt <= input.now
        ? action('RETRY_NOW', 'next-day retry, as scheduled by the default policy')
        : action(
            'RETRY_SCHEDULED',
            'next-day retry, as scheduled by the default policy',
            retryAt,
          ),
    );

    // Reached when the guardrails refuse the retry - a hard decline, or notice that
    // has not matured. The default has nothing else to try, and saying so is more
    // honest than inventing a fallback it does not have.
    candidates.push(
      action(
        'ESCALATE_TO_MERCHANT',
        'the default policy has no alternative to a retry for this case',
      ),
    );

    return { diagnosis: null, candidates };
  },
};
