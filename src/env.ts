export type Env = {
  TOKENS: KVNamespace;
  CACHE: KVNamespace;
  // Fitbit creds retained while the legacy provider still compiles.
  FITBIT_CLIENT_ID: string;
  FITBIT_CLIENT_SECRET: string;
  // Google Health API v4 OAuth credentials (set via `wrangler secret put`).
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;
  MCP_SHARED_SECRET: string;
  ALLOWED_CIDRS: string;
};
