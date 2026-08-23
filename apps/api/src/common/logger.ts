import pino from 'pino';
import { getContext } from './context/request-context';

/**
 * Structured JSON logging, one logger for the process.
 *
 * Every line carries the correlation id and the replica id. The replica id is
 * what lets the concurrency proof show that 200 requests really were spread
 * across three replicas rather than served by one.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: {
    service: 'atrium-api',
    replica: process.env.REPLICA_ID ?? 'unknown',
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      'passwordHash',
      '*.password',
      '*.passwordHash',
    ],
    censor: '[redacted]',
  },
});

/**
 * A child logger bound to the current request.
 *
 * Call this per log site rather than caching it — the context is
 * AsyncLocalStorage-scoped, so a cached logger would carry the wrong
 * correlation id into the next request.
 */
export function log() {
  const ctx = getContext();
  if (!ctx) return logger;
  return logger.child({
    correlationId: ctx.correlationId,
    ...(ctx.principal
      ? { userId: ctx.principal.userId, role: ctx.principal.role }
      : {}),
  });
}
