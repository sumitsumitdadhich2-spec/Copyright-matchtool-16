/** @type {import('next').NextConfig} */
const nextConfig = {
  // Long-lived Node server inside Docker (see Dockerfile) — the standalone
  // output bundles only what the server needs. ffmpeg/ffprobe come from the
  // OS package (apt-get install ffmpeg), see lib/ffmpeg-bin.ts.
  output: 'standalone',
  serverExternalPackages: ['@google/genai', '@aws-sdk/client-s3', '@aws-sdk/lib-storage'],
  outputFileTracingExcludes: {
    '*': ['./data/**', './public/**'],
  },
  // NOTE: the standalone tracer drops some transitive pnpm packages (it copies
  // the symlink `.pnpm/google-auth-library@*/node_modules/gcp-metadata` but
  // not its target), which crashes @google/genai at runtime with
  // "Cannot find module 'gcp-metadata'". `outputFileTracingIncludes` cannot
  // fix this (it copies files, not the sibling symlinks pnpm relies on), so
  // the Dockerfile runs scripts/fix-standalone-symlinks.mjs after `next build`.
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ]
  },
}

export default nextConfig
