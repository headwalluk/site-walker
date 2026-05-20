import type { Knex } from 'knex';

/**
 * Protocols the adapter layer in `src/providers/` can actually serve.
 * Extending this requires adding the corresponding case in `buildAdapter`.
 */
export const SUPPORTED_PROTOCOLS = ['ollama-native', 'openrouter'] as const;

export type Protocol = (typeof SUPPORTED_PROTOCOLS)[number];

export function isSupportedProtocol(s: string): s is Protocol {
  return (SUPPORTED_PROTOCOLS as readonly string[]).includes(s);
}

export interface Provider {
  id: number;
  name: string;
  protocol: Protocol;
  base_url: string;
  is_local: boolean;
  is_metered: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface ProviderModel {
  id: number;
  provider_id: number;
  model_slug: string;
  context_window: number;
  /** DECIMAL columns come back from mysql2 as strings. NULL on unmetered. */
  input_per_million_usd: string | null;
  output_per_million_usd: string | null;
  is_available: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface ResolvedProviderModel {
  provider: Provider;
  model: ProviderModel;
}

const PROVIDER_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function assertProviderName(name: string): void {
  if (!PROVIDER_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid provider name "${name}": must be 1–64 chars, lowercase alphanumeric + hyphens, ` +
        `cannot start or end with a hyphen.`,
    );
  }
}

function assertProtocol(protocol: string): void {
  if (!isSupportedProtocol(protocol)) {
    throw new Error(
      `Invalid protocol "${protocol}". Supported: ${SUPPORTED_PROTOCOLS.join(', ')}.`,
    );
  }
}

interface ProviderRow {
  id: number;
  name: string;
  protocol: string;
  base_url: string;
  is_local: number;
  is_metered: number;
  created_at: Date;
  updated_at: Date;
}

interface ProviderModelRow {
  id: number;
  provider_id: number;
  model_slug: string;
  context_window: number;
  input_per_million_usd: string | null;
  output_per_million_usd: string | null;
  is_available: number;
  created_at: Date;
  updated_at: Date;
}

function normaliseProvider(row: ProviderRow | undefined): Provider | null {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol as Protocol,
    base_url: row.base_url,
    is_local: Boolean(row.is_local),
    is_metered: Boolean(row.is_metered),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normaliseProviderModel(row: ProviderModelRow | undefined): ProviderModel | null {
  if (!row) return null;
  return {
    id: row.id,
    provider_id: row.provider_id,
    model_slug: row.model_slug,
    context_window: row.context_window,
    input_per_million_usd: row.input_per_million_usd,
    output_per_million_usd: row.output_per_million_usd,
    is_available: Boolean(row.is_available),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function createProvider(
  db: Knex,
  input: {
    name: string;
    protocol: string;
    base_url: string;
    is_local?: boolean;
    is_metered?: boolean;
  },
): Promise<Provider> {
  assertProviderName(input.name);
  assertProtocol(input.protocol);
  if (input.base_url.trim().length === 0) {
    throw new Error('base_url must be a non-empty string.');
  }
  const is_local = input.is_local ?? false;
  // Default is_metered = !is_local — local Ollama is unmetered by default,
  // every cloud provider charges. Explicit override is always honoured.
  const is_metered = input.is_metered ?? !is_local;
  const [id] = await db('providers').insert({
    name: input.name,
    protocol: input.protocol,
    base_url: input.base_url,
    is_local,
    is_metered,
  });
  const row = await getProviderById(db, id);
  if (!row) {
    throw new Error(`createProvider: insert succeeded but read-back failed for id=${id}`);
  }
  return row;
}

export async function getProviderById(db: Knex, id: number): Promise<Provider | null> {
  const row = await db<ProviderRow>('providers').where({ id }).first();
  return normaliseProvider(row);
}

export async function getProviderByName(db: Knex, name: string): Promise<Provider | null> {
  const row = await db<ProviderRow>('providers').where({ name }).first();
  return normaliseProvider(row);
}

export async function listProviders(db: Knex): Promise<Provider[]> {
  const rows = await db<ProviderRow>('providers').select('*').orderBy('name', 'asc');
  return rows.map((r) => normaliseProvider(r) as Provider);
}

export interface DeleteProviderResult {
  models: number;
}

/**
 * Delete a provider and CASCADE through its provider_models rows. Returns
 * the cascade count so the operator sees the blast radius. Does not check
 * whether any chatbot still references this provider via `model_slug` —
 * that's surfaced by the next chat request as `model_not_configured`.
 */
export async function deleteProvider(db: Knex, name: string): Promise<DeleteProviderResult> {
  return db.transaction(async (trx) => {
    const provider = await trx<ProviderRow>('providers').where({ name }).first();
    if (!provider) {
      throw new Error(`Provider not found: name="${name}"`);
    }
    const [modelRow] = await trx('provider_models')
      .where({ provider_id: provider.id })
      .count<{ n: number }[]>({ n: '*' });
    await trx('providers').where({ id: provider.id }).del();
    return { models: Number(modelRow?.n ?? 0) };
  });
}

export async function createProviderModel(
  db: Knex,
  input: {
    provider_id: number;
    model_slug: string;
    context_window: number;
    input_per_million_usd?: number | null;
    output_per_million_usd?: number | null;
    is_available?: boolean;
  },
): Promise<ProviderModel> {
  if (input.model_slug.trim().length === 0) {
    throw new Error('model_slug must be a non-empty string.');
  }
  if (!Number.isInteger(input.context_window) || input.context_window <= 0) {
    throw new Error(`context_window must be a positive integer (got ${input.context_window}).`);
  }
  const [id] = await db('provider_models').insert({
    provider_id: input.provider_id,
    model_slug: input.model_slug,
    context_window: input.context_window,
    input_per_million_usd: input.input_per_million_usd ?? null,
    output_per_million_usd: input.output_per_million_usd ?? null,
    is_available: input.is_available ?? true,
  });
  const row = await db<ProviderModelRow>('provider_models').where({ id }).first();
  if (!row) {
    throw new Error(`createProviderModel: insert succeeded but read-back failed for id=${id}`);
  }
  return normaliseProviderModel(row) as ProviderModel;
}

export async function listProviderModelsForProvider(
  db: Knex,
  providerId: number,
): Promise<ProviderModel[]> {
  const rows = await db<ProviderModelRow>('provider_models')
    .where({ provider_id: providerId })
    .orderBy('model_slug', 'asc');
  return rows.map((r) => normaliseProviderModel(r) as ProviderModel);
}

export async function deleteProviderModel(
  db: Knex,
  providerName: string,
  modelSlug: string,
): Promise<void> {
  const provider = await getProviderByName(db, providerName);
  if (!provider) {
    throw new Error(`Provider not found: name="${providerName}"`);
  }
  const deleted = await db('provider_models')
    .where({ provider_id: provider.id, model_slug: modelSlug })
    .del();
  if (deleted === 0) {
    throw new Error(`Provider model not found: provider="${providerName}" model="${modelSlug}".`);
  }
}

/**
 * Resolve a `provider/model` slug into the joined provider + provider_model
 * rows. Used by `resolveModel` on every chat request. Returns null if
 * either the provider or the model row is missing — caller decides the
 * error semantics (route layer maps to `model_not_configured`).
 */
export async function findProviderModel(
  db: Knex,
  providerName: string,
  modelSlug: string,
): Promise<ResolvedProviderModel | null> {
  const row = await db('providers as p')
    .join('provider_models as m', 'm.provider_id', 'p.id')
    .where('p.name', providerName)
    .andWhere('m.model_slug', modelSlug)
    .first<
      | {
          p_id: number;
          p_name: string;
          protocol: string;
          base_url: string;
          is_local: number;
          is_metered: number;
          p_created_at: Date;
          p_updated_at: Date;
          m_id: number;
          provider_id: number;
          model_slug: string;
          context_window: number;
          input_per_million_usd: string | null;
          output_per_million_usd: string | null;
          is_available: number;
          m_created_at: Date;
          m_updated_at: Date;
        }
      | undefined
    >('p.id as p_id', 'p.name as p_name', 'p.protocol', 'p.base_url', 'p.is_local', 'p.is_metered', 'p.created_at as p_created_at', 'p.updated_at as p_updated_at', 'm.id as m_id', 'm.provider_id', 'm.model_slug', 'm.context_window', 'm.input_per_million_usd', 'm.output_per_million_usd', 'm.is_available', 'm.created_at as m_created_at', 'm.updated_at as m_updated_at');
  if (!row) return null;
  return {
    provider: {
      id: row.p_id,
      name: row.p_name,
      protocol: row.protocol as Protocol,
      base_url: row.base_url,
      is_local: Boolean(row.is_local),
      is_metered: Boolean(row.is_metered),
      created_at: row.p_created_at,
      updated_at: row.p_updated_at,
    },
    model: {
      id: row.m_id,
      provider_id: row.provider_id,
      model_slug: row.model_slug,
      context_window: row.context_window,
      input_per_million_usd: row.input_per_million_usd,
      output_per_million_usd: row.output_per_million_usd,
      is_available: Boolean(row.is_available),
      created_at: row.m_created_at,
      updated_at: row.m_updated_at,
    },
  };
}
