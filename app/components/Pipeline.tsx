const STEPS = [
  {
    n: '01',
    title: 'Detect',
    copy: 'Reads the failure exactly as the issuer reports it — code, reason, source, step — the same payload your webhook already receives.',
    detail: 'Razorpay-shaped failure object',
  },
  {
    n: '02',
    title: 'Diagnose',
    copy: 'Fourteen known causes, five verdicts. A lookup table settles most failures instantly; a model only ever sees what the table cannot.',
    detail: '14 causes · 5 recoverability classes',
  },
  {
    n: '03',
    title: 'Intervene',
    copy: 'One action from nine. Retrying is not the default answer — waiting out a paused mandate or stopping for a revoked one is often correct.',
    detail: '9 actions · WAIT and STOP are first-class',
  },
  {
    n: '04',
    title: 'Learn',
    copy: 'Every ruling lands in an append-only ledger: what was proposed, which rule refused it, what happened next. Nothing is averaged away.',
    detail: 'Append-only ledger · full replay',
  },
] as const;

/** The product loop, as four moves. This is the pitch in one scroll. */
export function Pipeline() {
  return (
    <section className="space-y-7" aria-labelledby="how-it-works">
      <div className="max-w-2xl">
        <p className="text-brand text-[10px] font-semibold tracking-[0.08em] uppercase">How Sequencer thinks</p>
        <h2 id="how-it-works" className="display text-ink mt-3 text-[32px] leading-[1.05] sm:text-[40px]">
          Four moves per failed charge. None of them is “try again tomorrow.”
        </h2>
      </div>

      <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((step) => (
          <li key={step.n} className="panel flex flex-col p-5">
            <span className="tnum text-brand/70 font-mono text-[11px] font-semibold">{step.n}</span>
            <h3 className="text-ink mt-3 text-base font-semibold">{step.title}</h3>
            <p className="text-ink-soft mt-2 flex-1 text-xs leading-6">{step.copy}</p>
            <p className="border-line text-ink-faint mt-4 border-t pt-3 text-[10px] font-medium tracking-wide">
              {step.detail}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}
