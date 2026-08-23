import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { AuthPrincipal } from '../context/request-context';
import type { UserRole } from '../../db/schema';

/**
 * Coarse role check. This answers "may this KIND of user call this route",
 * never "may this user see this ROW" — that is VenueScopedRepository's job,
 * and conflating the two is how tenant isolation bugs get written.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const principal = (req as Request & { principal?: AuthPrincipal }).principal;

    if (!principal || !required.includes(principal.role)) {
      throw new ForbiddenException('Insufficient role');
    }
    return true;
  }
}
