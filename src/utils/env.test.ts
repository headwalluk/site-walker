import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertEnvFilePermissions } from './env.js';

async function makeTempEnv(mode: number): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sw-env-'));
  const file = path.join(dir, '.env');
  await writeFile(file, 'DB_PASSWORD=hunter2\n', 'utf8');
  await chmod(file, mode);
  return { dir, file };
}

test('assertEnvFilePermissions: no-op when file is missing', () => {
  assert.doesNotThrow(() =>
    assertEnvFilePermissions('/nonexistent/path/to/.env-xyz-does-not-exist'),
  );
});

test('assertEnvFilePermissions: passes on 0600', async (t) => {
  const { dir, file } = await makeTempEnv(0o600);
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.doesNotThrow(() => assertEnvFilePermissions(file));
});

test('assertEnvFilePermissions: throws on 0644 with fix command', async (t) => {
  const { dir, file } = await makeTempEnv(0o644);
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.throws(
    () => assertEnvFilePermissions(file),
    /must be mode 0600 \(currently 0644\)[\s\S]*Run: chmod 0600/,
  );
});

test('assertEnvFilePermissions: throws on 0660 (group readable)', async (t) => {
  const { dir, file } = await makeTempEnv(0o660);
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.throws(() => assertEnvFilePermissions(file), /must be mode 0600 \(currently 0660\)/);
});
