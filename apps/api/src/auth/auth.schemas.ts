import { z } from 'zod';

export const LoginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(1024),
});
export type LoginInput = z.infer<typeof LoginSchema>;

/**
 * Self-registration creates a CUSTOMER and nothing else.
 *
 * There is deliberately no `role` or `venue_id` field. Accepting either would
 * let anyone mint a VENUE_ADMIN for an arbitrary venue, which is INV-6 handed
 * away at the front door. Staff accounts are created by a VENUE_ADMIN through
 * the venue console (P6), and the platform admin is seeded.
 */
export const RegisterSchema = z.object({
  email: z.string().email().max(320),
  password: z
    .string()
    .min(12, 'Password must be at least 12 characters')
    .max(1024),
});
export type RegisterInput = z.infer<typeof RegisterSchema>;
