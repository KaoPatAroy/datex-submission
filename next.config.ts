import type { NextConfig } from 'next';
const config: NextConfig = {
  serverExternalPackages: ['better-sqlite3'], poweredByHeader: false, devIndicators:false,
  outputFileTracingExcludes:{'/*':['./.env*','./.local/**','./Competition Booklet _ Engineering Track.pdf','./BIZTANIA_AI_CONCIERGE_CONTEXT.md','./AI_RUNTIME_9ARM.md','./CODEX_START_PROMPT.md']}
};
export default config;
