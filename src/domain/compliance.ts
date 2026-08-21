/**
 * The guardrails.
 *
 * Policy proposes. This file permits or refuses. It is the authority, and it cannot
 * be argued with by a confidence score, a prompt, or a strategy that would rather
 * collect the money.
 *
 * Two properties make this trustworthy rather than decorative:
 *
 *   1. Every rule carries the source it derives from. Nothing here rests on our
 *      preference — the one internal rule is labelled as internal.
 *   2. A refusal is returned, never thrown. The ledger records what the agent
 *      wanted and which rule stopped it, because a blocked attempt is a result
 *      worth seeing rather than an error to swallow.
 *
 * Pure. Time is a parameter.
 */

import { isHardDecline } from './causes.js';
import {
  MAX_ATTEMPTS_PER_MANDATE_CYCLE,
  MIN_CONFIDENCE_FOR_AUTONOMOUS_ACTION,
  PRE_DEBIT_NOTIFICATION_LEAD_MS,
  afaCeilingPaise,
  hourOfDayIST,
  isWithinAutopayWindow,
} from './regulation.js';
import {
  consumesAttempt,
  contactsCustomer,
  type Action,
  type Diagnosis,
  type GuardrailRejection,
  type MandateState,
  type Millis,
  type ObservableSubscription,
  type Ruling,
} from './types.js';

/* ------------------------------------------------------------------ *
 * Context
 * ------------------------------------------------------------------ */

export interface GuardrailContext {
  readonly sub: ObservableSubscription;
  readonly mandateState: MandateState;
  readonly diagnosis: Diagnosis;
  readonly action: Action;
  readonly now: Millis;
}

/** Everything except the action under consideration. */
export type GuardrailBase = Omit<GuardrailContext, 'action'>;

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

export function attemptsUsed(sub: ObservableSubscription): number {
  return sub.attempts.length;
}

export function attemptsRemaining(sub: ObservableSubscription): number {
  return Math.max(0, MAX_ATTEMPTS_PER_MANDATE_CYCLE - attemptsUsed(sub));
}

/**
 * Whether a debit at `at` would be covered by a notification already sent.
 *
 * Evaluated against the moment the debit would actually land, not against now, so
 * that sending notice today and debiting in three days is correctly permitted.
 */
export function hasValidPreDebitNotification(
  sub: ObservableSubscription,
  at: Millis,
): boolean {
  const sentAt = sub.lastPreDebitNotificationAt;
  if (sentAt === undefined) return false;
  return at - sentAt >= PRE_DEBIT_NOTIFICATION_LEAD_MS;
}

/** When this action would take effect. */
function effectiveAt(action: Action, now: Millis): Millis {
  return action.scheduledFor ?? now;
}

function hours(ms: Millis): number {
  return Math.round(ms / (60 * 60 * 1000));
}

/* ------------------------------------------------------------------ *
 * Rules
 * ------------------------------------------------------------------ */

interface Guardrail {
  readonly id: string;
  readonly citation: string;
  /** A string explains why the action must be refused. `null` permits it. */
  readonly check: (ctx: GuardrailContext) => string | null;
}

