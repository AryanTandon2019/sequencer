import { Card } from './Primitives';
import { inr, pct, STRATEGY_LABEL } from '../lib/format';
import type { RunSummary } from '../lib/runs';

/**
 * The value ladder.
 *
 * Each rung is a strategy, drawn as a share of the achievable ceiling, with what it adds
 * over the rung below. The bars grow on load in reading order — the one animation on this
 * page that carries information rather than decoration, because the growth makes the gaps
 * legible before you read a single figure.
 */
export function Ladder({
  summaries,
  ceiling,
}: {
  summaries: readonly RunSummary[];
  ceiling: number;
}) {
  const ordered = summaries.slice();
  const oracle = ordered.find((s) => s.strategy === 'oracle');
  const last = ordered.filter((s) => s.strategy !== 'oracle').at(-1);

  const diagnosisGap = (oracle?.score.recoveredPaise ?? 0) - (last?.score.recoveredPaise ?? 0);
  const policyGap = ceiling - (oracle?.score.recoveredPaise ?? 0);

  return (
    <Card className="p-6">
      <div className="space-y-5">
        {ordered.map((s, i) => {
          const share = ceiling === 0 ? 0 : s.score.recoveredPaise / ceiling;
          const previous = ordered[i - 1];
          const added =
            previous === undefined
              ? null
              : s.score.recoveredPaise - previous.score.recoveredPaise;
          const isOracle = s.strategy === 'oracle';

          return (
            <div key={s.strategy}>
              <div className="mb-1.5 flex items-baseline justify-between gap-4">
                <span className="text-ink text-sm font-medium">
                  {STRATEGY_LABEL[s.strategy] ?? s.strategy}
                </span>
                <span className="flex items-baseline gap-3">
                  {added !== null && added !== 0 && (
                    <span
                      className={`tnum text-xs ${added > 0 ? 'text-permitted' : 'text-refused'}`}
                    >
                      {added > 0 ? '+' : '−'}
                      {inr(Math.abs(added))}
                    </span>
                  )}
                  <span className="tnum text-ink font-mono text-sm font-bold">
                    {inr(s.score.recoveredPaise)}
                  </span>
                  <span className="tnum text-ink-faint w-12 text-right text-xs">
                    {pct(share)}
                  </span>
                </span>
              </div>

              <div className="bg-canvas border-line h-3 overflow-hidden rounded-md border">
                <div
                  className={`animate-bar h-full ${
                    isOracle
                      ? 'bg-ink-faint'
                      : s.strategy === 'baseline'
                        ? 'bg-refused'
                        : 'bg-brand'
                  }`}
                  style={{
                    width: `${Math.max(0, Math.min(100, share * 100))}%`,
                    animationDelay: `${0.12 * i + 0.1}s`,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* The two remainders, which point at different work. */}
      <div className="border-line mt-6 grid gap-3 border-t pt-5 sm:grid-cols-2">
        <div>
          <p className="text-ink-faint text-xs">Still lost to diagnosis error</p>
          <p className="tnum text-ink mt-1 font-mono text-lg font-bold">{inr(diagnosisGap)}</p>
          <p className="text-ink-faint mt-0.5 text-xs">
            {pct(ceiling === 0 ? 0 : diagnosisGap / ceiling)} — what a better reasoning layer
            could still win
          </p>
        </div>
        <div>
          <p className="text-ink-faint text-xs">Beyond any diagnosis</p>
          <p className="tnum text-ink mt-1 font-mono text-lg font-bold">{inr(policyGap)}</p>
          <p className="text-ink-faint mt-0.5 text-xs">
            {pct(ceiling === 0 ? 0 : policyGap / ceiling)} — a policy limit, not a diagnosis
            failure
          </p>
        </div>
      </div>
    </Card>
  );
}
