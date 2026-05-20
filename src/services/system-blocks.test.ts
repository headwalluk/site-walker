import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HANDLING_RULE, assemblePrompt, loadDiskBlocks, type Block } from './system-blocks.js';
import { estimateTokens } from '../utils/tokens.js';

async function makeChatbotDir(): Promise<{ baseDir: string; slug: string; siteDir: string }> {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'sw-blocks-'));
  const slug = 'test-site';
  const siteDir = path.join(baseDir, slug);
  await mkdir(siteDir, { recursive: true });
  return { baseDir, slug, siteDir };
}

test('loadDiskBlocks: missing chatbot directory returns []', async (t) => {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'sw-blocks-'));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const blocks = await loadDiskBlocks('does-not-exist', baseDir);
  assert.deepEqual(blocks, []);
});

test('loadDiskBlocks: empty directory returns []', async (t) => {
  const { baseDir, slug } = await makeChatbotDir();
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const blocks = await loadDiskBlocks(slug, baseDir);
  assert.deepEqual(blocks, []);
});

test('loadDiskBlocks: single block', async (t) => {
  const { baseDir, slug, siteDir } = await makeChatbotDir();
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  await writeFile(path.join(siteDir, 'COMPANY.md'), 'we sell widgets', 'utf8');
  const blocks = await loadDiskBlocks(slug, baseDir);
  assert.deepEqual(blocks, [{ name: 'COMPANY', content: 'we sell widgets' }]);
});

test('loadDiskBlocks: multiple blocks in alphabetical filename order', async (t) => {
  const { baseDir, slug, siteDir } = await makeChatbotDir();
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  await writeFile(path.join(siteDir, 'PRODUCTS.md'), 'p', 'utf8');
  await writeFile(path.join(siteDir, 'COMPANY.md'), 'c', 'utf8');
  await writeFile(path.join(siteDir, 'FAQ.md'), 'f', 'utf8');
  const blocks = await loadDiskBlocks(slug, baseDir);
  assert.deepEqual(
    blocks.map((b) => b.name),
    ['COMPANY', 'FAQ', 'PRODUCTS'],
  );
});

test('loadDiskBlocks: ignores non-.md files', async (t) => {
  const { baseDir, slug, siteDir } = await makeChatbotDir();
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  await writeFile(path.join(siteDir, 'COMPANY.md'), 'c', 'utf8');
  await writeFile(path.join(siteDir, 'NOTES.txt'), 'not loaded', 'utf8');
  await writeFile(path.join(siteDir, 'README'), 'not loaded', 'utf8');
  const blocks = await loadDiskBlocks(slug, baseDir);
  assert.deepEqual(
    blocks.map((b) => b.name),
    ['COMPANY'],
  );
});

test('loadDiskBlocks: skips empty / whitespace-only .md files', async (t) => {
  const { baseDir, slug, siteDir } = await makeChatbotDir();
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  await writeFile(path.join(siteDir, 'COMPANY.md'), 'c', 'utf8');
  await writeFile(path.join(siteDir, 'EMPTY.md'), '', 'utf8');
  await writeFile(path.join(siteDir, 'BLANK.md'), '   \n  \t\n', 'utf8');
  const blocks = await loadDiskBlocks(slug, baseDir);
  assert.deepEqual(
    blocks.map((b) => b.name),
    ['COMPANY'],
  );
});

test('loadDiskBlocks: PERSONA.md on disk is skipped with console.error', async (t) => {
  const { baseDir, slug, siteDir } = await makeChatbotDir();
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  await writeFile(path.join(siteDir, 'PERSONA.md'), 'stray persona on disk', 'utf8');
  await writeFile(path.join(siteDir, 'COMPANY.md'), 'c', 'utf8');

  const errSpy = t.mock.method(console, 'error', () => {});
  const blocks = await loadDiskBlocks(slug, baseDir);
  assert.deepEqual(
    blocks.map((b) => b.name),
    ['COMPANY'],
  );
  assert.equal(errSpy.mock.callCount(), 1);
  const args = errSpy.mock.calls[0].arguments;
  assert.match(String(args[0]), /PERSONA block already added, skipping PERSONA\.md/);
});

test('assemblePrompt: handling rule only when no persona and no blocks', () => {
  const out = assemblePrompt({ persona: null, diskBlocks: [] });
  assert.equal(out.prompt, HANDLING_RULE);
  assert.deepEqual(out.perBlockTokens, {});
  assert.equal(out.estimatedTokens, estimateTokens(HANDLING_RULE));
});

test('assemblePrompt: persona NULL → no PERSONA block emitted', () => {
  const out = assemblePrompt({
    persona: null,
    diskBlocks: [{ name: 'COMPANY', content: 'we do things' }],
  });
  assert.ok(!out.prompt.includes('<block name="PERSONA">'));
  assert.ok(out.prompt.includes('<block name="COMPANY">'));
  assert.ok(!('PERSONA' in out.perBlockTokens));
});

test('assemblePrompt: whitespace-only persona treated as empty', () => {
  const out = assemblePrompt({ persona: '   \n\t  ', diskBlocks: [] });
  assert.equal(out.prompt, HANDLING_RULE);
});

test('assemblePrompt: persona present → PERSONA block first, before disk blocks', () => {
  const out = assemblePrompt({
    persona: 'be friendly',
    diskBlocks: [
      { name: 'COMPANY', content: 'we sell widgets' },
      { name: 'FAQ', content: 'q&a' },
    ],
  });

  const personaAt = out.prompt.indexOf('<block name="PERSONA">');
  const companyAt = out.prompt.indexOf('<block name="COMPANY">');
  const faqAt = out.prompt.indexOf('<block name="FAQ">');
  assert.ok(personaAt > 0, 'PERSONA tag present');
  assert.ok(personaAt < companyAt, 'PERSONA before COMPANY');
  assert.ok(companyAt < faqAt, 'COMPANY before FAQ');
  assert.ok(out.prompt.startsWith(HANDLING_RULE), 'handling rule first');
  assert.deepEqual(out.perBlockTokens, {
    PERSONA: estimateTokens('be friendly'),
    COMPANY: estimateTokens('we sell widgets'),
    FAQ: estimateTokens('q&a'),
  });
});

test('assemblePrompt: estimatedTokens matches whole assembled prompt', () => {
  const out = assemblePrompt({
    persona: 'p',
    diskBlocks: [{ name: 'C', content: 'cc' } as Block],
  });
  assert.equal(out.estimatedTokens, estimateTokens(out.prompt));
});
