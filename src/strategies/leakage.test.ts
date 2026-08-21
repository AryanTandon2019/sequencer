/**
 * The leakage boundary, enforced.
 *
 * Every number this project reports rests on one claim: that no strategy can see
 * the hidden truth deciding its outcomes. If a strategy could read a persona it
 * would score near-perfectly, the results would be worthless, and nothing in the
 * output would look wrong.
 *
 * That claim is too important to rest on care. This test reads the source of every
 * file under src/strategies/ and src/domain/ and fails if any of them imports from
 * src/sim/ — with exactly one sanctioned exception, the oracle, whose entire purpose
 * is to read truth in order to establish a ceiling.
 *
 * A structural test rather than a habit. Someone adding a strategy in six months
 * cannot quietly break it.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/** The only file permitted to import the simulator's hidden state. */
const SANCTIONED_TRUTH_READERS = ['oracle.ts'] as const;

/** Matches any import or re-export that reaches into the simulator. */
const SIM_IMPORT = /(?:from|import)\s+['"][^'"]*\/sim\/[^'"]*['"]/;

/** Matches an import of the personas module specifically, hidden state and all. */
const PERSONAS_IMPORT = /(?:from|import)\s+['"][^'"]*personas(?:\.js)?['"]/;

function tsFilesIn(dir: string): readonly string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .sort();
}

function sourceOf(dir: string, file: string): string {
  return readFileSync(join(dir, file), 'utf8');
}

describe('strategies cannot see the hidden truth', () => {
  const dir = 'src/strategies';

  it('finds strategy files to check', () => {
    // Without this the suite could pass vacuously by scanning an empty directory,
    // which would be worse than a failure because it would look like proof.
    const files = tsFilesIn(dir);
    assert.ok(files.length >= 4, `expected at least four files in ${dir}, found ${files.length}`);
    assert.ok(files.includes('baseline.ts'));
    assert.ok(files.includes('agent.ts'));
    assert.ok(files.includes('oracle.ts'));
  });

  it('lets no strategy but the oracle import from the simulator', () => {
    for (const file of tsFilesIn(dir)) {
      if ((SANCTIONED_TRUTH_READERS as readonly string[]).includes(file)) continue;
      if (file.endsWith('.test.ts')) continue;

      const source = sourceOf(dir, file);
      assert.ok(
        !SIM_IMPORT.test(source),
        `${file} imports from src/sim/. Only ${SANCTIONED_TRUTH_READERS.join(', ')} may do that, ` +
          'because any other strategy reading hidden state invalidates every reported number.',
      );
      assert.ok(!PERSONAS_IMPORT.test(source), `${file} imports the personas module`);
    }
  });

  it('confirms the oracle really is the exception, not a stale allowance', () => {
    // If the oracle stopped reading truth, the ceiling would silently become a
    // second agent run and the headline denominator would be wrong.
    const source = sourceOf(dir, 'oracle.ts');
    assert.ok(
      SIM_IMPORT.test(source),
      'oracle.ts no longer imports hidden state, so it cannot be establishing a ceiling',
    );
  });

  it('keeps the shared contract free of any hidden field', () => {
    // The stronger guarantee: even a careless strategy could not read truth,
    // because there is nowhere on the input for it to arrive.
    const source = sourceOf(dir, 'strategy.ts');
    assert.ok(!SIM_IMPORT.test(source), 'strategy.ts must not reference the simulator');
    assert.ok(!/hidden/i.test(source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')));
  });
});

describe('the domain layer stays pure', () => {
  const dir = 'src/domain';

  it('finds domain files to check', () => {
    const files = tsFilesIn(dir);
    assert.ok(files.length >= 6, `expected at least six files in ${dir}, found ${files.length}`);
  });

  it('never imports the simulator', () => {
    // The rules must be readable and testable without any of the machinery that
    // exercises them, and they must not be able to consult the answers.
    for (const file of tsFilesIn(dir)) {
      const source = sourceOf(dir, file);
      assert.ok(!SIM_IMPORT.test(source), `${file} imports from src/sim/`);
    }
  });

  it('never reads a clock or a random number outside tests', () => {
    // Time is always a parameter here. A hidden Date.now() or Math.random() would
    // make a run unreproducible, and an unreproducible number is not evidence.
    for (const file of tsFilesIn(dir)) {
      if (file.endsWith('.test.ts')) continue;

      const source = sourceOf(dir, file).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      assert.ok(!/Date\.now\s*\(/.test(source), `${file} calls Date.now()`);
      assert.ok(!/Math\.random\s*\(/.test(source), `${file} calls Math.random()`);
    }
  });
});

describe('nothing outside the simulator rolls its own dice', () => {
  it('keeps Math.random out of every non-test source file', () => {
    // All randomness must come from the seeded generator in src/sim/rng.ts.
    const dirs = ['src/domain', 'src/strategies', 'src/diagnosis', 'src/sim'];

    for (const dir of dirs) {
      for (const file of tsFilesIn(dir)) {
        if (file.endsWith('.test.ts')) continue;

        const source = sourceOf(dir, file).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
        assert.ok(
          !/Math\.random\s*\(/.test(source),
          `${dir}/${file} calls Math.random(); use the seeded rng so runs reproduce`,
        );
      }
    }
  });
});
