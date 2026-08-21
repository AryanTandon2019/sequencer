/**
 * Tests for the simulator's hidden truth.
 *
 * Two groups matter.
 *
 * The internal-consistency group checks that a persona cannot claim to be
 * recoverable while offering no route to recovery, and vice versa. That mistake
 * would corrupt the denominator of every headline figure — the achievable ceiling
 * would be wrong, and the agent would be measured against a fiction.
 *
 * The cross-layer group is the more interesting one. It feeds each persona's
 * emitted failure into the real domain classifier and asserts the classifier
 * arrives at the cause the persona says is true. If those disagree, either the
 * persona is emitting something Razorpay would never emit, or the taxonomy is
 * wrong. Either way it is a bug, and without this test it would be invisible.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MANDATE_CAP_HEADROOM, SIMULATION_START } from '../config.js';
import { classify } from '../domain/taxonomy.js';
import type { MandateState, Paise } from '../domain/types.js';
import { PERSONAS, MIXES, personaById, weightsFor, type Persona } from './personas.js';
import { createRng, deriveRng, hashSeed } from './rng.js';

const DEFAULT_AMOUNT: Paise = 499_00;

/* ------------------------------------------------------------------ *
 * The generator
 * ------------------------------------------------------------------ */

describe('seeded randomness', () => {
  it('produces the same sequence for the same seed', () => {
    // Without this, no reported number is checkable by anyone.
    const a = createRng(42);
    const b = createRng(42);
    for (let i = 0; i < 100; i += 1) {
      assert.equal(a.next(), b.next());
    }
  });

  it('produces different sequences for different seeds', () => {
    const a = createRng(1);
    const b = createRng(2);
    let sameCount = 0;
    for (let i = 0; i < 50; i += 1) {
      if (a.next() === b.next()) sameCount += 1;
    }
    assert.equal(sameCount, 0);
  });

  it('stays within bounds', () => {
    const rng = createRng(7);
    for (let i = 0; i < 500; i += 1) {
      const n = rng.next();
      assert.ok(n >= 0 && n < 1);
      const k = rng.int(3, 9);
      assert.ok(k >= 3 && k <= 9 && Number.isInteger(k));
    }
  });

  it('handles a single-value integer range', () => {
    const rng = createRng(7);
    assert.equal(rng.int(5, 5), 5);
  });

  it('refuses an inverted integer range instead of returning nonsense', () => {
    assert.throws(() => createRng(7).int(9, 3));
  });

  it('refuses to pick from an empty array', () => {
    assert.throws(() => createRng(7).pick([]));
  });

  it('respects weights', () => {
    const rng = createRng(99);
    let heavy = 0;
    for (let i = 0; i < 2000; i += 1) {
      if (rng.weighted([{ value: 'h', weight: 9 }, { value: 'l', weight: 1 }]) === 'h') {
        heavy += 1;
      }
    }
    assert.ok(heavy > 1700 && heavy < 1950, `expected roughly 1800 of 2000, got ${heavy}`);
  });

  it('gives each named entity an independent stream', () => {
    // So that adding a persona or changing cohort size does not reshuffle the
    // outcomes of subscriptions that already existed.
    const a = deriveRng(1000, 'sub_0001');
    const b = deriveRng(1000, 'sub_0002');
    assert.notEqual(a.next(), b.next());

    const again = deriveRng(1000, 'sub_0001');
    assert.equal(createRng((1000 ^ hashSeed('sub_0001')) >>> 0).next(), again.next());
  });
});

/* ------------------------------------------------------------------ *
 * Persona hygiene
 * ------------------------------------------------------------------ */

