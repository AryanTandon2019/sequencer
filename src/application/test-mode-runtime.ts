const NON_PRODUCTION_DATABASE_CONFIRMATION = 'confirmed-non-production';

type TestModeEnvironment = Readonly<Record<string, string | undefined>>;

export function assertNonProductionTestMode(
  environment: TestModeEnvironment = process.env,
): void {
  const vercelEnvironment = environment.VERCEL_ENV;
  if (vercelEnvironment !== undefined) {
    if (vercelEnvironment === 'preview' || vercelEnvironment === 'development') return;
    throw new Error(
      'Test Mode execution is forbidden in production or unknown Vercel deployments',
    );
  }
  if (environment.NODE_ENV === 'production') {
    throw new Error('Test Mode execution is forbidden in a production runtime');
  }
}

export function assertNonProductionDatabase(
  environment: TestModeEnvironment = process.env,
): void {
  assertNonProductionTestMode(environment);
  if (environment.TEST_MODE_DATABASE !== NON_PRODUCTION_DATABASE_CONFIRMATION) {
    throw new Error(
      `TEST_MODE_DATABASE must equal ${NON_PRODUCTION_DATABASE_CONFIRMATION}`,
    );
  }
}
