import Link from 'next/link';

import { BatchReplay } from './components/BatchReplay';
import { Empty, Mark } from './components/Primitives';
import { inr, inrCompact, pct } from './lib/format';
import { getRazorpayConnectorStatus } from './lib/razorpay-status';
import { loadPrimaryRunSet } from './lib/runs';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const set = await loadPrimaryRunSet();
  const razorpay = getRazorpayConnectorStatus();

  if (set === null || set.summaries.length === 0) {
    return (
      <Empty
        title="No proof run found"
        hint={
          <>
            Run <code className="text-ink font-mono">npm run harness</code> to generate the real
            summary and ledger artifacts used by this dashboard.
          </>
        }
      />
    );
  }

  const baseline = set.summaries.find((summary) => summary.strategy === 'baseline');
  const agent = set.summaries.find((summary) => summary.strategy === 'agent');
  const oracle = set.summaries.find((summary) => summary.strategy === 'oracle');

  if (baseline === undefined || agent === undefined) {
    return <Empty title="Comparison incomplete" hint="The baseline and agent summaries are both required." />;
  }

  const uplift = agent.score.recoveredPaise - baseline.score.recoveredPaise;
  const attemptsSaved = baseline.score.attemptsUsed - agent.score.attemptsUsed;
  const maxRecovered = Math.max(...set.summaries.map((summary) => summary.score.recoveredPaise));

  return (
    <div className="space-y-10">
      <section className="grid items-center gap-9 pt-2 lg:grid-cols-[1.12fr_0.88fr] lg:gap-14">
        <div className="animate-rise">
          <div className="text-brand mb-5 flex items-center gap-2.5 text-[11px] font-semibold tracking-[0.08em] uppercase">
            <Mark className="w-5" />
            Reason-aware revenue recovery
          </div>
          <h1 className="display text-ink text-[44px] sm:text-[58px] lg:text-[64px]">
            Recover the payment.
            <br />
            <span className="text-brand">Respect the customer.</span>
          </h1>
          <p className="text-ink-soft mt-6 max-w-xl text-[15px] leading-7">
            Sequencer understands why a subscription payment failed before spending one of four
            permitted attempts—then retries, asks for a fix, or stops.
          </p>
          <div className="mt-7 flex flex-wrap gap-2.5">
            <Link href="#live-run" className="btn btn-primary">
              Watch 300 recoveries <span aria-hidden>↓</span>
            </Link>
            <Link href="/cases?strategy=agent" className="btn btn-ghost">
              Open decision ledger
            </Link>
          </div>
          <p className="text-ink-faint mt-4 text-[11px]">
            Seeded simulated outcomes · deterministic replay · every decision auditable
          </p>
          <div className="border-line bg-surface mt-4 inline-flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-3 py-2 text-[10px]">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                razorpay.readyForSignedEvents
                  ? 'bg-permitted'
                  : razorpay.apiCredentialsConfigured
                    ? 'bg-waiting'
                    : 'bg-ink-faint'
              }`}
              aria-hidden
            />
            <span className="text-ink font-semibold">Razorpay Test Mode</span>
            <span className="text-ink-faint">{razorpay.label}</span>
          </div>
        </div>

        <div className="panel overflow-hidden">
          <div className="border-line flex items-center justify-between border-b px-5 py-4">
            <div className="flex items-center gap-2">
              <span className="bg-permitted h-2 w-2 rounded-full" />
              <span className="text-ink text-xs font-semibold">Validated simulation holdout</span>
            </div>
            <span className="text-ink-faint font-mono text-[10px]">seed {set.seed}</span>
          </div>

          <div className="p-5 sm:p-6">
            <p className="text-ink-faint text-[10px] font-semibold tracking-[0.08em] uppercase">Recovered by Sequencer</p>
            <p className="tnum text-ink mt-3 font-mono text-[40px] leading-none font-medium tracking-[-0.04em] sm:text-[46px]">
              {inr(agent.score.recoveredPaise)}
            </p>
            <p className="text-ink-soft mt-2 text-xs">
              from {agent.score.cases} failed subscriptions · {pct(agent.score.captureOfCeiling)} of collectable revenue
            </p>

            <div className="bg-raised mt-5 h-2 overflow-hidden rounded-full">
              <div className="bg-permitted h-full rounded-full" style={{ width: `${agent.score.captureOfCeiling * 100}%` }} />
            </div>

            <div className="border-line mt-6 grid grid-cols-3 border-t pt-5">
              <ProofMetric label="Lift" value={`+${inrCompact(uplift)}`} />
              <ProofMetric label="Attempts saved" value={String(attemptsSaved)} bordered />
              <ProofMetric label="Unsafe contacts" value={String(agent.score.harmfulContacts)} bordered />
            </div>
          </div>

          <div className="bg-brand-wash border-brand/15 border-t px-5 py-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-brand text-[11px] font-semibold">Four attempts. Spend each with evidence.</p>
                <p className="text-ink-faint mt-0.5 text-[10px]">One original charge and three retries.</p>
              </div>
              <div className="flex w-28 gap-1" aria-label="Four-attempt budget">
                {[0, 1, 2, 3].map((index) => (
                  <span key={index} className={`h-2 flex-1 rounded-sm ${index === 0 ? 'bg-brand' : 'bg-brand/25'}`} />
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <BatchReplay baselineCases={baseline.cases} agentCases={agent.cases} />

      <section className="bg-ink overflow-hidden rounded-2xl text-white shadow-[0_14px_36px_rgb(15_23_42/0.14)]">
        <div className="grid lg:grid-cols-[0.9fr_1.1fr]">
          <div className="border-white/12 p-6 sm:p-8 lg:border-r">
            <p className="text-brand-wash text-[10px] font-semibold tracking-[0.1em] uppercase">Proof, not promise</p>
            <h2 className="display mt-4 text-[30px] leading-[1.06] text-white sm:text-[36px]">
              The win is not trying harder. It is knowing which attempt is worth spending.
            </h2>
            <p className="mt-5 max-w-md text-xs leading-6 text-white/60">
              All three policies saw the same failures. Only the diagnosis and decision policy
              changed. Oracle receives perfect knowledge only to mark the upper bound.
            </p>
          </div>

          <div className="p-6 sm:p-8">
            <div className="space-y-5">
              {set.summaries.map((summary) => {
                const width = maxRecovered === 0 ? 0 : (summary.score.recoveredPaise / maxRecovered) * 100;
                const label =
                  summary.strategy === 'baseline'
                    ? 'Calendar retry'
                    : summary.strategy === 'oracle'
                      ? 'Perfect diagnosis'
                      : 'Sequencer';
                return (
                  <div key={summary.strategy}>
                    <div className="mb-2 flex items-center justify-between gap-4 text-xs">
                      <span className={summary.strategy === 'agent' ? 'font-semibold text-white' : 'text-white/60'}>{label}</span>
                      <span className="tnum font-mono text-[11px] text-white/80">
                        {inr(summary.score.recoveredPaise)} · {pct(summary.score.captureOfCeiling)}
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-sm bg-white/10">
                      <div
                        className={`animate-bar h-full ${
                          summary.strategy === 'agent'
                            ? 'bg-permitted'
                            : summary.strategy === 'baseline'
                              ? 'bg-refused'
                              : 'bg-brand'
                        }`}
                        style={{ width: `${width}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-7 flex flex-wrap items-center justify-between gap-4 border-t border-white/12 pt-5">
              <p className="text-[11px] text-white/55">
                {agent.score.attemptsUsed} attempts · {agent.score.contactsSent} customer contacts · {agent.score.harmfulContacts} unsafe
              </p>
              <Link href="/cases?strategy=agent" className="text-xs font-semibold text-white hover:text-white/75">
                Inspect every decision →
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function ProofMetric({
  label,
  value,
  bordered = false,
}: {
  label: string;
  value: string;
  bordered?: boolean;
}) {
  return (
    <div className={bordered ? 'border-line border-l pl-4' : ''}>
      <p className="tnum text-ink font-mono text-lg font-medium">{value}</p>
      <p className="text-ink-faint mt-1 text-[9px]">{label}</p>
    </div>
  );
}
