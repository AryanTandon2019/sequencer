import { Card } from './Primitives';
import type { RunSummary } from '../lib/runs';

/**
 * Restraint, shown side by side.
 *
 * Recovery is only half the story. The other half is what a system refuses to do — and
 * it is the half a payments platform cares about most. This contrasts the documented
 * default against Sequencer on the three measures that matter: attempts burned on cases
 * that could never pay, proposals a guardrail had to stop, and messages aimed at
 * customers who had withdrawn consent.
 *
 * The punchline is the last column. Both delivered zero — the guardrail saw to that —
 * but only one of them needed the brakes.
 */
const ROWS: readonly {
  readonly key: 'attemptsWasted' | 'refusedProposals' | 'blockedHarmfulProposals';
  readonly label: string;
  readonly note: string;
}[] = [
  {
    key: 'attemptsWasted',
    label: 'Attempts burned on lost causes',
    note: 'retries spent on cases that could never have paid',
  },
  {
    key: 'refusedProposals',
    label: 'Actions a rule had to stop',
    note: 'proposals the compliance layer refused',
  },
  {
    key: 'blockedHarmfulProposals',
    label: 'Messages aimed at cancelled customers',
    note: 'proposed to withdrawn consent — every one blocked, none delivered',
  },
];

export function Restraint({ summaries }: { summaries: readonly RunSummary[] }) {
  const baseline = summaries.find((s) => s.strategy === 'baseline');
  const agent = summaries.find((s) => s.strategy === 'agent');
  if (baseline === undefined || agent === undefined) return null;

  return (
    <Card className="p-6">
      <div className="mb-5 grid grid-cols-[1fr_auto_auto] items-baseline gap-x-6">
        <span className="text-ink-faint text-xs tracking-wide uppercase">Restraint</span>
        <span className="text-refused pixel-label w-20 text-right">Retry tmrw</span>
        <span className="text-brand pixel-label w-20 text-right">Sequencer</span>
      </div>

      <div className="space-y-4">
        {ROWS.map((row) => {
          const b = baseline.score[row.key];
          const a = agent.score[row.key];
          return (
            <div key={row.key} className="grid grid-cols-[1fr_auto_auto] items-center gap-x-6">
              <div className="min-w-0">
                <p className="text-ink text-sm font-medium">{row.label}</p>
                <p className="text-ink-faint mt-0.5 text-xs leading-relaxed">{row.note}</p>
              </div>
              <span className="tnum text-refused w-20 text-right font-mono text-lg font-bold">
                {b}
              </span>
              <span
                className={`tnum w-20 text-right font-mono text-lg font-bold ${
                  a === 0 ? 'text-permitted' : 'text-ink'
                }`}
              >
                {a}
              </span>
            </div>
          );
        })}
      </div>

      <p className="border-line text-ink-soft mt-5 border-t pt-4 text-xs leading-relaxed">
        Both systems delivered <span className="text-permitted font-semibold">zero</span> messages
        to a customer who had cancelled — the guardrail refused every one. The difference is that
        one of them kept proposing them. A policy that never proposes the wrong move is not relying
        on the brakes.
      </p>
    </Card>
  );
}
