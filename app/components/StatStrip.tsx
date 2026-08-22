import type { ReactNode } from 'react';

/**
 * The at-a-glance operating figures.
 *
 * This is what turns the cases screen from a table into a console: the numbers a
 * merchant would actually watch — money back, attempts spent against the regulated
 * ceiling, customers contacted, and proposals a rule had to stop. Every value is read
 * from a run summary on disk; nothing is computed in the browser.
 */
export interface Stat {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
  readonly tone?: 'ink' | 'permitted' | 'refused' | 'cyan';
}

const VALUE_TONE: Readonly<Record<NonNullable<Stat['tone']>, string>> = {
  ink: 'text-ink',
  permitted: 'text-permitted',
  refused: 'text-refused',
  cyan: 'text-cyan',
};

export function StatStrip({ stats }: { stats: readonly Stat[] }) {
  return (
    <div className="stagger grid grid-cols-2 gap-3 sm:grid-cols-4">
      {stats.map((s) => (
        <div key={s.label} className="panel-flat p-4">
          <p className="text-ink-faint text-[11px] tracking-wide uppercase">{s.label}</p>
          <p
            className={`tnum mt-2 font-mono text-2xl leading-none font-bold ${
              VALUE_TONE[s.tone ?? 'ink']
            }`}
          >
            {s.value}
          </p>
          {s.hint !== undefined && (
            <p className="text-ink-faint mt-1.5 text-[11px] leading-relaxed">{s.hint}</p>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * A spotlight link that jumps straight to the single most telling case of a kind.
 *
 * The demo lives or dies on getting to the right case without hunting. These take one
 * click to the money shots: an attempt a rule refused, and a decline the bank refused
 * to explain.
 */
export function Spotlight({
  href,
  kicker,
  title,
  body,
  icon,
}: {
  href: string;
  kicker: string;
  title: string;
  body: string;
  icon: ReactNode;
}) {
  return (
    <a
      href={href}
      className="panel group hover:border-brand flex items-start gap-3.5 p-4 transition-all hover:-translate-y-px"
    >
      <span className="bg-brand-wash text-brand mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg font-mono text-lg">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="pixel-label text-cyan block">{kicker}</span>
        <span className="text-ink group-hover:text-brand mt-1.5 block text-sm font-semibold transition-colors">
          {title} <span aria-hidden>→</span>
        </span>
        <span className="text-ink-soft mt-1 block text-xs leading-relaxed">{body}</span>
      </span>
    </a>
  );
}
