CREATE TABLE IF NOT EXISTS razorpay_shadow_events (
  event_key char(64) PRIMARY KEY,
  provider_event_id text,
  body_sha256 char(64) NOT NULL,
  provider_event text NOT NULL,
  kind text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  normalized_event jsonb NOT NULL,
  projection jsonb,
  status text NOT NULL CHECK (
    status IN ('processing', 'ignored', 'needs_context', 'decided', 'failed')
  ),
  result jsonb,
  processing_attempts integer NOT NULL DEFAULT 1 CHECK (processing_attempts > 0),
  next_attempt_at timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error text,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (event_key ~ '^[0-9a-f]{64}$'),
  CHECK (body_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS razorpay_shadow_events_retry_idx
  ON razorpay_shadow_events (next_attempt_at)
  WHERE status = 'failed';

CREATE INDEX IF NOT EXISTS razorpay_shadow_events_lease_idx
  ON razorpay_shadow_events (lease_expires_at)
  WHERE status = 'processing';

CREATE TABLE IF NOT EXISTS test_mode_actions (
  action_key char(64) PRIMARY KEY,
  source_event_key char(64) NOT NULL UNIQUE
    REFERENCES razorpay_shadow_events(event_key) ON DELETE RESTRICT,
  mode text NOT NULL DEFAULT 'test' CHECK (mode = 'test'),
  kind text NOT NULL CHECK (
    kind IN (
      'RETRY_NOW',
      'RETRY_SCHEDULED',
      'REQUEST_CARD_UPDATE',
      'REQUEST_MANDATE_REAUTH',
      'REQUEST_AFA',
      'SEND_PRE_DEBIT_NOTIFICATION',
      'WAIT',
      'STOP',
      'ESCALATE_TO_MERCHANT'
    )
  ),
  rationale text NOT NULL CHECK (length(rationale) > 0),
  payload jsonb NOT NULL,
  scheduled_for timestamptz,
  due_at timestamptz NOT NULL,
  available_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'retry', 'running', 'succeeded', 'dead')
  ),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  lease_token uuid,
  lease_owner text,
  lease_expires_at timestamptz,
  outcome jsonb,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (action_key ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS test_mode_actions_due_idx
  ON test_mode_actions (available_at, created_at)
  WHERE status IN ('pending', 'retry');

CREATE INDEX IF NOT EXISTS test_mode_actions_lease_idx
  ON test_mode_actions (lease_expires_at)
  WHERE status = 'running';

CREATE TABLE IF NOT EXISTS test_mode_action_attempts (
  action_key char(64) NOT NULL
    REFERENCES test_mode_actions(action_key) ON DELETE RESTRICT,
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  lease_token uuid NOT NULL UNIQUE,
  worker_id text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  status text NOT NULL CHECK (
    status IN ('running', 'succeeded', 'failed', 'lease_expired')
  ),
  error text,
  outcome jsonb,
  PRIMARY KEY (action_key, attempt_no)
);
