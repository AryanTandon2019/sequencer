/**
 * Seeded pseudo-random number generator.
 *
 * Every random choice in the simulator comes from here, and every one is seeded.
 * That is not a nicety — it is what makes the reported numbers checkable. A
 * reviewer running `npm run harness` must get the figures in the README, to the
 * rupee, or the figures mean nothing.
 *
 * `Math.random()` must never appear anywhere in src/.
 *
 * Algorithm is mulberry32: small, fast, and good enough for generating a cohort.
 * Nothing here is used for anything security-sensitive.
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max], inclusive both ends. */
  int(min: number, max: number): number;
  /** True with probability `p`. */
  bool(p: number): boolean;
  /** Uniform element. Throws on an empty array rather than returning undefined. */
  pick<T>(items: readonly T[]): T;
  /** Weighted choice. Weights need not sum to any particular value. */
  weighted<T>(entries: readonly { readonly value: T; readonly weight: number }[]): T;
  /** Uniform in [min, max). */
  between(min: number, max: number): number;
}

export function createRng(seed: number): Rng {
  let a = seed >>> 0;

  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng: Rng = {
    next,

    int(min, max) {
      if (max < min) throw new Error(`int: max ${max} is below min ${min}`);
      return min + Math.floor(next() * (max - min + 1));
    },

    bool(p) {
      return next() < p;
    },

    pick(items) {
      if (items.length === 0) throw new Error('pick: empty array');
      const item = items[Math.floor(next() * items.length)];
      // Unreachable given the length check, but the compiler cannot know that
      // and a silent undefined here would corrupt a cohort invisibly.
      if (item === undefined) throw new Error('pick: index out of range');
      return item;
    },

    weighted(entries) {
      if (entries.length === 0) throw new Error('weighted: empty array');

      const total = entries.reduce((sum, e) => sum + e.weight, 0);
      if (total <= 0) throw new Error('weighted: weights must sum above zero');

      let threshold = next() * total;
      for (const entry of entries) {
        threshold -= entry.weight;
        if (threshold < 0) return entry.value;
      }

      // Floating point can leave the loop one hair short of selecting anything.
      const last = entries[entries.length - 1];
      if (last === undefined) throw new Error('weighted: unreachable');
      return last.value;
    },

    between(min, max) {
      return min + next() * (max - min);
    },
  };

  return rng;
}

/**
 * Deterministic 32-bit hash of a string, for deriving a sub-seed from a name.
 *
 * Used so that each subscription gets its own independent stream keyed by its id.
 * That has a property worth having: changing the cohort size, or adding a persona,
 * does not reshuffle the outcomes of the subscriptions that were already there.
 * Without it, every result would shift whenever the generator changed, and
 * comparing two runs would be meaningless.
 *
 * FNV-1a.
 */
export function hashSeed(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** An independent generator for one named entity, derived from a root seed. */
export function deriveRng(rootSeed: number, name: string): Rng {
  return createRng((rootSeed ^ hashSeed(name)) >>> 0);
}
