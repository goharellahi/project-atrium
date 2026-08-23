import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { runWithContext } from './request-context';

/**
 * Establishes the request context for every request.
 *
 * The correlation id is taken from X-Request-Id when nginx or a client supplied
 * one, and generated otherwise. nginx generates one if the client did not, so
 * in the compose stack this is almost always inherited — which is what makes a
 * single booking traceable across replicas, and later into the webhook path.
 */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const header = req.header('x-request-id');
    const correlationId = header && header.length > 0 ? header : randomUUID();

    res.setHeader('x-request-id', correlationId);

    runWithContext({ correlationId, principal: null }, () => next());
  }
}
