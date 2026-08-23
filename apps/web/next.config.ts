import type { NextConfig } from 'next';

/**
 * `output: 'standalone'` exists for the Docker image: it emits a self-contained
 * server bundle so the runtime stage can `node server.js` with no pnpm and no
 * node_modules copy.
 *
 * Vercel does its own packaging and does not want that bundle — leaving it on
 * there produces a build whose output layout Vercel has to work around. VERCEL
 * is set in their build environment, so the flag is scoped to the target that
 * actually needs it.
 */
const nextConfig: NextConfig = {
  ...(process.env.VERCEL ? {} : { output: 'standalone' as const }),
};

export default nextConfig;
