import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

const routePath: string = '../../../app/api/razorpay/webhook/route.js';
const route = (await import(routePath)) as { readonly GET: () => Response };

const NAMES = [
  'VERCEL_ENV',
  'RAZORPAY_MODE',
  'RAZORPAY_WEBHOOK_SECRET',
  'TEST_MODE_DATABASE',
  'DATABASE_URL',
  'TEST_MODE_EXECUTOR',
  'CRON_SECRET',
] as const;
const ORIGINAL = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of NAMES) {
    const value = ORIGINAL[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('Razorpay webhook status route', { concurrency: false }, () => {
  it('returns the shared public-safe configuration contract without caching', async () => {
    process.env.VERCEL_ENV = 'preview';
    process.env.RAZORPAY_MODE = 'test';
    process.env.RAZORPAY_WEBHOOK_SECRET = 'must-not-leak';
    process.env.TEST_MODE_DATABASE = 'confirmed-non-production';
    process.env.DATABASE_URL = 'postgresql://example.invalid/test';
    process.env.TEST_MODE_EXECUTOR = 'mock';
    process.env.CRON_SECRET = 'also-must-not-leak';

    const response = route.GET();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.signedWebhookConfigured, true);
    assert.equal(body.mockRunnerConfigured, true);
    assert.equal(body.execution, 'durable-mock-only');
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes('must-not-leak'), false);
  });

  it('reports the signed connector disabled in production', async () => {
    process.env.VERCEL_ENV = 'production';
    process.env.RAZORPAY_MODE = 'test';
    process.env.RAZORPAY_WEBHOOK_SECRET = 'configured';
    process.env.TEST_MODE_DATABASE = 'confirmed-non-production';
    process.env.DATABASE_URL = 'postgresql://example.invalid/test';

    const body = (await route.GET().json()) as Record<string, unknown>;
    assert.equal(body.mode, 'disabled');
    assert.equal(body.nonProduction, false);
    assert.equal(body.signedWebhookConfigured, false);
    assert.equal(body.execution, 'disabled');
    assert.equal(body.idempotency, 'disabled');
  });
});
