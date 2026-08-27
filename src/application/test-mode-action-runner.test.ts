import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { executeMockTestModeAction } from './mock-action-executor.js';
import {
  assertMockExecutorEnabled,
  runDueTestModeActions,
} from './test-mode-action-runner.js';
import type {
  ActionFailureInput,
  ClaimedTestModeAction,
  DurableTestModeStore,
} from './test-mode-action-queue.js';
import type { ActionKind, Millis } from '../domain/types.js';

const NOW: Millis = Date.UTC(2026, 7, 27, 13, 0);

function claimed(
  kind: ActionKind,
  overrides: Partial<ClaimedTestModeAction> = {},
): ClaimedTestModeAction {
  return {
    actionKey: `action_${kind}`,
    sourceEventKey: 'event_test',
    action: { kind, rationale: 'test action' },
    mode: 'test',
    dueAt: NOW,
    attemptCount: 1,
    maxAttempts: 5,
    leaseToken: `lease_${kind}`,
    ...overrides,
  };
}

function runnerStore(actions: readonly ClaimedTestModeAction[], options?: {
  readonly complete?: boolean;
}): {
  readonly store: DurableTestModeStore;
  readonly completed: unknown[];
  readonly failed: ActionFailureInput[];
} {
  const queue = [...actions];
  const completed: unknown[] = [];
  const failed: ActionFailureInput[] = [];
  const unused = async (): Promise<never> => {
    throw new Error('unused store method');
  };
  const store: DurableTestModeStore = {
    claimEvent: unused,
    finalizeEvent: unused,
    failEvent: unused,
    claimDueAction: async () => queue.shift() ?? null,
    completeAction: async (input) => {
      completed.push(input);
      return options?.complete ?? true;
    },
    failAction: async (input) => {
      failed.push(input);
      return true;
    },
  };
  return { store, completed, failed };
}

describe('mock Test Mode executor', () => {
  it('covers every action without performing network I/O', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('network access is forbidden in the mock executor');
    };
    try {
      const kinds: readonly ActionKind[] = [
        'RETRY_NOW',
        'RETRY_SCHEDULED',
        'REQUEST_CARD_UPDATE',
        'REQUEST_MANDATE_REAUTH',
        'REQUEST_AFA',
        'SEND_PRE_DEBIT_NOTIFICATION',
        'WAIT',
        'STOP',
        'ESCALATE_TO_MERCHANT',
      ];
      for (const kind of kinds) {
        const outcome = await executeMockTestModeAction(claimed(kind), NOW);
        assert.equal(outcome.actionKind, kind);
        assert.equal(outcome.simulated, true);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('treats a scheduled retry as a reconsideration wake, not a debit', async () => {
    const outcome = await executeMockTestModeAction(claimed('RETRY_SCHEDULED'), NOW);
    assert.equal(outcome.outcome, 'mock_wake_for_reconsideration');
  });

  it('fails closed unless both runtime gates are explicit', () => {
    assert.throws(
      () => assertMockExecutorEnabled({ NODE_ENV: 'test', RAZORPAY_MODE: 'live' }),
      /test/,
    );
    assert.throws(
      () => assertMockExecutorEnabled({ NODE_ENV: 'test', RAZORPAY_MODE: 'test' }),
      /TEST_MODE_EXECUTOR/,
    );
    assert.doesNotThrow(() =>
      assertMockExecutorEnabled({
        NODE_ENV: 'test',
        RAZORPAY_MODE: 'test',
        TEST_MODE_EXECUTOR: 'mock',
      }),
    );
  });
});

describe('Test Mode action runner', () => {
  it('claims, executes and lease-guards successful completion', async () => {
    const fixture = runnerStore([claimed('STOP')]);
    const report = await runDueTestModeActions({
      store: fixture.store,
      execute: executeMockTestModeAction,
      workerId: 'worker_success',
      clock: () => NOW,
      leaseToken: () => 'new_lease',
    });
    assert.equal(report.claimed, 1);
    assert.equal(report.succeeded, 1);
    assert.equal(report.leaseLost, 0);
    assert.equal(fixture.completed.length, 1);
  });

  it('schedules a retry with deterministic backoff after execution failure', async () => {
    const fixture = runnerStore([claimed('RETRY_NOW')]);
    const report = await runDueTestModeActions({
      store: fixture.store,
      execute: async () => {
        throw new Error('temporary mock failure');
      },
      workerId: 'worker_retry',
      clock: () => NOW,
      leaseToken: () => 'new_lease',
    });
    assert.equal(report.retried, 1);
    assert.equal(fixture.failed[0]?.status, 'retry');
    assert.equal(fixture.failed[0]?.availableAt, NOW + 5_000);
  });

  it('dead-letters the final failed attempt', async () => {
    const fixture = runnerStore([
      claimed('RETRY_NOW', { attemptCount: 5, maxAttempts: 5 }),
    ]);
    const report = await runDueTestModeActions({
      store: fixture.store,
      execute: async () => {
        throw new Error('terminal mock failure');
      },
      workerId: 'worker_dead',
      clock: () => NOW,
      leaseToken: () => 'new_lease',
    });
    assert.equal(report.dead, 1);
    assert.equal(fixture.failed[0]?.status, 'dead');
    assert.equal(fixture.failed[0]?.availableAt, NOW);
  });

  it('reports a stale completion without claiming success', async () => {
    const fixture = runnerStore([claimed('WAIT')], { complete: false });
    const report = await runDueTestModeActions({
      store: fixture.store,
      execute: executeMockTestModeAction,
      workerId: 'worker_stale',
      clock: () => NOW,
      leaseToken: () => 'new_lease',
    });
    assert.equal(report.succeeded, 0);
    assert.equal(report.leaseLost, 1);
  });
});
