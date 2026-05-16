import { existsSync, statSync } from 'node:fs';

/**
 * Assert that an `.env` file (if present) is mode 0600. DB_PASSWORD and
 * any future secrets live here, so a group/world-readable env file is a
 * misconfiguration we refuse to start with — same threat model as
 * site-walker.toml.
 *
 * If the file is absent, this is a no-op (env vars may be provided by
 * the surrounding shell or platform).
 */
export function assertEnvFilePermissions(filePath = '.env'): void {
  if (!existsSync(filePath)) return;
  const mode = statSync(filePath).mode & 0o777;
  if (mode !== 0o600) {
    const octal = mode.toString(8).padStart(4, '0');
    throw new Error(
      `Env file ${filePath} must be mode 0600 (currently ${octal}).\n` +
        `Run: chmod 0600 ${filePath}`,
    );
  }
}
