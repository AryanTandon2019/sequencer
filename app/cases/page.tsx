import Link from 'next/link';

import { CasesTable } from '../components/CasesTable';
import { ConfusionMatrix } from '../components/ConfusionMatrix';
import { Empty } from '../components/Primitives';
import { inr, inrCompact, STRATEGY_LABEL, STRATEGY_NOTE } from '../lib/format';
import { loadPrimaryRunSet } from '../lib/runs';

export const dynamic = 'force-dynamic';

export default async function CasesPage({
  searchParams,
}: {
  searchParams: Promise<{ strategy?: string }>;
}) {
  const params = await searchParams;
  const set = await loadPrimaryRunSet();

  if (set === null || set.summaries.length === 0) {
    return (
      <Empty
        title="No recovery batch found"
        hint={<>Run <code className="text-ink font-mono">npm run harness</code> to create one.</>}
      />
    );
  }

  const summary =
    set.summaries.find((item) => item.strategy === params.strategy) ??
    set.summaries.find((item) => item.strategy === 'agent') ??
    set.summaries[0];

  if (summary === undefined) return null;

  const needsReview = summary.cases.filter(
    (item) => item.recoverable && item.recoveredPaise === 0,
  ).length;
  const guarded = summary.cases.filter((item) => item.hadRefusal).length;

  return (
    <div className="space-y-6">
      <section className="border-line flex flex-col gap-4 border-b pb-6 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-brand text-[10px] font-semibold tracking-[0.08em] uppercase">Recovery operations</p>
          <h1 className="display text-ink mt-3 text-[36px]">Failed-payment queue</h1>
          <p className="text-ink-soft mt-2 max-w-2xl text-sm leading-6">
            {summary.score.cases} subscriptions from the validated simulation {set.cohort} batch. Filter the
            queue and open any recovery to inspect its decision trail.
          </p>
        </div>
        <Link href="/#live-run" className="btn btn-ghost self-start lg:self-auto">
          Back to replay
        </Link>
      </section>

      <section className="metric-grid border-line bg-surface grid grid-cols-2 overflow-hidden rounded-lg border lg:grid-cols-4" aria-label="Queue summary">
        <QueueMetric label="Recovered" value={inrCompact(summary.score.recoveredPaise)} note={`${summary.score.recoveredCases} subscriptions`} success />
        <QueueMetric label="Attempts used" value={String(summary.score.attemptsUsed)} note={`${summary.score.attemptsWasted} spent on unwinnable cases`} />
        <QueueMetric label="Needs review" value={String(needsReview)} note="collectable, not recovered" />
        <QueueMetric label="Rule events" value={String(guarded)} note={`${summary.score.refusedProposals} actions refused`} />
      </section>

      <section className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="seg" aria-label="Recovery policy">
          {set.summaries.map((item) => (
            <Link
              key={item.strategy}
              href={`/cases?strategy=${encodeURIComponent(item.strategy)}`}
              data-active={item.strategy === summary.strategy}
              className="seg-item"
              title={STRATEGY_NOTE[item.strategy] ?? ''}
            >
              {STRATEGY_LABEL[item.strategy] ?? item.strategy}
            </Link>
          ))}
        </div>
        <p className="text-ink-faint text-[11px]">
          {STRATEGY_LABEL[summary.strategy] ?? summary.strategy} · {inr(summary.score.atRiskPaise)} at risk
        </p>
      </section>

      {summary.score.confusion !== null ? <ConfusionMatrix confusion={summary.score.confusion} /> : null}

      <CasesTable cases={summary.cases} strategy={summary.strategy} />
    </div>
  );
}

function QueueMetric({
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
    <div className="min-h-22 p-4">
      <p className="text-ink-faint text-[10px]">{label}</p>
      <p className={`tnum mt-2 font-mono text-xl font-medium ${success ? 'text-permitted' : 'text-ink'}`}>{value}</p>
      <p className="text-ink-faint mt-1 text-[10px] leading-relaxed">{note}</p>
    </div>
  );
}
