/**
 * The hidden truth.
 *
 * Each simulated subscription is assigned one persona, which decides what
 * actually happens when a strategy acts on it. No strategy may ever read this
 * file — a test asserts that src/strategies/ never imports from src/sim/, because
 * if a strategy could see a persona then every reported number would be void.
 *
 * The personas are not invented from nothing. Each one corresponds to a failure
 * cause Razorpay's own documentation enumerates. What *is* invented is the
 * response behaviour: how likely a customer is to update a dead card when asked,
 * and how long they take. Those numbers are ours, they are not data, and they are
 * the softest part of the project.
 *
 * That is precisely why the sensitivity analysis exists. If the conclusion only
 * holds at one set of response rates it is not a conclusion. See DECISIONS.md D3.
 *
 * IMPORTANT DESIGN RULE: all randomness happens here, at generation time. The
 * world model that resolves outcomes is a pure function of hidden state and time,
 * with no randomness of its own. That keeps a run reproducible and makes the
 * resolution logic trivially testable.
 */

import { nextFundingDay } from '../domain/policy.js';
import type { Rng } from './rng.js';
import type {
  ActionKind,
  DeclineCause,
  MandateAuthorisation,
  Millis,
  Paise,
} from '../domain/types.js';

const HOUR: Millis = 60 * 60 * 1000;
const DAY: Millis = 24 * HOUR;

export type PersonaId =
  | 'SALARY_CYCLE_SHORTFALL'
  | 'CHRONIC_SHORTFALL'
  | 'REISSUED_CARD'
  | 'SILENT_CHURNER'
  | 'DELIBERATE_CANCELLER'
  | 'TEMPORARY_PAUSE'
  | 'BANK_OUTAGE'
  | 'PLAN_UPGRADE_OVER_CAP'
  | 'AFA_THRESHOLD'
  | 'FRAUD_FLAGGED'
  | 'UNEXPLAINED_DECLINE';

/**
 * Everything the simulator knows and no strategy may see.
 *
 * Precomputed at generation time so that outcome resolution is deterministic.
 */
export interface HiddenState {
  readonly personaId: PersonaId;

  /** The reason string the bank emits when a debit against this customer fails. */
  readonly failureReason: string;

  /** The mandate authorisation this customer presents. */
  readonly authorisation: MandateAuthorisation;

  /**
   * A retry alone succeeds at or after this time.
   * `undefined` means no retry ever succeeds, however many are spent.
   */
  readonly retrySucceedsFrom: Millis | undefined;

  /**
   * Request kinds this customer would act on. Empty means they ignore everything.
   * Acting on a request is what turns a futile cause into a viable one.
   */
  readonly respondsTo: readonly ActionKind[];

  /** How long after being asked they act. */
  readonly responseDelay: Millis;

  /** Resolves with no intervention at this time — a paused mandate resuming. */
  readonly selfResolvesAt: Millis | undefined;

  /**
   * Contacting this customer is a harm rather than merely noise. True only for
   * someone who deliberately withdrew consent.
   */
  readonly harmOnContact: boolean;

  /**
   * GROUND TRUTH for scoring: could this money be recovered by any correct
   * sequence of actions? This is the denominator that turns a bare recovery
   * percentage into "captured X% of what was achievable".
   */
  readonly recoverable: boolean;

  /** The cause a perfect diagnoser would name. Drives the oracle and the matrix. */
  readonly trueCause: DeclineCause;
}

/** Overrides a persona applies to the observable subscription it is attached to. */
export interface PersonaShape {
  /** Force a specific amount, e.g. to push a case above the AFA ceiling. */
  readonly amountPaise?: Paise;
  /** Force a mandate cap, e.g. to put the charge above the authorised ceiling. */
  readonly capPaise?: Paise;
  /** Force a payment method where the persona only makes sense on one. */
  readonly method?: 'card' | 'upi_autopay' | 'emandate';
  /** Whether this subscription is in a higher-AFA-ceiling category. */
  readonly higherAfaCeiling?: boolean;
  /** Give the customer a discernible funding day, so timing can be tested. */
  readonly fundingDayOfMonth?: number;
}

