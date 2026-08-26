import type { Metadata } from 'next';

import { Playground } from '../components/Playground';
import { Empty } from '../components/Primitives';
import { getRazorpayConnectorStatus } from '../lib/razorpay-status';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Adjudication playground — Sequencer',
  description:
    'Feed a Razorpay-shaped payment failure to the same proposal, classification and compliance pipeline the live webhook uses.',
};

export default function PlaygroundPage() {
  const razorpay = getRazorpayConnectorStatus();

  return (
    <div className="space-y-6">
      <section className="border-line flex flex-col gap-4 border-b pb-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-2xl">
          <p className="text-brand text-[10px] font-semibold tracking-[0.08em] uppercase">
            Try it — no signup
          </p>
          <h1 className="display text-ink mt-3 text-[36px] leading-tight">Adjudication playground</h1>
          <p className="text-ink-soft mt-2 text-sm leading-6">
            Pick a failure or paste your own Razorpay envelope. The exact pipeline that judges
            live signed webhooks — proposal, independent classification, cited guardrail
            rulings — runs in front of you. Shadow only: nothing is executed.
          </p>
        </div>
        <div className="border-line bg-surface inline-flex items-center gap-x-2 rounded-lg border px-3 py-2 text-[10px]">
          <span
            className={`h-1.5 w-1.5 rounded-full ${razorpay.readyForSignedEvents ? 'bg-permitted' : 'bg-waiting'}`}
            aria-hidden
          />
          <span className="text-ink font-semibold">Live connector</span>
          <span className="text-ink-faint">{razorpay.label}</span>
        </div>
      </section>

      {razorpay.mode === 'test' ? (
        <Playground />
      ) : (
        <Empty
          title="Connector disabled"
          hint="Set RAZORPAY_MODE=test to enable adjudication. See the README for the one-line setup."
        />
      )}
    </div>
  );
}
