/**
 * The vocabulary of the domain.
 *
 * Pure type declarations plus two tiny predicates. Nothing here reads a clock,
 * a file, or a random number generator.
 *
 * Money is always integer paise. Never floats, never rupees-as-decimal. Every
 * amount field is suffixed `Paise` so a unit mistake is visible at the call site
 * rather than three layers down in a total.
 */

export type Paise = number;

/** Time is epoch milliseconds. The harness supplies it; nothing here reads a clock. */
export type Millis = number;

export type PaymentMethod = 'card' | 'upi_autopay' | 'emandate';

/* ------------------------------------------------------------------ *
 * Input 1: the payment failure
 * ------------------------------------------------------------------ */

/**
 * A payment failure exactly as a merchant observes it.
 *
 * Field set mirrors Razorpay's documented error object:
 *   { code, description, field, source, step, reason, metadata }
 * See https://razorpay.com/docs/errors/codes
 *
 * `reason` is what we classify on. `step` and `source` are disambiguating
 * signals for the cases where `reason` alone is insufficient.
 *
 * Nothing in this object is inferred by us. The issuing bank decided why the
 * payment failed; Razorpay translated it; we read it.
 */
export interface ObservedFailure {
  /** Error type, e.g. "BAD_REQUEST_ERROR". */
  readonly code: string;
  /** The exact machine-handleable failure reason, e.g. "card_expired". */
  readonly reason: string;
  /** Where the failure originated: customer, business, bank, gateway, network. */
  readonly source: string;
  /** Stage at which it failed, e.g. "payment_authentication". */
  readonly step: string;
  readonly description: string;
  readonly at: Millis;
}

/* ------------------------------------------------------------------ *
 * Input 2: mandate state
 * ------------------------------------------------------------------ */

/**
 * Mandate authorisation state.
 *
 * This is a SEPARATE input from `ObservedFailure`, and that separation is the
 * single most consequential thing we learned from reading the docs.
 *
 * Razorpay's error taxonomy carries no mandate information at all - there is no
 * `reason` string for a revoked or paused mandate, because those pages document
 * checkout failures. Yet the subscription retries doc names customer mandate
 * cancellation as a cause of failed recurring charges. So mandate state arrives
 * via subscription state transitions and webhooks, not via `reason`.
 *
 * A classifier reading only `reason` cannot tell a customer who withdrew consent
 * from a customer whose bank was briefly down - and those have opposite correct
 * responses.
 *
 * See docs/decline-taxonomy.md §5 and DECISIONS.md D12.
 */
export type MandateAuthorisation = 'active' | 'paused' | 'revoked' | 'expired';

export interface MandateState {
  readonly authorisation: MandateAuthorisation;
  /** Ceiling authorised by the customer. Debits above this are outside consent. */
  readonly capPaise: Paise;
  /**
   * Whether this subscription falls in a category carrying the higher AFA
   * exemption ceiling (insurance premiums, SIP instalments, credit card bills).
   */
  readonly higherAfaCeiling: boolean;
  /**
   * When the customer completed an additional authentication factor for this
   * cycle, if they have.
   *
   * Without this, a charge above the AFA ceiling would be blocked for ever and
   * the authentication we asked the customer to perform would achieve nothing.
   */
  readonly afaCompletedAt?: Millis | undefined;
}

/* ------------------------------------------------------------------ *
 * Causes and recoverability
 * ------------------------------------------------------------------ */

/**
 * Internal decline buckets.
 *
 * Derived from Razorpay's documented `reason` values (see domain/taxonomy.ts)
 * plus mandate state. The list is longer than first assumed because verifying
 * the real error pages surfaced causes that were missed: fraud-flagged declines,
 * temporary daily limits, instruments never enabled for online use, and declines
 * the bank refuses to explain.
 */
