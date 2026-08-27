import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

type RouteHandler = (request: Request) => Promise<Response>;
const routePath: string = '../../app/api/test-mode/actions/run/route.js';
const route = (await import(routePath)) as {
  readonly GET: RouteHandler;
  readonly POST: RouteHandler;
};

const ORIGINAL = {
  CRON_SECRET: process.env.CRON_SECRET,
  RAZORPAY_MODE: process.env.RAZORPAY_MODE,
  TEST_MODE_EXECUTOR: process.env.TEST_MODE_EXECUTOR,
  TEST_MODE_DATABASE: process.env.TEST_MODE_DATABASE,
  DATABASE_URL: process.env.DATABASE_URL,
  VERCEL_ENV: process.env.VERCEL_ENV,
};

function restore(name: keyof typeof ORIGINAL): void {
  const value = ORIGINAL[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore('CRON_SECRET');
  restore('RAZORPAY_MODE');
  restore('TEST_MODE_EXECUTOR');
  restore('TEST_MODE_DATABASE');
  restore('DATABASE_URL');
  restore('VERCEL_ENV');
});

describe('Test Mode action runner route protection', { concurrency: false }, () => {
  it('fails closed when the endpoint secret is absent', async () => {
    delete process.env.CRON_SECRET;
    const response = await route.GET(new Request('http://localhost/api/test-mode/actions/run'));
    assert.equal(response.status, 503);
  });

  it('rejects both GET and POST with the wrong bearer token', async () => {
    process.env.CRON_SECRET = 'expected-secret';
    const request = () =>
      new Request('http://localhost/api/test-mode/actions/run', {
        headers: { authorization: 'Bearer wrong-secret' },
      });
    assert.equal((await route.GET(request())).status, 401);
    assert.equal((await route.POST(request())).status, 401);
  });

  it('checks mock-only runtime gates before opening the database', async () => {
    process.env.CRON_SECRET = 'expected-secret';
    process.env.RAZORPAY_MODE = 'live';
    process.env.TEST_MODE_EXECUTOR = 'mock';
    delete process.env.DATABASE_URL;
    const response = await route.POST(
      new Request('http://localhost/api/test-mode/actions/run', {
        method: 'POST',
        headers: { authorization: 'Bearer expected-secret' },
      }),
    );
    assert.equal(response.status, 503);
    const body = (await response.json()) as { readonly error?: string };
    assert.equal(body.error, 'Mock Test Mode execution is disabled');
  });

  it('rejects an unconfirmed database before opening it', async () => {
    process.env.CRON_SECRET = 'expected-secret';
    process.env.RAZORPAY_MODE = 'test';
    process.env.TEST_MODE_EXECUTOR = 'mock';
    delete process.env.TEST_MODE_DATABASE;
    process.env.DATABASE_URL = 'postgresql://must-not-be-opened.invalid/test';
    const response = await route.GET(
      new Request('http://localhost/api/test-mode/actions/run', {
        headers: { authorization: 'Bearer expected-secret' },
      }),
    );
    assert.equal(response.status, 503);
    const body = (await response.json()) as { readonly error?: string };
    assert.equal(body.error, 'Non-production Test Mode database is not confirmed');
  });

  it('rejects production deployment before opening the database', async () => {
    process.env.CRON_SECRET = 'expected-secret';
    process.env.RAZORPAY_MODE = 'test';
    process.env.TEST_MODE_EXECUTOR = 'mock';
    process.env.TEST_MODE_DATABASE = 'confirmed-non-production';
    process.env.VERCEL_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://must-not-be-opened.invalid/test';
    const response = await route.POST(
      new Request('http://localhost/api/test-mode/actions/run', {
        method: 'POST',
        headers: { authorization: 'Bearer expected-secret' },
      }),
    );
    assert.equal(response.status, 503);
    const body = (await response.json()) as { readonly error?: string };
    assert.equal(body.error, 'Mock Test Mode execution is disabled');
  });

  it('requires durable storage after all safety checks pass', async () => {
    process.env.CRON_SECRET = 'expected-secret';
    process.env.RAZORPAY_MODE = 'test';
    process.env.TEST_MODE_EXECUTOR = 'mock';
    process.env.TEST_MODE_DATABASE = 'confirmed-non-production';
    delete process.env.DATABASE_URL;
    const response = await route.GET(
      new Request('http://localhost/api/test-mode/actions/run', {
        headers: { authorization: 'Bearer expected-secret' },
      }),
    );
    assert.equal(response.status, 503);
    const body = (await response.json()) as { readonly error?: string };
    assert.equal(body.error, 'Durable Test Mode queue is not configured');
  });
});
