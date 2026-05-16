import type { Knex } from 'knex';

export interface ModelParameters {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string[];
}

export interface Website {
  id: number;
  slug: string;
  name: string;
  welcome_message: string | null;
  persona: string | null;
  model_slug: string | null;
  model_parameters: ModelParameters | null;
  model_context_window: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface WebsiteOrigin {
  id: number;
  website_id: number;
  origin: string;
  created_at: Date;
}

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function assertSlug(slug: string): void {
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(
      `Invalid slug "${slug}": must be 1–64 chars, lowercase alphanumeric + hyphens, ` +
        `cannot start or end with a hyphen.`,
    );
  }
}

/**
 * Validate and normalise a browser `Origin` string.
 * Per dev-notes/01-auth-and-session-flow.md: exact-match origins (scheme + host
 * only, no path, no query, no trailing slash). Host is lower-cased; default
 * ports (80/443) are omitted per HTTP convention.
 */
export function normaliseOrigin(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Invalid origin "${input}": not a parseable URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Invalid origin "${input}": scheme must be http or https.`);
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error(`Invalid origin "${input}": must not include a path.`);
  }
  if (url.search || url.hash) {
    throw new Error(`Invalid origin "${input}": must not include a query or fragment.`);
  }
  const host = url.host.toLowerCase();
  return `${url.protocol}//${host}`;
}

export async function createWebsite(
  db: Knex,
  input: { slug: string; name: string; persona?: string | null },
): Promise<Website> {
  assertSlug(input.slug);
  const [id] = await db('websites').insert({
    slug: input.slug,
    name: input.name,
    persona: input.persona ?? null,
  });
  const row = await getWebsiteById(db, id);
  if (!row) {
    throw new Error(`createWebsite: insert succeeded but read-back failed for id=${id}`);
  }
  return row;
}

export async function setPersona(db: Knex, slug: string, persona: string): Promise<Website> {
  const website = await getWebsiteBySlug(db, slug);
  if (!website) {
    throw new Error(`Website not found: slug="${slug}"`);
  }
  await db('websites').where({ id: website.id }).update({ persona });
  const updated = await getWebsiteById(db, website.id);
  if (!updated) {
    throw new Error(`setPersona: update succeeded but read-back failed for id=${website.id}`);
  }
  return updated;
}

function normaliseWebsiteRow(row: Website | undefined): Website | null {
  if (!row) return null;
  // MariaDB's JSON column comes back as a string through mysql2; parse it
  // here so callers can rely on the declared `ModelParameters | null` shape.
  if (typeof row.model_parameters === 'string') {
    row.model_parameters = JSON.parse(row.model_parameters) as ModelParameters;
  }
  return row;
}

export async function getWebsiteById(db: Knex, id: number): Promise<Website | null> {
  const row = await db<Website>('websites').where({ id }).first();
  return normaliseWebsiteRow(row);
}

export async function getWebsiteBySlug(db: Knex, slug: string): Promise<Website | null> {
  const row = await db<Website>('websites').where({ slug }).first();
  return normaliseWebsiteRow(row);
}

export async function addOrigin(
  db: Knex,
  websiteSlug: string,
  rawOrigin: string,
): Promise<WebsiteOrigin> {
  const website = await getWebsiteBySlug(db, websiteSlug);
  if (!website) {
    throw new Error(`Website not found: slug="${websiteSlug}"`);
  }
  const origin = normaliseOrigin(rawOrigin);
  const [id] = await db('website_origins').insert({
    website_id: website.id,
    origin,
  });
  const row = await db<WebsiteOrigin>('website_origins').where({ id }).first();
  if (!row) {
    throw new Error(`addOrigin: insert succeeded but read-back failed for id=${id}`);
  }
  return row;
}

export async function findWebsiteByOrigin(db: Knex, rawOrigin: string): Promise<Website | null> {
  const origin = normaliseOrigin(rawOrigin);
  const row = await db<Website>({ w: 'websites' })
    .join({ o: 'website_origins' }, 'w.id', 'o.website_id')
    .where('o.origin', origin)
    .select('w.*')
    .first();
  return row ?? null;
}
