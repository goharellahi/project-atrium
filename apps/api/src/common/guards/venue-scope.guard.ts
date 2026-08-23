import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { setPrincipal, type AuthPrincipal } from '../context/request-context';

/**
 * Attaches the authenticated principal's venue scope to the request context so
 * the repository layer can pick it up without every controller remembering to
 * pass it down.
 *
 * This guard does NOT authorise anything by itself, and that is intentional.
 * Enforcement lives in VenueScopedRepository, one layer lower, because a guard
 * can only see the route — it cannot see the row a handler is about to read.
 * Authorisation that depends on the caller remembering to apply it is
 * authorisation that will eventually be forgotten.
 */
@Injectable()
export class VenueScopeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const principal = (req as Request & { principal?: AuthPrincipal }).principal;
    if (principal) setPrincipal(principal);
    return true;
  }
}
