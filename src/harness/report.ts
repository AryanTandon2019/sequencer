/**
 * Terminal reporting.
 *
 * Plain text tables, no dependencies. The output of `npm run harness` is the primary
 * artefact of this project, so it is written to be read by someone who has thirty
 * seconds and no context.
 *
 * Ordering is deliberate: the comparison first, the caveats immediately after, and
 * the detail below for anyone who wants it. Numbers that flatter should not appear
 * before the reasons to distrust them.
 */

import type { DeclineCause } from '../domain/types.js';
import type { Cohort } from '../sim/cohort.js';
import { largestCaseShare, recoverableCaseCount } from '../sim/cohort.js';
import type { StrategyScore } from './score.js';

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

export function inr(paise: number): string {
  const rupees = Math.round(paise / 100);
  return `₹${rupees.toLocaleString('en-IN')}`;
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function padLeft(text: string, width: number): string {
  return text.length >= width ? text : ' '.repeat(width - text.length) + text;
}

function rule(width = 78): string {
  return '─'.repeat(width);
}

/* ------------------------------------------------------------------ *
 * Sections
 * ------------------------------------------------------------------ */

export function renderCohortHeader(cohort: Cohort): string {
  const total = cohort.subscriptions.reduce((a, s) => a + s.observable.amountPaise, 0);
  const recoverable = cohort.subscriptions
    .filter((s) => s.hidden.recoverable)
    .reduce((a, s) => a + s.observable.amountPaise, 0);

  const lines = [
    rule(),
    `COHORT   ${cohort.subscriptions.length} subscriptions · seed ${cohort.seed} · mix ${cohort.mix}`,
    rule(),
    `  at risk          ${padLeft(inr(total), 12)}   ${cohort.subscriptions.length} cases`,
    `  recoverable      ${padLeft(inr(recoverable), 12)}   ${recoverableCaseCount(cohort)} cases` +
      `   (${pct(recoverable / total)} of money, ` +
      `${pct(recoverableCaseCount(cohort) / cohort.subscriptions.length)} of cases)`,
    `  unrecoverable    ${padLeft(inr(total - recoverable), 12)}   ` +
      `${cohort.subscriptions.length - recoverableCaseCount(cohort)} cases`,
    '',
    `  Money and case shares differ because unrecoverable cases skew cheaper. Read both.`,
    `  Largest single case holds ${pct(largestCaseShare(cohort))} of at-risk money.`,
  ];

  return lines.join('\n');
}

export function renderComparison(scores: readonly StrategyScore[]): string {
  const head =
    pad('STRATEGY', 12) +
    padLeft('RECOVERED', 12) +
    padLeft('% MONEY', 9) +
    padLeft('% CASES', 9) +
    padLeft('ATTEMPTS', 10) +
    padLeft('₹/ATTEMPT', 11) +
    padLeft('CONTACTS', 10);

  const rows = scores.map((s) =>
    pad(s.strategy, 12) +
      padLeft(inr(s.recoveredPaise), 12) +
      padLeft(pct(s.captureOfCeiling), 9) +
      padLeft(pct(s.captureOfCeilingByCase), 9) +
      padLeft(String(s.attemptsUsed), 10) +
      padLeft(inr(s.paisePerAttempt), 11) +
      padLeft(String(s.contactsSent), 10),
  );

  return [
    rule(),
    'RECOVERY',
    rule(),
    head,
    ...rows,
    '',
    '  % MONEY and % CASES are both against the achievable ceiling, not against total',
    '  at-risk. Money is the business-relevant figure; cases is the harder one to',
    '  distort. Where they diverge, the divergence is the finding.',
  ].join('\n');
}

export function renderRestraint(scores: readonly StrategyScore[]): string {
  const head =
    pad('STRATEGY', 12) +
    padLeft('WASTED ATT', 12) +
    padLeft('REFUSED', 10) +
    padLeft('HARD-DECL', 11) +
    padLeft('NO-CONSENT', 12) +
    padLeft('REACHED', 9);

  const rows = scores.map((s) =>
    pad(s.strategy, 12) +
      padLeft(String(s.attemptsWasted), 12) +
      padLeft(String(s.refusedProposals), 10) +
      padLeft(String(s.blockedHardDeclineRetries), 11) +
      padLeft(String(s.blockedHarmfulProposals), 12) +
      padLeft(String(s.harmfulContacts), 9),
  );

  return [
    rule(),
    'RESTRAINT',
    rule(),
    head,
    ...rows,
    '',
    '  WASTED ATT  attempts beyond the original charge on cases never recoverable',
    '  REFUSED     candidate actions the compliance layer rejected',
    '  HARD-DECL   debits refused because the decline could never approve',
    '  NO-CONSENT  messages to a withdrawn-consent customer that had to be blocked',
    '  REACHED     messages that actually got through to them (must be zero)',
    '',
    '  NO-CONSENT is the restraint measure. Nothing bad happened either way, but a',
    '  policy that never proposes it is not relying on the brakes to save it.',
  ].join('\n');
}

export function renderOutcomes(scores: readonly StrategyScore[]): string {
  const head =
    pad('STRATEGY', 12) +
    padLeft('RECOVERED', 11) +
    padLeft('STOPPED', 9) +
    padLeft('ESCALATED', 11) +
    padLeft('HALTED', 8) +
    padLeft('OPEN', 7);

  const rows = scores.map((s) =>
    pad(s.strategy, 12) +
      padLeft(String(s.outcomes.recovered), 11) +
      padLeft(String(s.outcomes.stopped), 9) +
      padLeft(String(s.outcomes.escalated), 11) +
      padLeft(String(s.outcomes.halted), 8) +
      padLeft(String(s.outcomes.unresolved), 7),
  );

  return [rule(), 'OUTCOMES', rule(), head, ...rows].join('\n');
}

/**
 * The diagnosis gap.
 *
 * Oracle-minus-agent is diagnosis error; ceiling-minus-oracle is the limit of the
 * policy itself. Separating them says which of the two to go and fix, and a single
 * combined figure would hide that.
 */
export function renderDiagnosisGap(scores: readonly StrategyScore[]): string | null {
  const oracle = scores.find((s) => s.strategy === 'oracle');
  const baseline = scores.find((s) => s.strategy === 'baseline');
  if (oracle === undefined || baseline === undefined) return null;

  const agents = scores.filter((s) => s.strategy !== 'oracle' && s.strategy !== 'baseline');
  if (agents.length === 0) return null;

  const ceiling = oracle.recoverablePaise;
  const lines = [
    rule(),
    'WHAT EACH LAYER IS WORTH',
    rule(),
    `  ${pad('ceiling — recoverable at all', 36)}${padLeft(inr(ceiling), 12)}`,
    '',
  ];

  // Each rung shows what the layer above it added, so the value of a layer is a
  // number rather than an assertion. A single combined figure would hide which part
  // of the system to go and improve.
  let previous = baseline;
  lines.push(
    `  ${pad("Razorpay's documented default", 36)}${padLeft(inr(baseline.recoveredPaise), 12)}   ${padLeft(pct(baseline.captureOfCeiling), 7)}`,
  );

  for (const agent of agents) {
    const added = agent.recoveredPaise - previous.recoveredPaise;
    lines.push(
      `  ${pad(`+ ${agent.strategy}`, 36)}${padLeft(inr(agent.recoveredPaise), 12)}   ` +
        `${padLeft(pct(agent.captureOfCeiling), 7)}   adds ${inr(added)}`,
    );
    previous = agent;
  }

  const diagnosisGap = oracle.recoveredPaise - previous.recoveredPaise;
  const policyGap = ceiling - oracle.recoveredPaise;

  lines.push(
    `  ${pad('+ perfect diagnosis (oracle)', 36)}${padLeft(inr(oracle.recoveredPaise), 12)}   ` +
      `${padLeft(pct(oracle.captureOfCeiling), 7)}   adds ${inr(diagnosisGap)}`,
    '',
    `  Still lost to diagnosis error:  ${inr(diagnosisGap)}  (${pct(diagnosisGap / ceiling)})`,
    `  Beyond any diagnosis, a policy limit:  ${inr(policyGap)}  (${pct(policyGap / ceiling)})`,
    '',
    '  The two remainders point at different work. Diagnosis error is what a better',
    '  reasoning layer could still win. The policy limit is money no amount of correct',
    '  diagnosis reaches, because the customer was never going to pay in this window.',
  );

  return lines.join('\n');
}

export function renderConfusion(score: StrategyScore): string {
  const c = score.confusion;
  if (c === null) {
    return [
      rule(),
      `DIAGNOSIS — ${score.strategy}`,
      rule(),
      '  Forms no view about causes, so there is nothing to score.',
      "  That is not a gap in the measurement; it is the strategy's defining property.",
    ].join('\n');
  }

  const lines = [
    rule(),
    `DIAGNOSIS — ${score.strategy}`,
    rule(),
    `  correct ${c.correct} of ${c.total}   (${pct(c.total === 0 ? 0 : c.correct / c.total)})` +
      `   abstained on ${c.abstained}`,
    '',
  ];

  const actuals = [...c.counts.keys()].sort();
  for (const actual of actuals) {
    const row = c.counts.get(actual);
    if (row === undefined) continue;

    const entries = [...row.entries()].sort((a, b) => b[1] - a[1]);
    const detail = entries
      .map(([predicted, n]) => {
        const label = predicted === null ? 'ABSTAINED' : predicted;
        const marker = predicted === actual ? '' : '  ✗';
        return `${label}×${n}${marker}`;
      })
      .join(', ');

    lines.push(`  ${pad(actual, 26)} → ${detail}`);
  }

  lines.push('');
  lines.push('  ABSTAINED means no diagnosis was reached, so the case went to a human.');
  lines.push('  That is a deliberate outcome rather than a wrong answer, and it costs');
  lines.push('  recoverable money — which is exactly what the gap above measures.');

  return lines.join('\n');
}

export function renderPersonaBreakdown(score: StrategyScore): string {
  const head =
    pad('PERSONA', 26) +
    padLeft('CASES', 7) +
    padLeft('RECOVERABLE', 13) +
    padLeft('RECOVERED', 12) +
    padLeft('CAPTURE', 9) +
    padLeft('ATT', 6);

  const rows = score.byPersona
    .slice()
    .sort((a, b) => b.recoverablePaise - a.recoverablePaise)
    .map((p) => {
      const capture = p.recoverablePaise === 0 ? '—' : pct(p.recoveredPaise / p.recoverablePaise);
      return (
        pad(p.label, 26) +
        padLeft(String(p.cases), 7) +
        padLeft(inr(p.recoverablePaise), 13) +
        padLeft(inr(p.recoveredPaise), 12) +
        padLeft(capture, 9) +
        padLeft(String(p.attemptsUsed), 6)
      );
    });

  return [rule(), `BY PERSONA — ${score.strategy}`, rule(), head, ...rows].join('\n');
}

export function renderInvariants(violations: readonly string[]): string {
  if (violations.length === 0) {
    return [
      rule(),
      'INVARIANTS',
      rule(),
      '  All passed. No case exceeded the four permitted attempts, no strategy beat the',
      '  achievable ceiling or the oracle, no message reached a withdrawn-consent',
      '  customer, and every case is accounted for.',
    ].join('\n');
  }

  return [
    rule(),
    `INVARIANTS — ${violations.length} VIOLATION(S)`,
    rule(),
    ...violations.map((v) => `  ✗ ${v}`),
    '',
    '  These figures are not trustworthy. A bug here does not crash, it prints a',
    '  believable wrong number, which is why the run refuses to stand behind them.',
  ].join('\n');
}

/** Cause labels, exported so the UI can share them. */
export const CAUSE_LABELS: Readonly<Record<DeclineCause, string>> = {
  INSUFFICIENT_FUNDS: 'Insufficient funds',
  BANK_UNAVAILABLE: 'Bank unavailable',
  LIMIT_EXCEEDED_TEMPORARY: 'Daily limit reached',
  CARD_EXPIRED: 'Card expired',
  INSTRUMENT_BLOCKED: 'Instrument blocked',
  INSTRUMENT_NOT_ENABLED: 'Not enabled online',
  ACCOUNT_MISMATCH: 'Account mismatch',
  VPA_INVALID: 'Invalid UPI handle',
  FRAUD_SUSPECTED: 'Fraud suspected',
  AMOUNT_EXCEEDS_MANDATE: 'Above mandate cap',
  AUTH_REQUIRED_AFA: 'Authentication required',
  MANDATE_REVOKED: 'Mandate revoked',
  MANDATE_PAUSED: 'Mandate paused',
  AMBIGUOUS_BANK_DECLINE: 'Unexplained decline',
};
