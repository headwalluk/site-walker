import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface EncryptedSecret {
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
}

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const NONCE_LENGTH = 12; // 96 bits, GCM-recommended
const AUTH_TAG_LENGTH = 16; // 128 bits, GCM default

function assertKey(key: Buffer, op: string): void {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`${op}: key must be ${KEY_LENGTH} bytes (got ${key.length}).`);
  }
}

/**
 * Encrypt a UTF-8 string with AES-256-GCM, generating a fresh random nonce.
 * Returns the three components needed to decrypt: ciphertext, nonce, authTag.
 * Caller is responsible for persisting all three.
 */
export function encrypt(plaintext: string, key: Buffer): EncryptedSecret {
  assertKey(key, 'encrypt');
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const plaintextBuf = Buffer.from(plaintext, 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, nonce, authTag };
}

/**
 * Decrypt an EncryptedSecret. Throws if the auth tag doesn't verify — that
 * covers wrong key, tampered ciphertext, tampered nonce, and tampered tag.
 * No partial-plaintext leak: GCM only emits the plaintext after `final()`,
 * which only succeeds if the tag is valid.
 */
export function decrypt(secret: EncryptedSecret, key: Buffer): string {
  assertKey(key, 'decrypt');
  if (secret.nonce.length !== NONCE_LENGTH) {
    throw new Error(`decrypt: nonce must be ${NONCE_LENGTH} bytes (got ${secret.nonce.length}).`);
  }
  if (secret.authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error(
      `decrypt: authTag must be ${AUTH_TAG_LENGTH} bytes (got ${secret.authTag.length}).`,
    );
  }
  const decipher = createDecipheriv(ALGORITHM, key, secret.nonce);
  decipher.setAuthTag(secret.authTag);
  const plaintext = Buffer.concat([decipher.update(secret.ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

/**
 * Generate a fresh 32-byte (256-bit) random key suitable for use as the
 * master `SW_ENCRYPTION_KEY`. The CLI helper `sw secrets gen-key` prints
 * the base64 encoding of this for the operator to paste into `.env`.
 */
export function generateMasterKey(): Buffer {
  return randomBytes(KEY_LENGTH);
}
