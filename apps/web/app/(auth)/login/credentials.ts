/**
 * The seeded accounts, as `apps/api/src/db/seed.ts` creates them.
 *
 * On the login screen rather than in the README, deliberately: a reviewer with
 * five minutes should not have to open a second document to get past the first
 * page. The shared password is `SEED_PASSWORD` in the seed — every seeded
 * account uses it, which is safe precisely because these accounts only exist in
 * a seeded database.
 *
 * The two VENUE_ADMINs are at different venues on purpose. That is the pair
 * INV-6 is proven against, and it is the pair a reviewer needs in order to try
 * the cross-tenant probe by hand.
 */
export const SEED_PASSWORD = 'AtriumDemo123!';

export interface SeedLogin {
  role: string;
  email: string;
  scope: string;
}

export const SEED_LOGINS: SeedLogin[] = [
  { role: 'PLATFORM_ADMIN', email: 'admin@atrium.test', scope: 'All venues' },
  { role: 'VENUE_ADMIN', email: 'admin.a@atrium.test', scope: 'Venue A' },
  { role: 'VENUE_ADMIN', email: 'admin.b@atrium.test', scope: 'Venue B' },
  { role: 'VENUE_STAFF', email: 'staff.a@atrium.test', scope: 'Venue A' },
  { role: 'CUSTOMER', email: 'customer@atrium.test', scope: 'Own bookings' },
];
