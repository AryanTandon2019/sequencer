import Link from 'next/link';

/**
 * Closing CTA. A real product ends with "run it"; this one can mean it literally,
 * because the entire demo reproduces from one command with no API key.
 */
export function CtaRun() {
  return (
    <section className="bg-ink overflow-hidden rounded-2xl text-white shadow-[0_14px_36px_rgb(15_23_42/0.14)]">
      <div className="grid gap-8 p-6 sm:p-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
        <div>
          <p className="text-brand-wash text-[10px] font-semibold tracking-[0.1em] uppercase">No API key. No network. No database.</p>
          <h2 className="display mt-4 text-[30px] leading-[1.06] sm:text-[38px]">
            Run the whole thing yourself in under a minute.
          </h2>
          <p className="mt-4 max-w-md text-xs leading-6 text-white/60">
            The harness replays 300 simulated failures through three policies, checks every
            invariant, and prints the comparison to the rupee. If any number here could not
            be reproduced by a stranger, it should not be on this page.
          </p>
          <div className="mt-6 flex flex-wrap gap-2.5">
            <Link href="/cases?strategy=agent" className="btn btn-primary">
              Inspect the ledger
            </Link>
            <a
              href="https://github.com/AryanTandon2019/sequencer"
              target="_blank"
              rel="noopener noreferrer"
              className="btn h-10 min-h-10 border border-white/20 bg-transparent px-4 text-xs font-semibold text-white hover:bg-white/10"
            >
              Read the source →
            </a>
          </div>
        </div>

        <div className="rounded-xl border border-white/12 bg-black/40 p-5 font-mono text-xs leading-7">
          <p className="text-white/40 text-[10px] tracking-wide uppercase">terminal</p>
          <p className="mt-3 text-white/85">
            <span className="text-permitted">$</span> npm install
          </p>
          <p className="text-white/85">
            <span className="text-permitted">$</span> npm run harness
          </p>
          <p className="text-white/40 mt-1"># → ₹3,92,147 recovered · 76.5% of ceiling</p>
          <p className="text-white/85 mt-3">
            <span className="text-permitted">$</span> npm run sensitivity
          </p>
          <p className="text-white/40 mt-1"># ordering holds across three cohort mixes</p>
        </div>
      </div>
    </section>
  );
}
