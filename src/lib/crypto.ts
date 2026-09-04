const AES_ALGORITHM = 'AES-GCM';

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be valid hex.');
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function importEncryptionKey(hexKey: string): Promise<CryptoKey> {
  const raw = hexToBytes(hexKey);

  if (raw.length !== 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be exactly 32 bytes (64 hex characters).');
  }

  return crypto.subtle.importKey(
    'raw',
    raw,
    { name: AES_ALGORITHM },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptSecret(
  plaintext: string,
  hexKey: string,
): Promise<string> {
  const key = await importEncryptionKey(hexKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintextBytes = new TextEncoder().encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt(
    {
      name: AES_ALGORITHM,
      iv,
    },
    key,
    plaintextBytes,
  );

  return JSON.stringify({
    v: 1,
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(ciphertext)),
  });
}

export async function decryptSecret(
  payload: string,
  hexKey: string,
): Promise<string> {
  const parsed = JSON.parse(payload) as {
    v?: number;
    iv?: string;
    data?: string;
  };

  if (
    parsed.v !== 1 ||
    typeof parsed.iv !== 'string' ||
    typeof parsed.data !== 'string'
  ) {
    throw new Error('Invalid encrypted secret payload.');
  }

  const key = await importEncryptionKey(hexKey);
  const iv = base64ToBytes(parsed.iv);
  const ciphertext = base64ToBytes(parsed.data);

  const plaintext = await crypto.subtle.decrypt(
    {
      name: AES_ALGORITHM,
      iv,
    },
    key,
    ciphertext,
  );

  return new TextDecoder().decode(plaintext);
}
