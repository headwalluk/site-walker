/**
 * Boot loader for env-resident master secrets. Today: `SW_ENCRYPTION_KEY`
 * (M17, master key for AES-256-GCM-encrypted chatbot BYO API keys). M19
 * will add `SW_PROVISIONING_KEY` alongside.
 *
 * Per the air-gap design in dev-notes/10-saas-shape.md, these live in `.env`
 * (already 0600-gated) and never in the DB.
 */

import { Buffer } from 'node:buffer';

export class EncryptionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionKeyError';
  }
}

const EXPECTED_DECODED_BYTES = 32;

let cachedKey: Buffer | null = null;

/**
 * Load + validate `SW_ENCRYPTION_KEY` from the environment.
 *
 * Strict failure modes (per the fail-loud convention) — each throws
 * {@link EncryptionKeyError} with a message naming the variable and the
 * `sw secrets gen-key` recovery command:
 *
 * - Variable unset or empty string
 * - Base64-decodes to anything other than exactly 32 bytes
 *
 * Successful loads are cached at module scope. Tests that mutate
 * `process.env` between cases reset via {@link resetEncryptionKeyCache}.
 */
export function loadEncryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  if (cachedKey) return cachedKey;
  const raw = env.SW_ENCRYPTION_KEY;
  if (raw === undefined || raw === '') {
    throw new EncryptionKeyError(
      'SW_ENCRYPTION_KEY is not set. Generate one with `sw secrets gen-key` ' +
        'and paste it into your .env file.',
    );
  }
  const decoded = Buffer.from(raw, 'base64');
  if (decoded.length !== EXPECTED_DECODED_BYTES) {
    throw new EncryptionKeyError(
      `SW_ENCRYPTION_KEY must base64-decode to exactly ${EXPECTED_DECODED_BYTES} bytes ` +
        `(decoded length: ${decoded.length}). Regenerate with \`sw secrets gen-key\`.`,
    );
  }
  cachedKey = decoded;
  return cachedKey;
}

/** Reset the cached key. Test-only. */
export function resetEncryptionKeyCache(): void {
  cachedKey = null;
}
