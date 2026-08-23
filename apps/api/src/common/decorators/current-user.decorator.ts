import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthPrincipal } from '../context/request-context';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthPrincipal => {
    const req = ctx.switchToHttp().getRequest<{ principal: AuthPrincipal }>();
    return req.principal;
  },
);
