import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FitbitAuthError } from '../../../src/lib/errors';
import {
  getAccessToken,
  invalidateAccessToken,
  refreshTokens,
} from '../../../src/providers/google/oauth';
import { createMockEnv } from '../../helpers/mock-env';

// Google token responses differ from Fitbit's: creds go in the FORM BODY
// (not a Basic header), there is no `user_id`, and a refresh response MAY
// omit `refresh_token` — in which case we must keep the stored one.

describe('getAccessToken (google)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns the current access_token when not near expiry', async () => {
    const env = createMockEnv({
      access_token: 'current-token',
      refresh_token: 'refresh-xyz',
      expires_at: String(Math.floor(Date.now() / 1000) + 600),
    });
    expect(await getAccessToken(env)).toBe('current-token');
  });

  it('refreshes when the access_token is within the 60s skew window', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: 'new-token',
            refresh_token: 'new-refresh',
            expires_in: 3599,
            scope: 'https://www.googleapis.com/auth/googlehealth.profile.readonly',
            token_type: 'Bearer',
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const env = createMockEnv({
      access_token: 'stale',
      refresh_token: 'refresh-xyz',
      expires_at: String(Math.floor(Date.now() / 1000) + 30), // inside 60s skew
    });
    expect(await getAccessToken(env)).toBe('new-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await env.TOKENS.get('access_token')).toBe('new-token');
  });

  it('throws FitbitAuthError when tokens are missing', async () => {
    await expect(getAccessToken(createMockEnv())).rejects.toBeInstanceOf(FitbitAuthError);
  });

  it('throws FitbitAuthError when expires_at is not numeric', async () => {
    const env = createMockEnv({ access_token: 'a', refresh_token: 'r', expires_at: 'garbage' });
    await expect(getAccessToken(env)).rejects.toBeInstanceOf(FitbitAuthError);
  });
});

describe('refreshTokens (google)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends client creds in the form body (not a Basic header) to the Google token endpoint', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL, _init: RequestInit) =>
        new Response(
          JSON.stringify({
            access_token: 'a2',
            refresh_token: 'r2',
            expires_in: 3599,
            scope: '',
            token_type: 'Bearer',
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const env = createMockEnv();
    await refreshTokens(env, 'rt');

    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error('fetch was not called');
    const [url, init] = call;
    expect(String(url)).toBe('https://oauth2.googleapis.com/token');
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBeUndefined(); // Google: NO Basic auth
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const body = init.body as URLSearchParams;
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('rt');
    expect(body.get('client_id')).toBe('test-google-client-id');
    expect(body.get('client_secret')).toBe('test-google-client-secret');
  });

  it('persists the new bundle with expires_at = now + expires_in', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: 'a2',
            refresh_token: 'r2',
            expires_in: 3599,
            scope: '',
            token_type: 'Bearer',
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const env = createMockEnv();
    const result = await refreshTokens(env, 'old-refresh');
    const nowSec = Math.floor(Date.now() / 1000);

    expect(result.accessToken).toBe('a2');
    expect(result.refreshToken).toBe('r2');
    expect(result.expiresAt).toBe(nowSec + 3599);
    expect(await env.TOKENS.get('access_token')).toBe('a2');
    expect(await env.TOKENS.get('refresh_token')).not.toBe('r2');
    expect(await env.TOKENS.get('expires_at')).toBe(String(nowSec + 3599));
  });

  it('reuses the stored refresh_token when the refresh response omits one', async () => {
    // Google frequently omits refresh_token on refresh — must keep the old one.
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: 'rotated-access',
            expires_in: 3599,
            scope: '',
            token_type: 'Bearer',
            // no refresh_token
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const env = createMockEnv({
      access_token: 'old-access',
      refresh_token: 'keep-me',
      expires_at: '0',
    });
    const result = await refreshTokens(env, 'keep-me');

    expect(result.accessToken).toBe('rotated-access');
    expect(result.refreshToken).toBe('keep-me');
    expect(await env.TOKENS.get('refresh_token')).not.toBe('keep-me');
  });

  it('throws FitbitAuthError with the response body on HTTP 4xx/5xx', async () => {
    const fetchMock = vi.fn(
      async () => new Response('invalid_grant', { status: 400, statusText: 'Bad Request' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(refreshTokens(createMockEnv(), 'rt')).rejects.toThrow(
      /Token refresh failed: HTTP 400 Bad Request/,
    );
  });

  it('throws FitbitAuthError when client id / secret are absent', async () => {
    const env = createMockEnv({}, { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' });
    await expect(refreshTokens(env, 'rt')).rejects.toBeInstanceOf(FitbitAuthError);
  });
});

describe('invalidateAccessToken (google)', () => {
  it('writes expires_at=0 so the next getAccessToken is forced to refresh', async () => {
    const env = createMockEnv({ access_token: 'a', refresh_token: 'r', expires_at: '9999999999' });
    await invalidateAccessToken(env);
    expect(await env.TOKENS.get('expires_at')).toBe('0');
  });
});
