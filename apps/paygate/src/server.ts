import Fastify from 'fastify';

/**
 * Paygate scaffold.
 *
 * Only the health route exists today. The charge, refund and webhook-delivery
 * machinery — and the six chaos behaviours from brief §06 (duplicate delivery,
 * race on response, transient 500s, delayed delivery, out-of-order, bad
 * signature) — are built in P5. See PLAN.md.
 *
 * Paygate is intentionally a separate service with its own process: the API
 * must talk to it over HTTP so the failure modes are real network failures,
 * not a stubbed function that always resolves.
 */
const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
});

app.get('/health', async () => ({
  status: 'ok',
  service: 'paygate',
  chaos: process.env.PAYGATE_CHAOS ?? 'off',
}));

const port = Number(process.env.PAYGATE_PORT ?? 9000);
app.listen({ port, host: '0.0.0.0' }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
