import { assertNonProductionTestMode } from '../../application/test-mode-runtime.js';

export interface RazorpayConnectorStatus {
  readonly mode: 'test' | 'disabled';
  readonly nonProduction: boolean;
  readonly webhookSecretConfigured: boolean;
  readonly databaseConfirmed: boolean;
  readonly durableQueueConfigured: boolean;
  readonly signedWebhookConfigured: boolean;
  readonly mockRunnerConfigured: boolean;
  readonly label: string;
}

type PublicStatusEnvironment = Readonly<Record<string, string | undefined>>;

function hasValue(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

/** Configuration status only; credential values and database health never leave the server. */
export function getRazorpayConnectorStatus(
  environment: PublicStatusEnvironment = process.env,
): RazorpayConnectorStatus {
  let nonProduction = true;
  try {
    assertNonProductionTestMode(environment);
  } catch {
    nonProduction = false;
  }

  const mode =
    nonProduction && environment.RAZORPAY_MODE === 'test' ? 'test' : 'disabled';
  const webhookSecretConfigured = hasValue(environment.RAZORPAY_WEBHOOK_SECRET);
  const databaseConfirmed =
    environment.TEST_MODE_DATABASE === 'confirmed-non-production';
  const durableQueueConfigured = hasValue(environment.DATABASE_URL);
  const signedWebhookConfigured =
    mode === 'test' &&
    webhookSecretConfigured &&
    databaseConfirmed &&
    durableQueueConfigured;
  const mockRunnerConfigured =
    signedWebhookConfigured &&
    environment.TEST_MODE_EXECUTOR === 'mock' &&
    hasValue(environment.CRON_SECRET);

  const label = signedWebhookConfigured
    ? mockRunnerConfigured
      ? 'Durable webhook + mock runner configured'
      : 'Signed webhook configured · shadow only'
    : mode === 'test'
      ? 'Test Mode connector incomplete'
      : 'Signed connector disabled · demo available';

  return {
    mode,
    nonProduction,
    webhookSecretConfigured,
    databaseConfirmed,
    durableQueueConfigured,
    signedWebhookConfigured,
    mockRunnerConfigured,
    label,
  };
}
