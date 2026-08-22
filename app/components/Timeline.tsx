'use client';

import { useEffect, useState } from 'react';

import { Badge, Card } from './Primitives';
import {
  ACTION_LABEL,
  CAUSE_LABEL,
  days,
  pct,
  RECOVERABILITY_LABEL,
  recoverabilityTone,
  RULE_LABEL,
} from '../lib/format';
import type { Decision } from '../lib/runs';

export function Timeline({
  decisions,
  startedAt,
  strategy,
}: {
  decisions: readonly Decision[];
  startedAt: number;
  strategy: string;
}) {
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [fast, setFast] = useState(false);

  useEffect(() => {
    if (!playing || decisions.length < 2) return;
    const timer = window.setInterval(() => {
      setStep((current) => {
        if (current >= decisions.length - 1) {
          setPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, fast ? 650 : 1300);
    return () => window.clearInterval(timer);
  }, [playing, fast, decisions.length]);

  if (decisions.length === 0) {
    return (
      <Card className="border-dashed p-6 text-center">
        <p className="text-ink text-sm font-medium">No decision events are available</p>
        <p className="text-ink-faint mt-1 text-xs">The ledger may be absent or this policy recorded no deliberation.</p>
      </Card>
    );
  }

  const active = decisions[Math.min(step, decisions.length - 1)];
  if (active === undefined) return null;
  const refusals = active.rulings.filter((ruling) => ruling.rejections.length > 0);
  const knowledgeHeading =
    strategy === 'oracle'
      ? 'Evaluator truth given to Oracle'
      : strategy === 'baseline'
        ? 'What the calendar policy knew'
        : 'What Sequencer knew';

  function play(): void {
    if (step === decisions.length - 1) setStep(0);
    setPlaying((value) => !value);
  }

  return (
    <div className="panel border-t-brand overflow-hidden border-t-2">
      <div className="border-line flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 sm:px-5">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${playing ? 'bg-permitted animate-live' : 'bg-ink-faint'}`} />
          <span className="text-ink text-xs font-medium">Decision replay</span>
          <span className="text-ink-faint font-mono text-[10px]">{step + 1} / {decisions.length}</span>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setFast((value) => !value)} className="seg-item bg-canvas" aria-pressed={fast}>
            {fast ? '2×' : '1×'}
          </button>
          <button type="button" onClick={() => setStep((value) => Math.max(0, value - 1))} disabled={step === 0} className="btn btn-ghost disabled:cursor-not-allowed disabled:opacity-35" aria-label="Previous decision">←</button>
          <button type="button" onClick={play} className="btn btn-primary min-w-24">
            {playing ? 'Pause' : step === decisions.length - 1 ? 'Replay' : 'Play trail'}
          </button>
          <button type="button" onClick={() => setStep((value) => Math.min(decisions.length - 1, value + 1))} disabled={step === decisions.length - 1} className="btn btn-ghost disabled:cursor-not-allowed disabled:opacity-35" aria-label="Next decision">→</button>
        </div>
      </div>

      <div className="grid lg:grid-cols-[220px_minmax(0,1fr)]">
        <ol className="border-line bg-canvas/45 border-b p-3 lg:border-r lg:border-b-0">
          {decisions.map((decision, index) => {
            const selected = index === step;
            const complete = index <= step;
            const label = decision.executed === null ? 'Action refused' : ACTION_LABEL[decision.executed.kind] ?? decision.executed.kind;
            return (
              <li key={`${decision.at}-${index}`}>
                <button
                  type="button"
                  onClick={() => { setPlaying(false); setStep(index); }}
                  className={`flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${selected ? 'bg-raised' : 'hover:bg-surface'}`}
                >
                  <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${selected ? 'bg-lime' : complete ? 'bg-brand' : 'bg-line-strong'}`} />
                  <span className="min-w-0">
                    <span className={`block truncate text-xs font-medium ${selected ? 'text-ink' : 'text-ink-soft'}`}>{label}</span>
                    <span className="text-ink-faint mt-0.5 block font-mono text-[9px]">+{days(decision.at - startedAt)} on run clock</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>

        <div key={step} className="animate-rise p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="kicker text-cyan">{knowledgeHeading}</p>
              {active.diagnosis !== null ? (
                <>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <h3 className="text-ink text-lg font-medium">{CAUSE_LABEL[active.diagnosis.cause] ?? active.diagnosis.cause}</h3>
                    <Badge tone={recoverabilityTone(active.diagnosis.recoverability)}>
                      {RECOVERABILITY_LABEL[active.diagnosis.recoverability] ?? active.diagnosis.recoverability}
                    </Badge>
                  </div>
                  <p className="text-ink-soft mt-2 max-w-2xl text-sm leading-6">{active.diagnosis.reasoning}</p>
                  <div className="mt-3 flex items-center gap-3">
                    <div className="bg-line h-1.5 w-32 overflow-hidden rounded-full">
                      <div className="bg-cyan h-full rounded-full" style={{ width: `${active.diagnosis.confidence * 100}%` }} />
                    </div>
                    <span className="text-ink-faint font-mono text-[10px]">{pct(active.diagnosis.confidence, 0)} confidence · {active.diagnosis.source}</span>
                  </div>
                </>
              ) : (
                <>
                  <h3 className="text-ink mt-2 text-lg font-medium">No diagnosis formed</h3>
                  <p className="text-ink-soft mt-2 text-sm leading-6">The policy did not claim a cause. The enforcement layer still checked independently observable facts.</p>
                </>
              )}
            </div>
            {active.executed !== null ? (
              <Badge tone="brand">{ACTION_LABEL[active.executed.kind] ?? active.executed.kind}</Badge>
            ) : (
              <Badge tone="refused">No action permitted</Badge>
            )}
          </div>

          <div className="border-line my-6 border-t" />

          <div>
            <p className="kicker text-ink-faint">Guardrail verdict</p>
            {refusals.length === 0 ? (
              <div className="border-permitted/50 mt-3 border-l-2 py-1 pl-3">
                <div className="flex items-center gap-2">
                  <span className="text-permitted" aria-hidden>✓</span>
                  <p className="text-permitted text-xs font-medium">Candidate action passed every applicable rule</p>
                </div>
                {active.executed !== null && <p className="text-ink-soft mt-2 text-xs leading-5">{active.executed.rationale}</p>}
              </div>
            ) : (
              <div className="mt-3 space-y-3">
                {refusals.flatMap((ruling) => ruling.rejections.map((rejection) => (
                  <div key={`${ruling.action.kind}-${rejection.rule}`} className="rule-stop">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-refused text-xs font-medium">{ACTION_LABEL[ruling.action.kind] ?? ruling.action.kind} refused</p>
                      <span className="text-refused font-mono text-[9px] uppercase">{RULE_LABEL[rejection.rule] ?? rejection.rule}</span>
                    </div>
                    <p className="text-ink-soft mt-2 text-xs leading-5">{rejection.detail}</p>
                    <details className="mt-3">
                      <summary className="text-ink-faint cursor-pointer text-[10px] font-medium">View cited rule</summary>
                      <p className="text-ink-faint mt-2 border-l border-refused/30 pl-3 text-[10px] leading-5">{rejection.citation}</p>
                    </details>
                  </div>
                )))}
              </div>
            )}
          </div>

          {active.executed !== null && refusals.length > 0 && (
            <div className="border-line mt-5 border-t pt-4">
              <p className="text-ink-faint text-[10px] uppercase">Safe fallback executed</p>
              <p className="text-ink mt-1 text-sm font-medium">{ACTION_LABEL[active.executed.kind] ?? active.executed.kind}</p>
              <p className="text-ink-soft mt-1 text-xs leading-5">{active.executed.rationale}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
