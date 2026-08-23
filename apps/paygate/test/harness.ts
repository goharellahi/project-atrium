import Fastify, { type FastifyInstance } from 'fastify';
import { buildApp, type PaygateApp } from '../src/app.js';
import type { PaygateConfig } from '../src/config.js';

/** One webhook as the receiver saw it, raw bytes included. */
export interface CapturedWebhook {
  raw: string;
  signature: string | null;
  deliveryId: string | null;
  requestId: string | null;
  body: {
    charge_id: string;
    reference: string;
    event: string;
    amount_minor: number;
    occurred_at: string;
    refund_id?: string;
  };
  receivedAt: number;
}

/**
 * A stand-in for the API's webhook endpoint.
 *
 * It parses the body as a string, not as JSON, so tests verify the signature
 * against the exact bytes Paygate put on the wire. Verifying against a
 * re-serialised object would let a genuine signing bug pass.
 */
export class Receiver {
  readonly received: CapturedWebhook[] = [];
  private server: FastifyInstance | null = null;
  private url_ = '';

  get url(): string {
    return this.url_;
  }

  async start(): Promise<void> {
    const server = Fastify({ logger: false });
    server.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
      done(null, { raw: typeof body === 'string' ? body : body.toString('utf8') });
    });
    server.post('/webhooks/paygate', async (req, reply) => {
      const { raw } = req.body as { raw: string };
      const sig = req.headers['x-paygate-signature'];
      const del = req.headers['x-paygate-delivery'];
      const rid = req.headers['x-request-id'];
      this.received.push({
        raw,
        signature: typeof sig === 'string' ? sig : null,
        deliveryId: typeof del === 'string' ? del : null,
        requestId: typeof rid === 'string' ? rid : null,
        body: JSON.parse(raw) as CapturedWebhook['body'],
        receivedAt: Date.now(),
      });
      return reply.code(200).send({ ok: true });
    });
    await server.listen({ port: 0, host: '127.0.0.1' });
    const addr = server.addresses()[0];
    if (!addr) throw new Error('receiver failed to bind');
    this.url_ = `http://127.0.0.1:${addr.port}/webhooks/paygate`;
    this.server = server;
  }

  async stop(): Promise<void> {
    await this.server?.close();
    this.server = null;
  }

  clear(): void {
    this.received.length = 0;
  }
}

export const SECRET = 'test-paygate-hmac-secret';

export function testConfig(overrides: Partial<PaygateConfig> = {}): PaygateConfig {
  return {
    port: 0,
    secret: SECRET,
    chaos: false,
    seed: 'test-seed',
    callbackUrl: null,
    production: false,
    testEndpointsRequested: true,
    testEndpoints: true,
    declineAmountMinor: 666,
    deliveryTimeoutMs: 5000,
    logLevel: 'silent',
    ...overrides,
  };
}

export interface Harness extends PaygateApp {
  receiver: Receiver;
  stop(): Promise<void>;
  /** Await every delivery already dispatched. */
  settle(): Promise<void>;
}

export async function startHarness(overrides: Partial<PaygateConfig> = {}): Promise<Harness> {
  const receiver = new Receiver();
  await receiver.start();
  const built = buildApp(testConfig({ callbackUrl: receiver.url, ...overrides }));
  return {
    ...built,
    receiver,
    settle: () => built.deliverer.drain(),
    async stop() {
      await built.app.close();
      await receiver.stop();
    },
  };
}
