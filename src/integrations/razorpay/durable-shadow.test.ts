import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  ActionCompletionInput,
  ActionFailureInput,
  ClaimDueActionInput,
  ClaimedTestModeAction,
  DurableEventClaimInput,
  DurableEventClaimResult,
  DurableTestModeStore,
  FinalizeDurableEventInput,
  QueuedActionSummary,
} from '../../application/test-mode-action-queue.js';
import type { Millis } from '../../domain/types.js';
import { processDurableRazorpayEvent } from './durable-shadow.js';
import { buildDemoProjection } from './projection.js';
import type { NormalizedRazorpayEvent } from './webhook.js';

const NOW: Millis = Date.UTC(2026, 7, 27, 14, 0);
const BODY_SHA256 = 'c'.repeat(64);

function event(reason = 'card_expired'): Extract<NormalizedRazorpayEvent, { kind: 'payment_failure' }> {
  return {
    kind: 'payment_failure',
    eventKey: 'd'.repeat(64),
    occurredAt: NOW,
    paymentId: 'pay_durable',
    subscriptionId: 'sub_durable',
    customerId: 'cust_durable',
    amountPaise: 149_900,
    providerMethod: 'card',
    failure: {
      code: 'BAD_REQUEST_ERROR',
      reason,
      source: 'bank',
      step: 'payment_authorization',
      description: 'durable test failure',
      at: NOW,
    },
  };
}

class FakeStore implements DurableTestModeStore {
  claimResult: DurableEventClaimResult = { kind: 'claimed', leaseToken: 'lease_event' };
  claimed: DurableEventClaimInput | null = null;
  finalized: FinalizeDurableEventInput | null = null;
  failedEvent = false;

  async claimEvent(input: DurableEventClaimInput): Promise<DurableEventClaimResult> {
    this.claimed = input;
    return this.claimResult;
  }

  async finalizeEvent(input: FinalizeDurableEventInput): Promise<QueuedActionSummary | null> {
    this.finalized = input;
    return input.queuePlan === null
      ? null
      : { actionKey: input.queuePlan.actionKey, status: 'pending', dueAt: input.queuePlan.dueAt };
  }

  async failEvent(): Promise<boolean> {
    this.failedEvent = true;
    return true;
  }

  async claimDueAction(_input: ClaimDueActionInput): Promise<ClaimedTestModeAction | null> {
    throw new Error('unused');
  }

  async completeAction(_input: ActionCompletionInput): Promise<boolean> {
    throw new Error('unused');
  }

  async failAction(_input: ActionFailureInput): Promise<boolean> {
    throw new Error('unused');
  }
}

function run(store: FakeStore, paymentEvent = event()) {
  return processDurableRazorpayEvent({
    event: paymentEvent,
    projection: buildDemoProjection(paymentEvent),
    providerEventId: 'evt_durable',
    providerEvent: 'payment.failed',
    bodySha256: BODY_SHA256,
    store,
    now: NOW,
    leaseToken: 'lease_event',
  });
}

describe('durable Razorpay shadow orchestration', () => {
  it('finalizes the event and queues exactly the selected permitted action', async () => {
    const store = new FakeStore();
    const result = await run(store);
    assert.equal(result.status, 'decided');
    assert.equal(store.claimed?.eventKey, 'd'.repeat(64));
    assert.equal(store.finalized?.status, 'decided');
    assert.equal(store.finalized?.queuePlan?.action.kind, 'REQUEST_CARD_UPDATE');
    assert.equal(result.queuedAction?.status, 'pending');
  });

  it('replays terminal duplicate metadata without deliberating again', async () => {
    const store = new FakeStore();
    store.claimResult = {
      kind: 'duplicate',
      eventStatus: 'decided',
      queuedAction: { actionKey: 'e'.repeat(64), status: 'pending', dueAt: NOW },
    };
    const result = await run(store);
    assert.equal(result.status, 'duplicate');
    assert.equal(store.finalized, null);
    assert.equal(result.queuedAction?.actionKey, 'e'.repeat(64));
  });

  it('surfaces live leases and body conflicts without finalizing', async () => {
    const pendingStore = new FakeStore();
    pendingStore.claimResult = { kind: 'in_progress', retryAt: NOW + 1_000 };
    const pending = await run(pendingStore);
    assert.equal(pending.status, 'in_progress');
    assert.equal(pendingStore.finalized, null);

    const conflictStore = new FakeStore();
    conflictStore.claimResult = { kind: 'conflict' };
    const conflict = await run(conflictStore);
    assert.equal(conflict.status, 'conflict');
    assert.equal(conflictStore.finalized, null);
  });

  it('finalizes ignored events without creating an action', async () => {
    const store = new FakeStore();
    const unsupported: NormalizedRazorpayEvent = {
      kind: 'unsupported',
      eventKey: 'f'.repeat(64),
      occurredAt: NOW,
      providerEvent: 'payment.captured',
      reason: 'not used',
    };
    const result = await processDurableRazorpayEvent({
      event: unsupported,
      providerEventId: 'evt_ignored',
      providerEvent: 'payment.captured',
      bodySha256: BODY_SHA256,
      store,
      now: NOW,
      leaseToken: 'lease_event',
    });
    assert.equal(result.status, 'ignored');
    assert.equal(store.finalized?.queuePlan, null);
  });

  it('records a retryable failed receipt when deliberation throws', async () => {
    const store = new FakeStore();
    const paymentEvent = event();
    const projection = buildDemoProjection(paymentEvent);
    const brokenProjection = {
      ...projection,
      subBeforeFailure: {
        ...projection.subBeforeFailure,
        get attempts(): never {
          throw new Error('projection unavailable');
        },
      },
    };
    const result = await processDurableRazorpayEvent({
      event: paymentEvent,
      projection: brokenProjection,
      providerEventId: 'evt_failed',
      providerEvent: 'payment.failed',
      bodySha256: BODY_SHA256,
      store,
      now: NOW,
      leaseToken: 'lease_event',
    });
    assert.equal(result.status, 'failed');
    assert.equal(store.failedEvent, true);
    assert.equal(store.finalized, null);
  });
});
