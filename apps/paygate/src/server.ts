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
const { app, ledger } = buildApp(cfg);

async function main(): Promise<void> {
  /**
   * Migrations before the port opens, not after.
   *
   * Paygate is a single instance on every target it runs on, so there is no
   * replica race to arrange around — but a charge accepted against tables that
   * do not exist yet is a 500 the caller reads as a chaos branch, which is the
   * worst possible way to fail. The runner takes an advisory lock anyway, so a
   * seed racing a cold start cannot apply the same file twice.
   */
  await ledger.init();
  app.log.info({ store: ledger.kind }, 'paygate.ledger.ready');

  // Bind :: rather than 0.0.0.0. Docker's DNS hands out AAAA records, so an
  // IPv4-only bind produced intermittent 502s through nginx in P1.
  //
  // A host with no IPv6 stack at all cannot bind that and answers EAFNOSUPPORT,
  // which was fatal: the container crash-looped and `docker compose up` never
  // came up. The API carries the same fallback for the same reason — refusing
  // to serve is strictly worse than serving on IPv4, and the diagnosis costs
  // whoever hits it an hour. The default is unchanged; only EAFNOSUPPORT is
  // caught, so a port already in use still fails loudly.
  const host = await listenPreferringDualStack(cfg.port);

  app.log.info(
    {
      port: cfg.port,
      host,
      chaos: cfg.chaos ? 'on' : 'off',
      seed: cfg.seed,
      callback_url: cfg.callbackUrl,
      test_endpoints: cfg.testEndpoints ? 'on' : 'off',
    },
    'paygate.started',
  );
}

async function listenPreferringDualStack(port: number): Promise<string> {
  try {
    await app.listen({ port, host: '::' });
    return '::';
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EAFNOSUPPORT') throw err;
    app.log.warn({ port }, 'no IPv6 on this host — binding 0.0.0.0');
    await app.listen({ port, host: '0.0.0.0' });
    return '0.0.0.0';
  }
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
