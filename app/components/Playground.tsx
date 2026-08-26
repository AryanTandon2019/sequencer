'use client';

import { useMemo, useState } from 'react';

import { Badge } from './Primitives';
import {
  ACTION_LABEL,
  CAUSE_LABEL,
  RECOVERABILITY_LABEL,
  RULE_LABEL,
  TONE_CLASS,
  recoverabilityTone,
} from '../lib/format';

type Adjudication = {
  accepted: boolean;
  status?: string;
  error?: string;
  failure?: { reason: string; step: string; source: string; code: string };
  amountPaise?: number;
  diagnosis?: {
    cause: string;
    recoverability: string;
    confidence: number;
    reasoning: string;
    source: string;
  } | null;
  enforcementCause?: string | null;
  rulings?: {
    action: string;
    scheduledFor: string | null;
    rationale: string;
    rejections: { rule: string; citation: string; detail: string }[];
  }[];
  wouldExecute?: string | null;
};

const SCENARIOS = [
  { label: 'Salary-cycle shortfall', reason: 'insufficient_funds', hint: 'retry can work, timed' },
  { label: 'Card expired', reason: 'card_expired', hint: 'retry is futile — ask instead' },
  { label: 'Bank outage', reason: 'bank_technical_error', hint: 'transient — retry soon' },
  { label: 'Daily limit hit', reason: 'transaction_limit_exceeded', hint: 'resets overnight' },
  { label: 'Instrument blocked', reason: 'debit_instrument_blocked', hint: 'customer must act' },
  { label: 'Above mandate cap', reason: 'payment_failed', hint: 'consent boundary' },
  { label: 'Fraud suspected', reason: 'payment_risk_check_failed', hint: 'hard stop' },
  { label: 'Unexplained decline', reason: 'card_declined', hint: 'abstain → human' },
] as const;

function envelope(reason: string): string {
  const now = Math.floor(Date.now() / 1000);
  return JSON.stringify(
    {
      event: 'payment.failed',
      created_at: now,
      payload: {
        payment: {
          entity: {
            id: 'pay_demo_' + reason.slice(0, 6),
            entity: 'payment',
            amount: 149900,
            currency: 'INR',
            status: 'failed',
            method: 'card',
            invoice_id: null,
            order_id: null,
            subscription_id: 'sub_demo_001',
            customer_id: 'cust_demo_001',
            error_code: 'BAD_REQUEST_ERROR',
            error_source: 'bank',
            error_step: 'payment_authorization',
            error_reason: reason,
            error_description: `Demo failure raised for "${reason}".`,
            created_at: now,
          },
        },
      },
    },
    null,
    2,
  );
}

