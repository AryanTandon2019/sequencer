import Link from 'next/link';
import { notFound } from 'next/navigation';

import { AttemptMeter, Badge } from '../../components/Primitives';
import { Timeline } from '../../components/Timeline';
import {
  caseStatus,
  CAUSE_LABEL,
  inr,
  STRATEGY_LABEL,
} from '../../lib/format';
import { loadCase, loadCaseAcrossStrategies, loadPrimaryRunSet } from '../../lib/runs';

export const dynamic = 'force-dynamic';

export default async function CasePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ strategy?: string }>;
}) {
  const { id } = await params;
  const { strategy: requested } = await searchParams;
  const set = await loadPrimaryRunSet();
  if (set === null) notFound();

  const strategy =
    set.summaries.find((entry) => entry.strategy === requested)?.strategy ??
    set.summaries.find((entry) => entry.strategy === 'agent')?.strategy ??
    set.summaries[0]?.strategy;
  if (strategy === undefined) notFound();

  const [found, comparison] = await Promise.all([
    loadCase(strategy, id),
    loadCaseAcrossStrategies(id),
  ]);
  if (found === null) notFound();

  const { summary: item, decisions } = found;
  const selectedSummary = set.summaries.find((summary) => summary.strategy === strategy);
  const missed = item.recoverable && item.recoveredPaise === 0;
  const isOracle = strategy === 'oracle';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href={`/cases?strategy=${encodeURIComponent(strategy)}`}
          className="text-ink-faint hover:text-ink inline-flex items-center gap-2 text-xs transition-colors"
        >
          <span aria-hidden>←</span> Recovery queue
        </Link>
        <span className="text-ink-faint font-mono text-[10px]">saved ledger · {decisions.length} events</span>
      </div>

      <section className="border-line flex flex-col gap-5 border-b pb-6 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="text-brand font-mono text-[11px] font-medium">{item.id}</span>
            <Badge tone={caseStatus(item).tone}>{caseStatus(item).label}</Badge>
            {item.hadRefusal && <Badge tone="waiting">rule event</Badge>}
            {missed && <Badge tone="refused">needs review</Badge>}
          </div>
          <h1 className="display text-ink text-[38px]">{item.personaLabel}</h1>
          <p className="text-ink-soft mt-2 text-sm">
            {inr(item.amountPaise)} recurring payment · {STRATEGY_LABEL[strategy] ?? strategy}
          </p>
        </div>
        <div className="seg" aria-label="Switch policy">
          {set.summaries.map((summary) => (
            <Link
              key={summary.strategy}
              href={`/cases/${item.id}?strategy=${encodeURIComponent(summary.strategy)}`}
              data-active={summary.strategy === strategy}
              className="seg-item"
            >
              {STRATEGY_LABEL[summary.strategy] ?? summary.strategy}
            </Link>
          ))}
        </div>
      </section>

      {isOracle && (
        <div className="border-line border-l-waiting border-l-2 py-2 pl-4">
          <p className="text-ink text-xs font-medium">Oracle is an evaluator, not a deployable strategy.</p>
          <p className="text-ink-faint mt-1 text-[11px] leading-5">
            It receives the hidden true cause to show the policy&rsquo;s perfect-diagnosis ceiling.
          </p>
        </div>
      )}

      <section className="metric-grid border-line bg-surface grid grid-cols-2 overflow-hidden rounded-lg border lg:grid-cols-4">
        <Fact label="Payment amount" value={inr(item.amountPaise)} note="recurring debit at risk" />
        <div className="min-h-24 p-4">
          <p className="text-ink-faint text-[10px]">Attempt budget</p>
          <div className="mt-3"><AttemptMeter used={item.attemptsUsed} recovered={item.recoveredPaise > 0} size="lg" /></div>
          <p className="text-ink-faint mt-2 text-[10px]">{item.attemptsUsed} of 4 used</p>
        </div>
        <Fact label="Customer contacts" value={String(item.contactsSent)} note={item.contactsSent === 0 ? 'no message required' : 'action requested'} />
        <Fact label="Money recovered" value={item.recoveredPaise > 0 ? inr(item.recoveredPaise) : '—'} note={item.recoveredPaise > 0 ? 'collection completed' : 'no collection recorded'} success={item.recoveredPaise > 0} />
      </section>

      {comparison !== null && comparison.outcomes.length > 1 && (
        <section className="panel p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-ink-faint text-[10px] tracking-wide uppercase">Policy comparison</p>
              <h2 className="text-ink mt-2 text-sm font-medium">Same failure, every policy</h2>
            </div>
            <p className="text-ink-faint max-w-sm text-right text-[10px] leading-4">
              The cohort stays fixed. Oracle alone receives hidden truth.
            </p>
          </div>
          <div
            className={`border-line mt-4 grid border-t ${
              comparison.outcomes.length >= 4
                ? 'sm:grid-cols-4'
                : comparison.outcomes.length === 3
                  ? 'sm:grid-cols-3'
                  : comparison.outcomes.length === 2
                    ? 'sm:grid-cols-2'
                    : ''
            }`}
          >
            {comparison.outcomes.map((outcome, index) => (
              <div
                key={outcome.strategy}
                className={`py-4 sm:px-4 ${index > 0 ? 'border-line border-t sm:border-t-0 sm:border-l' : ''}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-ink-soft text-xs">{STRATEGY_LABEL[outcome.strategy] ?? outcome.strategy}</p>
                  {outcome.strategy === strategy && <span className="text-brand text-[9px]">Viewing</span>}
                </div>
                <p className={`tnum mt-2 font-mono text-base ${outcome.case.recoveredPaise > 0 ? 'text-permitted' : 'text-ink-faint'}`}>
                  {outcome.case.recoveredPaise > 0 ? inr(outcome.case.recoveredPaise) : 'Not recovered'}
                </p>
                <p className="text-ink-faint mt-1 text-[10px]">{outcome.case.attemptsUsed} attempts · {outcome.case.contactsSent} contacts</p>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="mb-4">
          <p className="text-ink-faint text-[10px] tracking-wide uppercase">Decision ledger</p>
          <h2 className="text-ink mt-2 text-lg font-medium">What happened, step by step</h2>
          <p className="text-ink-soft mt-1 text-xs leading-5">
            Replay the diagnosis, proposed action, rule decision, and safe fallback in order.
          </p>
        </div>
        <Timeline
          decisions={decisions}
          startedAt={selectedSummary?.startedAt ?? decisions[0]?.at ?? 0}
          strategy={strategy}
        />
      </section>

      <details className="border-line border-t py-4">
        <summary className="text-ink-faint hover:text-ink flex cursor-pointer list-none items-center justify-between text-xs">
          Evaluator-only ground truth
          <span>+</span>
        </summary>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <p className="text-ink-faint text-[9px] uppercase">Hidden cause</p>
            <p className="text-ink mt-1 text-sm">{CAUSE_LABEL[item.trueCause] ?? item.trueCause}</p>
          </div>
          <div>
            <p className="text-ink-faint text-[9px] uppercase">Recoverable in simulation</p>
            <p className="text-ink mt-1 text-sm">{item.recoverable ? 'Yes' : 'No'}</p>
          </div>
          <p className="text-ink-faint text-[10px] leading-5 sm:col-span-2">
            {isOracle
              ? 'Oracle receives these fields intentionally to establish an upper bound. Baseline and Sequencer do not.'
              : 'These fields score the experiment. They were not exposed to this strategy.'}
          </p>
        </div>
      </details>
    </div>
  );
}

function Fact({
  label,
  value,
  note,
  success = false,
}: {
  label: string;
  value: string;
  note: string;
  success?: boolean;
}) {
  return (
    <div className="min-h-24 p-4">
      <p className="text-ink-faint text-[10px]">{label}</p>
      <p className={`tnum mt-2 font-mono text-base ${success ? 'text-permitted' : 'text-ink'}`}>{value}</p>
      <p className="text-ink-faint mt-1 text-[10px]">{note}</p>
    </div>
  );
}
