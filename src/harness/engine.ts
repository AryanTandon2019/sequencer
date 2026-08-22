/**
 * The engine: runs one strategy over one cohort and records everything.
 *
 * Advances a clock in fixed ticks and, for each unresolved case, asks the strategy
 * what to do, has the compliance layer rule on it, executes what was permitted, and
 * writes the whole deliberation down.
 *
 * Three structural decisions worth knowing:
 *
 *   1. The engine derives the enforcement cause itself, from observable signals, and
 *      hands that to the guardrails. A strategy's own diagnosis is never used for
 *      enforcement. So a strategy cannot escape a rule by staying silent, nor buy
 *      permission by claiming confidence.
 *
 *   2. Only the engine touches the world. Strategies return candidates; the engine
 *      adjudicates and acts. There is no path by which a proposal becomes an action
 *      without passing compliance.
 *
 *   3. `RETRY_SCHEDULED` does not debit. It sets a wake time, and when that time
 *      arrives the strategy is asked again and proposes an immediate retry, which is
 *      re-checked against the rules. Conditions change while a retry waits — notice
 *      matures, a mandate gets revoked — and acting on a permission granted days
 *      earlier would be exactly the kind of stale authorisation this project exists
 *      to argue against.
 */

import { RECONSIDER_INTERVAL, SIMULATION_END, SIMULATION_START, TICK_MS } from '../config.js';
import { deliberateFailure } from '../application/deliberate-failure.js';
import {
  contactsCustomer,
  type Action,
  type Attempt,
  type CustomerContact,
  type DeclineCause,
  type Decision,
  type MandateState,
  type Millis,
  type ObservableSubscription,
  type ObservedFailure,
  type Paise,
  type SubscriptionState,
} from '../domain/types.js';
import type { Cohort, SimulatedSubscription } from '../sim/cohort.js';
import type { HiddenState, MixName, PersonaId } from '../sim/personas.js';
import {
  applyRemedyToMandate,
  authorisationAt,
  customerResponseAt,
  hasSelfResolved,
  resolveDebit,
} from '../sim/world.js';
import type { Strategy } from '../strategies/strategy.js';

/* ------------------------------------------------------------------ *
 * Results
 * ------------------------------------------------------------------ */

export type CaseOutcome =
  /** Money collected during this cycle. */
  | 'recovered'
  /** The strategy chose to stop. */
  | 'stopped'
  /** Handed to a human. */
  | 'escalated'
  /** Attempt budget spent without recovery and nothing else proposed. */
  | 'halted'
  /** Still open when the simulated window closed. */
  | 'unresolved';

export interface CaseResult {
  readonly id: string;
  readonly personaId: PersonaId;
  readonly personaLabel: string;
  readonly amountPaise: Paise;
  /** Ground truth, for the confusion matrix. Never visible to the strategy. */
  readonly trueCause: DeclineCause;
  /** Ground truth, for the achievable ceiling. */
  readonly recoverable: boolean;
  readonly outcome: CaseOutcome;
  readonly recoveredPaise: Paise;
  /** Whether the original charge failed at all. */
  readonly neededRecovery: boolean;
  readonly attemptsUsed: number;
  readonly contactsSent: number;
  /**
   * Messages that actually reached someone who had withdrawn consent.
   *
   * Expected to be zero for every strategy, because the consent guardrail refuses
   * them. That is the point of having the guardrail — and it is why the metric below
   * matters more.
   */
  readonly harmfulContacts: number;
  /**
   * Messages to a withdrawn-consent customer that the strategy proposed and the
   * guardrail had to stop.
   *
   * This is the restraint measure. Nothing bad happened either way, but a policy
   * that never proposes it is not relying on the brakes. Defence in depth is worth
   * having; needing it is worth knowing about.
   */
  readonly blockedHarmfulProposals: number;
  /** Candidate actions the guardrails refused, for any reason. */
  readonly refusedProposals: number;
  /** Debits refused because the cause was a hard decline that cannot approve. */
  readonly blockedHardDeclineRetries: number;
  readonly finalState: SubscriptionState;
  readonly decisions: readonly Decision[];
}

