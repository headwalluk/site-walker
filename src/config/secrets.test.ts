import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EncryptionKeyError, loadEncryptionKey, resetEncryptionKeyCache } from './secrets.js';
import { generateMasterKey } from '../utils/crypto.js';

function freshEnv(value?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (value !== undefined) env.SW_ENCRYPTION_KEY = value;
  return env;
}

test('loadEncryptionKey: returns the decoded 32-byte buffer on a valid env', (t) => {
  t.after(() => resetEncryptionKeyCache());
  const original = generateMasterKey();
  const env = freshEnv(original.toString('base64'));
  const loaded = loadEncryptionKey(env);
  assert.equal(loaded.length, 32);
  assert.deepEqual(loaded, original);
});

test('loadEncryptionKey: caches across calls (second call ignores env changes)', (t) => {
  t.after(() => resetEncryptionKeyCache());
  const first = generateMasterKey();
  const second = generateMasterKey();
  const env = freshEnv(first.toString('base64'));
  const a = loadEncryptionKey(env);
  // Mutate env; loader should still return the cached buffer.
  env.SW_ENCRYPTION_KEY = second.toString('base64');
  const b = loadEncryptionKey(env);
  assert.deepEqual(a, b);
  assert.deepEqual(a, first);
});

test('loadEncryptionKey: resetEncryptionKeyCache forgets the cached value', (t) => {
  t.after(() => resetEncryptionKeyCache());
  const first = generateMasterKey();
  const second = generateMasterKey();
  loadEncryptionKey(freshEnv(first.toString('base64')));
  resetEncryptionKeyCache();
  const loaded = loadEncryptionKey(freshEnv(second.toString('base64')));
  assert.deepEqual(loaded, second);
});

test('loadEncryptionKey: throws EncryptionKeyError when SW_ENCRYPTION_KEY is unset', (t) => {
  t.after(() => resetEncryptionKeyCache());
  assert.throws(
    () => loadEncryptionKey(freshEnv()),
    (err) => {
      return (
        err instanceof EncryptionKeyError &&
        /SW_ENCRYPTION_KEY is not set/.test(err.message) &&
        /sw secrets gen-key/.test(err.message)
      );
    },
  );
});

test('loadEncryptionKey: throws when SW_ENCRYPTION_KEY is the empty string', (t) => {
  t.after(() => resetEncryptionKeyCache());
  assert.throws(
    () => loadEncryptionKey(freshEnv('')),
    (err) => err instanceof EncryptionKeyError && /not set/.test(err.message),
  );
});

test('loadEncryptionKey: throws when the decoded length is wrong (16-byte key)', (t) => {
  t.after(() => resetEncryptionKeyCache());
  const tooShort = Buffer.alloc(16, 0).toString('base64');
  assert.throws(
    () => loadEncryptionKey(freshEnv(tooShort)),
    (err) => {
      return (
        err instanceof EncryptionKeyError &&
        /must base64-decode to exactly 32 bytes/.test(err.message) &&
        /decoded length: 16/.test(err.message) &&
        /gen-key/.test(err.message)
      );
    },
  );
});

test('loadEncryptionKey: throws when the decoded length is wrong (64-byte key)', (t) => {
  t.after(() => resetEncryptionKeyCache());
  const tooLong = Buffer.alloc(64, 0).toString('base64');
  assert.throws(
    () => loadEncryptionKey(freshEnv(tooLong)),
    (err) => err instanceof EncryptionKeyError && /decoded length: 64/.test(err.message),
  );
});

test('loadEncryptionKey: throws when the value is not valid base64 (silently decodes short)', (t) => {
  t.after(() => resetEncryptionKeyCache());
  // 'not-base64' decodes to a 5-byte buffer with Buffer.from('base64'); the
  // length check catches it.
  assert.throws(
    () => loadEncryptionKey(freshEnv('not-base64-but-also-clearly-too-short')),
    (err) => err instanceof EncryptionKeyError && /must base64-decode/.test(err.message),
  );
});