describe('persona hygiene', () => {
  it('gives every persona a unique id', () => {
    const ids = PERSONAS.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('gives every persona a positive weight', () => {
    for (const p of PERSONAS) {
      assert.ok(p.weight > 0, `${p.id} has weight ${p.weight}`);
    }
  });

  it('sums the balanced weights to 100', () => {
    const total = PERSONAS.reduce((sum, p) => sum + p.weight, 0);
    assert.equal(total, 100);
  });

  it('documents what is really going on and what the right answer is', () => {
    // These strings end up in the README and the video. A stub here means an
    // unexplained row in the results table.
    for (const p of PERSONAS) {
      assert.ok(p.description.length > 60, `${p.id} needs a real description`);
      assert.ok(p.correctResponse.length > 30, `${p.id} needs a stated correct response`);
    }
  });

  it('looks up by id and rejects an unknown one', () => {
    assert.equal(personaById('REISSUED_CARD').id, 'REISSUED_CARD');
    // @ts-expect-error deliberately passing an id that does not exist
    assert.throws(() => personaById('NOT_A_PERSONA'));
  });
});

/* ------------------------------------------------------------------ *
 * Internal consistency of the hidden truth
 * ------------------------------------------------------------------ */

describe('hidden truth is internally consistent', () => {
  /** Materialise each persona several times, since some branch on a coin flip. */
  function samples(persona: Persona, count = 40) {
    return Array.from({ length: count }, (_, i) => {
      const rng = deriveRng(hashSeed(persona.id), `sample_${i}`);
      return persona.materialise(rng, SIMULATION_START);
    });
  }

  it('reports the persona it came from', () => {
    for (const persona of PERSONAS) {
      for (const hidden of samples(persona, 5)) {
        assert.equal(hidden.personaId, persona.id);
      }
    }
  });

  it('never claims recoverable without offering a route to recovery', () => {
    // The denominator of every headline figure depends on this being right.
    for (const persona of PERSONAS) {
      for (const hidden of samples(persona)) {
        if (!hidden.recoverable) continue;

        const hasRoute =
          hidden.retrySucceedsFrom !== undefined ||
          hidden.respondsTo.length > 0 ||
          hidden.selfResolvesAt !== undefined;

        assert.ok(hasRoute, `${persona.id} claims recoverable with no route`);
      }
    }
  });

  it('never offers a route to recovery while claiming to be unrecoverable', () => {
    for (const persona of PERSONAS) {
      for (const hidden of samples(persona)) {
        if (hidden.recoverable) continue;

        const hasRoute =
          hidden.retrySucceedsFrom !== undefined ||
          hidden.respondsTo.length > 0 ||
          hidden.selfResolvesAt !== undefined;

        assert.ok(!hasRoute, `${persona.id} claims unrecoverable but offers a route`);
      }
    }
  });

  it('gives a response delay to exactly those who respond', () => {
    for (const persona of PERSONAS) {
      for (const hidden of samples(persona)) {
        if (hidden.respondsTo.length > 0) {
          assert.ok(hidden.responseDelay > 0, `${persona.id} responds instantly, which is unreal`);
        } else {
          assert.equal(hidden.responseDelay, 0);
        }
      }
    }
  });

  it('marks contact as harmful only where consent was deliberately withdrawn', () => {
    // If this ever broadens, the restraint metric stops meaning what it claims.
    for (const persona of PERSONAS) {
      for (const hidden of samples(persona, 5)) {
        if (hidden.harmOnContact) {
          assert.equal(hidden.personaId, 'DELIBERATE_CANCELLER');
        }
      }
    }
  });

  it('emits a non-empty failure reason', () => {
    for (const persona of PERSONAS) {
      for (const hidden of samples(persona, 5)) {
        assert.ok(hidden.failureReason.length > 0);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * Cross-layer: the simulator and the domain must agree
 * ------------------------------------------------------------------ */

describe('the domain classifier reaches each persona true cause', () => {
  it('classifies every unmasked persona emission to its declared true cause', () => {
    for (const persona of PERSONAS) {
      if (persona.maskedCause) continue;

      for (let i = 0; i < 20; i += 1) {
        const rng = deriveRng(hashSeed(persona.id), `xlayer_${i}`);
        const shape = persona.shape(rng);
        const hidden = persona.materialise(rng, SIMULATION_START, shape);

        const amountPaise = shape.amountPaise ?? DEFAULT_AMOUNT;
        const mandateState: MandateState = {
          authorisation: hidden.authorisation,
          capPaise: shape.capPaise ?? amountPaise * MANDATE_CAP_HEADROOM,
          higherAfaCeiling: shape.higherAfaCeiling ?? false,
        };

        const result = classify({
          failure: {
            code: 'BAD_REQUEST_ERROR',
            reason: hidden.failureReason,
            source: 'bank',
            step: 'payment_authorization',
            description: persona.description,
            at: SIMULATION_START,
          },
          mandateState,
          amountPaise,
        });

        assert.equal(
          result.kind,
          'resolved',
          `${persona.id} emitted "${hidden.failureReason}" which the classifier could not resolve`,
        );
        assert.equal(
          result.kind === 'resolved' ? result.cause : undefined,
          hidden.trueCause,
          `${persona.id}: classifier and persona disagree on the true cause`,
        );
      }
    }
  });

  it('genuinely conceals the cause on every masked persona', () => {
    // The other half of the contract. If a mask stopped masking, the deterministic
    // classifier would silently become perfect again, the oracle would collapse into
    // a second agent run, and the benchmark would quietly stop being able to
    // distinguish good diagnosis from luck.
    for (const persona of PERSONAS) {
      if (!persona.maskedCause) continue;

      for (let i = 0; i < 20; i += 1) {
        const rng = deriveRng(hashSeed(persona.id), `masked_${i}`);
        const shape = persona.shape(rng);
        const hidden = persona.materialise(rng, SIMULATION_START, shape);

        const amountPaise = shape.amountPaise ?? DEFAULT_AMOUNT;
        const result = classify({
          failure: {
            code: 'BAD_REQUEST_ERROR',
            reason: hidden.failureReason,
            source: 'bank',
            step: 'payment_authorization',
            description: persona.description,
            at: SIMULATION_START,
          },
          mandateState: {
            authorisation: hidden.authorisation,
            capPaise: shape.capPaise ?? amountPaise * MANDATE_CAP_HEADROOM,
            higherAfaCeiling: shape.higherAfaCeiling ?? false,
          },
          amountPaise,
        });

        const deterministicCause = result.kind === 'resolved' ? result.cause : null;
        assert.notEqual(
          deterministicCause,
          hidden.trueCause,
          `${persona.id} claims to mask its cause but the classifier reads it correctly`,
        );
      }
    }
  });

  it('keeps at least two masked personas, so diagnosis error is possible at all', () => {
    const masked = PERSONAS.filter((p) => p.maskedCause);
    assert.ok(masked.length >= 2, 'a benchmark with no diagnosable error measures nothing');
  });

  it('leaves masked cases recoverable, so the loss from misdiagnosis is real', () => {
    // A masked case that was unrecoverable anyway would cost nothing to get wrong.
    for (const persona of PERSONAS) {
      if (!persona.maskedCause) continue;
      const rng = deriveRng(hashSeed(persona.id), 'recoverable');
      const hidden = persona.materialise(rng, SIMULATION_START, persona.shape(rng));
      assert.ok(hidden.recoverable, `${persona.id} masks a cause that costs nothing to miss`);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Sensitivity mixes
 * ------------------------------------------------------------------ */

describe('sensitivity mixes', () => {
  it('leaves the balanced mix as declared weights', () => {
    assert.deepEqual(MIXES.balanced, {});
    for (const entry of weightsFor('balanced')) {
      assert.equal(entry.weight, entry.value.weight);
    }
  });

  it('covers every persona in every mix', () => {
    // A mix that silently drops a persona would quietly remove a whole class of
    // case from the comparison.
    for (const mix of ['balanced', 'churn_heavy', 'funds_heavy'] as const) {
      const entries = weightsFor(mix);
      assert.equal(entries.length, PERSONAS.length);
      for (const entry of entries) {
        assert.ok(entry.weight > 0, `${entry.value.id} has no weight in ${mix}`);
      }
    }
  });

  it('actually shifts the balance between mixes', () => {
    const share = (mix: 'churn_heavy' | 'funds_heavy', id: string) => {
      const entries = weightsFor(mix);
      const total = entries.reduce((s, e) => s + e.weight, 0);
      const found = entries.find((e) => e.value.id === id);
      return (found?.weight ?? 0) / total;
    };

    assert.ok(
      share('churn_heavy', 'DELIBERATE_CANCELLER') > share('funds_heavy', 'DELIBERATE_CANCELLER'),
    );
    assert.ok(
      share('funds_heavy', 'SALARY_CYCLE_SHORTFALL') >
        share('churn_heavy', 'SALARY_CYCLE_SHORTFALL'),
    );
  });
});
