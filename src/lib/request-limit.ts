import type { Env } from '../env';

const WINDOW_SEC = 60;
const MAX_REQUESTS_PER_WINDOW = 30;

export async function checkRequestLimit(env: Env, clientIp: string): Promise<boolean> {
  const bucket = Math.floor(Date.now() / 1000 / WINDOW_SEC);
  const key = `rate:${clientIp}:${bucket}`;

  const currentRaw = await env.CACHE.get(key);
  const current = currentRaw ? Number(currentRaw) : 0;

  if (!Number.isFinite(current)) {
    return false;
  }

  if (current >= MAX_REQUESTS_PER_WINDOW) {
    return false;
  }

  await env.CACHE.put(key, String(current + 1), {
    expirationTtl: WINDOW_SEC + 10,
  });

  return true;
}
