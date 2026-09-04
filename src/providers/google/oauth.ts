import { decryptSecret, encryptSecret } from '../../lib/crypto';
import { z } from 'zod';
import type { Env } from '../../env';
// Reused across providers under a Fitbit-era name.
import { FitbitAuthError } from '../../lib/errors';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Google's token response differs from Fitbit's: no `user_id`, and on a
// refresh grant `refresh_token` is frequently ABSENT (the original stays
// valid).
const TokenResponse = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
  refresh_token: z.string().optional(),
});
type TokenResponseT = z.infer<typeof TokenResponse>;

const REFRESH_SKEW_SEC = 60;

export type TokenBundle = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix seconds
};

async function readStoredTokens(env: Env): Promise<TokenBundle> {
  const [accessToken, encryptedRefreshToken, expiresAtRaw] = await Promise.all([
  env.TOKENS.get('access_token'),
  env.TOKENS.get('refresh_token'),
  env.TOKENS.get('expires_at'),
]);

if (!encryptedRefreshToken || !expiresAtRaw) {
    throw new FitbitAuthError(
      'Google tokens not found in TOKENS KV. Run `pnpm run setup:google` on a developer machine and populate the namespace.',
    );
  }

  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt)) {
    throw new FitbitAuthError(`expires_at in KV is not numeric: ${expiresAtRaw}`);
  }

  const refreshToken = await decryptSecret(
    encryptedRefreshToken,
    env.TOKEN_ENCRYPTION_KEY,
  );

  return {
    accessToken: accessToken ?? '',
    refreshToken,
    expiresAt,
  };
}

async function persistTokens(
  env: Env,
  tokens: TokenResponseT,
  issuedAtSec: number,
  fallbackRefreshToken: string,
): Promise<TokenBundle> {
  const expiresAt = issuedAtSec + tokens.expires_in;
  // Keep the stored refresh_token when Google omits one on refresh.
  const refreshToken = tokens.refresh_token ?? fallbackRefreshToken;

  const encryptedRefreshToken = await encryptSecret(
    refreshToken,
    env.TOKEN_ENCRYPTION_KEY,
  );

  const accessTokenTtl = Math.max(60, tokens.expires_in);

  await Promise.all([
    env.TOKENS.put('access_token', tokens.access_token, {
      expirationTtl: accessTokenTtl,
    }),
    env.TOKENS.put('refresh_token', encryptedRefreshToken),
    env.TOKENS.put('expires_at', String(expiresAt)),
  ]);
  return { accessToken: tokens.access_token, refreshToken, expiresAt };
}

export async function refreshTokens(env: Env, refreshToken: string): Promise<TokenBundle> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new FitbitAuthError(
      'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set. Run `wrangler secret put ...`.',
    );
  }

  // Google wants the client credentials in the form body, NOT a Basic header.
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new FitbitAuthError(
    `Token refresh failed: HTTP ${res.status} ${res.statusText}`,
    );
  }

  let parsed: TokenResponseT;
  try {
    parsed = TokenResponse.parse(JSON.parse(text));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new FitbitAuthError(
    `Token refresh returned unexpected payload (${reason})`,
    );
  }

  const issuedAtSec = Math.floor(Date.now() / 1000);
  return persistTokens(env, parsed, issuedAtSec, refreshToken);
}

/**
 * Returns a currently-valid access token, refreshing it when within
 * REFRESH_SKEW_SEC of expiry. Safe to call on every Google Health request.
 */
export async function getAccessToken(env: Env): Promise<string> {
  const current = await readStoredTokens(env);
  const now = Math.floor(Date.now() / 1000);
  if (current.expiresAt - REFRESH_SKEW_SEC > now) {
    return current.accessToken;
  }
  const refreshed = await refreshTokens(env, current.refreshToken);
  return refreshed.accessToken;
}

/** Force the next `getAccessToken()` to refresh. Used after an unexpected 401. */
export async function invalidateAccessToken(env: Env): Promise<void> {
  await env.TOKENS.put('expires_at', '0');
}
