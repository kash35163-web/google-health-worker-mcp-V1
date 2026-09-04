#!/usr/bin/env tsx
/**
 * One-shot Google Health API v4 OAuth bootstrap CLI.
 *
 *   export GOOGLE_CLIENT_ID=...
 *   export GOOGLE_CLIENT_SECRET=...
 *   pnpm run setup:google
 *
 * Starts a tiny localhost callback server, walks the user through the
 * Authorization Code flow in their system browser, exchanges the code for
 * tokens, and prints the exact `wrangler` commands to move those tokens
 * into Workers KV / Secrets.
 *
 * Google differences vs the Fitbit bootstrap:
 *   - endpoints: accounts.google.com / oauth2.googleapis.com
 *   - client credentials go in the token-exchange BODY (no Basic header)
 *   - NO `include_granted_scopes` (mixing legacy scopes → 403 on data reads)
 *   - `access_type=offline` + `prompt=consent` to force a refresh_token
 *   - the token response has no `user_id`
 *
 * Prerequisite (Google Cloud Console → Google Auth Platform):
 *   - App published "In production" (Testing-mode refresh tokens die in 7d)
 *   - Data Access page must declare EVERY scope in SCOPES below, else the
 *     authorize step fails with invalid_scope.
 *   - OAuth client (Web application) redirect URI must equal REDIRECT_URI.
 */

import { exec } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { z } from 'zod';
import { encryptSecret } from '../src/lib/crypto';

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALLBACK_HOST = '127.0.0.1';
const CALLBACK_PORT = 8787;
const CALLBACK_PATH = '/oauth/callback';
const REDIRECT_URI = `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`;

// The read scopes for this edition. Every scope here must also be declared
// on the consent screen's Data Access page.
const SCOPE_PREFIX = 'https://www.googleapis.com/auth/';
const SCOPES = [
  'googlehealth.profile.readonly',
  'googlehealth.settings.readonly',
  'googlehealth.activity_and_fitness.readonly',
  'googlehealth.health_metrics_and_measurements.readonly',
  'googlehealth.sleep.readonly',
  'googlehealth.nutrition.readonly',
].map((s) => SCOPE_PREFIX + s);

const TokenResponse = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
  refresh_token: z.string().optional(),
});
type TokenResponseT = z.infer<typeof TokenResponse>;

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function mask(value: string): string {
  if (value.length <= 12) return '***';
  return `${value.slice(0, 6)}…${value.slice(-4)} (${value.length} chars)`;
}

function openInBrowser(url: string): void {
  const platform = process.platform;
  const cmd =
    platform === 'darwin'
      ? `open '${url}'`
      : platform === 'win32'
        ? `start "" "${url}"`
        : `xdg-open '${url}'`;
  exec(cmd, () => {
    // best effort; user can copy the URL from stdout
  });
}

function waitForCallback(opts: { expectedState: string }): Promise<{ code: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }

      const error = url.searchParams.get('error');
      if (error) {
        const desc = url.searchParams.get('error_description') ?? '';
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h1>Google authorization error</h1><pre>${error}\n${desc}</pre>`);
        server.close();
        reject(new Error(`Google OAuth error: ${error} ${desc}`));
        return;
      }

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing code');
        return;
      }
      if (state !== opts.expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('State mismatch');
        server.close();
        reject(new Error('State mismatch — possible CSRF'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Authorized</title>
<style>body{font-family:system-ui;max-width:480px;margin:80px auto;padding:0 24px}</style></head>
<body>
<h1>✓ Authorized</h1>
<p>You can close this tab and return to the terminal.</p>
</body>
</html>`);
      server.close();
      resolve({ code });
    });

    server.on('error', reject);
    server.listen(CALLBACK_PORT, CALLBACK_HOST);
  });
}

