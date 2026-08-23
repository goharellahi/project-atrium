import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { z } from 'zod';
import { PUBLIC_KEY } from '../decorators/roles.decorator';
import { setPrincipal, type AuthPrincipal } from '../context/request-context';
import { userRole } from '../../db/schema';

/**
 * The JWT payload, validated rather than cast.
 *
 * A token is attacker-influenced input even when the signature verifies — the
 * signature proves we issued it, not that its shape is still what this version
 * of the code expects. A stale token with a missing venue_id must not
 * degenerate into `undefined` flowing into a tenant filter.
 */
const JwtPayloadSchema = z.object({
  sub: z.string().uuid(),
  role: z.enum(userRole.enumValues),
  venue_id: z.string().uuid().nullable(),
});

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const header = req.header('authorization');
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }

    let raw: unknown;
    try {
      raw = await this.jwt.verifyAsync(header.slice('Bearer '.length));
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const parsed = JwtPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      throw new UnauthorizedException('Malformed token payload');
    }

    const principal: AuthPrincipal = {
      userId: parsed.data.sub,
      role: parsed.data.role,
      venueId: parsed.data.venue_id,
    };

    (req as Request & { principal: AuthPrincipal }).principal = principal;
    setPrincipal(principal);

    return true;
  }
}