export interface Persona {
  readonly id: PersonaId;
  /** Short label for reports and the UI. */
  readonly label: string;
  /** What is really going on, in one sentence. For the README and the video. */
  readonly description: string;
  /** Relative share of the cohort. */
  readonly weight: number;
  /** What an ideal agent should do about this customer. Documentation, not logic. */
  readonly correctResponse: string;
  /** Constraints this persona places on its subscription. */
  shape(rng: Rng): PersonaShape;
  /**
   * Produce the hidden state for one subscription of this persona.
   *
   * Receives the shape so hidden truth can be made consistent with the observable
   * signals derived from it. That consistency is not optional: if a customer
   * advertises a funding day and the money arrives on some unrelated date, then a
   * strategy reading that signal is being tested against a fiction, and the result
   * says nothing about whether reading the signal was the right idea.
   */
  materialise(rng: Rng, cycleStart: Millis, shape?: PersonaShape): HiddenState;
}

/* ------------------------------------------------------------------ *
 * The personas
 * ------------------------------------------------------------------ */

export const PERSONAS: readonly Persona[] = [
  {
    id: 'SALARY_CYCLE_SHORTFALL',
    label: 'Salary-cycle shortfall',
    weight: 20,
    description:
      'Balance was short on the charge date. Money lands on a predictable day each ' +
      'month and the debit succeeds once it does.',
    correctResponse: 'Retry, timed to the funding day. Do not burn attempts before then.',
    shape: (rng) => ({ fundingDayOfMonth: rng.pick([1, 2, 3, 7, 10]) }),
    materialise: (rng, cycleStart, shape) => {
      // Money lands on the funding day this customer's history advertises. Anchored
      // to the same day the observable signal reports, so a strategy that reads the
      // signal and times its attempt is rewarded, and one that retries blindly the
      // next morning is not. Any other arrangement would be testing the heuristic
      // against noise.
      const fundingDay = shape?.fundingDayOfMonth ?? 1;
      const arrivesAt = nextFundingDay(cycleStart, fundingDay) + rng.int(1, 8) * HOUR;

      return {
        personaId: 'SALARY_CYCLE_SHORTFALL',
        failureReason: 'insufficient_funds',
        authorisation: 'active',
        retrySucceedsFrom: arrivesAt,
        respondsTo: [],
        responseDelay: 0,
        selfResolvesAt: undefined,
        harmOnContact: false,
        recoverable: true,
        trueCause: 'INSUFFICIENT_FUNDS',
      };
    },
  },

  {
    id: 'CHRONIC_SHORTFALL',
    label: 'Chronic shortfall',
    weight: 9,
    description:
      'Persistently short of funds. Occasionally the money appears, usually it does ' +
      'not. Spending the full attempt budget here is poor value.',
    correctResponse:
      'One well-timed retry is defensible. Four is a waste of a regulated budget.',
    shape: () => ({}),
    materialise: (rng, cycleStart) => {
      // Only a minority ever become collectable, and late when they do.
      const everPays = rng.bool(0.2);
      return {
        personaId: 'CHRONIC_SHORTFALL',
        failureReason: 'insufficient_funds',
        authorisation: 'active',
        retrySucceedsFrom: everPays ? cycleStart + rng.int(12, 25) * DAY : undefined,
        respondsTo: [],
        responseDelay: 0,
        selfResolvesAt: undefined,
        harmOnContact: false,
        recoverable: everPays,
        trueCause: 'INSUFFICIENT_FUNDS',
      };
    },
  },

  {
    id: 'REISSUED_CARD',
    label: 'Reissued card',
    weight: 14,
    description:
      'Card expired and the replacement is already in their wallet. They simply have ' +
      'not told anyone. No retry can ever succeed; asking them once does.',
    correctResponse:
      'Do not spend an attempt. Request a card update, then retry once the new ' +
      'instrument is in place.',
    shape: () => ({ method: 'card' }),
    materialise: (rng) => ({
      personaId: 'REISSUED_CARD',
      failureReason: 'card_expired',
      authorisation: 'active',
      // The defining property: repetition is futile, the instrument must change.
      retrySucceedsFrom: undefined,
      respondsTo: ['REQUEST_CARD_UPDATE'],
      responseDelay: rng.int(6, 96) * HOUR,
      selfResolvesAt: undefined,
      harmOnContact: false,
      recoverable: true,
      trueCause: 'CARD_EXPIRED',
    }),
  },

  {
    id: 'SILENT_CHURNER',
    label: 'Silent churner',
    weight: 8,
    description:
      'Card is dead and they have quietly stopped caring. They will not update it and ' +
      'they will not cancel. Nothing recovers this.',
    correctResponse:
      'Ask, twice at most, then stop. The value here is in not spending anything.',
    shape: () => ({ method: 'card' }),
    materialise: () => ({
      personaId: 'SILENT_CHURNER',
      failureReason: 'card_expired',
      authorisation: 'active',
      retrySucceedsFrom: undefined,
      respondsTo: [],
      responseDelay: 0,
      selfResolvesAt: undefined,
      harmOnContact: false,
      recoverable: false,
      trueCause: 'CARD_EXPIRED',
    }),
  },

  {
    id: 'DELIBERATE_CANCELLER',
    label: 'Deliberate canceller',
    weight: 12,
    description:
      'Revoked the mandate on purpose. Nothing recovers this, and every message sent ' +
      'is a message to someone who asked to be left alone.',
    correctResponse:
      'Stop. Not "stop retrying" — stop entirely, including messages. This is the ' +
      'restraint case.',
    shape: () => ({}),
    materialise: () => ({
      personaId: 'DELIBERATE_CANCELLER',
      failureReason: 'payment_failed',
      authorisation: 'revoked',
      retrySucceedsFrom: undefined,
      respondsTo: [],
      responseDelay: 0,
      selfResolvesAt: undefined,
      // The only persona for which contact is scored as damage.
      harmOnContact: true,
      recoverable: false,
      trueCause: 'MANDATE_REVOKED',
    }),
  },

  {
    id: 'TEMPORARY_PAUSE',
    label: 'Temporary pause',
    weight: 6,
    description:
      'Paused the mandate for a while and will resume on their own. The money arrives ' +
      'free of charge if you do nothing at all.',
    correctResponse: 'Wait. Any attempt or message spent here is pure waste.',
    shape: () => ({}),
    materialise: (rng, cycleStart) => {
      const resumesAt = cycleStart + rng.int(4, 9) * DAY;
      return {
        personaId: 'TEMPORARY_PAUSE',
        failureReason: 'payment_failed',
        authorisation: 'paused',
        // Both routes point at the same moment, on purpose. Once the mandate
        // resumes the money arrives whether or not anyone did anything, and an
        // explicit retry after that point also succeeds. Anything spent before it
        // was waste, which is the entire lesson of this persona.
        retrySucceedsFrom: resumesAt,
        respondsTo: [],
        responseDelay: 0,
        selfResolvesAt: resumesAt,
        harmOnContact: false,
        recoverable: true,
        trueCause: 'MANDATE_PAUSED',
      };
    },
  },

  {
    id: 'BANK_OUTAGE',
    label: 'Bank outage',
    weight: 15,
    description:
      'The bank or partner bank was briefly down. Clears within hours and the debit ' +
      'then succeeds. The cheapest recovery on the board.',
    correctResponse: 'Retry after a short delay. Do not wait days for this.',
    shape: () => ({}),
    materialise: (rng, cycleStart) => ({
      personaId: 'BANK_OUTAGE',
      failureReason: rng.pick(['bank_technical_error', 'gateway_technical_error']),
      authorisation: 'active',
      retrySucceedsFrom: cycleStart + rng.int(2, 10) * HOUR,
      respondsTo: [],
      responseDelay: 0,
      selfResolvesAt: undefined,
      harmOnContact: false,
      recoverable: true,
      trueCause: 'BANK_UNAVAILABLE',
    }),
  },

  {
    id: 'PLAN_UPGRADE_OVER_CAP',
    label: 'Plan upgrade over cap',
    weight: 5,
    description:
      'Moved to a pricier plan, so the charge now exceeds the ceiling they originally ' +
      'authorised. A debit above the cap is outside their consent.',
    correctResponse: 'Request re-authorisation at a higher ceiling, then retry.',
    shape: (rng) => ({
      amountPaise: rng.pick([1_499_00, 1_999_00, 2_499_00]),
      capPaise: 999_00,
    }),
    materialise: (rng) => ({
      personaId: 'PLAN_UPGRADE_OVER_CAP',
      failureReason: 'payment_failed',
      authorisation: 'active',
      retrySucceedsFrom: undefined,
      respondsTo: ['REQUEST_MANDATE_REAUTH'],
      responseDelay: rng.int(12, 72) * HOUR,
      selfResolvesAt: undefined,
      harmOnContact: false,
      recoverable: true,
      trueCause: 'AMOUNT_EXCEEDS_MANDATE',
    }),
  },

  {
    id: 'AFA_THRESHOLD',
    label: 'Above the AFA ceiling',
    weight: 4,
    description:
      'Charge sits above the authentication exemption ceiling, so each debit needs an ' +
      'additional factor. A silent retry cannot supply one.',
    correctResponse: 'Request authentication, then retry.',
    // Amounts sit just above the exemption ceiling rather than far above it. The
    // persona only needs to cross the threshold; making it 70x a typical
    // subscription would let a dozen cases dominate every money-weighted figure
    // and make the headline number hinge on a handful of outcomes.
    shape: (rng) => ({
      amountPaise: rng.pick([15_499_00, 16_999_00, 19_999_00]),
      capPaise: 30_000_00,
      higherAfaCeiling: false,
    }),
    materialise: (rng) => ({
      personaId: 'AFA_THRESHOLD',
      failureReason: 'payment_failed',
      authorisation: 'active',
      retrySucceedsFrom: undefined,
      respondsTo: ['REQUEST_AFA'],
      responseDelay: rng.int(6, 48) * HOUR,
      selfResolvesAt: undefined,
      harmOnContact: false,
      recoverable: true,
      trueCause: 'AUTH_REQUIRED_AFA',
    }),
  },

  {
    id: 'FRAUD_FLAGGED',
    label: 'Fraud-flagged',
    weight: 3,
    description:
      'The issuer declined citing suspected fraud. Reattempting pushes against a risk ' +
      'decision the bank has already made, and the network charges for it.',
    correctResponse: 'Stop. This is not ours to overrule.',
    shape: () => ({ method: 'card' }),
    materialise: () => ({
      personaId: 'FRAUD_FLAGGED',
      failureReason: 'payment_risk_check_failed',
      authorisation: 'active',
      retrySucceedsFrom: undefined,
      respondsTo: [],
      responseDelay: 0,
      selfResolvesAt: undefined,
      harmOnContact: false,
      recoverable: false,
      trueCause: 'FRAUD_SUSPECTED',
    }),
  },

  {
    id: 'UNEXPLAINED_DECLINE',
    label: 'Unexplained decline',
    weight: 4,
    description:
      'The bank declined and told nobody why. Razorpay documents that it may not have ' +
      'access to the cause. Sometimes a human can sort it out, often not.',
    correctResponse:
      'Escalate. Guessing here is how a system starts inventing confident answers.',
    shape: () => ({ method: 'card' }),
    materialise: (rng, cycleStart) => {
      const humanCanFixIt = rng.bool(0.35);
      return {
        personaId: 'UNEXPLAINED_DECLINE',
        failureReason: rng.pick(['card_declined', 'payment_failed']),
        authorisation: 'active',
        retrySucceedsFrom: humanCanFixIt ? cycleStart + rng.int(3, 14) * DAY : undefined,
        respondsTo: [],
        responseDelay: 0,
        selfResolvesAt: undefined,
        harmOnContact: false,
        recoverable: humanCanFixIt,
        trueCause: 'AMBIGUOUS_BANK_DECLINE',
      };
    },
  },
];