export interface RunResult {
  readonly strategy: string;
  readonly strategyDescription: string;
  readonly seed: number;
  readonly mix: MixName;
  readonly startedAt: Millis;
  readonly endedAt: Millis;
  readonly cases: readonly CaseResult[];
}

/* ------------------------------------------------------------------ *
 * Mutable per-case state
 * ------------------------------------------------------------------ */

interface CaseState {
  observable: ObservableSubscription;
  mandateState: MandateState;
  readonly hidden: HiddenState;
  readonly personaLabel: string;

  /** When to next consult the strategy. */
  nextWakeAt: Millis;
  /** A request sent and not yet answered. */
  awaiting: { readonly kind: Action['kind']; readonly respondsAt: Millis | null } | null;

  terminal: boolean;
  outcome: CaseOutcome;
  recoveredPaise: Paise;
  neededRecovery: boolean;
  harmfulContacts: number;
  blockedHarmfulProposals: number;
  refusedProposals: number;
  blockedHardDeclineRetries: number;
  selfResolutionApplied: boolean;
  readonly decisions: Decision[];
}

function initialState(s: SimulatedSubscription): CaseState {
  return {
    observable: s.observable,
    mandateState: s.mandateState,
    hidden: s.hidden,
    personaLabel: s.personaLabel,
    nextWakeAt: s.observable.chargeDate,
    awaiting: null,
    terminal: false,
    outcome: 'unresolved',
    recoveredPaise: 0,
    neededRecovery: false,
    harmfulContacts: 0,
    blockedHarmfulProposals: 0,
    refusedProposals: 0,
    blockedHardDeclineRetries: 0,
    selfResolutionApplied: false,
    decisions: [],
  };
}

/* ------------------------------------------------------------------ *
 * Small state transitions
 * ------------------------------------------------------------------ */

function latestFailure(sub: ObservableSubscription): ObservedFailure | null {
  for (let i = sub.attempts.length - 1; i >= 0; i -= 1) {
    const failure = sub.attempts[i]?.failure;
    if (failure !== undefined) return failure;
  }
  return null;
}

function withAttempt(sub: ObservableSubscription, attempt: Attempt): ObservableSubscription {
  return { ...sub, attempts: [...sub.attempts, attempt] };
}

function withContact(sub: ObservableSubscription, contact: CustomerContact): ObservableSubscription {
  return { ...sub, contacts: [...sub.contacts, contact] };
}

function setState(sub: ObservableSubscription, state: SubscriptionState): ObservableSubscription {
  return { ...sub, state };
}

function markRecovered(c: CaseState, at: Millis, outcome: CaseOutcome = 'recovered'): void {
  c.recoveredPaise = c.observable.amountPaise;
  c.observable = setState(c.observable, 'recovered');
  c.outcome = outcome;
  c.terminal = true;
  void at;
}

/* ------------------------------------------------------------------ *
 * Executing a permitted action
 * ------------------------------------------------------------------ */

function fireDebit(c: CaseState, at: Millis): void {
  const outcome = resolveDebit(c.hidden, c.observable, at);
  const sequenceNo = c.observable.attempts.length + 1;

  const attempt: Attempt =
    outcome.outcome === 'success'
      ? { sequenceNo, at, outcome: 'success' }
      : { sequenceNo, at, outcome: 'failure', failure: outcome.failure };

  c.observable = withAttempt(c.observable, attempt);

  if (outcome.outcome === 'success') {
    markRecovered(c, at);
    return;
  }

  c.neededRecovery = true;
  c.observable = setState(c.observable, 'pending');

  // Issue the pre-debit notice for the recovery cycle.
  //
  // This is platform infrastructure, not a policy decision. RBI requires 24 hours
  // notice before a debit; Razorpay's documented retry does not expose control over
  // notices to a retry policy, so making a strategy responsible for sending one
  // would measure the wrong thing and would imply the shipped default is
  // non-compliant. The engine issues it once, identically for every strategy, and
  // policies schedule around its maturity.
  //
  // Deliberately not recorded as a customer contact: it is a regulatory
  // notification rather than a dunning message, and counting it would swamp the
  // metric that measures how much a strategy pesters people.
  if (c.observable.lastPreDebitNotificationAt === undefined) {
    c.observable = { ...c.observable, lastPreDebitNotificationAt: at };
  }
}

