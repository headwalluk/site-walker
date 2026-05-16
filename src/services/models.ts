import type { Knex } from 'knex';
import type { ProviderEntry, ProviderRegistry } from '../config/site-walker-config.js';
import { NormalisedParametersSchema, parseModelSlug } from '../providers/index.js';
import type { NormalisedParameters } from '../providers/index.js';
import { getWebsiteBySlug, type Website } from './websites.js';

export interface ResolvedModel {
  websiteId: number;
  websiteSlug: string;
  modelSlug: string;
  provider: ProviderEntry;
  model: string;
  parameters: NormalisedParameters;
  contextWindow: number | null;
}

async function getRowOrThrow(db: Knex, slug: string): Promise<Website> {
  const row = await getWebsiteBySlug(db, slug);
  if (!row) {
    throw new Error(`Website not found: slug="${slug}"`);
  }
  return row;
}

async function reload(db: Knex, slug: string): Promise<Website> {
  const row = await getWebsiteBySlug(db, slug);
  if (!row) {
    throw new Error(`Website disappeared after update: slug="${slug}"`);
  }
  return row;
}

/**
 * Set a website's model slug. Validates that the provider portion of the
 * slug exists in the loaded registry; the model portion is opaque (we don't
 * call the provider to check it — first request surfaces typos).
 */
export async function setModel(
  db: Knex,
  slug: string,
  modelSlug: string,
  registry: ProviderRegistry,
): Promise<Website> {
  const website = await getRowOrThrow(db, slug);
  const { provider } = parseModelSlug(modelSlug);
  if (!registry.providers.has(provider)) {
    throw new Error(
      `Provider "${provider}" (referenced by model_slug "${modelSlug}") is not defined in ${registry.configPath}. ` +
        `Known providers: ${[...registry.providers.keys()].join(', ') || '(none)'}.`,
    );
  }
  await db('websites').where({ id: website.id }).update({ model_slug: modelSlug });
  return reload(db, slug);
}

/**
 * Set a website's normalised parameters. Validates via Zod — unknown keys
 * and out-of-range values are rejected at admin-set time so bad config
 * never reaches production traffic.
 */
export async function setParameters(db: Knex, slug: string, params: unknown): Promise<Website> {
  const website = await getRowOrThrow(db, slug);
  const parsed = NormalisedParametersSchema.parse(params);
  await db('websites')
    .where({ id: website.id })
    .update({ model_parameters: JSON.stringify(parsed) });
  return reload(db, slug);
}

export async function setContextWindow(db: Knex, slug: string, tokens: number): Promise<Website> {
  if (!Number.isInteger(tokens) || tokens <= 0) {
    throw new Error(`context window must be a positive integer (got ${tokens}).`);
  }
  const website = await getRowOrThrow(db, slug);
  await db('websites').where({ id: website.id }).update({ model_context_window: tokens });
  return reload(db, slug);
}

/**
 * Resolve a website's chosen model into provider entry + model string +
 * parsed parameters. Throws if the website has no model_slug or if its
 * provider is missing from the registry.
 */
export function resolveModel(website: Website, registry: ProviderRegistry): ResolvedModel {
  if (!website.model_slug) {
    throw new Error(`Website "${website.slug}" has no model_slug set.`);
  }
  const { provider: providerName, model } = parseModelSlug(website.model_slug);
  const provider = registry.providers.get(providerName);
  if (!provider) {
    throw new Error(
      `Website "${website.slug}" references provider "${providerName}" which is not defined in ${registry.configPath}.`,
    );
  }
  const parameters: NormalisedParameters = website.model_parameters
    ? NormalisedParametersSchema.parse(website.model_parameters)
    : {};
  return {
    websiteId: website.id,
    websiteSlug: website.slug,
    modelSlug: website.model_slug,
    provider,
    model,
    parameters,
    contextWindow: website.model_context_window,
  };
}

/**
 * Default headroom for conversation history + response when checking
 * whether an assembled system prompt fits within the model's context
 * window. 12.5% of the window with a 512-token floor.
 */
export function defaultHeadroom(contextWindow: number): number {
  return Math.max(512, Math.ceil(contextWindow / 8));
}

export interface ContextBudgetCheck {
  websiteSlug: string;
  modelSlug: string;
  contextWindow: number;
  promptTokens: number;
  headroomTokens?: number;
}

/**
 * Fail if the assembled prompt leaves no headroom for conversation history
 * + response. Error shape matches dev-notes/03-llm-providers.md.
 */
export function validateContextBudget(check: ContextBudgetCheck): void {
  const headroom = check.headroomTokens ?? defaultHeadroom(check.contextWindow);
  const residual = check.contextWindow - check.promptTokens;
  if (check.promptTokens + headroom > check.contextWindow) {
    throw new Error(
      `system blocks for website "${check.websiteSlug}" total ~${check.promptTokens} tokens, but ` +
        `model_context_window for "${check.modelSlug}" is ${check.contextWindow}. That leaves ` +
        `only ~${residual} for conversation history + response. ` +
        `Either reduce system blocks or move this website to a larger-context model.`,
    );
  }
}

/**
 * Startup check: every website with a non-NULL model_slug must reference a
 * provider that exists in the loaded registry. Caller decides what to do
 * with the thrown error (fail boot, fail CLI command, etc.).
 */
export async function validateRegistryAgainstWebsites(
  db: Knex,
  registry: ProviderRegistry,
): Promise<void> {
  const rows = await db<Website>('websites')
    .whereNotNull('model_slug')
    .select('slug', 'model_slug');
  const problems: string[] = [];
  for (const row of rows) {
    if (!row.model_slug) continue;
    try {
      const { provider } = parseModelSlug(row.model_slug);
      if (!registry.providers.has(provider)) {
        problems.push(
          `website "${row.slug}" references provider "${provider}" (from model_slug "${row.model_slug}") ` +
            `which is not defined in ${registry.configPath}`,
        );
      }
    } catch (err) {
      problems.push(
        `website "${row.slug}" has invalid model_slug "${row.model_slug}": ${(err as Error).message}`,
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(`Provider registry validation failed:\n  - ${problems.join('\n  - ')}`);
  }
}