export type DeclineCause =
  /** Balance was short. An attempt can work; timing decides whether it does. */
  | 'INSUFFICIENT_FUNDS'
  /** Transient infrastructure failure at the bank or partner bank. */
  | 'BANK_UNAVAILABLE'
  /** Daily transaction limit hit. Resets overnight. */
  | 'LIMIT_EXCEEDED_TEMPORARY'
  /** The card is past its expiry date. */
  | 'CARD_EXPIRED'
  /** The instrument is blocked, by the customer or their bank. */
  | 'INSTRUMENT_BLOCKED'
  /** The instrument was never enabled for online or recurring use. */
  | 'INSTRUMENT_NOT_ENABLED'
  /** Customer paid from an account other than the registered one. */
  | 'ACCOUNT_MISMATCH'
  /** UPI ID is invalid or cannot be resolved. */
  | 'VPA_INVALID'
  /** The bank declined citing suspected fraud. */
  | 'FRAUD_SUSPECTED'
  /** Charge exceeds the authorised mandate ceiling. */
  | 'AMOUNT_EXCEEDS_MANDATE'
  /** Charge is above the AFA exemption ceiling and needs authentication. */
  | 'AUTH_REQUIRED_AFA'
  /** Consent withdrawn by the customer. */
  | 'MANDATE_REVOKED'
  /** Consent suspended, not withdrawn. */
  | 'MANDATE_PAUSED'
  /** The bank declined and supplied no reason. Genuinely unknowable. */
  | 'AMBIGUOUS_BANK_DECLINE';

/**
 * The central idea of the project.
 *
 * NPCI permits one original debit attempt plus at most three retries per
 * mandate. Attempts are therefore a scarce, regulated resource, and for every
 * failure the only question that matters is whether spending one can possibly
 * succeed.
 */
export type Recoverability =
  /** An attempt can succeed. Timing is the whole game. */
  | 'RETRY_VIABLE'
  /** No attempt can ever succeed. The instrument or mandate must change. */
  | 'RETRY_FUTILE'
  /** Retrying is not merely wasteful, it is a consent or risk problem. */
  | 'RETRY_FORBIDDEN'
  /** Resolves without intervention. Acting burns attempts and goodwill. */
  | 'WAIT'
  /** Not determinable from available signals. A human must look. */
  | 'NEEDS_HUMAN';

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

export type ActionKind =
  | 'RETRY_NOW'
  | 'RETRY_SCHEDULED'
  | 'REQUEST_CARD_UPDATE'
  | 'REQUEST_MANDATE_REAUTH'
  | 'REQUEST_AFA'
  | 'SEND_PRE_DEBIT_NOTIFICATION'
  | 'WAIT'
  | 'STOP'
  | 'ESCALATE_TO_MERCHANT';

/** Actions that consume one of the four NPCI-permitted mandate attempts. */
export const ATTEMPT_CONSUMING_ACTIONS = [
  'RETRY_NOW',
  'RETRY_SCHEDULED',
] as const satisfies readonly ActionKind[];

/** Actions that put a message in front of the customer. */
export const CUSTOMER_CONTACTING_ACTIONS = [
  'REQUEST_CARD_UPDATE',
  'REQUEST_MANDATE_REAUTH',
  'REQUEST_AFA',
  'SEND_PRE_DEBIT_NOTIFICATION',
] as const satisfies readonly ActionKind[];

export function consumesAttempt(kind: ActionKind): boolean {
  return (ATTEMPT_CONSUMING_ACTIONS as readonly ActionKind[]).includes(kind);
}

export function contactsCustomer(kind: ActionKind): boolean {
  return (CUSTOMER_CONTACTING_ACTIONS as readonly ActionKind[]).includes(kind);
}

export interface Action {
  readonly kind: ActionKind;
  /** For scheduled retries and notifications, when this should fire. */
  readonly scheduledFor?: Millis | undefined;
  /** Why this action was chosen. Surfaced in the ledger and the UI. */
  readonly rationale: string;
}

/* ------------------------------------------------------------------ *
 * Subscription state
 * ------------------------------------------------------------------ */

export interface Attempt {
  /** Sequence within the mandate cycle. 1 is the original auto-debit. */
  readonly sequenceNo: number;
  readonly at: Millis;
  readonly outcome: 'success' | 'failure';
  readonly failure?: ObservedFailure | undefined;
}

export interface CustomerContact {
  readonly kind: ActionKind;
  readonly at: Millis;
}

export type SubscriptionState =
  /** Charge succeeded; nothing to do. */
  | 'active'
  /** A charge failed and recovery is in progress. */
  | 'pending'
  /** Attempts exhausted or the strategy stopped. Money not recovered. */
  | 'halted'
  /** Money recovered during this cycle. */
  | 'recovered'
  /** Customer is gone. Terminal, and must not be contacted. */
  | 'cancelled';

