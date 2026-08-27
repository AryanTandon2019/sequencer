import type { ClaimedTestModeAction } from './test-mode-action-queue.js';
import type { ActionKind, Millis } from '../domain/types.js';

export type MockActionOutcomeKind =
  | 'mock_would_retry_payment'
  | 'mock_wake_for_reconsideration'
  | 'mock_would_contact_customer'
  | 'mock_wait_recorded'
  | 'mock_stop_recorded'
  | 'mock_merchant_escalation_created';

export interface MockActionOutcome {
  readonly simulated: true;
  readonly outcome: MockActionOutcomeKind;
  readonly actionKind: ActionKind;
  readonly actionKey: string;
  readonly recordedAt: Millis;
  readonly detail: string;
}

function assertNever(value: never): never {
  throw new Error(`unhandled Test Mode action: ${String(value)}`);
}

/**
 * Record what the selected action would do without importing any provider,
 * messaging client or network adapter. RETRY_SCHEDULED is a wake-up, not a debit.
 */
export async function executeMockTestModeAction(
  claimed: ClaimedTestModeAction,
  now: Millis,
): Promise<MockActionOutcome> {
  if (claimed.mode !== 'test') throw new Error('mock executor refuses non-test actions');

  let outcome: MockActionOutcomeKind;
  let detail: string;
  switch (claimed.action.kind) {
    case 'RETRY_NOW':
      outcome = 'mock_would_retry_payment';
      detail = 'A real Test Mode adapter would request a payment retry now.';
      break;
    case 'RETRY_SCHEDULED':
      outcome = 'mock_wake_for_reconsideration';
      detail = 'The schedule matured; a real worker would refresh context and deliberate again.';
      break;
    case 'REQUEST_CARD_UPDATE':
    case 'REQUEST_MANDATE_REAUTH':
    case 'REQUEST_AFA':
    case 'SEND_PRE_DEBIT_NOTIFICATION':
      outcome = 'mock_would_contact_customer';
      detail = 'A real Test Mode adapter would place this customer action in an outbox.';
      break;
    case 'WAIT':
      outcome = 'mock_wait_recorded';
      detail = 'No external action is appropriate; the wait decision was durably recorded.';
      break;
    case 'STOP':
      outcome = 'mock_stop_recorded';
      detail = 'Recovery was stopped without charging or contacting the customer.';
      break;
    case 'ESCALATE_TO_MERCHANT':
      outcome = 'mock_merchant_escalation_created';
      detail = 'A real merchant workflow would receive a review item.';
      break;
    default:
      return assertNever(claimed.action.kind);
  }

  return {
    simulated: true,
    outcome,
    actionKind: claimed.action.kind,
    actionKey: claimed.actionKey,
    recordedAt: now,
    detail,
  };
}
