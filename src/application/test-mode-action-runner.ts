import { randomUUID } from 'node:crypto';

import {
  retryDelayMs,
  sanitizeExecutionError,
  type ClaimedTestModeAction,
  type DurableTestModeStore,
} from './test-mode-action-queue.js';
import { assertNonProductionTestMode } from './test-mode-runtime.js';
import type { Millis } from '../domain/types.js';

const DEFAULT_ACTION_LEASE_MS = 60_000;
const DEFAULT_MAX_ACTIONS = 10;

export type TestModeActionExecutor = (
  action: ClaimedTestModeAction,
  now: Millis,
) => Promise<unknown>;

export interface ActionRunItem {
  readonly actionKey: string;
  readonly attempt: number;
  readonly status: 'succeeded' | 'retry' | 'dead' | 'lease_lost';
}

export interface ActionRunReport {
  readonly workerId: string;
  readonly claimed: number;
  readonly succeeded: number;
  readonly retried: number;
  readonly dead: number;
  readonly leaseLost: number;
  readonly actions: readonly ActionRunItem[];
}

export function assertMockExecutorEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  assertNonProductionTestMode(environment);
  if (environment.RAZORPAY_MODE !== 'test') {
    throw new Error('Test Mode executor requires RAZORPAY_MODE=test');
  }
  if (environment.TEST_MODE_EXECUTOR !== 'mock') {
    throw new Error('Test Mode executor requires TEST_MODE_EXECUTOR=mock');
  }
}

export async function runDueTestModeActions(options: {
  readonly store: DurableTestModeStore;
  readonly execute: TestModeActionExecutor;
  readonly workerId: string;
  readonly maxActions?: number;
  readonly leaseDurationMs?: number;
  readonly clock?: () => Millis;
  readonly leaseToken?: () => string;
}): Promise<ActionRunReport> {
  const maxActions = options.maxActions ?? DEFAULT_MAX_ACTIONS;
  const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_ACTION_LEASE_MS;
  if (!Number.isInteger(maxActions) || maxActions < 1 || maxActions > 50) {
    throw new Error('maxActions must be an integer from 1 to 50');
  }
  if (!Number.isInteger(leaseDurationMs) || leaseDurationMs < 1_000) {
    throw new Error('leaseDurationMs must be at least 1000ms');
  }
  if (options.workerId.trim().length === 0) throw new Error('workerId is required');

  const clock = options.clock ?? Date.now;
  const nextLeaseToken = options.leaseToken ?? randomUUID;
  const actions: ActionRunItem[] = [];

  for (let index = 0; index < maxActions; index += 1) {
    const claimNow = clock();
    const claimed = await options.store.claimDueAction({
      workerId: options.workerId,
      leaseToken: nextLeaseToken(),
      now: claimNow,
      leaseDurationMs,
    });
    if (claimed === null) break;

    try {
      const outcome = await options.execute(claimed, clock());
      const completed = await options.store.completeAction({
        actionKey: claimed.actionKey,
        leaseToken: claimed.leaseToken,
        outcome,
        now: clock(),
      });
      actions.push({
        actionKey: claimed.actionKey,
        attempt: claimed.attemptCount,
        status: completed ? 'succeeded' : 'lease_lost',
      });
    } catch (error) {
      const now = clock();
      const dead = claimed.attemptCount >= claimed.maxAttempts;
      const persisted = await options.store.failAction({
        actionKey: claimed.actionKey,
        leaseToken: claimed.leaseToken,
        error: sanitizeExecutionError(error),
        status: dead ? 'dead' : 'retry',
        availableAt: dead ? now : now + retryDelayMs(claimed.attemptCount),
        now,
      });
      actions.push({
        actionKey: claimed.actionKey,
        attempt: claimed.attemptCount,
        status: persisted ? (dead ? 'dead' : 'retry') : 'lease_lost',
      });
    }
  }

  return {
    workerId: options.workerId,
    claimed: actions.length,
    succeeded: actions.filter((item) => item.status === 'succeeded').length,
    retried: actions.filter((item) => item.status === 'retry').length,
    dead: actions.filter((item) => item.status === 'dead').length,
    leaseLost: actions.filter((item) => item.status === 'lease_lost').length,
    actions,
  };
}
