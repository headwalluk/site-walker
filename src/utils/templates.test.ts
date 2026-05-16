import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readPersonaTemplate } from './templates.js';

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'sw-templates-'));
}

test('readPersonaTemplate returns file contents', async (t) => {
  const dir = await makeTempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'PERSONA.md'), 'hello persona\n', 'utf8');
  const content = await readPersonaTemplate(dir);
  assert.equal(content, 'hello persona\n');
});

test('readPersonaTemplate throws when PERSONA.md missing', async (t) => {
  const dir = await makeTempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(() => readPersonaTemplate(dir), /ENOENT/);
});

test('repository ships templates/PERSONA.md', async () => {
  const content = await readPersonaTemplate();
  assert.ok(content.length > 0, 'expected templates/PERSONA.md to have content');
});
