'use client';

import { useState } from 'react';

import { Figure } from './Figure';
import type { RunSummary } from '../lib/runs';

/**
 * The comparison, driven by one control.
 *
 * Flipping between approaches moves one figure and one bar. The point is that the reader
 * watches the difference instead of reading about it — a control does the explaining that
 * four paragraphs were doing badly.
 *
 * Labels are plain English on purpose. "Retry tomorrow" says more to a stranger than
 * "baseline" ever will, and the technical name is available on the cases screen.
 */

interface Option {
  readonly key: string;
  readonly label: string;
  readonly caption: string;
}

const OPTIONS: readonly Option[] = [
  {
    key: 'baseline',
    label: 'Retry tomorrow',
    caption: 'What most systems do — try again the next day, whatever went wrong.',
  },
  {
    key: 'agent',
    label: 'Read the reason first',
    caption: 'Spends attempts only where they can succeed. Asks the customer for the rest.',
  },
  {
    key: 'agent+llm',
    label: '+ AI on the unclear ones',
    caption: 'Some banks decline without saying why. A model reads the history and infers.',
  },
  {
    key: 'oracle',
    label: 'If we knew everything',
    caption: 'A cheat: perfect knowledge of every cause. The best anyone could ever do.',
  },
];

const rupees = (paise: number) => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;

export function Hero({
  summaries,
  cohortLabel,
}: {
  summaries: readonly RunSummary[];
  cohortLabel: string;
}) {
  const available = OPTIONS.filter((o) => summaries.some((s) => s.strategy === o.key));
  const [selected, setSelected] = useState(
    available.some((o) => o.key === 'agent') ? 'agent' : (available[0]?.key ?? 'baseline'),
  );

  const current = summaries.find((s) => s.strategy === selected) ?? summaries[0];
  const baseline = summaries.find((s) => s.strategy === 'baseline');
  if (current === undefined) return null;

  const ceiling = current.score.recoverablePaise;
  const share = ceiling === 0 ? 0 : current.score.recoveredPaise / ceiling;
  const option = available.find((o) => o.key === selected);
  const gain =
    baseline === undefined ? 0 : current.score.recoveredPaise - baseline.score.recoveredPaise;

  const tiles = [
    {
      label: 'Attempts used',
      value: current.score.attemptsUsed,
      format: (n: number) => String(Math.round(n)),
      hint: `of ${current.score.cases * 4} allowed`,
    },
    {
      label: 'Collected per attempt',
      value: current.score.paisePerAttempt,
      format: rupees,
      hint: 'higher is better',
    },
    {
      label: 'Customers messaged',
      value: current.score.contactsSent,
      format: (n: number) => String(Math.round(n)),
      hint: 'fewer is kinder',
    },
    {
      label: 'Blocked by a rule',
      value: current.score.refusedProposals,
      format: (n: number) => String(Math.round(n)),
      hint: 'wanted to, was not allowed',
    },
  ];

  return (
    <div className="space-y-7">
      {/* The control. Plain-language options, one row. */}
      <div>
        <div className="flex flex-wrap gap-2">
          {available.map((o) => {
            const active = o.key === selected;
            return (
              <button
                key={o.key}
                type="button"
                onClick={() => setSelected(o.key)}
                aria-pressed={active}
                className={`rounded-lg border-2 px-3.5 py-2 text-sm font-semibold transition-all duration-150 ${
                  active
                    ? 'border-brand-deep bg-brand text-white shadow-[3px_3px_0_0_var(--color-brand-deep)]'
                    : 'border-line bg-card text-ink-soft hover:border-brand hover:text-ink'
                }`}
              >
                {o.label}
              </button>
            );
          })}
        </div>
        <p className="text-ink-faint mt-3 min-h-[2.5rem] max-w-lg text-xs leading-relaxed">
          {option?.caption}
        </p>
      </div>

      {/* The figure and the bar, in one panel. */}
      <div className="panel p-6 sm:p-7">
        <p className="pixel-label text-ink-faint mb-3">Collected</p>

        <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
          <Figure
            value={current.score.recoveredPaise}
            format={rupees}
            className="text-ink font-mono text-[44px] leading-none font-bold tracking-tight sm:text-[60px]"
          />
          {selected !== 'baseline' && gain !== 0 && (
            <span className="bg-permitted-wash text-permitted rounded-md px-2.5 py-1 font-mono text-sm font-semibold">
              +{rupees(gain)}
            </span>
          )}
        </div>

        <p className="text-ink-soft mt-3 text-sm">
          <Figure
            value={share * 100}
            format={(n) => `${n.toFixed(1)}%`}
            className="text-ink font-mono font-semibold"
          />{' '}
          of the {rupees(ceiling)} that was collectable
        </p>

        {/* One bar. Hard edges, and a marker where the shipped default sits. */}
        <div className="mt-6">
          <div className="border-line bg-canvas relative h-11 overflow-hidden rounded-lg border-2">
            <div
              className="from-brand to-cyan absolute inset-y-0 left-0 bg-gradient-to-r transition-all duration-700 ease-out"
              style={{ width: `${Math.max(2, Math.min(100, share * 100))}%` }}
            />
            {baseline !== undefined && selected !== 'baseline' && (
              <div
                className="bg-refused absolute inset-y-0 w-[3px] transition-all duration-700 ease-out"
                style={{
                  left: `${Math.min(100, (baseline.score.recoveredPaise / ceiling) * 100)}%`,
                }}
              />
            )}
          </div>
          <div className="text-ink-faint mt-2 flex justify-between font-mono text-[11px]">
            <span>₹0</span>
            {baseline !== undefined && selected !== 'baseline' && (
              <span className="text-refused">▲ retry-tomorrow gets this far</span>
            )}
            <span>{rupees(ceiling)}</span>
          </div>
        </div>
      </div>

      {/* Four numbers, each with a plain hint so none needs explaining. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {tiles.map((tile) => (
          <div key={tile.label} className="panel-flat p-4">
            <Figure
              value={tile.value}
              format={tile.format}
              className="text-ink block font-mono text-xl font-bold"
            />
            <p className="text-ink-soft mt-1.5 text-xs font-medium">{tile.label}</p>
            <p className="text-ink-faint mt-0.5 text-[11px]">{tile.hint}</p>
          </div>
        ))}
      </div>

      <p className="text-ink-faint text-[11px]">{cohortLabel}</p>
    </div>
  );
}
