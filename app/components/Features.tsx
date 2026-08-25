const FEATURES = [
  {
    title: 'Guardrails in code, not prompts',
    copy: 'A prompt is a request; code is a rule. Eight cited rules run between proposal and execution, and refusals are recorded — a blocked attempt is a result, not an error.',
  },
  {
    title: 'Append-only decision ledger',
    copy: 'Every deliberation is written down: the diagnosis, each ruling with its citation, and the outcome. Open any subscription and replay it move by move.',
  },
  {
    title: 'Benchmarked against an oracle',
    copy: 'A perfect-diagnosis twin runs on the same failures to mark the ceiling. Reported figures are a share of that ceiling — never a bare percentage.',
  },
  {
    title: 'Escalation by design',
    copy: 'When a decline genuinely cannot be classified, the case goes to a human instead of being guessed at. Abstention is treated as an answer.',
  },
  {
    title: 'Integer money end to end',
    copy: 'Amounts are integer paise through every layer. No float can invent a rupee, and every amount field is suffixed so misuse is visible at the call site.',
  },
  {
    title: 'Reproducible to the seed',
    copy: 'Rerun any batch and get the same rupees back. The artifacts committed to this repo are what the dashboard reads — no hidden database behind the numbers.',
  },
] as const;

/** Infrastructure-grade claims, as a feature wall. */
export function Features() {
  return (
    <section className="space-y-7" aria-labelledby="built-like">
      <div className="max-w-2xl">
        <p className="text-brand text-[10px] font-semibold tracking-[0.08em] uppercase">Built like infrastructure</p>
        <h2 id="built-like" className="display text-ink mt-3 text-[32px] leading-[1.05] sm:text-[40px]">
          The parts that make it trustworthy are the product.
        </h2>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((feature) => (
          <article key={feature.title} className="panel p-5">
            <h3 className="text-ink text-sm font-semibold">{feature.title}</h3>
            <p className="text-ink-soft mt-2 text-xs leading-6">{feature.copy}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