/* ------------------------------------------------------------------ *
 * Lookup and mixes
 * ------------------------------------------------------------------ */

const BY_ID = new Map<PersonaId, Persona>(PERSONAS.map((p) => [p.id, p]));

export function personaById(id: PersonaId): Persona {
  const persona = BY_ID.get(id);
  if (persona === undefined) throw new Error(`unknown persona: ${id}`);
  return persona;
}

/**
 * Named cohort compositions for the sensitivity analysis.
 *
 * A conclusion that only holds for one invented distribution is not a conclusion.
 * Running the same comparison across all three of these is what answers the
 * sharpest objection to this project: that the mix was chosen to flatter it.
 *
 * `balanced` is the default and uses each persona's declared weight.
 */
export type MixName = 'balanced' | 'churn_heavy' | 'funds_heavy';

export const MIXES: Readonly<Record<MixName, Readonly<Partial<Record<PersonaId, number>>>>> = {
  balanced: {},

  /** Cancellations and dead cards dominate. Rewards restraint, punishes chasing. */
  churn_heavy: {
    DELIBERATE_CANCELLER: 28,
    SILENT_CHURNER: 20,
    REISSUED_CARD: 16,
    SALARY_CYCLE_SHORTFALL: 8,
    BANK_OUTAGE: 8,
  },

  /** Transient and balance problems dominate. Rewards good retry timing. */
  funds_heavy: {
    SALARY_CYCLE_SHORTFALL: 34,
    BANK_OUTAGE: 26,
    CHRONIC_SHORTFALL: 14,
    DELIBERATE_CANCELLER: 5,
    SILENT_CHURNER: 3,
  },
};

/** Persona weights for a named mix, falling back to each persona's own weight. */
export function weightsFor(mix: MixName): readonly { value: Persona; weight: number }[] {
  const overrides = MIXES[mix];
  return PERSONAS.map((persona) => ({
    value: persona,
    weight: overrides[persona.id] ?? persona.weight,
  }));
}
