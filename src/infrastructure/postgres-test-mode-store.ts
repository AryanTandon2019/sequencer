import type {
  ActionCompletionInput,
  ActionFailureInput,
  ClaimedTestModeAction,
  ClaimDueActionInput,
  DurableEventClaimInput,
  DurableEventClaimResult,
  DurableEventStatus,
  DurableTestModeStore,
  FinalizeDurableEventInput,
  QueueActionStatus,
  QueuedActionSummary,
} from '../application/test-mode-action-queue.js';
import { TEST_MODE_ACTION_KINDS } from '../application/test-mode-action-queue.js';
import type { Action, ActionKind, Millis } from '../domain/types.js';
import { createNeonQuery, type DatabaseQuery, type DatabaseRow } from './neon.js';

const TERMINAL_EVENT_STATUSES = new Set<DurableEventStatus>([
  'ignored',
  'needs_context',
  'decided',
]);
const ACTION_STATUSES = new Set<QueueActionStatus>([
  'pending',
  'retry',
  'running',
  'succeeded',
  'dead',
]);

function iso(value: Millis, label: string): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is not a valid timestamp`);
  return new Date(value).toISOString();
}

function requiredString(row: DatabaseRow, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`database returned invalid ${key}`);
  }
  return value;
}

function nullableString(row: DatabaseRow, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error(`database returned invalid ${key}`);
  return value;
}

function requiredNumber(row: DatabaseRow, key: string): number {
  const value = row[key];
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed)) throw new Error(`database returned invalid ${key}`);
  return parsed;
}

function requiredBoolean(row: DatabaseRow, key: string): boolean {
  const value = row[key];
  if (typeof value !== 'boolean') throw new Error(`database returned invalid ${key}`);
  return value;
}

function dateMillis(value: unknown, label: string): Millis {
  const parsed = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`database returned invalid ${label}`);
  return parsed;
}

function nullableDateMillis(value: unknown, label: string): Millis | null {
  if (value === null || value === undefined) return null;
  return dateMillis(value, label);
}

function eventStatus(value: unknown): DurableEventStatus {
  if (
    value === 'processing' ||
    value === 'ignored' ||
    value === 'needs_context' ||
    value === 'decided' ||
    value === 'failed'
  ) {
    return value;
  }
  throw new Error('database returned invalid event status');
}

function actionStatus(value: unknown): QueueActionStatus {
  if (typeof value === 'string' && ACTION_STATUSES.has(value as QueueActionStatus)) {
    return value as QueueActionStatus;
  }
  throw new Error('database returned invalid action status');
}

function actionKind(value: unknown): ActionKind {
  if (
    typeof value === 'string' &&
    (TEST_MODE_ACTION_KINDS as readonly string[]).includes(value)
  ) {
    return value as ActionKind;
  }
  throw new Error('database returned invalid action kind');
}

function queuedActionFromRow(row: DatabaseRow): QueuedActionSummary | null {
  const key = nullableString(row, 'action_key');
  if (key === null) return null;
  return {
    actionKey: key,
    status: actionStatus(row.action_status),
    dueAt: dateMillis(row.action_due_at, 'action_due_at'),
  };
}

export class PostgresTestModeStore implements DurableTestModeStore {
  constructor(private readonly query: DatabaseQuery) {}

  async claimEvent(input: DurableEventClaimInput): Promise<DurableEventClaimResult> {
    const leaseExpiresAt = input.now + input.leaseDurationMs;
    const claimed = await this.query(
      `
        INSERT INTO razorpay_shadow_events (
          event_key, provider_event_id, body_sha256, provider_event, kind,
          occurred_at, received_at, normalized_event, projection, status,
          processing_attempts, lease_token, lease_expires_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6::timestamptz, $7::timestamptz, $8::jsonb, $9::jsonb, 'processing',
          1, $10::uuid, $11::timestamptz, $7::timestamptz
        )
        ON CONFLICT (event_key) DO UPDATE SET
          status = 'processing',
          processing_attempts = razorpay_shadow_events.processing_attempts + 1,
          next_attempt_at = NULL,
          lease_token = EXCLUDED.lease_token,
          lease_expires_at = EXCLUDED.lease_expires_at,
          last_error = NULL,
          updated_at = EXCLUDED.updated_at
        WHERE razorpay_shadow_events.body_sha256 = EXCLUDED.body_sha256
          AND (
            (
              razorpay_shadow_events.status = 'failed'
              AND (
                razorpay_shadow_events.next_attempt_at IS NULL
                OR razorpay_shadow_events.next_attempt_at <= EXCLUDED.updated_at
              )
            )
            OR (
              razorpay_shadow_events.status = 'processing'
              AND razorpay_shadow_events.lease_expires_at <= EXCLUDED.updated_at
            )
          )
        RETURNING event_key, lease_token
      `,
      [
        input.eventKey,
        input.providerEventId,
        input.bodySha256,
        input.providerEvent,
        input.kind,
        iso(input.occurredAt, 'occurredAt'),
        iso(input.now, 'now'),
        JSON.stringify(input.normalizedEvent),
        input.projection === null ? null : JSON.stringify(input.projection),
        input.leaseToken,
        iso(leaseExpiresAt, 'leaseExpiresAt'),
      ],
    );
    if (claimed.length > 0) {
      const leaseToken = requiredString(claimed[0]!, 'lease_token');
      if (leaseToken !== input.leaseToken) throw new Error('database returned a foreign event lease');
      return { kind: 'claimed', leaseToken };
    }

    const existingRows = await this.query(
      `
        SELECT
          e.status,
          e.body_sha256,
          e.lease_expires_at,
          e.next_attempt_at,
          a.action_key,
          a.status AS action_status,
          a.due_at AS action_due_at
        FROM razorpay_shadow_events e
        LEFT JOIN test_mode_actions a ON a.source_event_key = e.event_key
        WHERE e.event_key = $1
      `,
      [input.eventKey],
    );
    const existing = existingRows[0];
    if (existing === undefined) throw new Error('event claim disappeared before inspection');
    if (requiredString(existing, 'body_sha256') !== input.bodySha256) return { kind: 'conflict' };

    const status = eventStatus(existing.status);
    if (TERMINAL_EVENT_STATUSES.has(status)) {
      return {
        kind: 'duplicate',
        eventStatus: status as Exclude<DurableEventStatus, 'processing' | 'failed'>,
        queuedAction: queuedActionFromRow(existing),
      };
    }
    return {
      kind: 'in_progress',
      retryAt:
        nullableDateMillis(existing.next_attempt_at, 'next_attempt_at') ??
        nullableDateMillis(existing.lease_expires_at, 'lease_expires_at'),
    };
  }

  async finalizeEvent(input: FinalizeDurableEventInput): Promise<QueuedActionSummary | null> {
    const plan = input.queuePlan;
    const rows = await this.query(
      `
        WITH finalized AS (
          UPDATE razorpay_shadow_events
          SET status = $3,
              result = $4::jsonb,
              lease_token = NULL,
              lease_expires_at = NULL,
              completed_at = $5::timestamptz,
              updated_at = $5::timestamptz
          WHERE event_key = $1
            AND status = 'processing'
            AND lease_token = $2::uuid
            AND lease_expires_at > CURRENT_TIMESTAMP
          RETURNING event_key
        ), queued AS (
          INSERT INTO test_mode_actions (
            action_key, source_event_key, mode, kind, rationale, payload,
            scheduled_for, due_at, available_at, status, created_at, updated_at
          )
          SELECT
            $6, finalized.event_key, 'test', $7, $8, $9::jsonb,
            $10::timestamptz, $11::timestamptz, $12::timestamptz,
            'pending', $5::timestamptz, $5::timestamptz
          FROM finalized
          WHERE $13::boolean
          ON CONFLICT (source_event_key) DO UPDATE
            SET action_key = test_mode_actions.action_key
          RETURNING action_key, status, due_at
        )
        SELECT
          EXISTS (SELECT 1 FROM finalized) AS finalized,
          (SELECT action_key FROM queued LIMIT 1) AS action_key,
          (SELECT status FROM queued LIMIT 1) AS action_status,
          (SELECT due_at FROM queued LIMIT 1) AS action_due_at
      `,
      [
        input.eventKey,
        input.leaseToken,
        input.status,
        JSON.stringify(input.result),
        iso(input.now, 'now'),
        plan?.actionKey ?? null,
        plan?.action.kind ?? null,
        plan?.action.rationale ?? null,
        plan === null ? null : JSON.stringify(plan.payload),
        plan?.action.scheduledFor === undefined
          ? null
          : iso(plan.action.scheduledFor, 'scheduledFor'),
        plan === null ? null : iso(plan.dueAt, 'dueAt'),
        plan === null ? null : iso(plan.availableAt, 'availableAt'),
        plan !== null,
      ],
    );
    const row = rows[0];
    if (row === undefined || !requiredBoolean(row, 'finalized')) {
      throw new Error('event finalization lost its lease');
    }
    return queuedActionFromRow(row);
  }

  async failEvent(input: {
    readonly eventKey: string;
    readonly leaseToken: string;
    readonly error: string;
    readonly retryAt: Millis;
    readonly now: Millis;
  }): Promise<boolean> {
    const rows = await this.query(
      `
        UPDATE razorpay_shadow_events
        SET status = 'failed',
            next_attempt_at = $3::timestamptz,
            lease_token = NULL,
            lease_expires_at = NULL,
            last_error = $4,
            updated_at = $5::timestamptz
        WHERE event_key = $1
          AND status = 'processing'
          AND lease_token = $2::uuid
          AND lease_expires_at > CURRENT_TIMESTAMP
        RETURNING event_key
      `,
      [
        input.eventKey,
        input.leaseToken,
        iso(input.retryAt, 'retryAt'),
        input.error,
        iso(input.now, 'now'),
      ],
    );
    return rows.length === 1;
  }

  async claimDueAction(input: ClaimDueActionInput): Promise<ClaimedTestModeAction | null> {
    const leaseExpiresAt = input.now + input.leaseDurationMs;
    const rows = await this.query(
      `
        WITH dead_candidates AS (
          SELECT action.action_key
          FROM test_mode_actions action
          WHERE action.status = 'running'
            AND action.lease_expires_at <= $1::timestamptz
            AND action.attempt_count >= action.max_attempts
          ORDER BY action.lease_expires_at, action.created_at
          FOR UPDATE OF action SKIP LOCKED
          LIMIT 10
        ), dead_actions AS (
          UPDATE test_mode_actions action
          SET status = 'dead',
              last_error = 'execution lease expired after final attempt',
              lease_token = NULL,
              lease_owner = NULL,
              lease_expires_at = NULL,
              completed_at = $1::timestamptz,
              updated_at = $1::timestamptz
          FROM dead_candidates candidate
          WHERE action.action_key = candidate.action_key
          RETURNING action.action_key, action.attempt_count
        ), expired_final_attempts AS (
          UPDATE test_mode_action_attempts attempt
          SET status = 'lease_expired',
              finished_at = $1::timestamptz,
              error = 'worker lease expired'
          FROM dead_actions dead
          WHERE attempt.action_key = dead.action_key
            AND attempt.attempt_no = dead.attempt_count
            AND attempt.status = 'running'
          RETURNING attempt.action_key
        ), candidate AS (
          SELECT action.action_key
          FROM test_mode_actions action
          WHERE (
              (
                action.status IN ('pending', 'retry')
                AND action.available_at <= $1::timestamptz
              )
              OR (
                action.status = 'running'
                AND action.lease_expires_at <= $1::timestamptz
              )
            )
            AND action.attempt_count < action.max_attempts
          ORDER BY action.available_at, action.created_at
          FOR UPDATE OF action SKIP LOCKED
          LIMIT 1
        ), expired_previous_attempt AS (
          UPDATE test_mode_action_attempts attempt
          SET status = 'lease_expired',
              finished_at = $1::timestamptz,
              error = 'worker lease expired'
          FROM test_mode_actions action, candidate
          WHERE action.action_key = candidate.action_key
            AND action.status = 'running'
            AND attempt.action_key = action.action_key
            AND attempt.attempt_no = action.attempt_count
            AND attempt.status = 'running'
          RETURNING attempt.action_key
        ), claimed AS (
          UPDATE test_mode_actions action
          SET status = 'running',
              attempt_count = action.attempt_count + 1,
              lease_token = $2::uuid,
              lease_owner = $3,
              lease_expires_at = $4::timestamptz,
              updated_at = $1::timestamptz
          FROM candidate
          WHERE action.action_key = candidate.action_key
          RETURNING
            action.action_key,
            action.source_event_key,
            action.mode,
            action.kind,
            action.rationale,
            action.scheduled_for,
            action.due_at,
            action.attempt_count,
            action.max_attempts,
            action.lease_token
        ), logged AS (
          INSERT INTO test_mode_action_attempts (
            action_key, attempt_no, lease_token, worker_id, started_at, status
          )
          SELECT
            action_key, attempt_count, lease_token, $3, $1::timestamptz, 'running'
          FROM claimed
          RETURNING action_key, attempt_no
        )
        SELECT claimed.*
        FROM claimed
        JOIN logged USING (action_key)
      `,
      [
        iso(input.now, 'now'),
        input.leaseToken,
        input.workerId,
        iso(leaseExpiresAt, 'leaseExpiresAt'),
      ],
    );
    const row = rows[0];
    if (row === undefined) return null;
    if (requiredString(row, 'mode') !== 'test') throw new Error('database returned a non-test action');
    const scheduledFor = nullableDateMillis(row.scheduled_for, 'scheduled_for');
    const action: Action =
      scheduledFor === null
        ? {
            kind: actionKind(row.kind),
            rationale: requiredString(row, 'rationale'),
          }
        : {
            kind: actionKind(row.kind),
            rationale: requiredString(row, 'rationale'),
            scheduledFor,
          };
    return {
      actionKey: requiredString(row, 'action_key'),
      sourceEventKey: requiredString(row, 'source_event_key'),
      action,
      mode: 'test',
      dueAt: dateMillis(row.due_at, 'due_at'),
      attemptCount: requiredNumber(row, 'attempt_count'),
      maxAttempts: requiredNumber(row, 'max_attempts'),
      leaseToken: requiredString(row, 'lease_token'),
    };
  }

  async completeAction(input: ActionCompletionInput): Promise<boolean> {
    const rows = await this.query(
      `
        WITH completed_action AS (
          UPDATE test_mode_actions
          SET status = 'succeeded',
              outcome = $3::jsonb,
              last_error = NULL,
              lease_token = NULL,
              lease_owner = NULL,
              lease_expires_at = NULL,
              completed_at = $4::timestamptz,
              updated_at = $4::timestamptz
          WHERE action_key = $1
            AND status = 'running'
            AND lease_token = $2::uuid
            AND lease_expires_at > CURRENT_TIMESTAMP
          RETURNING action_key, attempt_count
        ), completed_attempt AS (
          UPDATE test_mode_action_attempts attempt
          SET status = 'succeeded',
              outcome = $3::jsonb,
              finished_at = $4::timestamptz
          FROM completed_action action
          WHERE attempt.action_key = action.action_key
            AND attempt.attempt_no = action.attempt_count
            AND attempt.lease_token = $2::uuid
          RETURNING attempt.action_key
        )
        SELECT EXISTS (SELECT 1 FROM completed_attempt) AS completed
      `,
      [input.actionKey, input.leaseToken, JSON.stringify(input.outcome), iso(input.now, 'now')],
    );
    return rows[0] !== undefined && requiredBoolean(rows[0], 'completed');
  }

  async failAction(input: ActionFailureInput): Promise<boolean> {
    const rows = await this.query(
      `
        WITH failed_action AS (
          UPDATE test_mode_actions
          SET status = $3,
              available_at = $4::timestamptz,
              last_error = $5,
              lease_token = NULL,
              lease_owner = NULL,
              lease_expires_at = NULL,
              completed_at = CASE WHEN $3 = 'dead' THEN $6::timestamptz ELSE NULL END,
              updated_at = $6::timestamptz
          WHERE action_key = $1
            AND status = 'running'
            AND lease_token = $2::uuid
            AND lease_expires_at > CURRENT_TIMESTAMP
          RETURNING action_key, attempt_count
        ), failed_attempt AS (
          UPDATE test_mode_action_attempts attempt
          SET status = 'failed',
              error = $5,
              finished_at = $6::timestamptz
          FROM failed_action action
          WHERE attempt.action_key = action.action_key
            AND attempt.attempt_no = action.attempt_count
            AND attempt.lease_token = $2::uuid
          RETURNING attempt.action_key
        )
        SELECT EXISTS (SELECT 1 FROM failed_attempt) AS failed
      `,
      [
        input.actionKey,
        input.leaseToken,
        input.status,
        iso(input.availableAt, 'availableAt'),
        input.error,
        iso(input.now, 'now'),
      ],
    );
    return rows[0] !== undefined && requiredBoolean(rows[0], 'failed');
  }
}

let cached:
  | { readonly connectionString: string; readonly store: PostgresTestModeStore }
  | undefined;

export function getPostgresTestModeStore(): PostgresTestModeStore {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString.trim().length === 0) {
    throw new Error('DATABASE_URL is required for durable Test Mode processing');
  }
  if (cached?.connectionString === connectionString) return cached.store;
  const store = new PostgresTestModeStore(createNeonQuery(connectionString));
  cached = { connectionString, store };
  return store;
}
