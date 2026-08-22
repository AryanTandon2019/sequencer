'use client';

import { useState } from 'react';

/**
 * The four-attempt budget, shown rather than described.
 *
 * The single most important fact about this problem is that you get four tries and no more.
 * Three paragraphs failed to land it. Four boxes that fill up in front of you do, because
 * scarcity is a thing you see rather than a number you read.
 *
 * Two rows, same budget, same dead card: one burns all four and collects nothing, the other
 * spends none and asks a question instead.
 */

const CARDS = [
  { key: 'wasteful', label: 'Retry tomorrow', spent: 4, recovered: false },
  { key: 'sequencer', label: 'Read the reason', spent: 0, recovered: true },
] as const;

export function BudgetDemo() {
  const [playing, setPlaying] = useState(false);

  return (
    <div className="panel p-5 sm:p-6">
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <p className="pixel-label text-gold">Four tries. That&rsquo;s the law.</p>
          <p className="text-ink-soft mt-2 text-sm">
            Same customer, same expired card. Watch where the four go.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setPlaying(false);
            requestAnimationFrame(() => setPlaying(true));
          }}
          className="btn btn-ghost text-xs"
        >
          {playing ? 'Again' : 'Run it'} <span aria-hidden>▸</span>
        </button>
      </div>

      <div className="space-y-4">
        {CARDS.map((row) => (
          <div key={row.key}>
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <span className="text-ink text-sm font-semibold">{row.label}</span>
              <span
                className={`font-mono text-xs font-semibold ${
                  row.recovered ? 'text-permitted' : 'text-refused'
                }`}
              >
                {playing ? (row.recovered ? '₹1,499 collected' : '₹0 — all four gone') : ''}
              </span>
            </div>

            <div className="flex gap-2">
              {[0, 1, 2, 3].map((i) => {
                const spent = playing && i < row.spent;
                return (
                  <div
                    key={i}
                    className={`flex h-11 flex-1 items-center justify-center rounded-lg border-2 font-mono text-xs transition-all duration-300 ${
                      spent
                        ? 'border-refused bg-refused-wash text-refused'
                        : 'border-line bg-canvas text-ink-faint'
                    }`}
                    style={{ transitionDelay: playing ? `${i * 160}ms` : '0ms' }}
                  >
                    {spent ? '✕' : `try ${i + 1}`}
                  </div>
                );
              })}
            </div>

            <p className="text-ink-faint mt-2 text-xs">
              {row.recovered
                ? 'Spent nothing. Asked for a new card instead, then charged it once.'
                : 'Retried a card that was never going to work. Four times.'}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