function executeAction(c: CaseState, action: Action, at: Millis): void {
  switch (action.kind) {
    case 'RETRY_NOW':
      fireDebit(c, at);
      return;

    case 'RETRY_SCHEDULED':
      // Not a debit. A wake time. The strategy is asked again when it arrives and
      // the resulting immediate retry is re-checked against the rules.
      c.nextWakeAt = action.scheduledFor ?? at + RECONSIDER_INTERVAL;
      return;

    case 'SEND_PRE_DEBIT_NOTIFICATION':
      c.observable = withContact(
        { ...c.observable, lastPreDebitNotificationAt: at },
        { kind: action.kind, at },
      );
      if (c.hidden.harmOnContact) c.harmfulContacts += 1;
      return;

    case 'REQUEST_CARD_UPDATE':
    case 'REQUEST_MANDATE_REAUTH':
    case 'REQUEST_AFA': {
      c.observable = withContact(c.observable, { kind: action.kind, at });
      if (c.hidden.harmOnContact) c.harmfulContacts += 1;

      const respondsAt = customerResponseAt(c.hidden, action.kind, at);
      c.awaiting = { kind: action.kind, respondsAt };
      return;
    }

    case 'WAIT':
      return;

    case 'STOP':
      c.observable = setState(c.observable, c.hidden.harmOnContact ? 'cancelled' : 'halted');
      c.outcome = 'stopped';
      c.terminal = true;
      return;

    case 'ESCALATE_TO_MERCHANT':
      c.observable = setState(c.observable, 'halted');
      c.outcome = 'escalated';
      c.terminal = true;
      return;
  }
}

/* ------------------------------------------------------------------ *
 * World events, which happen whether or not anyone acts
 * ------------------------------------------------------------------ */

function applyWorldEvents(c: CaseState, at: Millis): void {
  // A pause that has ended. Refresh authorisation so a later diagnosis sees the
  // mandate as active again rather than perpetually paused.
  const authorisation = authorisationAt(c.hidden, at);
  if (authorisation !== c.mandateState.authorisation) {
    c.mandateState = { ...c.mandateState, authorisation };
  }

  // The customer did what was asked. Record it and let the mandate reflect it, so
  // a re-authorised ceiling or a completed authentication actually unblocks the
  // debit that was refused before.
  const awaiting = c.awaiting;
  if (awaiting !== null && awaiting.respondsAt !== null && at >= awaiting.respondsAt) {
    c.observable = { ...c.observable, remedyCompletedAt: at };
    c.mandateState = applyRemedyToMandate(
      c.mandateState,
      awaiting.kind,
      c.observable.amountPaise,
      at,
    );
    c.awaiting = null;
    // Ask the strategy promptly rather than waiting out the reconsider interval;
    // the situation has materially changed.
    c.nextWakeAt = Math.min(c.nextWakeAt, at);
  }

  // A paused mandate resuming collects the money without anyone doing anything.
  // The case that punishes acting: every attempt or message spent before this
  // moment was waste.
  if (
    !c.selfResolutionApplied &&
    !c.terminal &&
    c.neededRecovery &&
    hasSelfResolved(c.hidden, at)
  ) {
    c.selfResolutionApplied = true;
    markRecovered(c, at);
  }
}

/* ------------------------------------------------------------------ *
 * One consultation
 * ------------------------------------------------------------------ */

