import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { decrypt, encrypt, generateMasterKey } from './crypto.js';

test('encrypt + decrypt round-trip recovers the original string', () => {
  const key = generateMasterKey();
  const plaintext = 'sk-ant-api03-fake-key-for-testing-purposes-only';
  const secret = encrypt(plaintext, key);
  const recovered = decrypt(secret, key);
  assert.equal(recovered, plaintext);
});

test('encrypt produces a fresh nonce each call (no determinism)', () => {
  const key = generateMasterKey();
  const a = encrypt('same plaintext', key);
  const b = encrypt('same plaintext', key);
  assert.notDeepEqual(a.nonce, b.nonce, 'nonces should differ between calls');
  assert.notDeepEqual(a.ciphertext, b.ciphertext, 'ciphertexts should differ');
});

test('decrypt with wrong key throws (auth tag mismatch)', () => {
  const key = generateMasterKey();
  const wrongKey = generateMasterKey();
  const secret = encrypt('topsecret', key);
  assert.throws(() => decrypt(secret, wrongKey));
});

test('decrypt with tampered ciphertext throws', () => {
  const key = generateMasterKey();
  const secret = encrypt('topsecret', key);
  // Flip a bit in the first byte.
  const tampered = {
    ...secret,
    ciphertext: Buffer.from(secret.ciphertext),
  };
  tampered.ciphertext[0] = tampered.ciphertext[0] ^ 0x01;
  assert.throws(() => decrypt(tampered, key));
});

test('decrypt with tampered nonce throws', () => {
  const key = generateMasterKey();
  const secret = encrypt('topsecret', key);
  const tampered = {
    ...secret,
    nonce: Buffer.from(secret.nonce),
  };
  tampered.nonce[0] = tampered.nonce[0] ^ 0x01;
  assert.throws(() => decrypt(tampered, key));
});

test('decrypt with tampered auth tag throws', () => {
  const key = generateMasterKey();
  const secret = encrypt('topsecret', key);
  const tampered = {
    ...secret,
    authTag: Buffer.from(secret.authTag),
  };
  tampered.authTag[0] = tampered.authTag[0] ^ 0x01;
  assert.throws(() => decrypt(tampered, key));
});

test('encrypt rejects keys that are not 32 bytes', () => {
  const shortKey = randomBytes(16);
  const longKey = randomBytes(64);
  assert.throws(() => encrypt('whatever', shortKey), /must be 32 bytes/);
  assert.throws(() => encrypt('whatever', longKey), /must be 32 bytes/);
});

test('decrypt rejects keys that are not 32 bytes', () => {
  const key = generateMasterKey();
  const secret = encrypt('whatever', key);
  const shortKey = randomBytes(16);
  assert.throws(() => decrypt(secret, shortKey), /must be 32 bytes/);
});

test('decrypt rejects nonces that are not 12 bytes', () => {
  const key = generateMasterKey();
  const secret = encrypt('whatever', key);
  const badNonce = { ...secret, nonce: randomBytes(8) };
  assert.throws(() => decrypt(badNonce, key), /nonce must be 12 bytes/);
});

test('decrypt rejects auth tags that are not 16 bytes', () => {
  const key = generateMasterKey();
  const secret = encrypt('whatever', key);
  const badTag = { ...secret, authTag: randomBytes(8) };
  assert.throws(() => decrypt(badTag, key), /authTag must be 16 bytes/);
});

test('empty string round-trips cleanly', () => {
  const key = generateMasterKey();
  const secret = encrypt('', key);
  assert.equal(decrypt(secret, key), '');
});

test('long string round-trips cleanly', () => {
  const key = generateMasterKey();
  const plaintext = 'x'.repeat(200);
  const secret = encrypt(plaintext, key);
  assert.equal(decrypt(secret, key), plaintext);
});

test('generateMasterKey returns 32 fresh random bytes', () => {
  const a = generateMasterKey();
  const b = generateMasterKey();
  assert.equal(a.length, 32);
  assert.equal(b.length, 32);
  assert.notDeepEqual(a, b, 'consecutive calls should not collide');
});
