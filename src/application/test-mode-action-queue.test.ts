import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ShadowDeliberation } from './deliberate-failure.js';
import {
  deriveActionKey,
  deriveDurableEventKey,
  queuePlanFromDecision,
  retryDelayMs,
  sanitizeExecutionError,
  TEST_MODE_ACTION_KINDS,
} from './test-mode-action-queue.js';
import type { Action, Millis, Ruling } from '../domain/types.js';

const NOW: Millis = Date.UTC(2026, 7, 27, 12, 0);
const BODY_A = 'a'.repeat(64);
const BODY_B = 'b'.repeat(64);

function decision(options: {
  readonly rulings: readonly Ruling[];
  readonly selected: Action | null;
}): ShadowDeliberation {
  return {
    mode: 'shadow',
    subscriptionId: 'sub_queue_test',
    at: NOW,
    diagnosis: null,
    enforcementCause: null,
    rulings: options.rulings,
    wouldExecute: options.selected,
  };
}

describe('durable Test Mode action keys', () => {
  it('uses a stable provider event id key independent of retransmitted bytes', () => {
    const first = deriveDurableEventKey({ providerEventId: 'evt_123', bodySha256: BODY_A });
    const second = deriveDurableEventKey({ providerEventId: ' evt_123 ', bodySha256: BODY_B });
    assert.equal(first, second);
    assert.match(first, /^[0-9a-f]{64}$/);
  });

  it('falls back to the body digest when no provider id exists', () => {
    const first = deriveDurableEventKey({ providerEventId: null, bodySha256: BODY_A });
    const second = deriveDurableEventKey({ providerEventId: null, bodySha256: BODY_B });
    assert.notEqual(first, second);
  });

  it('rejects malformed digests and unbounded provider ids', () => {
    assert.throws(
      () => deriveDurableEventKey({ providerEventId: null, bodySha256: 'not-a-digest' }),
      /SHA-256/,
    );
    assert.throws(
      () => deriveDurableEventKey({ providerEventId: 'x'.repeat(256), bodySha256: BODY_A }),
      /255/,
    );
  });

  it('derives one versioned action key per event', () => {
    const eventKey = deriveDurableEventKey({ providerEventId: 'evt_123', bodySha256: BODY_A });
    assert.equal(deriveActionKey(eventKey), deriveActionKey(eventKey));
    assert.notEqual(deriveActionKey(eventKey), eventKey);
  });
});

describe('queue planning', () => {
  it('queues only the first permitted selected action', () => {
    const refused: Action = { kind: 'RETRY_NOW', rationale: 'try immediately' };
    const permitted: Action = { kind: 'ESCALATE_TO_MERCHANT', rationale: 'needs review' };
    const rulings: readonly Ruling[] = [
      {
        action: refused,
        rejections: [
          {
            rule: 'RBI_PRE_DEBIT_NOTIFICATION',
            citation: 'test citation',
            detail: 'notice missing',
          },
        ],
      },
      { action: permitted, rejections: [] },
    ];
    const eventKey = deriveDurableEventKey({ providerEventId: 'evt_queue', bodySha256: BODY_A });
    const plan = queuePlanFromDecision({
      eventKey,
      decision: decision({ rulings, selected: permitted }),
      now: NOW,
    });

    assert.ok(plan);
    assert.equal(plan.action.kind, 'ESCALATE_TO_MERCHANT');
    assert.equal(plan.dueAt, NOW);
    assert.equal(plan.availableAt, NOW);
  });

  it('preserves a future schedule as both due and availability time', () => {
    const scheduledFor = NOW + 60_000;
    const action: Action = {
      kind: 'RETRY_SCHEDULED',
      rationale: 'wake after the bank outage',
      scheduledFor,
    };
    const eventKey = deriveDurableEventKey({ providerEventId: 'evt_future', bodySha256: BODY_A });
    const plan = queuePlanFromDecision({
      eventKey,
      decision: decision({ rulings: [{ action, rejections: [] }], selected: action }),
      now: NOW,
    });
    assert.equal(plan?.dueAt, scheduledFor);
    assert.equal(plan?.availableAt, scheduledFor);
  });

  it('does not queue a null selection or a selection that bypassed rulings', () => {
    const eventKey = deriveDurableEventKey({ providerEventId: 'evt_none', bodySha256: BODY_A });
    assert.equal(
      queuePlanFromDecision({
        eventKey,
        decision: decision({ rulings: [], selected: null }),
        now: NOW,
      }),
      null,
    );
    const action: Action = { kind: 'STOP', rationale: 'stop safely' };
    assert.throws(
      () =>
        queuePlanFromDecision({
          eventKey,
          decision: decision({ rulings: [], selected: action }),
          now: NOW,
        }),
      /first permitted/,
    );
  });

  it('keeps the allowlist synchronized with every ActionKind', () => {
    assert.deepEqual(TEST_MODE_ACTION_KINDS, [
      'RETRY_NOW',
      'RETRY_SCHEDULED',
      'REQUEST_CARD_UPDATE',
      'REQUEST_MANDATE_REAUTH',
      'REQUEST_AFA',
      'SEND_PRE_DEBIT_NOTIFICATION',
      'WAIT',
      'STOP',
      'ESCALATE_TO_MERCHANT',
    ]);
  });
});

describe('queue retry hygiene', () => {
  it('uses deterministic exponential backoff capped at five minutes', () => {
    assert.equal(retryDelayMs(1), 5_000);
    assert.equal(retryDelayMs(2), 10_000);
    assert.equal(retryDelayMs(7), 300_000);
    assert.equal(retryDelayMs(20), 300_000);
  });

  it('sanitizes and bounds persisted execution errors', () => {
    const sanitized = sanitizeExecutionError(new Error(`secret\n${'x'.repeat(600)}`));
    assert.equal(sanitized.includes('\n'), false);
    assert.equal(sanitized.length, 500);
  });
});
