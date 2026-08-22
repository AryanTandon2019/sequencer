/**
 * Presentation helpers.
 *
 * Money arrives as integer paise and is only ever converted for display.
 */

export function inr(paise: number): string {
  return `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;
}

export function inrCompact(paise: number): string {
  const rupees = Math.round(paise / 100);
  if (rupees >= 100000) return `₹${(rupees / 100000).toFixed(2)}L`;
  if (rupees >= 1000) return `₹${(rupees / 1000).toFixed(1)}K`;
  return `₹${rupees}`;
}

export function pct(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function days(ms: number): string {
  const d = ms / 86_400_000;
  if (d < 1) return `${Math.round(ms / 3_600_000)}h`;
  return `${d.toFixed(d < 10 ? 1 : 0)}d`;
}

export const CAUSE_LABEL: Readonly<Record<string, string>> = {
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

export const ACTION_LABEL: Readonly<Record<string, string>> = {
  RETRY_NOW: 'Retry now',
  RETRY_SCHEDULED: 'Schedule retry',
  REQUEST_CARD_UPDATE: 'Ask for a new card',
  REQUEST_MANDATE_REAUTH: 'Ask to re-authorise',
  REQUEST_AFA: 'Ask to authenticate',
  SEND_PRE_DEBIT_NOTIFICATION: 'Send 24h notice',
  WAIT: 'Wait',
  STOP: 'Stop',
  ESCALATE_TO_MERCHANT: 'Escalate to a human',
};

export const RECOVERABILITY_LABEL: Readonly<Record<string, string>> = {
  RETRY_VIABLE: 'Retry can work',
  RETRY_FUTILE: 'Retry can never work',
  RETRY_FORBIDDEN: 'Retry is not permitted',
  WAIT: 'Resolves on its own',
  NEEDS_HUMAN: 'Needs a human',
};

export const STRATEGY_LABEL: Readonly<Record<string, string>> = {
  baseline: 'Calendar retry',
  agent: 'Sequencer',
  'agent+llm': 'Sequencer + AI',
  oracle: 'Oracle',
};

export const STRATEGY_PLAIN: Readonly<Record<string, string>> = {
  baseline: 'Retry tomorrow',
  agent: 'Read the reason',
  'agent+llm': '+ AI on the unclear ones',
  oracle: 'If we knew everything',
};

export const STRATEGY_NOTE: Readonly<Record<string, string>> = {
  baseline: "Razorpay's documented retry schedule: next day, one card-change email.",
  agent: 'Diagnoses the cause, then spends attempts only where one can succeed.',
  'agent+llm': 'Adds a model on declines the lookup table cannot classify.',
  oracle: 'Perfect diagnosis. The ceiling — not a competitor.',
};

export const RULE_LABEL: Readonly<Record<string, string>> = {
  NPCI_ATTEMPT_CAP: 'NPCI attempt cap',
  RBI_PRE_DEBIT_NOTIFICATION: 'RBI 24h notice',
  CARD_NETWORK_NO_HARD_DECLINE_RETRY: 'No hard-decline retry',
  NPCI_EXECUTION_WINDOW: 'Autopay window',
  MANDATE_CAP: 'Mandate ceiling',
  AFA_REQUIRED_ABOVE_CEILING: 'AFA required',
  REVOKED_CONSENT_NO_CONTACT: 'Revoked consent',
  CONFIDENCE_FLOOR: 'Confidence floor',
};

export type Tone = 'permitted' | 'refused' | 'waiting' | 'neutral' | 'brand';

export function outcomeTone(outcome: string): Tone {
  switch (outcome) {
    case 'recovered':
      return 'permitted';
    case 'halted':
      return 'refused';
    case 'stopped':
      return 'waiting';
    case 'escalated':
      return 'brand';
    default:
      return 'neutral';
  }
}

export interface CaseDisplayStatus {
  readonly label: string;
  readonly tone: Tone;
}

/** One presentation mapping keeps case outcomes consistent across every screen. */
export function caseStatus(item: {
  readonly recoveredPaise: number;
  readonly recoverable: boolean;
  readonly outcome: string;
}): CaseDisplayStatus {
  if (item.recoveredPaise > 0) return { label: 'Recovered', tone: 'permitted' };
  if (item.outcome === 'escalated') return { label: 'Human review', tone: 'waiting' };
  if (!item.recoverable || item.outcome === 'stopped') {
    return { label: 'Stopped safely', tone: 'brand' };
  }
  if (item.outcome === 'halted') return { label: 'Halted', tone: 'refused' };
  return { label: 'Not recovered', tone: 'refused' };
}

export function recoverabilityTone(recoverability: string): Tone {
  switch (recoverability) {
    case 'RETRY_VIABLE':
      return 'permitted';
    case 'RETRY_FUTILE':
    case 'RETRY_FORBIDDEN':
      return 'refused';
    case 'WAIT':
      return 'waiting';
    default:
      return 'neutral';
  }
}

export const TONE_CLASS: Readonly<Record<Tone, string>> = {
  permitted: 'bg-permitted-wash text-permitted',
  refused: 'bg-refused-wash text-refused',
  waiting: 'bg-waiting-wash text-waiting',
  brand: 'bg-brand-wash text-brand',
  neutral: 'bg-raised text-ink-soft',
};
