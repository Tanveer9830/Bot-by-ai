/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript sources; Next transpiles them directly.
  transpilePackages: ['@bot-by-ai/shared', '@bot-by-ai/database'],
  output: 'standalone',
  poweredByHeader: false,
  // Types are still checked during the build; linting is handled once for the
  // whole monorepo by `npm run lint` (and CI), so Next's internal pass is skipped
  // to keep image builds fast and to avoid a second, weaker rule set.
  eslint: { ignoreDuringBuilds: true },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'geolocation=(), microphone=(), camera=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
