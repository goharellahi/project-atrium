import { buildApp } from './app.js';
import { loadConfig } from './config.js';

/**
 * Paygate — the mock payment provider, built to brief §06.
 *
 * Paygate is a separate process with its own port on purpose: the API must
 * reach it over HTTP so the failure modes are real network failures, and so
 * the webhook genuinely arrives back through the load balancer on whichever
 * replica nginx picks — not necessarily the one that submitted the charge.
 * A stubbed in-process function that always resolves would test nothing.
 *
 * See apps/paygate/README.md for the env vars, the chaos flags, how to force a
 * scenario, and a worked signature verification.
 */
const cfg = loadConfig();
const { app } = buildApp(cfg);

async function main(): Promise<void> {
  // Bind :: rather than 0.0.0.0. Docker's DNS hands out AAAA records, so an
  // IPv4-only bind produced intermittent 502s through nginx in P1.
  await app.listen({ port: cfg.port, host: '::' });
  app.log.info(
    {
      port: cfg.port,
      chaos: cfg.chaos ? 'on' : 'off',
      seed: cfg.seed,
      callback_url: cfg.callbackUrl,
      test_endpoints: cfg.testEndpoints ? 'on' : 'off',
    },
    'paygate.started',
  );
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info({ signal }, 'paygate.shutdown');
    void app.close().then(() => process.exit(0));
  });
}

main().catch((err: unknown) => {
  app.log.error({ err }, 'paygate.boot_failed');
  process.exit(1);
});
