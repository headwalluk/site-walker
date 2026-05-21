/**
 * Boot loader for env-resident master secrets:
 *
 * - `SW_ENCRYPTION_KEY` (M17) — AES-256-GCM master key for chatbot BYO API
 *   keys. Required for the API server to boot; raw 32 bytes, base64-encoded.
 * - `SW_PROVISIONING_KEY` (M19) — bearer token that gates `/admin/accounts/*`
 *   routes. Optional (self-hosters who don't run WC-side provisioning leave
 *   it unset and the gated routes lock down). Format: `sw_<base64url>`.
 *
 * Per the air-gap design in dev-notes/10-saas-shape.md, both secrets live
 * in `.env` (already 0600-gated) and never in the DB. The provisioning key
 * is deliberately not in the `admin_keys` table — a bug in admin-key code
 * can't accidentally mint a provisioning credential.
 */

import { Buffer } from 'node:buffer';

export class EncryptionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionKeyError';
  }
}

export class ProvisioningKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvisioningKeyError';
  }
}

// ---------------------------------------------------------------------------
// SW_ENCRYPTION_KEY (M17)
// ---------------------------------------------------------------------------

const EXPECTED_ENCRYPTION_KEY_BYTES = 32;

let cachedEncryptionKey: Buffer | null = null;

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
  if (cachedEncryptionKey) return cachedEncryptionKey;
  const raw = env.SW_ENCRYPTION_KEY;
  if (raw === undefined || raw === '') {
    throw new EncryptionKeyError(
      'SW_ENCRYPTION_KEY is not set. Generate one with `sw secrets gen-key` ' +
        'and paste it into your .env file.',
    );
  }
  const decoded = Buffer.from(raw, 'base64');
  if (decoded.length !== EXPECTED_ENCRYPTION_KEY_BYTES) {
    throw new EncryptionKeyError(
      `SW_ENCRYPTION_KEY must base64-decode to exactly ${EXPECTED_ENCRYPTION_KEY_BYTES} bytes ` +
        `(decoded length: ${decoded.length}). Regenerate with \`sw secrets gen-key\`.`,
    );
  }
  cachedEncryptionKey = decoded;
  return cachedEncryptionKey;
}

/** Reset the cached encryption key. Test-only. */
export function resetEncryptionKeyCache(): void {
  cachedEncryptionKey = null;
}

// ---------------------------------------------------------------------------
// SW_PROVISIONING_KEY (M19)
// ---------------------------------------------------------------------------

/**
 * Format `sw_<base64url-suffix>` with a minimum suffix length. The gen tool
 * (`sw secrets gen-provisioning-key`) emits a 43-char base64url suffix (32
 * random bytes); the floor here is conservative so a hand-crafted shorter
 * value is rejected rather than silently accepted.
 */
const PROVISIONING_KEY_PATTERN = /^sw_[A-Za-z0-9_-]{32,}$/;

/** Sentinel meaning "we tried to load and the env var was unset." */
const PROVISIONING_KEY_UNSET = Symbol('SW_PROVISIONING_KEY:unset');

let cachedProvisioningKey: string | typeof PROVISIONING_KEY_UNSET | null = null;

/**
 * Load + validate `SW_PROVISIONING_KEY` from the environment.
 *
 * Returns the raw string when set (caller hashes for bearer comparison).
 * Returns `null` when the variable is unset — that's a valid configuration
 * for self-hosters who don't run WC-side provisioning; `/admin/accounts/*`
 * routes lock down to "no caller can satisfy the bearer check."
 *
 * Strict failure modes — each throws {@link ProvisioningKeyError} with the
 * `sw secrets gen-provisioning-key` recovery command in the message:
 *
 * - Variable set to an empty string (likely operator mistake)
 * - Value doesn't match the `sw_<base64url-32+>` shape
 *
 * Successful loads are cached at module scope.
 */
export function loadProvisioningKey(env: NodeJS.ProcessEnv = process.env): string | null {
  if (cachedProvisioningKey !== null) {
    return cachedProvisioningKey === PROVISIONING_KEY_UNSET ? null : cachedProvisioningKey;
  }
  const raw = env.SW_PROVISIONING_KEY;
  if (raw === undefined) {
    cachedProvisioningKey = PROVISIONING_KEY_UNSET;
    return null;
  }
  if (raw === '') {
    throw new ProvisioningKeyError(
      'SW_PROVISIONING_KEY is set to an empty string. Either remove the line from .env ' +
        '(to leave /admin/accounts/* locked) or generate a value with ' +
        '`sw secrets gen-provisioning-key` and paste it in.',
    );
  }
  if (!PROVISIONING_KEY_PATTERN.test(raw)) {
    throw new ProvisioningKeyError(
      'SW_PROVISIONING_KEY does not match the expected shape `sw_<base64url-32+>`. ' +
        'Regenerate with `sw secrets gen-provisioning-key` and paste the output verbatim.',
    );
  }
  cachedProvisioningKey = raw;
  return cachedProvisioningKey;
}

/** Reset the cached provisioning key. Test-only. */
export function resetProvisioningKeyCache(): void {
  cachedProvisioningKey = null;
}
