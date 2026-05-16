import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_TEMPLATES_DIR = 'templates';

/**
 * Read the website-agnostic persona seed from `templates/PERSONA.md`.
 * Used at `sw website create` time to populate `websites.persona`.
 * Throws if the template file is missing — operators must not accidentally
 * end up with NULL persona because the template directory was nuked.
 */
export async function readPersonaTemplate(
  templatesDir: string = DEFAULT_TEMPLATES_DIR,
): Promise<string> {
  const file = path.join(templatesDir, 'PERSONA.md');
  return readFile(file, 'utf8');
}
