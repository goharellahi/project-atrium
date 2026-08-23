import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginSchema, RegisterSchema, type LoginInput, type RegisterInput } from './auth.schemas';
import { zodBody } from '../common/pipes/zod-validation.pipe';
import { Public } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthPrincipal } from '../common/context/request-context';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body(zodBody(LoginSchema)) body: LoginInput) {
    return this.auth.login(body);
  }

  /** CUSTOMER only. Role and venue are not accepted from the client. */
  @Public()
  @Post('register')
  @HttpCode(201)
  register(@Body(zodBody(RegisterSchema)) body: RegisterInput) {
    return this.auth.register(body);
  }

  @Get('me')
  me(@CurrentUser() principal: AuthPrincipal) {
    return this.auth.me(principal.userId);
  }
}
