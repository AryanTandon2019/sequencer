import { CAUSE_LABEL } from '../lib/format';
import type { ConfusionJson } from '../../src/harness/artifacts';

/**
 * Diagnosis confusion matrix for one strategy.
 *
 * Rows are what was really wrong; columns are what the strategy concluded,
 * including the deliberate "no diagnosis" outcome. The diagonal is the story a
 * marketing page would hide and this product refuses to.
 */
export function ConfusionMatrix({ confusion }: { confusion: ConfusionJson }) {
  const predictedKeys = dedupePredictions(confusion);

  return (
    <section className="panel overflow-hidden" aria-label="Diagnosis confusion matrix">
      <div className="border-line flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b px-5 py-4">
        <div>
          <h2 className="text-ink text-sm font-semibold">Diagnosis accuracy</h2>
          <p className="text-ink-faint mt-1 text-[11px]">
            What was really wrong vs what the policy concluded, per failed subscription
          </p>
        </div>
        <div className="flex items-baseline gap-4">
          <span className="tnum text-ink font-mono text-lg font-medium">
            {Math.round((confusion.correct / Math.max(1, confusion.total)) * 100)}%
          </span>
          <span className="text-ink-faint text-[10px]">
            {confusion.correct} of {confusion.total} named correctly
            {confusion.abstained > 0 ? ` · ${confusion.abstained} deliberately escalated` : ''}
          </span>
        </div>
      </div>

      <div className="overflow-x-auto p-5">
        <table className="w-full min-w-[640px] border-collapse text-left">
          <thead>
            <tr>
              <th scope="col" className="text-ink-faint w-44 pb-2 text-[10px] font-medium tracking-wide uppercase">
                Really was
              </th>
              {predictedKeys.map((key) => (
                <th key={key ?? 'none'} scope="col" className="text-ink-faint px-2 pb-2 text-center text-[10px] font-medium tracking-wide uppercase">
                  {key === null ? 'No diagnosis' : shortCause(key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {confusion.rows.map((row) => (
              <tr key={row.actual}>
                <th scope="row" className="text-ink border-line border-t py-2 pr-3 text-xs font-medium whitespace-nowrap">
                  {shortCause(row.actual)}
                </th>
                {predictedKeys.map((key) => {
                  const cell = row.predictions.find((p) => p.predicted === key);
                  const count = cell?.count ?? 0;
                  const correct = key === row.actual;
                  return (
                    <td
                      key={key ?? 'none'}
                      className={`border-line border-t px-2 py-2 text-center ${
                        count === 0
                          ? ''
                          : correct
                            ? 'bg-permitted-wash'
                            : 'bg-refused-wash'
                      }`}
                    >
                      <span
                        className={`tnum inline-block font-mono text-xs ${
                          count === 0 ? 'text-ink-faint/40' : correct ? 'text-permitted font-semibold' : 'text-refused font-semibold'
                        }`}
                        title={
                          count === 0
                            ? undefined
                            : `${count} case${count === 1 ? '' : 's'} really ${shortCause(row.actual).toLowerCase()}, called ${key === null ? 'undiagnosable' : shortCause(key!).toLowerCase()}`
                        }
                      >
                        {count === 0 ? '·' : count}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>

        <p className="text-ink-faint mt-4 text-[10px] leading-relaxed">
          Green diagonal: correct calls. Red off-diagonal: misdiagnoses, each one visible rather than averaged away.
          “No diagnosis” is the abstain path — the case went to a human instead of being guessed at.
        </p>
      </div>
    </section>
  );
}

function dedupePredictions(confusion: ConfusionJson): readonly (string | null)[] {
  const keys = new Set<string | null>();
  for (const row of confusion.rows) for (const p of row.predictions) keys.add(p.predicted);
  return [...keys].sort((a, b) => {
    if (a === null) return 1;
    if (b === null) return -1;
    return a.localeCompare(b);
  });
}

/** Column headers stay readable without horizontal scroll on mid screens. */
function shortCause(cause: string): string {
  const label = CAUSE_LABEL[cause] ?? cause;
  return label.length > 14 ? label.slice(0, 13) + '…' : label;
}
