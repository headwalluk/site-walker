import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parse as parseToml } from 'smol-toml';

export const SUPPORTED_PROTOCOLS = [
  'ollama-native',
  'anthropic',
  'openrouter',
  'openai-compatible',
] as const;

export type Protocol = (typeof SUPPORTED_PROTOCOLS)[number];

export interface ProviderEntry {
  name: string;
  protocol: Protocol;
  base_url?: string;
  api_key?: string;
}

export interface ProviderRegistry {
  configPath: string;
  providers: Map<string, ProviderEntry>;
}

export const CONFIG_FILENAME = 'site-walker.toml';

/**
 * Search paths in precedence order — first match wins.
 * Mirrors dev-notes/03-llm-providers.md.
 */
export function searchPaths(): string[] {
  const home = os.homedir();
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return [
    path.join(process.cwd(), CONFIG_FILENAME),
    path.join(home, '.site-walker', CONFIG_FILENAME),
    path.join(xdg, 'site-walker', CONFIG_FILENAME),
    path.join('/etc', CONFIG_FILENAME),
  ];
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveConfigPath(): Promise<string> {
  const override = process.env.SW_CONFIG;
  if (override) {
    if (!(await fileExists(override))) {
      throw new Error(`SW_CONFIG="${override}" but the file does not exist or is not readable.`);
    }
    return override;
  }
  const paths = searchPaths();
  for (const p of paths) {
    if (await fileExists(p)) return p;
  }
  throw new Error(
    `No ${CONFIG_FILENAME} found. Searched (first match wins):\n` +
      paths.map((p) => `  - ${p}`).join('\n') +
      `\nOr set SW_CONFIG=/path/to/${CONFIG_FILENAME} to override.`,
  );
}

async function assertPermissionGate(filePath: string): Promise<void> {
  const s = await stat(filePath);
  const mode = s.mode & 0o777;
  if (mode !== 0o600) {
    const octal = mode.toString(8).padStart(4, '0');
    throw new Error(
      `Config file ${filePath} must be mode 0600 (currently ${octal}).\n` +
        `Run: chmod 0600 ${filePath}`,
    );
  }
}

function parseProviders(raw: unknown, filePath: string): Map<string, ProviderEntry> {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`${filePath}: expected top-level table.`);
  }
  const providersTable = (raw as Record<string, unknown>).providers;
  if (providersTable === undefined) {
    return new Map();
  }
  if (typeof providersTable !== 'object' || providersTable === null) {
    throw new Error(`${filePath}: [providers] must be a table.`);
  }

  const entries = new Map<string, ProviderEntry>();
  for (const [name, value] of Object.entries(providersTable as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) {
      throw new Error(`${filePath}: [providers.${name}] must be a table.`);
    }
    const v = value as Record<string, unknown>;
    const protocol = v.protocol;
    if (typeof protocol !== 'string') {
      throw new Error(`${filePath}: [providers.${name}].protocol must be a string.`);
    }
    if (!(SUPPORTED_PROTOCOLS as readonly string[]).includes(protocol)) {
      throw new Error(
        `${filePath}: [providers.${name}].protocol = "${protocol}" is not supported. ` +
          `Supported: ${SUPPORTED_PROTOCOLS.join(', ')}.`,
      );
    }
    const entry: ProviderEntry = {
      name,
      protocol: protocol as Protocol,
    };
    if (typeof v.base_url === 'string') entry.base_url = v.base_url;
    if (typeof v.api_key === 'string') entry.api_key = v.api_key;
    entries.set(name, entry);
  }
  return entries;
}

/**
 * Load + validate the host-side provider registry.
 *
 * Default behaviour (no args): consult SW_CONFIG env, then walk the search
 * paths, applying the 0600 permission gate regardless of how the file was
 * resolved.
 *
 * Tests pass an explicit `configPath` to bypass discovery while keeping
 * the gate in force.
 */
export async function loadConfig(opts?: { configPath?: string }): Promise<ProviderRegistry> {
  const resolved = opts?.configPath ?? (await resolveConfigPath());
  await assertPermissionGate(resolved);
  const text = await readFile(resolved, 'utf8');
  const raw = parseToml(text);
  const providers = parseProviders(raw, resolved);
  return { configPath: resolved, providers };
}
