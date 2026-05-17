import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadEnv } from './env.js';
import { CONFIG_FILENAME, loadConfig, searchPaths } from './site-walker-config.js';

async function makeTempConfig(
  contents: string,
  mode = 0o600,
): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sw-config-'));
  const file = path.join(dir, CONFIG_FILENAME);
  await writeFile(file, contents, 'utf8');
  await chmod(file, mode);
  return { dir, file };
}

test('searchPaths returns four absolute paths in documented order', () => {
  const paths = searchPaths();
  assert.equal(paths.length, 4);
  for (const p of paths) {
    assert.ok(path.isAbsolute(p), `expected absolute: ${p}`);
    assert.ok(p.endsWith(CONFIG_FILENAME), `expected to end with ${CONFIG_FILENAME}: ${p}`);
  }
  // first path is the project root (cwd) — second segment is the filename
  assert.equal(path.dirname(paths[0]), process.cwd());
  assert.match(paths[1], /\.site-walker/);
  assert.match(paths[2], /(\.config\/site-walker|XDG)/);
  assert.match(paths[3], /^\/etc\//);
});

test('loadConfig parses a valid TOML with one ollama-native provider', async (t) => {
  const { dir, file } = await makeTempConfig(`
[providers.pi]
protocol = "ollama-native"
base_url = "http://rpi.local:11434"
`);
  t.after(() => rm(dir, { recursive: true, force: true }));

  const registry = await loadConfig({ configPath: file });
  assert.equal(registry.configPath, file);
  assert.equal(registry.providers.size, 1);
  const pi = registry.providers.get('pi');
  assert.ok(pi);
  assert.equal(pi.protocol, 'ollama-native');
  assert.equal(pi.base_url, 'http://rpi.local:11434');
  assert.equal(pi.api_key, undefined);
});

test('loadConfig fails on 0644 (permission gate)', async (t) => {
  const { dir, file } = await makeTempConfig(
    `[providers.pi]\nprotocol = "ollama-native"\nbase_url = "http://x"\n`,
    0o644,
  );
  t.after(() => rm(dir, { recursive: true, force: true }));

  await assert.rejects(
    () => loadConfig({ configPath: file }),
    /must be mode 0600 \(currently 0644\)/,
  );
});

test('loadConfig rejects unknown protocol', async (t) => {
  const { dir, file } = await makeTempConfig(`[providers.weird]\nprotocol = "telepathy"\n`);
  t.after(() => rm(dir, { recursive: true, force: true }));

  await assert.rejects(() => loadConfig({ configPath: file }), /not supported/);
});

test('loadConfig errors on TOML syntax errors', async (t) => {
  const { dir, file } = await makeTempConfig(`this is not = valid = toml = at all = "broken`);
  t.after(() => rm(dir, { recursive: true, force: true }));

  await assert.rejects(() => loadConfig({ configPath: file }));
});

test('loadConfig returns an empty registry when [providers] is absent', async (t) => {
  const { dir, file } = await makeTempConfig(`# nothing here\n`);
  t.after(() => rm(dir, { recursive: true, force: true }));

  const registry = await loadConfig({ configPath: file });
  assert.equal(registry.providers.size, 0);
});

test('loadConfig: SW_CONFIG env override still hits the permission gate', async (t) => {
  const { dir, file } = await makeTempConfig(
    `[providers.pi]\nprotocol="ollama-native"\nbase_url="http://x"\n`,
    0o644,
  );
  t.after(() => rm(dir, { recursive: true, force: true }));

  const original = process.env.SW_CONFIG;
  process.env.SW_CONFIG = file;
  t.after(() => {
    if (original === undefined) delete process.env.SW_CONFIG;
    else process.env.SW_CONFIG = original;
  });

  // Pass a fresh env snapshot so the loader sees the just-mutated SW_CONFIG,
  // not the module-load singleton captured before this test ran.
  await assert.rejects(() => loadConfig({ env: loadEnv() }), /must be mode 0600/);
});

test('loadConfig: SW_CONFIG env override resolves a 0600 file', async (t) => {
  const { dir, file } = await makeTempConfig(
    `[providers.pi]\nprotocol="ollama-native"\nbase_url="http://x"\n`,
  );
  t.after(() => rm(dir, { recursive: true, force: true }));

  const original = process.env.SW_CONFIG;
  process.env.SW_CONFIG = file;
  t.after(() => {
    if (original === undefined) delete process.env.SW_CONFIG;
    else process.env.SW_CONFIG = original;
  });

  const registry = await loadConfig({ env: loadEnv() });
  assert.equal(registry.configPath, file);
  assert.ok(registry.providers.has('pi'));
});
