import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertNonProductionDatabase,
  assertNonProductionTestMode,
} from './test-mode-runtime.js';

describe('Test Mode deployment boundary', () => {
  it('rejects Vercel production even when NODE_ENV is not production', () => {
    assert.throws(
      () =>
        assertNonProductionTestMode({
          NODE_ENV: 'development',
          VERCEL_ENV: 'production',
        }),
      /production/,
    );
  });

  it('allows a Vercel preview build despite its production NODE_ENV', () => {
    assert.doesNotThrow(() =>
      assertNonProductionTestMode({ NODE_ENV: 'production', VERCEL_ENV: 'preview' }),
    );
  });

  it('rejects a non-Vercel production runtime', () => {
    assert.throws(
      () => assertNonProductionTestMode({ NODE_ENV: 'production' }),
      /production/,
    );
  });

  it('requires an exact explicit non-production database confirmation', () => {
    assert.throws(() => assertNonProductionDatabase({ NODE_ENV: 'test' }), /TEST_MODE_DATABASE/);
    assert.throws(
      () =>
        assertNonProductionDatabase({
          NODE_ENV: 'test',
          TEST_MODE_DATABASE: 'true',
        }),
      /confirmed-non-production/,
    );
    assert.doesNotThrow(() =>
      assertNonProductionDatabase({
        NODE_ENV: 'test',
        TEST_MODE_DATABASE: 'confirmed-non-production',
      }),
    );
  });
});
