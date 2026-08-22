'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

import { AttemptMeter, Badge } from './Primitives';
import { caseStatus, inr } from '../lib/format';
import type { CaseSummary } from '../lib/runs';

type Filter = 'all' | 'recovered' | 'action' | 'guardrail' | 'missed';

const FILTERS: readonly { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'recovered', label: 'Recovered' },
  { id: 'action', label: 'Customer action' },
  { id: 'guardrail', label: 'Guardrail event' },
  { id: 'missed', label: 'Needs review' },
];

function matches(item: CaseSummary, filter: Filter): boolean {
  if (filter === 'recovered') return item.recoveredPaise > 0;
  if (filter === 'action') return item.contactsSent > 0;
  if (filter === 'guardrail') return item.hadRefusal;
  if (filter === 'missed') return item.recoverable && item.recoveredPaise === 0;
  return true;
}

export function CasesTable({
  cases,
  strategy,
}: {
  cases: readonly CaseSummary[];
  strategy: string;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');

  const counts = useMemo(
    () =>
      Object.fromEntries(
        FILTERS.map((item) => [item.id, cases.filter((entry) => matches(entry, item.id)).length]),
      ) as Record<Filter, number>,
    [cases],
  );

  const rows = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return cases.filter((item) => {
      const searchable = `${item.id} ${item.personaLabel} ${item.outcome}`.toLowerCase();
      return matches(item, filter) && (normalized === '' || searchable.includes(normalized));
    });
  }, [cases, filter, query]);

  return (
    <section className="panel overflow-hidden">
      <div className="border-line flex flex-col gap-4 border-b p-4 sm:p-5 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-ink text-sm font-medium">Recovery queue</h2>
          <p className="text-ink-faint mt-1 text-xs">Open a case to replay every decision and rule check.</p>
        </div>
        <label className="border-line bg-canvas focus-within:border-brand flex h-10 w-full items-center gap-2 rounded-lg border px-3 lg:w-72">
          <span className="text-ink-faint text-xs" aria-hidden>⌕</span>
          <span className="sr-only">Search recoveries</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search case or failure type"
            className="text-ink placeholder:text-ink-faint min-w-0 flex-1 bg-transparent text-xs outline-none"
          />
        </label>
      </div>

      <div className="border-line flex flex-wrap items-center gap-2 border-b px-4 py-3 sm:px-5">
        {FILTERS.map((item) => {
          const active = item.id === filter;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setFilter(item.id)}
              aria-pressed={active}
              className={`rounded-md border px-2.5 py-1.5 text-[11px] font-normal transition-colors ${
                active
                  ? 'border-line-strong bg-raised text-ink'
                  : 'border-line text-ink-soft hover:border-line-strong hover:text-ink'
              }`}
            >
              {item.label}
              <span className="text-ink-faint tnum ml-1.5 font-mono">{counts[item.id]}</span>
            </button>
          );
        })}
        <span className="text-ink-faint ml-auto hidden text-[11px] sm:block">{rows.length} shown</span>
      </div>

      <div className="text-ink-faint border-line hidden grid-cols-[minmax(210px,1.4fr)_minmax(140px,1fr)_120px_110px_110px] gap-4 border-b bg-canvas/55 px-5 py-2.5 text-[9px] font-medium tracking-[0.12em] uppercase lg:grid">
        <span>Subscription</span>
        <span>Status</span>
        <span>Attempt budget</span>
        <span className="text-right">Amount</span>
        <span className="text-right">Recovered</span>
      </div>

      <div className="max-h-[66vh] overflow-y-auto">
        {rows.map((item) => (
          <Link
            key={item.id}
            href={`/cases/${item.id}?strategy=${encodeURIComponent(strategy)}`}
            className="border-line row-lift group grid gap-3 border-b px-4 py-4 last:border-0 sm:px-5 lg:grid-cols-[minmax(210px,1.4fr)_minmax(140px,1fr)_120px_110px_110px] lg:items-center lg:gap-4"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-ink font-mono text-xs font-medium">{item.id}</span>
                {item.hadRefusal && <Badge tone="waiting">rule</Badge>}
                {item.personaId.startsWith('MASKED') && <Badge tone="brand">masked</Badge>}
              </div>
              <p className="text-ink-faint mt-1 truncate text-[11px]">{item.personaLabel}</p>
            </div>

            <div className="flex items-center justify-between gap-3 lg:block">
              <span className="text-ink-faint text-[10px] uppercase lg:hidden">Status</span>
              <div>
                <Badge tone={caseStatus(item).tone}>{caseStatus(item).label}</Badge>
                <p className="text-ink-faint mt-1 text-[10px]">{item.decisionCount} decision{item.decisionCount === 1 ? '' : 's'}</p>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 lg:block">
              <span className="text-ink-faint text-[10px] uppercase lg:hidden">Attempts</span>
              <div>
                <AttemptMeter used={item.attemptsUsed} recovered={item.recoveredPaise > 0} />
                <p className="text-ink-faint mt-1 font-mono text-[9px]">{item.attemptsUsed} of 4 used</p>
              </div>
            </div>

            <div className="flex items-center justify-between lg:block lg:text-right">
              <span className="text-ink-faint text-[10px] uppercase lg:hidden">Amount</span>
              <span className="tnum text-ink-soft font-mono text-xs">{inr(item.amountPaise)}</span>
            </div>

            <div className="flex items-center justify-between lg:block lg:text-right">
              <span className="text-ink-faint text-[10px] uppercase lg:hidden">Recovered</span>
              <span className={`tnum font-mono text-xs font-medium ${item.recoveredPaise > 0 ? 'text-permitted' : 'text-ink-faint'}`}>
                {item.recoveredPaise > 0 ? inr(item.recoveredPaise) : '—'}
              </span>
            </div>
          </Link>
        ))}

        {rows.length === 0 && (
          <div className="px-6 py-14 text-center">
            <p className="text-ink text-sm font-medium">No recoveries match this view</p>
            <p className="text-ink-faint mt-1 text-xs">Clear the search or choose another filter.</p>
          </div>
        )}
      </div>
    </section>
  );
}
