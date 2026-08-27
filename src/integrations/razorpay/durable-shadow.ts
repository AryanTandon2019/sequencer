import { randomUUID } from 'node:crypto';

import {
  queuePlanFromDecision,
  sanitizeExecutionError,
  type DurableTestModeStore,
  type QueuedActionSummary,
} from '../../application/test-mode-action-queue.js';
import type { Millis } from '../../domain/types.js';
import {
  processRazorpayEventWithoutIdempotency,
  type ClaimedProcessingResult,
  type ShadowProjection,
} from './shadow.js';
import type { NormalizedRazorpayEvent } from './webhook.js';

const EVENT_LEASE_MS = 60_000;
const EVENT_FAILURE_RETRY_MS = 5_000;

export type DurableRazorpayProcessingResult =
  | {
      readonly status: 'duplicate';
      readonly mode: 'shadow';
      readonly durable: true;
      readonly duplicate: true;
      readonly eventKey: string;
      readonly eventStatus: 'ignored' | 'needs_context' | 'decided';
      readonly queuedAction: QueuedActionSummary | null;
    }
  | {
      readonly status: 'in_progress';
      readonly mode: 'shadow';
      readonly durable: true;
      readonly duplicate: false;
      readonly eventKey: string;
      readonly retryAt: Millis | null;
    }
  | {
      readonly status: 'conflict';
      readonly mode: 'shadow';
      readonly durable: true;
      readonly duplicate: false;
      readonly eventKey: string;
    }
  | {
      readonly status: 'failed';
      readonly mode: 'shadow';
      readonly durable: true;
      readonly duplicate: false;
      readonly eventKey: string;
      readonly reason: string;
    }
  | (ClaimedProcessingResult & {
      readonly durable: true;
      readonly duplicate: false;
      readonly eventKey: string;
      readonly queuedAction: QueuedActionSummary | null;
    });

export async function processDurableRazorpayEvent(options: {
  readonly event: NormalizedRazorpayEvent;
  readonly projection?: ShadowProjection | undefined;
  readonly providerEventId: string | null;
  readonly providerEvent: string;
  readonly bodySha256: string;
  readonly store: DurableTestModeStore;
  readonly now?: Millis;
  readonly leaseToken?: string;
}): Promise<DurableRazorpayProcessingResult> {
  const now = options.now ?? Date.now();
  const leaseToken = options.leaseToken ?? randomUUID();
  const claim = await options.store.claimEvent({
    eventKey: options.event.eventKey,
    providerEventId: options.providerEventId,
    bodySha256: options.bodySha256,
    providerEvent: options.providerEvent,
    kind: options.event.kind,
    occurredAt: options.event.occurredAt,
    normalizedEvent: options.event,
    projection: options.projection ?? null,
    leaseToken,
    now,
    leaseDurationMs: EVENT_LEASE_MS,
  });

  if (claim.kind === 'duplicate') {
    return {
      status: 'duplicate',
      mode: 'shadow',
      durable: true,
      duplicate: true,
      eventKey: options.event.eventKey,
      eventStatus: claim.eventStatus,
      queuedAction: claim.queuedAction,
    };
  }
  if (claim.kind === 'in_progress') {
    return {
      status: 'in_progress',
      mode: 'shadow',
      durable: true,
      duplicate: false,
      eventKey: options.event.eventKey,
      retryAt: claim.retryAt,
    };
  }
  if (claim.kind === 'conflict') {
    return {
      status: 'conflict',
      mode: 'shadow',
      durable: true,
      duplicate: false,
      eventKey: options.event.eventKey,
    };
  }

  try {
    const result = await processRazorpayEventWithoutIdempotency({
      event: options.event,
      projection: options.projection,
    });
    const queuePlan =
      result.status === 'decided'
        ? queuePlanFromDecision({
            eventKey: options.event.eventKey,
            decision: result.decision,
            now,
          })
        : null;
    const queuedAction = await options.store.finalizeEvent({
      eventKey: options.event.eventKey,
      leaseToken: claim.leaseToken,
      status: result.status,
      result,
      queuePlan,
      now,
    });
    return {
      ...result,
      durable: true,
      duplicate: false,
      eventKey: options.event.eventKey,
      queuedAction,
    };
  } catch (error) {
    const reason = sanitizeExecutionError(error);
    const recorded = await options.store.failEvent({
      eventKey: options.event.eventKey,
      leaseToken: claim.leaseToken,
      error: reason,
      retryAt: now + EVENT_FAILURE_RETRY_MS,
      now,
    });
    if (!recorded) throw new Error('durable event processing failed after its lease was lost');
    return {
      status: 'failed',
      mode: 'shadow',
      durable: true,
      duplicate: false,
      eventKey: options.event.eventKey,
      reason: 'durable event processing failed; provider delivery may retry',
    };
  }
}
