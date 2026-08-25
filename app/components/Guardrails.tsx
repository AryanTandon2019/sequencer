import Link from 'next/link';

const RULES = [
  { rule: 'NPCI attempt cap', detail: '1 charge + 3 retries, then the budget is gone' },
  { rule: 'RBI 24h notice', detail: 'no debit before its pre-debit notice matures' },
  { rule: 'Visa hard declines', detail: 'a reattempt cannot approve — never spent' },
  { rule: 'Autopay windows', detail: 'execution avoids peak hours, to the minute' },
  { rule: 'Revoked consent', detail: 'no debit and no dunning. Stop means stop' },
  { rule: 'Confidence floor', detail: 'no autonomous action on a shaky diagnosis' },
] as const;

/**
 * The compliance band. Real SaaS products wear their trust surface; this one can
 * cite the source of every rule it enforces, which is rarer than a logo wall.
 */
export function Guardrails() {
  return (
    <section className="space-y-6" aria-labelledby="guardrails">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl">
          <p className="text-brand text-[10px] font-semibold tracking-[0.08em] uppercase">Compliance is not a setting</p>
          <h2 id="guardrails" className="display text-ink mt-3 text-[32px] leading-[1.05] sm:text-[40px]">
            Eight rules live in code. Every one cites its source.
          </h2>
        </div>
        <Link href="/cases" className="btn btn-ghost">
          See refusals in the ledger
        </Link>
      </div>

      <ul className="grid gap-px overflow-hidden rounded-xl border border-slate-200 bg-slate-200 sm:grid-cols-2 lg:grid-cols-3">
        {RULES.map((item) => (
          <li key={item.rule} className="bg-surface p-4">
            <p className="text-ink text-xs font-semibold">{item.rule}</p>
            <p className="text-ink-faint mt-1 text-[11px] leading-relaxed">{item.detail}</p>
          </li>
        ))}
      </ul>

      <p className="text-ink-faint max-w-3xl text-[11px] leading-relaxed">
        Proposals are adjudicated after the agent acts on its judgement and before anything
        touches money or a customer — and the platform derives the enforcement facts itself,
        so staying silent is not an escape route.
      </p>
    </section>
  );
}
