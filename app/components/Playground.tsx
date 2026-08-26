'use client';

import { useState } from 'react';

import {
  ACTION_LABEL,
  CAUSE_LABEL,
  RECOVERABILITY_LABEL,
  RULE_LABEL,
  STRATEGY_LABEL,
} from '../lib/format';
import { inr } from '../lib/format';

type Adjudication = {
  accepted: boolean;
  status?: string;
  error?: string;
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

function envelope(reason: string, amount = 149900): string {
  return JSON.stringify(
    {
      event: 'payment.failed',
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        payment: {
          entity: {
            id: 'pay_demo1',
            entity: 'payment',
            amount,
            currency: 'INR',
            status: 'failed',
            method: 'card',
            subscription_id: 'sub_demo1',
            customer_id: 'cust_demo1',
            error_code: 'BAD_REQUEST_ERROR',
            error_source: 'bank',
            error_step: 'payment_authorization',
            error_reason: reason,
            error_description: `Demo failure: ${reason}`,
            created_at: Math.floor(Date.now() / 1000),
          },
        },
      },
    },
    null,
    2,
  );
}

const SCENARIOS: readonly { label: string; reason: string; note: string }[] = [
  { label: 'Insufficient funds', reason: 'insufficient_funds', note: 'retry can work — timed' },
  { label: 'Card expired', reason: 'card_expired', note: 'retry is futile — ask instead' },
  { label: 'Bank outage', reason: 'bank_technical_error', note: 'transient — retry soon' },
  { label: 'Daily limit hit', reason: 'transaction_limit_exceeded', note: 'resets overnight' },
  { label: 'Instrument blocked', reason: 'debit_instrument_blocked', note: 'customer must act' },
  { label: 'Fraud suspected', reason: 'payment_risk_check_failed', note: 'hard stop' },
  { label: 'Unexplained decline', reason: 'card_declined', note: 'abstain → human' },
];

export function Playground() {
  const [reason, setReason] = useState(SCENARIOS[1]!.reason);
  const [body, setBody] = useState(envelope(SCENARIOS[1]!.reason));
  const [result, setResult] = useState<Adjudication | null>(null);
  const [busy, setBusy] = useState(false);

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
      setResult({ accepted: false, error: 'request failed' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      {/* ------------------------------------------------ input side */}
      <div className="panel flex flex-col gap-4 p-5">
        <div>
          <p className="text-brand text-[10px] font-semibold tracking-[0.08em] uppercase">Pick a failure</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {SCENARIOS.map((s) => (
              <button
                key={s.reason}
                type="button"
                aria-pressed={reason === s.reason}
                onClick={() => pick(s)}
                className={`seg-item h-auto rounded-md px-2.5 py-1.5 text-left text-[11px] leading-tight ${
                  reason === s.reason ? '' : 'border-line border'
                }`}
                title={s.note}
              >
                <span className="block font-semibold">{s.label}</span>
                <span className="text-ink-faint block text-[9px]">{s.note}</span>
              </button>
            ))}
          </div>
        </div>

        <label className="block flex-1">
          <span className="text-ink-faint text-[10px] font-semibold tracking-wide uppercase">
            Envelope — edit anything, then adjudicate
          </span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            spellCheck={false}
            rows={16}
            className="border-line bg-raised text-ink mt-2 w-full rounded-lg border p-3 font-mono text-[11px] leading-5 focus:border-brand outline-none"
          />
        </label>

        <button type="button" onClick={run} disabled={busy} className="btn btn-primary disabled:opacity-50">
          {busy ? 'Adjudicating…' : 'Run the pipeline →'}
        </button>
      </div>

      {/* ----------------------------------------------- result side */}
      <div className="panel flex flex-col p-5" aria-live="polite">
        {!result ? (
          <div className="text-ink-faint m-auto max-w-xs text-center text-xs leading-6">
            Choose a scenario and run the pipeline. The same proposal → classification →
            compliance path that judges live webhooks runs here — nothing is ever executed.
          </div>
        ) : !result.accepted ? (
          <div className="bg-refused-wash text-refused rounded-lg p-4 text-xs leading-relaxed">
            <p className="font-semibold">Refused before deliberation</p>
            <p className="mt-1">{result.error}</p>
            <p className="text-ink-faint mt-2 text-[10px]">
              A malformed payload never reaches the policy — parsing is a gate, not a suggestion.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {result.diagnosis ? (
              <div className="border-line border-b pb-4">
                <p className="text-ink-faint text-[10px] font-semibold tracking-wide uppercase">Diagnosis</p>
                <p className="text-ink mt-2 text-sm font-semibold">
                  {CAUSE_LABEL[result.diagnosis.cause] ?? result.diagnosis.cause}
                  <span className="tnum text-ink-faint ml-2 font-mono text-[11px] font-normal">
                    confidence {result.diagnosis.confidence.toFixed(2)} · {result.diagnosis.source}
                  </span>
                </p>
                <p className="text-ink-soft mt-1 text-[11px]">
                  {RECOVERABILITY_LABEL[result.diagnosis.recoverability] ?? result.diagnosis.recoverability}
                  {' — '}
                  {result.diagnosis.reasoning}
                </p>
              </div>
            ) : (
              <div className="border-line border-b pb-4">
                <p className="text-ink-faint text-[10px] font-semibold tracking-wide uppercase">Diagnosis</p>
                <p className="text-ink mt-2 text-sm font-semibold">No diagnosis — escalated</p>
                <p className="text-ink-soft mt-1 text-[11px]">
                  The payload does not name a cause the classifier can trust. Abstention routes
                  the case to a human rather than guessing.
                </p>
              </div>
            )}

            <div>
              <p className="text-ink-faint text-[10px] font-semibold tracking-wide uppercase">
                Compliance rulings
              </p>
              <ol className="mt-3 space-y-2.5">
                {result.rulings?.map((ruling, i) => (
                  <li key={i} className={`rounded-lg p-3 ${ruling.rejections.length === 0 ? 'bg-permitted-wash' : 'bg-refused-wash'}`}>
                    <p className={`text-xs font-semibold ${ruling.rejections.length === 0 ? 'text-permitted' : 'text-refused'}`}>
                      {ACTION_LABEL[ruling.action] ?? ruling.action}
                      {ruling.rejections.length === 0 ? ' — permitted' : ' — refused'}
                    </p>
                    {ruling.rationale ? (
                      <p className="text-ink-faint mt-1 text-[10px] leading-relaxed">{ruling.rationale}</p>
                    ) : null}
                    {ruling.rejections.map((rej) => (
                      <p key={rej.rule} className="text-refused/80 mt-1.5 text-[10px] leading-relaxed">
                        <span className="font-semibold">[{RULE_LABEL[rej.rule] ?? rej.rule}]</span> {rej.detail}
                        <a href={rej.citation.includes('http') ? rej.citation : undefined} target="_blank" rel="noopener noreferrer" className="hidden" aria-hidden />
                      </p>
                    ))}
                  </li>
                ))}
              </ol>
            </div>

            <div className="border-line bg-raised border-t pt-4">
              <p className="text-ink-faint text-[10px] font-semibold tracking-wide uppercase">Would execute</p>
              <p className="text-ink mt-1.5 text-sm font-semibold">
                {result.wouldExecute
                  ? (ACTION_LABEL[result.wouldExecute] ?? result.wouldExecute)
                  : 'Nothing — every candidate was refused'}
              </p>
              <p className="text-ink-faint mt-1 text-[10px]">
                Shadow mode. Nothing was debited, sent, or written back —{' '}
                {STRATEGY_LABEL.agent} proposes; only a permitted executor acts.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
