'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { caseStatus, inr, inrCompact } from '../lib/format';
import type { CaseSummary } from '../lib/runs';

type Speed = 1 | 2 | 4;

interface Totals {
  readonly recoveredPaise: number;
  readonly attempts: number;
  readonly recoveredCases: number;
}

interface CasePair {
  readonly baseline: CaseSummary;
  readonly agent: CaseSummary;
}

function totals(cases: readonly CaseSummary[]): Totals {
  return cases.reduce<Totals>(
    (sum, item) => ({
      recoveredPaise: sum.recoveredPaise + item.recoveredPaise,
      attempts: sum.attempts + item.attemptsUsed,
      recoveredCases: sum.recoveredCases + (item.recoveredPaise > 0 ? 1 : 0),
    }),
    { recoveredPaise: 0, attempts: 0, recoveredCases: 0 },
  );
}

function alignCases(
  baselineCases: readonly CaseSummary[],
  agentCases: readonly CaseSummary[],
): readonly CasePair[] | null {
  if (baselineCases.length !== agentCases.length) return null;

  const baselineById = new Map(baselineCases.map((item) => [item.id, item]));
  const agentIds = new Set(agentCases.map((item) => item.id));
  if (baselineById.size !== baselineCases.length || agentIds.size !== agentCases.length) return null;

  const pairs: CasePair[] = [];
  for (const agent of agentCases) {
    const baseline = baselineById.get(agent.id);
    if (baseline === undefined) return null;
    pairs.push({ baseline, agent });
  }
  return pairs;
}

function resultLabel(item: CaseSummary): string {
  if (item.recoveredPaise > 0) return `${inrCompact(item.recoveredPaise)} recovered`;
  return caseStatus(item).label.toLowerCase();
}

type MapState = 'waiting' | 'recovered' | 'stopped' | 'review' | 'missed';

function cellState(item: CaseSummary, active: boolean): MapState {
  if (!active) return 'waiting';
  switch (caseStatus(item).tone) {
    case 'permitted':
      return 'recovered';
    case 'waiting':
      return 'review';
    case 'brand':
      return 'stopped';
    case 'refused':
      return 'missed';
    default:
      return 'waiting';
  }
}