export const GUARDRAILS: readonly Guardrail[] = [
  {
    id: 'NPCI_ATTEMPT_CAP',
    citation:
      'NPCI: one original debit plus a maximum of three retries per mandate, four total. ' +
      'In force since 1 August 2025.',
    check: ({ sub, action }) => {
      if (!consumesAttempt(action.kind)) return null;
      if (attemptsRemaining(sub) > 0) return null;
      return (
        `attempt budget exhausted: ${attemptsUsed(sub)} of ` +
        `${MAX_ATTEMPTS_PER_MANDATE_CYCLE} already used`
      );
    },
  },

  {
    id: 'RBI_PRE_DEBIT_NOTIFICATION',
    citation:
      'RBI Digital Payments - E-mandate Framework, 2026: the customer must be notified ' +
      'at least 24 hours before the debit.',
    check: ({ sub, action, now }) => {
      if (!consumesAttempt(action.kind)) return null;

      const at = effectiveAt(action, now);
      if (hasValidPreDebitNotification(sub, at)) return null;

      const sentAt = sub.lastPreDebitNotificationAt;
      return sentAt === undefined
        ? 'no pre-debit notification has been sent for this cycle'
        : `notice would be only ${hours(at - sentAt)}h old at the intended debit; 24h required`;
    },
  },

  {
    id: 'CARD_NETWORK_NO_HARD_DECLINE_RETRY',
    citation:
      "Visa's excessive reattempts programme: no reattempts permitted on hard declines, " +
      'with per-transaction fees for exceeding reattempt limits.',
    check: ({ diagnosis, action }) => {
      if (!consumesAttempt(action.kind)) return null;
      if (!isHardDecline(diagnosis.cause)) return null;
      return (
        `${diagnosis.cause} is a hard decline; a reattempt cannot approve and is ` +
        'chargeable by the network'
      );
    },
  },

  {
    id: 'NPCI_EXECUTION_WINDOW',
    citation:
      'NPCI: Autopay mandate execution is restricted to non-peak windows. ' +
      'NOTE: the exact window boundaries in regulation.ts are UNVERIFIED.',
    check: ({ sub, action, now }) => {
      if (!consumesAttempt(action.kind)) return null;
      // The restriction is a UPI capacity measure; card debits are unaffected.
      if (sub.method !== 'upi_autopay') return null;

      const at = effectiveAt(action, now);
      if (isWithinAutopayWindow(at)) return null;
      return `intended execution at ${hourOfDayIST(at)}:00 IST falls outside permitted windows`;
    },
  },

  {
    id: 'MANDATE_CAP',
    citation:
      'A debit above the ceiling the customer authorised is not covered by their consent.',
    check: ({ sub, mandateState, action }) => {
      if (!consumesAttempt(action.kind)) return null;
      if (sub.amountPaise <= mandateState.capPaise) return null;
      return (
        `amount ${sub.amountPaise} paise exceeds the authorised cap ` +
        `${mandateState.capPaise} paise`
      );
    },
  },

  {
    id: 'AFA_REQUIRED_ABOVE_CEILING',
    citation:
      'RBI E-mandate Framework, 2026: recurring debits above the exemption ceiling ' +
      'require an additional factor of authentication on each occurrence.',
    check: ({ sub, mandateState, action }) => {
      if (!consumesAttempt(action.kind)) return null;

      const ceiling = afaCeilingPaise(mandateState.higherAfaCeiling);
      if (sub.amountPaise <= ceiling) return null;
      return (
        `amount ${sub.amountPaise} paise is above the ${ceiling} paise ceiling; ` +
        'a silent retry cannot supply an authentication factor'
      );
    },
  },

  {
    id: 'REVOKED_CONSENT_NO_CONTACT',
    citation:
      'A revoked mandate is withdrawn consent. Neither a debit nor a dunning message ' +
      'is appropriate against it.',
    check: ({ sub, mandateState, diagnosis, action }) => {
      const consentGone =
        mandateState.authorisation === 'revoked' ||
        mandateState.authorisation === 'expired' ||
        sub.state === 'cancelled' ||
        diagnosis.cause === 'MANDATE_REVOKED';

      if (!consentGone) return null;
      if (!consumesAttempt(action.kind) && !contactsCustomer(action.kind)) return null;
      return 'consent has been withdrawn; only STOP or ESCALATE_TO_MERCHANT remain available';
    },
  },

  {
    id: 'CONFIDENCE_FLOOR',
    citation:
      'INTERNAL POLICY, not an external rule: no autonomous action touching money or ' +
      'the customer on a diagnosis we do not trust.',
    check: ({ diagnosis, action }) => {
      if (!consumesAttempt(action.kind) && !contactsCustomer(action.kind)) return null;
      if (diagnosis.confidence >= MIN_CONFIDENCE_FOR_AUTONOMOUS_ACTION) return null;
      return (
        `diagnosis confidence ${diagnosis.confidence.toFixed(2)} is below the ` +
        `${MIN_CONFIDENCE_FOR_AUTONOMOUS_ACTION} floor`
      );
    },
  },
];

/* ------------------------------------------------------------------ *
 * Evaluation
 * ------------------------------------------------------------------ */

/**
 * Every reason this action must be refused. An empty array permits it.
 *
 * All rules are evaluated rather than short-circuiting on the first failure. A
 * debit blocked by three separate rules is more informative than one blocked by
 * whichever happened to be checked first.
 */
export function evaluate(ctx: GuardrailContext): readonly GuardrailRejection[] {
  const rejections: GuardrailRejection[] = [];

  for (const rail of GUARDRAILS) {
    const detail = rail.check(ctx);
    if (detail !== null) {
      rejections.push({ rule: rail.id, citation: rail.citation, detail });
    }
  }

  return rejections;
}

export function isPermitted(ctx: GuardrailContext): boolean {
  return evaluate(ctx).length === 0;
}

/**
 * Walk candidate actions in preference order and take the first permitted one.
 *
 * Returns every ruling, including refusals, so the ledger can show the whole
 * deliberation. `executed` is null when every candidate was refused — which is a
 * legitimate outcome meaning "there was nothing we were allowed to do", and is
 * recorded as such rather than treated as a failure.
 */
export function adjudicate(
  candidates: readonly Action[],
  base: GuardrailBase,
): { readonly rulings: readonly Ruling[]; readonly executed: Action | null } {
  const rulings: Ruling[] = [];
  let executed: Action | null = null;

  for (const action of candidates) {
    const rejections = evaluate({ ...base, action });
    rulings.push({ action, rejections });

    if (rejections.length === 0) {
      executed = action;
      break;
    }
  }

  return { rulings, executed };
}
