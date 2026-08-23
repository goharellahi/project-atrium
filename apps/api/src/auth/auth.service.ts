import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { hash, verify } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { users, type User, type UserRole } from '../db/schema';
import { log } from '../common/logger';
import type { LoginInput, RegisterInput } from './auth.schemas';

/**
 * argon2id parameters.
 *
 * These are the OWASP baseline (19 MiB, 2 iterations, 1 degree of parallelism).
 * Chosen over bcrypt for memory-hardness, and over higher settings because the
 * deployed instance is a 512 MB free-tier box — a 64 MiB-per-hash setting would
 * let a burst of logins exhaust it. That is a real constraint of the target
 * environment, not a shortcut, and it is recorded in DECISIONS.md.
 */
const ARGON2 = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export interface AccessToken {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly jwt: JwtService,
    private readonly accessTtlSeconds: number,
  ) {}

  async register(input: RegisterInput): Promise<AccessToken> {
    const passwordHash = await hash(input.password, ARGON2);

    const email = input.email.toLowerCase();

    try {
      const [created] = await this.db
        .insert(users)
        .values({
          email,
          passwordHash,
          role: 'CUSTOMER',
          venueId: null,
        })
        .returning();

      if (!created) throw new ConflictException('Registration failed');

      log().info({ userId: created.id }, 'user registered');
      return this.issue(created);
    } catch (err: unknown) {
      // 23505 = unique_violation on users.email.
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code: unknown }).code === '23505'
      ) {
        throw new ConflictException('Email already registered');
      }
      throw err;
    }
  }

  async login(input: LoginInput): Promise<AccessToken> {
    const email = input.email.toLowerCase();

    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    // Verify against a decoy hash when the user does not exist, so a missing
    // account and a wrong password take the same time. Without this, response
    // timing enumerates registered email addresses.
    if (!user) {
      await verify(await decoyHash(), input.password).catch(() => false);
      throw new UnauthorizedException('Invalid credentials');
    }

    const ok = await verify(user.passwordHash, input.password).catch(() => false);
    if (!ok) {
      log().warn({ userId: user.id }, 'failed login');
      throw new UnauthorizedException('Invalid credentials');
    }

    log().info({ userId: user.id, role: user.role }, 'login');
    return this.issue(user);
  }

  async me(userId: string): Promise<Omit<User, 'passwordHash'>> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) throw new UnauthorizedException('Invalid credentials');

    const { passwordHash: _omit, ...safe } = user;
    return safe;
  }

  private async issue(user: {
    id: string;
    role: UserRole;
    venueId: string | null;
  }): Promise<AccessToken> {
    const access_token = await this.jwt.signAsync({
      sub: user.id,
      role: user.role,
      // snake_case in the token payload, matching the JwtPayloadSchema in the
      // guard. This is a wire format, not an internal type.
      venue_id: user.venueId,
    });

    return {
      access_token,
      token_type: 'Bearer',
      expires_in: this.accessTtlSeconds,
    };
  }
}

/**
 * A genuine argon2id hash, computed once with the same parameters as real
 * passwords, used only to burn equivalent CPU when the account does not exist.
 *
 * It must be a real hash. A hard-coded fake string would fail to parse and
 * `verify` would reject it immediately, which reintroduces exactly the timing
 * difference this exists to remove.
 */
let decoy: Promise<string> | null = null;
function decoyHash(): Promise<string> {
  decoy ??= hash('atrium-decoy-password-for-timing-equalisation', ARGON2);
  return decoy;
}
