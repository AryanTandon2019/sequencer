import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DatabaseQuery, DatabaseRow } from './neon.js';
import { PostgresTestModeStore } from './postgres-test-mode-store.js';

const NOW = Date.UTC(2026, 7, 27, 15, 0);

function scriptedQuery(results: readonly (readonly DatabaseRow[])[]): {
  readonly query: DatabaseQuery;
  readonly calls: { readonly text: string; readonly parameters: readonly unknown[] }[];
} {
  const queue = [...results];
  const calls: { text: string; parameters: readonly unknown[] }[] = [];
  return {
    calls,
    query: async (text, parameters = []) => {
      calls.push({ text, parameters });
      const result = queue.shift();
      if (result === undefined) throw new Error('unexpected database query');
      return result;
    },
  };
}

describe('Postgres Test Mode store SQL contracts', () => {
  it('claims a new event with a parameterized lease', async () => {
    const fixture = scriptedQuery([[{ event_key: 'a'.repeat(64), lease_token: 'lease_event' }]]);
    const store = new PostgresTestModeStore(fixture.query);
    const result = await store.claimEvent({
      eventKey: 'a'.repeat(64),
      providerEventId: 'evt_1',
      bodySha256: 'b'.repeat(64),
      providerEvent: 'payment.failed',
      kind: 'payment_failure',
      occurredAt: NOW,
      normalizedEvent: { kind: 'payment_failure' },
      projection: null,
      leaseToken: 'lease_event',
      now: NOW,
      leaseDurationMs: 60_000,
    });
    assert.equal(result.kind, 'claimed');
    assert.match(fixture.calls[0]!.text, /ON CONFLICT \(event_key\)/);
    assert.equal(fixture.calls[0]!.parameters[0], 'a'.repeat(64));
  });

  it('detects an event-id collision with a different body digest', async () => {
    const fixture = scriptedQuery([
      [],
      [
        {
          status: 'decided',
          body_sha256: 'c'.repeat(64),
          lease_expires_at: null,
          next_attempt_at: null,
          action_key: null,
          action_status: null,
          action_due_at: null,
        },
      ],
    ]);
    const store = new PostgresTestModeStore(fixture.query);
    const result = await store.claimEvent({
      eventKey: 'a'.repeat(64),
      providerEventId: 'evt_1',
      bodySha256: 'b'.repeat(64),
      providerEvent: 'payment.failed',
      kind: 'payment_failure',
      occurredAt: NOW,
      normalizedEvent: {},
      projection: null,
      leaseToken: 'lease_event',
      now: NOW,
      leaseDurationMs: 60_000,
    });
    assert.equal(result.kind, 'conflict');
  });

  it('atomically finalizes an event and returns its queued action', async () => {
    const fixture = scriptedQuery([
      [
        {
          finalized: true,
          action_key: 'd'.repeat(64),
          action_status: 'pending',
          action_due_at: new Date(NOW),
        },
      ],
    ]);
    const store = new PostgresTestModeStore(fixture.query);
    const queued = await store.finalizeEvent({
      eventKey: 'a'.repeat(64),
      leaseToken: 'lease_event',
      status: 'decided',
      result: { status: 'decided' },
      queuePlan: {
        actionKey: 'd'.repeat(64),
        sourceEventKey: 'a'.repeat(64),
        action: { kind: 'STOP', rationale: 'stop safely' },
        dueAt: NOW,
        availableAt: NOW,
        payload: { selectedAction: 'STOP' },
      },
      now: NOW,
    });
    assert.equal(queued?.actionKey, 'd'.repeat(64));
    assert.match(fixture.calls[0]!.text, /WITH finalized AS/);
    assert.match(fixture.calls[0]!.text, /ON CONFLICT \(source_event_key\)/);
    assert.match(fixture.calls[0]!.text, /lease_expires_at > CURRENT_TIMESTAMP/);
  });

  it('claims due work with SKIP LOCKED and returns a lease-bound action', async () => {
    const fixture = scriptedQuery([
      [
        {
          action_key: 'd'.repeat(64),
          source_event_key: 'a'.repeat(64),
          mode: 'test',
          kind: 'RETRY_SCHEDULED',
          rationale: 'wake later',
          scheduled_for: new Date(NOW),
          due_at: new Date(NOW),
          attempt_count: 1,
          max_attempts: 5,
          lease_token: 'lease_action',
        },
      ],
    ]);
    const store = new PostgresTestModeStore(fixture.query);
    const action = await store.claimDueAction({
      workerId: 'worker_1',
      leaseToken: 'lease_action',
      now: NOW,
      leaseDurationMs: 60_000,
    });
    assert.equal(action?.action.kind, 'RETRY_SCHEDULED');
    assert.equal(action?.leaseToken, 'lease_action');
    const sql = fixture.calls[0]!.text;
    assert.equal(sql.match(/FOR UPDATE OF action SKIP LOCKED/g)?.length, 2);
    assert.match(sql, /WITH dead_candidates AS/);
    assert.match(sql, /LIMIT 10/);
    assert.match(sql, /test_mode_action_attempts/);
  });

  it('refuses to report completion when the lease predicate updates nothing', async () => {
    const fixture = scriptedQuery([[{ completed: false }]]);
    const store = new PostgresTestModeStore(fixture.query);
    const completed = await store.completeAction({
      actionKey: 'd'.repeat(64),
      leaseToken: 'stale_lease',
      outcome: { simulated: true },
      now: NOW,
    });
    assert.equal(completed, false);
    assert.match(fixture.calls[0]!.text, /lease_token = \$2::uuid/);
    assert.match(fixture.calls[0]!.text, /lease_expires_at > CURRENT_TIMESTAMP/);
  });

  it('fences event failure on both token ownership and lease expiry', async () => {
    const fixture = scriptedQuery([[]]);
    const store = new PostgresTestModeStore(fixture.query);
    const failed = await store.failEvent({
      eventKey: 'a'.repeat(64),
      leaseToken: 'stale_event_lease',
      error: 'test failure',
      retryAt: NOW + 5_000,
      now: NOW,
    });
    assert.equal(failed, false);
    assert.match(fixture.calls[0]!.text, /lease_token = \$2::uuid/);
    assert.match(fixture.calls[0]!.text, /lease_expires_at > CURRENT_TIMESTAMP/);
  });

  it('fences action failure on both token ownership and lease expiry', async () => {
    const fixture = scriptedQuery([[{ failed: false }]]);
    const store = new PostgresTestModeStore(fixture.query);
    const failed = await store.failAction({
      actionKey: 'd'.repeat(64),
      leaseToken: 'stale_action_lease',
      error: 'test failure',
      status: 'retry',
      availableAt: NOW + 5_000,
      now: NOW,
    });
    assert.equal(failed, false);
    assert.match(fixture.calls[0]!.text, /lease_token = \$2::uuid/);
    assert.match(fixture.calls[0]!.text, /lease_expires_at > CURRENT_TIMESTAMP/);
  });
});
