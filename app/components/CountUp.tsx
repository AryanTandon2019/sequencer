'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Counts a figure up on first paint.
 *
 * The one place animation earns its keep on a numbers page: the eye lands on a value that
 * moved. Deliberately short, runs once, never loops, and respects reduced-motion by
 * rendering the final value immediately.
 *
 * The number is already rendered server-side in the markup this replaces, so nothing is
 * hidden from a reader without JavaScript.
 */
export function CountUp({
  to,
  prefix = '',
  suffix = '',
  durationMs = 900,
}: {
  to: number;
  prefix?: string;
  suffix?: string;
  durationMs?: number;
}) {
  const [value, setValue] = useState(to);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || to === 0) {
      setValue(to);
      return;
    }

    setValue(0);
    const start = performance.now();

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      // Ease-out cubic: fast at first, settles gently on the final figure.
      const eased = 1 - (1 - t) ** 3;
      setValue(Math.round(to * eased));
      if (t < 1) frame.current = requestAnimationFrame(tick);
    };

    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [to, durationMs]);

  return (
    <span>
      {prefix}
      {value.toLocaleString('en-IN')}
      {suffix}
    </span>
  );
}
