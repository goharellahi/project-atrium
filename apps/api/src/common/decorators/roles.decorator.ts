import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '../../db/schema';

export const ROLES_KEY = 'atrium:roles';

/** Restrict a route to the listed roles. Absent means any authenticated user. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

export const PUBLIC_KEY = 'atrium:public';

/** Opt a route out of authentication entirely. Used by login, register, health. */
export const Public = () => SetMetadata(PUBLIC_KEY, true);