async function consult(c: CaseState, strategy: Strategy, at: Millis): Promise<void> {
  const failure = latestFailure(c.observable);
  // Nothing has failed yet, so there is nothing to respond to.
  if (failure === null) {
    c.nextWakeAt = at + RECONSIDER_INTERVAL;
    return;
  }

  const deliberation = await deliberateFailure(
    {
      sub: c.observable,
      mandateState: c.mandateState,
      failure,
      now: at,
    },
    strategy,
  );
  const executed = deliberation.wouldExecute;

  const decision: Decision = {
    subscriptionId: deliberation.subscriptionId,
    at: deliberation.at,
    diagnosis: deliberation.diagnosis,
    enforcementCause: deliberation.enforcementCause,
    rulings: deliberation.rulings,
    executed,
  };
  c.decisions.push(decision);

  for (const ruling of deliberation.rulings) {
    if (ruling.rejections.length === 0) continue;
    c.refusedProposals += 1;

    for (const rejection of ruling.rejections) {
      if (rejection.rule === 'REVOKED_CONSENT_NO_CONTACT' && contactsCustomer(ruling.action.kind)) {
        c.blockedHarmfulProposals += 1;
      }
      if (rejection.rule === 'CARD_NETWORK_NO_HARD_DECLINE_RETRY') {
        c.blockedHardDeclineRetries += 1;
      }
    }
  }

  // Default: come back later. An executed action may move this sooner or later.
  c.nextWakeAt = at + RECONSIDER_INTERVAL;

  if (executed === null) {
    // Every candidate refused. A legitimate outcome meaning there was nothing we
    // were permitted to do, recorded rather than treated as an error.
    return;
  }

  executeAction(c, executed, at);
}

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

export interface RunOptions {
  readonly strategy: Strategy;
  readonly cohort: Cohort;
  readonly startAt?: Millis;
  readonly endAt?: Millis;
  /** Safety valve. A strategy stuck in a loop fails loudly instead of hanging. */
  readonly maxDecisionsPerCase?: number;
}

export async function runStrategy(options: RunOptions): Promise<RunResult> {
  const { strategy, cohort } = options;
  const startAt = options.startAt ?? SIMULATION_START;
  const endAt = options.endAt ?? SIMULATION_END;
  const maxDecisions = options.maxDecisionsPerCase ?? 400;

  const states = cohort.subscriptions.map(initialState);

  for (let now = startAt; now <= endAt; now += TICK_MS) {
    for (const c of states) {
      if (c.terminal) continue;

      applyWorldEvents(c, now);
      if (c.terminal) continue;

      // The original scheduled charge. Consumes the first of the four attempts
      // NPCI permits, which is why the budget accounting starts here and not at
      // the first retry.
      if (c.observable.attempts.length === 0) {
        if (now >= c.observable.chargeDate) {
          fireDebit(c, now);
          // A failure should be considered immediately, not at the next interval.
          c.nextWakeAt = now;
        }
        continue;
      }

      if (now < c.nextWakeAt) continue;

      if (c.decisions.length >= maxDecisions) {
        throw new Error(
          `${strategy.name} made ${maxDecisions} decisions on ${c.observable.id} without ` +
            'resolving it, which means it is looping rather than deciding',
        );
      }

      await consult(c, strategy, now);
    }
  }

  return {
    strategy: strategy.name,
    strategyDescription: strategy.description,
    seed: cohort.seed,
    mix: cohort.mix,
    startedAt: startAt,
    endedAt: endAt,
    cases: states.map(toResult),
  };
}

function toResult(c: CaseState): CaseResult {
  // Budget spent, nothing recovered, and no explicit stop or escalation: the
  // subscription simply halted. Distinguished from a deliberate stop because they
  // mean different things about the policy.
  const outcome: CaseOutcome =
    c.outcome === 'unresolved' && c.observable.attempts.length >= 4 && c.recoveredPaise === 0
      ? 'halted'
      : c.outcome;

  return {
    id: c.observable.id,
    personaId: c.hidden.personaId,
    personaLabel: c.personaLabel,
    amountPaise: c.observable.amountPaise,
    trueCause: c.hidden.trueCause,
    recoverable: c.hidden.recoverable,
    outcome,
    recoveredPaise: c.recoveredPaise,
    neededRecovery: c.neededRecovery,
    attemptsUsed: c.observable.attempts.length,
    contactsSent: c.observable.contacts.length,
    harmfulContacts: c.harmfulContacts,
    blockedHarmfulProposals: c.blockedHarmfulProposals,
    refusedProposals: c.refusedProposals,
    blockedHardDeclineRetries: c.blockedHardDeclineRetries,
    finalState: c.observable.state,
    decisions: c.decisions,
  };
}