export interface BillingHistory {
  readonly cyclesBilled: number;
  readonly cyclesPaidFirstAttempt: number;
  readonly cyclesRecoveredAfterRetry: number;
  readonly cyclesFailed: number;
  /** Day of month funds have historically landed, where discernible. */
  readonly observedFundingDayOfMonth?: number | undefined;
}

/**
 * Everything a strategy is permitted to see.
 *
 * THIS INTERFACE IS THE LEAKAGE BOUNDARY and it is the most important contract
 * in the project. The simulator's hidden persona decides real outcomes and must
 * never appear on this type. If a field is not here, no strategy can read it.
 *
 * A test asserts that no file in src/strategies/ imports from src/sim/, so the
 * boundary is enforced rather than merely intended.
 */
export interface ObservableSubscription {
  readonly id: string;
  readonly customerId: string;
  readonly method: PaymentMethod;
  readonly amountPaise: Paise;
  /** Scheduled charge date for the current cycle. */
  readonly chargeDate: Millis;
  readonly state: SubscriptionState;
  readonly attempts: readonly Attempt[];
  readonly contacts: readonly CustomerContact[];
  /** When the most recent pre-debit notification was sent, if any. */
  readonly lastPreDebitNotificationAt?: Millis | undefined;
  /**
   * When the customer did the thing we asked, if they did.
   *
   * Deliberately one field rather than three. The remedy differs by cause — a
   * replacement card, a re-authorised mandate, a completed authentication — but
   * the question a strategy needs answered is the same in every case: has the
   * blocker been cleared since the last failure? A single field keeps that check
   * in one place instead of scattering it across every futile cause.
   */
  readonly remedyCompletedAt?: Millis | undefined;
  /** History prior to this cycle. Legitimate signal for diagnosis. */
  readonly history: BillingHistory;
}

/* ------------------------------------------------------------------ *
 * Decisions
 * ------------------------------------------------------------------ */

/** A diagnosis a strategy commits to before it is permitted to act. */
export interface Diagnosis {
  readonly cause: DeclineCause;
  readonly recoverability: Recoverability;
  /** 0..1. Below the configured floor, nothing autonomous is permitted. */
  readonly confidence: number;
  readonly reasoning: string;
  readonly source: 'deterministic' | 'llm' | 'oracle';
}

/** Why a proposed action was refused. Produced by the compliance layer. */
export interface GuardrailRejection {
  readonly rule: string;
  readonly citation: string;
  readonly detail: string;
}

/**
 * The compliance layer's verdict on one candidate action.
 *
 * An empty `rejections` array means permitted.
 */
export interface Ruling {
  readonly action: Action;
  readonly rejections: readonly GuardrailRejection[];
}

/**
 * One deliberation, start to finish.
 *
 * A strategy proposes candidate actions in preference order. The compliance layer
 * rules on each in turn, and the first permitted one executes. Every ruling is
 * retained, including the refusals.
 *
 * Keeping the refused candidates rather than only the executed action is
 * deliberate: "the agent wanted to charge and this cited rule stopped it" is the
 * most informative thing the ledger can show, and it is what makes the brakes
 * visible rather than merely claimed.
 */
export interface Decision {
  readonly subscriptionId: string;
  readonly at: Millis;
  /**
   * The strategy's diagnosis, or null when it does not diagnose at all.
   *
   * Null is the honest representation of the baseline. Razorpay's documented
   * retry consults a calendar, not a cause, so recording a fabricated diagnosis
   * for it would both misrepresent it and corrupt the confusion matrix.
   */
  readonly diagnosis: Diagnosis | null;
  /**
   * The cause the platform derived independently, used for enforcement.
   *
   * Deliberately separate from `diagnosis`. Guardrails must not trust the acting
   * strategy's opinion — they enforce against observable facts, which is both more
   * realistic and what lets a non-diagnosing strategy be governed at all.
   */
  readonly enforcementCause: DeclineCause | null;
  /** Rulings in the order the candidates were considered. */
  readonly rulings: readonly Ruling[];
  /** The candidate that passed, or null when every one was refused. */
  readonly executed: Action | null;
}
