import type { Metadata } from 'next';

import { Playground } from '../components/Playground';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Adjudication playground — Sequencer',
  description:
    'Feed a Razorpay-shaped payment failure to the proposal, classification and compliance core used by the signed webhook.',
};

export default function PlaygroundPage() {
  return (
    <div className="space-y-6">
      <section className="border-line flex flex-col gap-4 border-b pb-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-2xl">
          <p className="text-brand text-[10px] font-semibold tracking-[0.08em] uppercase">
            Try it — no signup
          </p>
          <h1 className="display text-ink mt-3 text-[36px] leading-tight">Adjudication playground</h1>
          <p className="text-ink-soft mt-2 text-sm leading-6">
            Pick a failure or paste your own Razorpay envelope. The same proposal,
            independent classification and cited guardrail core used by signed webhooks runs in
            front of you. Shadow only: nothing is persisted or executed.
          </p>
        </div>
        <div className="border-line bg-surface inline-flex items-center gap-x-2 rounded-lg border px-3 py-2 text-[10px]">
          <span className="bg-permitted h-1.5 w-1.5 rounded-full" aria-hidden />
          <span className="text-ink font-semibold">Non-persistent shadow demo</span>
          <span className="text-ink-faint">No queue · no side effects</span>
        </div>
      </section>

      <Playground />
    </div>
  );
}
