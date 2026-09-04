import type { ZodType } from 'zod';
import type { Env } from '../../env';
// Reused across providers under Fitbit-era names.
import { FitbitApiError, FitbitRateLimitError } from '../../lib/errors';
import { parseRetryAfter, sleep } from '../../lib/rate-limit';
import { getAccessToken, invalidateAccessToken } from './oauth';

const GOOGLE_API_BASE = 'https://health.googleapis.com';

export type GoogleRequest = {
  /** Absolute path starting with `/`, e.g. `/v4/users/me/profile`. */
  path: string;
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Query parameters appended to the URL. */
  query?: Record<string, string | number | undefined>;
  /** JSON request body for POST/PATCH; sent as `application/json`. */
  json?: unknown;
};

export class GoogleClient {
  constructor(private readonly env: Env) {}

  async requestJson<T>(schema: ZodType<T>, req: GoogleRequest): Promise<T> {
    const body = await this.requestText(req);
    const parsed = schema.safeParse(JSON.parse(body));
    if (!parsed.success) {
      throw new FitbitApiError(
        200,
        `Schema validation failed at ${req.path}: ${parsed.error.message}`,
        req.path,
      );
    }
    return parsed.data;
  }

  async requestText(req: GoogleRequest): Promise<string> {
    const url = new URL(req.path, GOOGLE_API_BASE);
    if (req.query) {
      for (const [k, v] of Object.entries(req.query)) {
        if (v !== undefined && v !== null && v !== '') {
          url.searchParams.set(k, String(v));
        }
      }
    }

    let attempt = 0;
    const MAX_ATTEMPTS = 3; // original + one refresh retry + one rate-limit retry
    while (true) {
      attempt++;
      const token = await getAccessToken(this.env);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      };

      let body: BodyInit | undefined;
      if (req.json !== undefined) {
        body = JSON.stringify(req.json);
        headers['Content-Type'] = 'application/json';
      }

      const t0 = Date.now();
      const res = await fetch(url, { method: req.method ?? 'GET', headers, body });
      const ms = Date.now() - t0;
      const method = req.method ?? 'GET';

      if (res.status === 401 && attempt === 1) {
        console.log(`[google] ${method} ${req.path} → 401 after ${ms}ms, refreshing token`);
        await invalidateAccessToken(this.env);
        continue;
      }

      if (res.status === 429) {
        const waitSec = parseRetryAfter(res.headers.get('Retry-After'));
        if (attempt < MAX_ATTEMPTS) {
          console.log(`[google] ${method} ${req.path} → 429, sleeping ${waitSec}s before retry`);
          await sleep(waitSec * 1000);
          continue;
        }
        throw new FitbitRateLimitError(waitSec, req.path);
      }

      const text = await res.text();

if (!res.ok) {
  console.error(
    `[google] ${method} ${req.path} -> ${res.status} after ${ms}ms`,
  );
  console.error(`[google] response body: ${text}`);

  throw new FitbitApiError(
    res.status,
    `Google Health request failed`,
    req.path,
  );
}

return text;
    }
  }
}