export function BatchReplay({
  baselineCases,
  agentCases,
}: {
  baselineCases: readonly CaseSummary[];
  agentCases: readonly CaseSummary[];
}) {
  const aligned = useMemo(
    () => alignCases(baselineCases, agentCases),
    [baselineCases, agentCases],
  );
  const total = aligned?.length ?? 0;
  const [cursor, setCursor] = useState(0);
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);

  useEffect(() => {
    if (!running || total === 0) return;
    const timer = window.setInterval(() => {
      setCursor((current) => {
        if (current >= total) {
          setRunning(false);
          return total;
        }
        return Math.min(total, current + 1);
      });
    }, 90 / speed);
    return () => window.clearInterval(timer);
  }, [running, speed, total]);

  const baseline = useMemo(
    () => totals((aligned ?? []).slice(0, cursor).map((pair) => pair.baseline)),
    [aligned, cursor],
  );
  const agent = useMemo(
    () => totals((aligned ?? []).slice(0, cursor).map((pair) => pair.agent)),
    [aligned, cursor],
  );
  const activity = (aligned ?? [])
    .slice(Math.max(0, cursor - 5), cursor)
    .map((pair) => pair.agent)
    .reverse();
  const progress = total === 0 ? 0 : (cursor / total) * 100;
  const complete = cursor === total && total > 0;

  function toggle(): void {
    if (complete) setCursor(0);
    setRunning((value) => !value || complete);
  }

  function reset(): void {
    setRunning(false);
    setCursor(0);
  }

  if (aligned === null) {
    return (
      <section id="live-run" className="panel scroll-mt-24 p-6 text-center">
        <p className="text-refused text-sm font-medium">Replay unavailable</p>
        <p className="text-ink-soft mt-2 text-xs">
          Baseline and Sequencer artifacts do not contain the same case IDs.
        </p>
      </section>
    );
  }

  const processed = aligned.slice(0, cursor);
  const recoveredCount = processed.filter((pair) => pair.agent.recoveredPaise > 0).length;
  const reviewCount = processed.filter((pair) => pair.agent.outcome === 'escalated').length;
  const stoppedCount = processed.filter(
    (pair) =>
      pair.agent.recoveredPaise === 0 &&
      (!pair.agent.recoverable || pair.agent.outcome === 'stopped'),
  ).length;

  return (
    <section id="live-run" className="panel border-t-brand overflow-hidden border-t-2 scroll-mt-20">
      <div className="border-line flex flex-wrap items-center justify-between gap-4 border-b px-5 py-4">
        <div className="flex items-center gap-2.5">
          <span className={`h-1.5 w-1.5 rounded-full ${running ? 'bg-permitted animate-live' : 'bg-ink-faint'}`} />
          <div>
            <h2 className="text-ink text-sm font-medium">Holdout batch replay</h2>
            <p className="text-ink-faint mt-0.5 text-[11px]">
              {total} matched failures · saved artifacts
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="seg" aria-label="Replay speed">
            {([1, 2, 4] as const).map((value) => (
              <button
                key={value}
                type="button"
                className="seg-item px-2 py-1 text-[10px]"
                aria-pressed={speed === value}
                onClick={() => setSpeed(value)}
              >
                {value}×
              </button>
            ))}
          </div>
          {cursor > 0 && (
            <button type="button" onClick={reset} className="btn btn-ghost" aria-label="Reset replay">
              Reset
            </button>
          )}
          <button type="button" onClick={toggle} className="btn btn-primary min-w-20">
            {running ? 'Pause' : complete ? 'Replay' : cursor > 0 ? 'Resume' : 'Run'}
          </button>
        </div>
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1.5fr)_minmax(270px,0.5fr)]">
        <div className="border-line p-5 lg:border-r">
          <div className="border-line grid grid-cols-2 border-b pb-5">
            <PolicySummary
              name="Calendar retry"
              note="Schedule only"
              current={baseline}
              processed={cursor}
            />
            <PolicySummary
              name="Sequencer"
              note="Reason-aware"
              current={agent}
              processed={cursor}
              featured
            />
          </div>

          <div className="mt-5">
            <div className="mb-3 flex items-end justify-between gap-4">
              <div>
                <p className="text-ink text-xs font-medium">Recovery map</p>
                <p className="text-ink-faint mt-1 text-[10px]">One cell per subscription</p>
              </div>
              <p className="tnum text-ink-faint font-mono text-[11px]">
                <span className="text-ink">{cursor}</span> / {total}
              </p>
            </div>

            <div
              role="list"
              aria-label={`Recovery map: ${cursor} processed, ${recoveredCount} recovered, ${reviewCount} sent to review, ${stoppedCount} stopped safely`}
              className="grid grid-cols-[repeat(20,minmax(0,1fr))] gap-1 sm:grid-cols-[repeat(25,minmax(0,1fr))]"
            >
              {aligned.map(({ agent: item }, index) => {
                const label = index < cursor ? resultLabel(item) : 'waiting';
                const state = cellState(item, index < cursor);
                return (
                  <span
                    key={item.id}
                    role="listitem"
                    data-state={state}
                    aria-label={`${item.id}: ${label}${item.hadRefusal ? '; guardrail checked' : ''}`}
                    title={`${item.id}: ${label}${item.hadRefusal ? ' · guardrail checked' : ''}`}
                    className={`recovery-cell ${index === cursor - 1 ? 'recovery-cell-current' : ''}`}
                  />
                );
              })}
            </div>

            <div className="text-ink-faint mt-4 flex flex-wrap gap-x-4 gap-y-2 text-[9px]">
              <Legend state="recovered" label="recovered" />
              <Legend state="stopped" label="stopped" />
              <Legend state="review" label="review" />
              <Legend state="missed" label="missed" />
            </div>
          </div>
        </div>

        <aside className="bg-canvas/35 flex min-h-[330px] flex-col p-5">
          <div className="flex items-center justify-between">
            <p className="text-ink-faint text-[10px] font-medium tracking-wide uppercase">Activity</p>
            <span className="text-ink-faint font-mono text-[10px]">{Math.round(progress)}%</span>
          </div>
          <div className="bg-line mt-2.5 h-px overflow-hidden">
            <div className="bg-brand h-full transition-all duration-150" style={{ width: `${progress}%` }} />
          </div>

          <div className="mt-4 flex-1">
            {activity.length === 0 ? (
              <div className="flex h-full min-h-44 flex-col justify-center">
                <p className="text-ink text-xs font-medium">Ready to process {total} failures</p>
                <p className="text-ink-faint mt-1 max-w-52 text-[11px] leading-5">
                  Start the replay to stream outcomes from the saved run.
                </p>
              </div>
            ) : (
              <div className="divide-line divide-y">
                {activity.map((item, index) => (
                  <Link
                    key={`${item.id}-${cursor}`}
                    href={`/cases/${item.id}?strategy=agent`}
                    className={`block py-3 first:pt-0 hover:opacity-80 ${index === 0 ? 'animate-rise' : ''}`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-ink font-mono text-[10px]">{item.id}</span>
                      <span className={`font-mono text-[9px] ${item.recoveredPaise > 0 ? 'text-permitted' : item.outcome === 'escalated' ? 'text-waiting' : 'text-ink-faint'}`}>
                        {resultLabel(item)}
                      </span>
                    </div>
                    <p className="text-ink-faint mt-1 truncate text-[10px]">
                      {item.personaLabel}{item.hadRefusal ? ' · rule checked' : ''}
                    </p>
                  </Link>
                ))}
              </div>
            )}
          </div>

          {complete && (
            <div className="border-line mt-4 border-t pt-4">
              <p className="text-permitted text-[11px] font-medium">Replay complete</p>
              <p className="text-ink-faint mt-1 text-[10px] leading-5">
                {inr(agent.recoveredPaise - baseline.recoveredPaise)} more recovered with{' '}
                {baseline.attempts - agent.attempts} fewer attempts.
              </p>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}

function PolicySummary({
  name,
  note,
  current,
  processed,
  featured = false,
}: {
  name: string;
  note: string;
  current: Totals;
  processed: number;
  featured?: boolean;
}) {
  return (
    <div className={`px-4 first:pl-0 last:pr-0 ${featured ? 'border-line border-l' : ''}`}>
      <div className="flex items-baseline justify-between gap-2">
        <p className={`text-xs font-semibold ${featured ? 'text-brand' : 'text-ink'}`}>{name}</p>
        <span className="text-ink-faint text-[9px]">{note}</span>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-3">
        <Metric value={inrCompact(current.recoveredPaise)} label="recovered" emphasis={featured} />
        <Metric value={String(current.attempts)} label="attempts" />
        <Metric value={String(current.recoveredCases)} label={`won / ${processed}`} />
      </div>
    </div>
  );
}

function Metric({ value, label, emphasis = false }: { value: string; label: string; emphasis?: boolean }) {
  return (
    <div>
      <p className={`tnum font-mono text-base font-medium tracking-tight ${emphasis ? 'text-permitted' : 'text-ink'}`}>{value}</p>
      <p className="text-ink-faint mt-0.5 text-[9px]">{label}</p>
    </div>
  );
}

function Legend({ state, label }: { state: Exclude<MapState, 'waiting'>; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="recovery-cell recovery-cell-legend" data-state={state} />
      {label}
    </span>
  );
}
