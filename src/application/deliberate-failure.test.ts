import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deterministicDiagnoser } from '../diagnosis/deterministic.js';
import type {
  Action,
  MandateState,
  Millis,
  ObservableSubscription,
  ObservedFailure,
} from '../domain/types.js';
import { createAgentStrategy, } from '../strategies/agent.js';
import type { Strategy, StrategyInput, StrategyProposal } from '../strategies/strategy.js';
import { deliberateFailure } from './deliberate-failure.js';

const NOW: Millis = Date.UTC(2026, 7, 20, 2, 30);
const DAY: Millis = 24 * 60 * 60 * 1000;
const strategy = createAgentStrategy(deterministicDiagnoser);

function failure(reason: string): ObservedFailure {
  return {
    code: 'BAD_REQUEST_ERROR',
    reason,
    source: 'bank',
    step: 'payment_authorization',
    description: `test failure: ${reason}`,
    at: NOW,
  };
}

function subscription(currentFailure: ObservedFailure): ObservableSubscription {
  return {
    id: 'sub_shadow_001',
    customerId: 'cust_shadow_001',
    method: 'card',
    amountPaise: 49_900,
    chargeDate: NOW,
    state: 'pending',
    attempts: [{ sequenceNo: 1, at: NOW, outcome: 'failure', failure: currentFailure }],
    contacts: [],
    lastPreDebitNotificationAt: NOW - 2 * DAY,
    history: {
      cyclesBilled: 6,
      cyclesPaidFirstAttempt: 5,
      cyclesRecoveredAfterRetry: 1,
      cyclesFailed: 0,
    },
  };
}

function mandate(authorisation: MandateState['authorisation'] = 'active'): MandateState {
  return { authorisation, capPaise: 99_900, higherAfaCeiling: false };
}

describe('single-failure shadow deliberation', () => {
  it('returns wouldExecute without claiming that any action executed', async () => {
    const observed = failure('insufficient_funds');
    const result = await deliberateFailure(
      { sub: subscription(observed), mandateState: mandate(), failure: observed, now: NOW },
      strategy,
    );

    assert.equal(result.mode, 'shadow');
    assert.equal(result.enforcementCause, 'INSUFFICIENT_FUNDS');
    assert.equal(result.wouldExecute?.kind, 'RETRY_SCHEDULED');
    assert.equal('executed' in result, false);
  });

  it('lets independently observed revoked consent override the payment reason', async () => {
    const observed = failure('insufficient_funds');
    const result = await deliberateFailure(
      {
        sub: subscription(observed),
        mandateState: mandate('revoked'),
        failure: observed,
        now: NOW,
      },
      strategy,
    );

    assert.equal(result.enforcementCause, 'MANDATE_REVOKED');
    assert.equal(result.wouldExecute?.kind, 'STOP');
  });

  it('escalates an unknown failure instead of guessing', async () => {
    const observed = failure('brand_new_provider_reason');
    const result = await deliberateFailure(
      { sub: subscription(observed), mandateState: mandate(), failure: observed, now: NOW },
      strategy,
    );

    assert.equal(result.diagnosis, null);
    assert.equal(result.enforcementCause, null);
    assert.equal(result.wouldExecute?.kind, 'ESCALATE_TO_MERCHANT');
  });

  it('honours a confidence floor other than the shipped default', async () => {
    // A run-level knob the strategy cannot set for itself: the entity being judged
    // does not choose its own pass mark. The same proposal clears at 0.7 and is
    // refused at 0.85, which is what makes the floor-sensitivity analysis a
    // measurement rather than a tautology.
    const observed = failure('insufficient_funds');
    const input: StrategyInput = {
      sub: subscription(observed),
      mandateState: mandate(),
      failure: observed,
      now: NOW,
    };

    const confidentEnough: Strategy = {
      name: 'confident-enough',
      description: 'claims 0.8 on everything',
      propose: (i: StrategyInput): StrategyProposal => ({
        diagnosis: {
          cause: 'INSUFFICIENT_FUNDS',
          recoverability: 'RETRY_VIABLE',
          confidence: 0.8,
          reasoning: 'fixture diagnosis with enough reasoning to satisfy any validator',
          source: 'deterministic',
        },
        candidates: [{ kind: 'RETRY_NOW', rationale: 'fixture candidate' } as Action],
      }),
    };

    const atDefault = await deliberateFailure(input, confidentEnough);
    assert.equal(atDefault.wouldExecute?.kind, 'RETRY_NOW');

    const atStrictFloor = await deliberateFailure(input, confidentEnough, {
      confidenceFloor: 0.85,
    });
    assert.equal(atStrictFloor.wouldExecute, null);
  });
});
