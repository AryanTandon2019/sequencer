import { createHash } from 'node:crypto';

import type { ShadowDeliberation } from './deliberate-failure.js';
import type { Action, ActionKind, Millis } from '../domain/types.js';

const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_PROVIDER_EVENT_ID_LENGTH = 255;

export const TEST_MODE_ACTION_KINDS = [
  'RETRY_NOW',
  'RETRY_SCHEDULED',
  'REQUEST_CARD_UPDATE',
  'REQUEST_MANDATE_REAUTH',
  'REQUEST_AFA',
  'SEND_PRE_DEBIT_NOTIFICATION',
  'WAIT',
  'STOP',
  'ESCALATE_TO_MERCHANT',
] as const satisfies readonly ActionKind[];

export type DurableEventStatus =
  | 'processing'
  | 'ignored'
  | 'needs_context'
  | 'decided'
  | 'failed';

export type QueueActionStatus = 'pending' | 'retry' | 'running' | 'succeeded' | 'dead';

export interface QueuedActionSummary {
  readonly actionKey: string;
  readonly status: QueueActionStatus;
  readonly dueAt: Millis;
}

export interface DurableEventClaimInput {
  readonly eventKey: string;
  readonly providerEventId: string | null;
  readonly bodySha256: string;
  readonly providerEvent: string;
  readonly kind: string;
  readonly occurredAt: Millis;
  readonly normalizedEvent: unknown;
  readonly projection: unknown | null;
  readonly leaseToken: string;
  readonly now: Millis;
  readonly leaseDurationMs: number;
}

export type DurableEventClaimResult =
  | { readonly kind: 'claimed'; readonly leaseToken: string }
  | {
      readonly kind: 'duplicate';
      readonly eventStatus: Exclude<DurableEventStatus, 'processing' | 'failed'>;
      readonly queuedAction: QueuedActionSummary | null;
    }
  | { readonly kind: 'in_progress'; readonly retryAt: Millis | null }
  | { readonly kind: 'conflict' };

export interface QueuePlan {
  readonly actionKey: string;
  readonly sourceEventKey: string;
  readonly action: Action;
  readonly dueAt: Millis;
  readonly availableAt: Millis;
  readonly payload: unknown;
}

export interface FinalizeDurableEventInput {
  readonly eventKey: string;
  readonly leaseToken: string;
  readonly status: Exclude<DurableEventStatus, 'processing' | 'failed'>;
  readonly result: unknown;
  readonly queuePlan: QueuePlan | null;
  readonly now: Millis;
}

export interface ClaimedTestModeAction {
  readonly actionKey: string;
  readonly sourceEventKey: string;
  readonly action: Action;
  readonly mode: 'test';
  readonly dueAt: Millis;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly leaseToken: string;
}

export interface ClaimDueActionInput {
  readonly workerId: string;
  readonly leaseToken: string;
  readonly now: Millis;
  readonly leaseDurationMs: number;
}

export interface ActionCompletionInput {
  readonly actionKey: string;
  readonly leaseToken: string;
  readonly outcome: unknown;
  readonly now: Millis;
}

export interface ActionFailureInput {
  readonly actionKey: string;
  readonly leaseToken: string;
  readonly error: string;
  readonly status: 'retry' | 'dead';
  readonly availableAt: Millis;
  readonly now: Millis;
}

export interface DurableTestModeStore {
  claimEvent(input: DurableEventClaimInput): Promise<DurableEventClaimResult>;
  finalizeEvent(input: FinalizeDurableEventInput): Promise<QueuedActionSummary | null>;
  failEvent(input: {
    readonly eventKey: string;
    readonly leaseToken: string;
    readonly error: string;
    readonly retryAt: Millis;
    readonly now: Millis;
  }): Promise<boolean>;
  claimDueAction(input: ClaimDueActionInput): Promise<ClaimedTestModeAction | null>;
  completeAction(input: ActionCompletionInput): Promise<boolean>;
  failAction(input: ActionFailureInput): Promise<boolean>;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertSha256(value: string, label: string): void {
  if (!SHA256_HEX.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
}

export function deriveDurableEventKey(options: {
  readonly providerEventId: string | null;
  readonly bodySha256: string;
}): string {
  assertSha256(options.bodySha256, 'bodySha256');
  const providerEventId = options.providerEventId?.trim() ?? '';
  if (providerEventId.length > MAX_PROVIDER_EVENT_ID_LENGTH) {
    throw new Error(`provider event id exceeds ${MAX_PROVIDER_EVENT_ID_LENGTH} characters`);
  }
  const source =
    providerEventId.length > 0
      ? `razorpay\0event-id\0${providerEventId}`
      : `razorpay\0body-sha256\0${options.bodySha256}`;
  return sha256(source);
}

export function deriveActionKey(eventKey: string): string {
  assertSha256(eventKey, 'eventKey');
  return sha256(`test-action:v1\0${eventKey}`);
}

function sameAction(left: Action, right: Action): boolean {
  return (
    left.kind === right.kind &&
    left.scheduledFor === right.scheduledFor &&
    left.rationale === right.rationale
  );
}

export function queuePlanFromDecision(options: {
  readonly eventKey: string;
  readonly decision: ShadowDeliberation;
  readonly now: Millis;
}): QueuePlan | null {
  const { decision, eventKey, now } = options;
  const action = decision.wouldExecute;
  if (action === null) return null;
  if (!(TEST_MODE_ACTION_KINDS as readonly string[]).includes(action.kind)) {
    throw new Error(`unsupported Test Mode action: ${action.kind}`);
  }
  if (action.rationale.trim().length === 0) throw new Error('selected action has no rationale');
  if (
    action.scheduledFor !== undefined &&
    (!Number.isSafeInteger(action.scheduledFor) || action.scheduledFor < 0)
  ) {
    throw new Error('selected action has an invalid scheduledFor timestamp');
  }

  const selectedRuling = decision.rulings.find((ruling) => ruling.rejections.length === 0);
  if (selectedRuling === undefined || !sameAction(selectedRuling.action, action)) {
    throw new Error('selected action is not the first permitted compliance ruling');
  }

  const dueAt = action.scheduledFor ?? now;
  return {
    actionKey: deriveActionKey(eventKey),
    sourceEventKey: eventKey,
    action,
    dueAt,
    availableAt: Math.max(dueAt, now),
    payload: {
      subscriptionId: decision.subscriptionId,
      decidedAt: decision.at,
      diagnosis: decision.diagnosis,
      enforcementCause: decision.enforcementCause,
      selectedAction: action,
      rulings: decision.rulings,
    },
  };
}

export function retryDelayMs(attemptCount: number): number {
  if (!Number.isInteger(attemptCount) || attemptCount < 1) {
    throw new Error('attemptCount must be a positive integer');
  }
  return Math.min(5_000 * 2 ** (attemptCount - 1), 5 * 60 * 1000);
}

export function sanitizeExecutionError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown execution failure';
  return message.replace(/[\r\n\t]+/g, ' ').slice(0, 500);
}