async function exchangeCode(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
}): Promise<TokenResponseT> {
  // Google: credentials in the body, no Basic header, no PKCE verifier.
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: REDIRECT_URI,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${res.statusText}\n${text}`);
  }
  return TokenResponse.parse(JSON.parse(text));
}

async function main(): Promise<void> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const tokenEncryptionKey = process.env.TOKEN_ENCRYPTION_KEY;
  if (!clientId || !clientSecret || !tokenEncryptionKey) {
    console.error(
      'Error: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and TOKEN_ENCRYPTION_KEY must be set.',
    );
    console.error('');
    console.error('  1. Create an OAuth client (Web application) in Google Cloud Console.');
    console.error(`     Authorized redirect URI: ${REDIRECT_URI}`);
    console.error('  2. Export the values:');
    console.error('     export GOOGLE_CLIENT_ID=...');
    console.error('     export GOOGLE_CLIENT_SECRET=...');
    console.error('     export TOKEN_ENCRYPTION_KEY=...');
    console.error('  3. Run again: pnpm run setup:google');
    process.exit(1);
  }

  const state = base64url(randomBytes(16));

  const authUrl = new URL(GOOGLE_AUTHORIZE_URL);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('scope', SCOPES.join(' '));
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('state', state);
  // NOTE: intentionally NO include_granted_scopes — mixing legacy scopes
  // causes 403 on v4 data reads.

  console.log('');
  console.log('Google Health API OAuth bootstrap');
  console.log('─────────────────────────────────');
  console.log('');
  console.log('Redirect URI (must match the OAuth client settings):');
  console.log(`  ${REDIRECT_URI}`);
  console.log('');
  console.log('Requesting scopes:');
  for (const s of SCOPES) console.log(`  ${s}`);
  console.log('');
  console.log('Opening the authorization URL in your default browser…');
  console.log('(If it does not open automatically, copy-paste this URL:)');
  console.log('');
  console.log(`  ${authUrl.toString()}`);
  console.log('');
  console.log(`Waiting for callback on ${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH} …`);
  console.log('');

  openInBrowser(authUrl.toString());

  const { code } = await waitForCallback({ expectedState: state });
  const tokens = await exchangeCode({ clientId, clientSecret, code });

  if (!tokens.refresh_token) {
    console.warn('⚠️  No refresh_token in the response. Ensure the app is "In production" and');
    console.warn('    the request used access_type=offline + prompt=consent. Aborting.');
    process.exit(1);
  }

  const encryptedRefreshToken = await encryptSecret(tokens.refresh_token, tokenEncryptionKey);

  console.log('✓ Got tokens');
  console.log('');
  console.log(`  scope:         ${tokens.scope ?? '(not returned)'}`);
  console.log(`  token_type:    ${tokens.token_type ?? 'Bearer'}`);
  console.log(`  access_token:  ${mask(tokens.access_token)}`);
  console.log(`  refresh_token: ${mask(tokens.refresh_token)}`);
  console.log(`  expires_in:    ${tokens.expires_in}s`);
  console.log('');
  console.log('Next: store these on Cloudflare Workers.');
  console.log('──────────────────────────────────────────');
  console.log('(wrangler v4 kv syntax; add --remote to target the deployed namespace)');
  console.log('');
  console.log('1) One-time KV namespace creation (if not yet done):');
  console.log('   pnpm wrangler kv namespace create TOKENS');
  console.log('   pnpm wrangler kv namespace create CACHE');
  console.log('   # paste returned ids into wrangler.toml (from wrangler.toml.example)');
  console.log('');
  console.log('2) Secrets:');
  console.log('   pnpm wrangler secret put GOOGLE_CLIENT_ID');
  console.log(`     ↳ value: ${clientId}`);
  console.log('   pnpm wrangler secret put GOOGLE_CLIENT_SECRET');
  console.log('     ↳ value: <your Google OAuth client secret>');
  console.log('   pnpm wrangler secret put TOKEN_ENCRYPTION_KEY');
  console.log('     ↳ value: <the same TOKEN_ENCRYPTION_KEY used for this setup>');
  console.log('   pnpm wrangler secret put MCP_SHARED_SECRET');
  // hex, not base64 — this secret is embedded in the /mcp/:secret URL path,
  // where base64's `/` and `+` would break routing.
  console.log('     ↳ value: $(openssl rand -hex 32)');
  console.log('');
  console.log('3) Google refresh token into the TOKENS KV namespace:');
  console.log(
    `   pnpm wrangler kv key put --binding=TOKENS --remote refresh_token '${encryptedRefreshToken}'`,
  );
  console.log(`   pnpm wrangler kv key put --binding=TOKENS --remote expires_at '0'`);
  console.log('');
  console.log('4) Deploy: pnpm deploy');
  console.log('');
}

main().catch((err) => {
  console.error('Setup failed:', err);
  process.exit(1);
});
