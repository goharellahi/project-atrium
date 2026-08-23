import type { Config } from 'drizzle-kit';

// Schema lives in apps/api/src/db by design — there is no separate db package.
// See ARCHITECTURE.md, "Assumptions".
export default {
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
} satisfies Config;
