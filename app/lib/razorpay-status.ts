export interface RazorpayConnectorStatus {
  readonly mode: 'test' | 'disabled';
  readonly apiCredentialsConfigured: boolean;
  readonly webhookSecretConfigured: boolean;
  readonly readyForSignedEvents: boolean;
  readonly label: string;
}

/** Public-safe status only. Credential values never leave the server environment. */
export function getRazorpayConnectorStatus(): RazorpayConnectorStatus {
  const mode = process.env.RAZORPAY_MODE === 'test' ? 'test' : 'disabled';
  const apiCredentialsConfigured = Boolean(
    process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET,
  );
  const webhookSecretConfigured = Boolean(process.env.RAZORPAY_WEBHOOK_SECRET);
  const readyForSignedEvents =
    mode === 'test' && apiCredentialsConfigured && webhookSecretConfigured;

  const label = readyForSignedEvents
    ? 'Signed webhook ready · shadow only'
    : mode === 'test' && apiCredentialsConfigured
      ? 'API keys ready · webhook setup next'
      : 'Connector not configured';

  return {
    mode,
    apiCredentialsConfigured,
    webhookSecretConfigured,
    readyForSignedEvents,
    label,
  };
}
