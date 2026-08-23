import { Module } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { DB, ENV_TOKEN } from '../app.tokens';
import type { Db } from '../db/client';
import type { Env } from '../config/env';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ENV_TOKEN],
      useFactory: (env: Env) => ({
        secret: env.JWT_SECRET,
        signOptions: { expiresIn: env.JWT_ACCESS_TTL },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    {
      provide: AuthService,
      inject: [DB, JwtService, ENV_TOKEN],
      useFactory: (db: Db, jwt: JwtService, env: Env) =>
        new AuthService(db, jwt, env.JWT_ACCESS_TTL),
    },
  ],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
