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
    const inherited = Boolean(header && header.length > 0);
    const correlationId = inherited ? header! : randomUUID();

    res.setHeader('x-request-id', correlationId);

    // Which replica served this request.
    //
    // The concurrency proof needs to show that 200 requests really were spread
    // across three replicas — a proof served entirely by one process proves
    // nothing about a strategy whose whole claim is that it survives N of them.
    // nginx's own `X-Upstream` header carries an IP, which changes on every
    // `compose up`; this carries the name the compose file assigns, so the
    // assertion reads as `api1/api2/api3` rather than as three addresses that
    // have to be mapped back by hand.
    res.setHeader('x-replica-id', process.env.REPLICA_ID ?? 'unknown');

    runWithContext(
      { correlationId, inheritedCorrelationId: inherited, principal: null },
      () => next(),
    );
  }
}
