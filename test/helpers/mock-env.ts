import { createCipheriv, randomBytes } from 'node:crypto';
import { vi } from 'vitest';
import type { Env } from '../../src/env';

const TEST_TOKEN_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function encryptTestSecret(plaintext: string): string {
  const key = Buffer.from(TEST_TOKEN_ENCRYPTION_KEY, 'hex');
  const iv = randomBytes(12);

  const cipher = createCipheriv('aes-256-gcm', key, iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  const authTag = cipher.getAuthTag();

  // Web Crypto AES-GCM represents the encrypted result as
  // ciphertext followed by the authentication tag.
  const encrypted = Buffer.concat([ciphertext, authTag]);

  return JSON.stringify({
    v: 1,
    iv: iv.toString('base64'),
    data: encrypted.toString('base64'),
  });
}

export function createMockKv(init: Record<string, string> = {}) {
  const store = new Map(Object.entries(init));

  const kv = {
    get: vi.fn(async (key: string, _type?: 'json' | 'text') => store.get(key) ?? null),

    put: vi.fn(async (key: string, value: string, _opts?: unknown) => {
      store.set(key, value);
    }),

    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),

    list: vi.fn(async () => ({
      keys: [],
      list_complete: true,
    })),

    getWithMetadata: vi.fn(),

    __store: store,
  };

  return kv;
}

export type MockKv = ReturnType<typeof createMockKv>;

export function createMockEnv(
  tokens: Record<string, string> = {},
  overrides: Partial<Env> = {},
): Env {
  const storedTokens = { ...tokens };

  if (storedTokens.refresh_token) {
    storedTokens.refresh_token = encryptTestSecret(storedTokens.refresh_token);
  }

  return {
    TOKENS: createMockKv(storedTokens) as unknown as KVNamespace,
    CACHE: createMockKv() as unknown as KVNamespace,

    FITBIT_CLIENT_ID: 'test-client-id',
    FITBIT_CLIENT_SECRET: 'test-client-secret',

    GOOGLE_CLIENT_ID: 'test-google-client-id',
    GOOGLE_CLIENT_SECRET: 'test-google-client-secret',

    TOKEN_ENCRYPTION_KEY: TEST_TOKEN_ENCRYPTION_KEY,

    MCP_SHARED_SECRET: 'test-shared-secret',
    ALLOWED_CIDRS: '160.79.104.0/21',

    ...overrides,
  } as Env;
}
