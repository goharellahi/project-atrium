import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Standalone output keeps the runtime image small and lets the container run
  // `node server.js` without pnpm present.
  output: 'standalone',
};

export default nextConfig;
