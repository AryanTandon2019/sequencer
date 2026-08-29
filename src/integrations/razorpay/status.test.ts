import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getRazorpayConnectorStatus } from './status.js';

const CONFIGURED = {
  NODE_ENV: 'production',
  VERCEL_ENV: 'preview',
  RAZORPAY_MODE: 'test',
  RAZORPAY_WEBHOOK_SECRET: 'test-signing-secret',
  TEST_MODE_DATABASE: 'confirmed-non-production',
  DATABASE_URL: 'postgresql://example.invalid/test',
  TEST_MODE_EXECUTOR: 'mock',
  CRON_SECRET: 'test-runner-secret',
} as const;

describe('public Razorpay connector status', () => {
  it('reports a fully configured Preview without requiring unused API keys', () => {
    const status = getRazorpayConnectorStatus(CONFIGURED);
    assert.equal(status.mode, 'test');
    assert.equal(status.nonProduction, true);
    assert.equal(status.signedWebhookConfigured, true);
    assert.equal(status.mockRunnerConfigured, true);
    assert.match(status.label, /configured/);
  });

  it('does not let API credentials change signed-ingestion readiness', () => {
    const withoutKeys = getRazorpayConnectorStatus(CONFIGURED);
    const withKeys = getRazorpayConnectorStatus({
      ...CONFIGURED,
      RAZORPAY_KEY_ID: 'unused-key-id',
      RAZORPAY_KEY_SECRET: 'unused-key-secret',
    });
    assert.deepEqual(withKeys, withoutKeys);
  });

  it('never reports the signed connector configured in production', () => {
    const status = getRazorpayConnectorStatus({
      ...CONFIGURED,
      VERCEL_ENV: 'production',
    });
    assert.equal(status.mode, 'disabled');
    assert.equal(status.nonProduction, false);
    assert.equal(status.signedWebhookConfigured, false);
    assert.equal(status.mockRunnerConfigured, false);
  });

  it('requires every signed-ingestion gate and rejects whitespace values', () => {
    const variants = [
      { ...CONFIGURED, RAZORPAY_WEBHOOK_SECRET: '   ' },
      { ...CONFIGURED, TEST_MODE_DATABASE: 'true' },
      { ...CONFIGURED, DATABASE_URL: '\t' },
      { ...CONFIGURED, RAZORPAY_MODE: 'live' },
    ];
    for (const environment of variants) {
      assert.equal(getRazorpayConnectorStatus(environment).signedWebhookConfigured, false);
    }
  });

  it('reports runner configuration separately from signed ingestion', () => {
    const status = getRazorpayConnectorStatus({ ...CONFIGURED, CRON_SECRET: ' ' });
    assert.equal(status.signedWebhookConfigured, true);
    assert.equal(status.mockRunnerConfigured, false);
    assert.match(status.label, /shadow only/);
  });
});