export function Playground() {
  const [reason, setReason] = useState<string>(SCENARIOS[1]!.reason);
  const [body, setBody] = useState<string>(envelope(SCENARIOS[1]!.reason));
  const [result, setResult] = useState<Adjudication | null>(null);
  const [busy, setBusy] = useState(false);

  const selected = useMemo(() => SCENARIOS.find((s) => s.reason === reason), [reason]);
  const bytes = useMemo(() => new TextEncoder().encode(body).length, [body]);

  function pick(next: (typeof SCENARIOS)[number]) {
    setReason(next.reason);
    setBody(envelope(next.reason));
    setResult(null);
  }

  async function run() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch('/api/demo/adjudicate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      setResult((await res.json()) as Adjudication);
    } catch {
      setResult({ accepted: false, error: 'The request could not reach the pipeline.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      {/* ----------------------------------------------------------- input */}
      <div className="panel flex flex-col gap-6 p-6">
        <section>
          <div className="flex items-baseline justify-between">
            <p className="kicker text-brand">1 · Pick a failure</p>
            {selected ? (
              <span className="text-ink-faint font-mono text-[10px]">{selected.reason}</span>
            ) : null}
          </div>

          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {SCENARIOS.map((s) => {
              const active = s.reason === reason;
              return (
                <button
                  key={s.reason}
                  type="button"
                  onClick={() => pick(s)}
                  aria-pressed={active}
                  className={`rounded-xl border p-3 text-left transition-all duration-150 ${
                    active
                      ? 'border-brand bg-brand-wash shadow-[0_2px_8px_rgb(53_89_217/0.10)]'
                      : 'border-line bg-surface hover:border-line-strong hover:bg-raised'
                  }`}
                >
                  <span className={`flex items-center justify-between gap-2 text-xs font-semibold ${active ? 'text-brand-deep' : 'text-ink'}`}>
                    {s.label}
                    {active ? (
                      <svg viewBox="0 0 16 16" className="text-brand h-3.5 w-3.5 shrink-0" fill="currentColor" aria-hidden>
                        <path d="M6.4 11.6 2.8 8l1.06-1.06L6.4 9.48l5.34-5.34L12.8 5.2z" />
                      </svg>
                    ) : null}
                  </span>
                  <span className="text-ink-faint mt-0.5 block text-[10px] leading-snug">{s.hint}</span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="flex flex-1 flex-col">
          <div className="flex items-center justify-between">
            <p className="kicker text-brand">2 · Inspect the envelope</p>
            <span className="tnum text-ink-faint font-mono text-[10px]">{bytes.toLocaleString('en-IN')} bytes</span>
          </div>
          <p className="text-ink-faint mt-1.5 text-[11px] leading-relaxed">
            This is exactly what Razorpay posts to the live webhook. Edit any field — unknown
            reasons are handled honestly.
          </p>

          <div className="focus-within:border-brand focus-within:ring-brand/15 mt-3 overflow-hidden rounded-xl border border-slate-200 transition-shadow focus-within:ring-2">
            <div className="bg-raised text-ink-faint flex items-center gap-1.5 border-b border-slate-200 px-3 py-1.5">
              <span className="h-2 w-2 rounded-full bg-refused/70" />
              <span className="h-2 w-2 rounded-full bg-waiting/70" />
              <span className="h-2 w-2 rounded-full bg-permitted/70" />
              <span className="ml-2 font-mono text-[10px]">payment.failed · JSON</span>
            </div>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              spellCheck={false}
              rows={14}
              className="text-ink block w-full resize-y bg-white p-3 font-mono text-[11px] leading-5 outline-none"
            />
          </div>

          <button type="button" onClick={run} disabled={busy} className="btn btn-primary mt-4 w-full disabled:opacity-50">
            {busy ? 'Running the pipeline…' : 'Run the pipeline'}
            <span aria-hidden>{busy ? '' : '→'}</span>
          </button>
        </section>
      </div>

      {/* ---------------------------------------------------------- result */}
      <div className="panel flex min-h-[420px] flex-col p-6" aria-live="polite">
        <p className="kicker text-ink-faint">3 · The decision</p>

        {busy ? (
          <Skeleton />
        ) : result === null ? (
          <EmptyState />
        ) : !result.accepted ? (
          <RejectedCard error={result.error ?? 'Unknown error'} />
        ) : (
          <Decision result={result} />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- states */

function EmptyState() {
  const steps = ['Detect', 'Diagnose', 'Intervene'];
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 py-10 text-center">
      <div className="flex items-center gap-3">
        {steps.map((step, i) => (
          <div key={step} className="flex items-center gap-3">
            <div className="border-line bg-raised text-ink-soft rounded-lg border px-3 py-2 text-[11px] font-semibold">
              {step}
            </div>
            {i < steps.length - 1 ? <span className="text-ink-faint text-xs" aria-hidden>→</span> : null}
          </div>
        ))}
        <span className="text-ink-faint text-xs" aria-hidden>→</span>
        <div className="rounded-lg border border-dashed border-slate-300 px-3 py-2 text-[11px] font-semibold text-slate-400">
          You are here
        </div>
      </div>
      <p className="text-ink-soft max-w-sm text-xs leading-6">
        The same proposal → classification → compliance path that judges live signed webhooks
        will run here, visibly, every ruling cited. Shadow only — nothing is ever executed.
      </p>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="mt-5 flex-1 animate-pulse space-y-4">
      <div className="bg-raised h-6 w-2/3 rounded-md" />
      <div className="bg-raised h-2 w-full rounded-full" />
      <div className="bg-raised h-20 w-full rounded-xl" />
      <div className="bg-raised h-14 w-full rounded-xl" />
      <div className="bg-raised h-14 w-5/6 rounded-xl" />
    </div>
  );
}

function RejectedCard({ error }: { error: string }) {
  return (
    <div className="bg-refused-wash mt-5 flex flex-1 flex-col justify-center rounded-xl p-6 text-center">
      <p className="text-refused mx-auto flex h-9 w-9 items-center justify-center rounded-full bg-white text-base font-bold" aria-hidden>✕</p>
      <p className="text-refused mt-3 text-sm font-semibold">Refused before deliberation</p>
      <p className="text-ink-soft mx-auto mt-1 max-w-sm text-xs leading-relaxed">{error}</p>
      <p className="text-ink-faint mx-auto mt-3 max-w-xs text-[10px] leading-relaxed">
        Parsing is a gate, not a suggestion — malformed payloads never reach policy, which is
        what keeps the audit trail trustworthy.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------ decided */

function Decision({ result }: { result: Adjudication }) {
  const dx = result.diagnosis;
  const executed = result.wouldExecute;

  return (
    <div className="mt-4 flex-1 space-y-5">
      {/* verdict header */}
      <div className={`rounded-xl border p-4 ${executed ? 'border-permitted/30 bg-permitted-wash' : 'border-waiting/40 bg-waiting-wash'}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="kicker text-ink-faint">Would execute</p>
          <Badge tone="neutral">shadow · nothing moves</Badge>
        </div>
        <p className={`mt-2 text-lg font-semibold ${executed ? 'text-permitted' : 'text-waiting'}`}>
          {executed ? (ACTION_LABEL[executed] ?? executed) : 'Nothing — every candidate was refused'}
        </p>
      </div>

      {/* diagnosis */}
      <section>
        <p className="kicker text-ink-faint">Diagnosis</p>
        {dx ? (
          <div className="border-line mt-2.5 rounded-xl border p-4">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <p className="text-ink text-sm font-semibold">{CAUSE_LABEL[dx.cause] ?? dx.cause}</p>
              <Badge tone={recoverabilityTone(dx.recoverability)}>
                {RECOVERABILITY_LABEL[dx.recoverability] ?? dx.recoverability}
              </Badge>
            </div>

            <div className="mt-3">
              <div className="text-ink-faint flex items-center justify-between text-[10px]">
                <span>confidence</span>
                <span className="tnum font-mono">{dx.confidence.toFixed(2)}</span>
              </div>
              <div className="bg-raised mt-1 h-1.5 overflow-hidden rounded-full">
                <div
                  className={`animate-bar h-full rounded-full ${dx.confidence >= 0.7 ? 'bg-permitted' : 'bg-waiting'}`}
                  style={{ width: `${Math.round(dx.confidence * 100)}%` }}
                />
              </div>
              {dx.confidence < 0.7 ? (
                <p className="text-waiting mt-1.5 text-[10px]">
                  Below the 0.70 floor — autonomous action is refused and the case escalates.
                </p>
              ) : null}
            </div>

            <p className="text-ink-soft mt-3 border-l-2 border-slate-200 pl-3 text-[11px] leading-relaxed italic">
              “{dx.reasoning}”
            </p>
            <p className="text-ink-faint mt-2 font-mono text-[10px]">
              via {dx.source}
              {result.enforcementCause ? ` · enforcement derives: ${result.enforcementCause}` : ''}
            </p>
          </div>
        ) : (
          <div className="border-line bg-raised mt-2.5 rounded-xl border border-dashed p-4">
            <p className="text-ink text-sm font-semibold">No diagnosis — escalated</p>
            <p className="text-ink-soft mt-1 text-[11px] leading-relaxed">
              The payload does not name a cause anyone can trust. Abstention routes this to a
              human rather than inventing an answer at 3 a.m.
            </p>
          </div>
        )}
      </section>

      {/* rulings timeline */}
      <section>
        <p className="kicker text-ink-faint">Compliance rulings</p>
        <ol className="mt-2.5 space-y-0">
          {result.rulings?.map((ruling, i) => {
            const ok = ruling.rejections.length === 0;
            return (
              <li key={i} className="relative flex gap-3 pb-4 last:pb-0">
                {i < (result.rulings?.length ?? 0) - 1 ? (
                  <span className="bg-line absolute top-6 bottom-0 left-[9px] w-px" aria-hidden />
                ) : null}
                <span
                  className={`relative z-10 mt-0.5 flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                    ok ? 'bg-permitted-wash text-permitted' : 'bg-refused-wash text-refused'
                  }`}
                  aria-hidden
                >
                  {ok ? '✓' : '✕'}
                </span>
                <div className="min-w-0 flex-1">
                  <p className={`text-xs font-semibold ${ok ? 'text-permitted' : 'text-refused line-through decoration-refused/40'}`}>
                    {ACTION_LABEL[ruling.action] ?? ruling.action}
                    <span className="text-ink-faint ml-1.5 font-normal">{ok ? '— permitted' : '— refused'}</span>
                  </p>
                  {ruling.rationale ? (
                    <p className="text-ink-faint mt-0.5 text-[10px] leading-relaxed">{ruling.rationale}</p>
                  ) : null}
                  {ruling.rejections.map((rej) => (
                    <div key={rej.rule} className="bg-refused-wash/60 mt-1.5 rounded-lg px-2.5 py-1.5">
                      <span className="text-refused text-[10px] font-semibold">
                        [{RULE_LABEL[rej.rule] ?? rej.rule}]
                      </span>
                      <span className="text-ink-soft ml-1 text-[10px] leading-relaxed">{rej.detail}</span>
                    </div>
                  ))}
                </div>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}
