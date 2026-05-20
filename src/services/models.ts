import type { Knex } from 'knex';
import { NormalisedParametersSchema, parseModelSlug } from '../providers/index.js';
import type { NormalisedParameters } from '../providers/index.js';
import { getChatbotBySlug, type Chatbot } from './chatbots.js';
import { findProviderModel, type Provider, type ProviderModel } from './providers.js';

export interface ResolvedModel {
  chatbotId: number;
  chatbotSlug: string;
  /** Full `provider/model` slug, as written in `chatbots.model_slug`. */
  modelSlug: string;
  /** DB-loaded provider row (name, protocol, base_url, is_local, is_metered). */
  provider: Provider;
  /**
   * DB-loaded provider_models row. Carries `context_window`, pricing, and
   * `is_available`. M18's chat path reads pricing from here to compute the
   * USD cost estimate for each assistant turn; no extra query needed since
   * `findProviderModel` already joined both rows.
   */
  providerModel: ProviderModel;
  /** The model portion after the slash, what the adapter passes to the API. */
  model: string;
  parameters: NormalisedParameters;
  /**
   * Effective context window. Operator override on the chatbot wins; otherwise
   * the value registered against the provider's `provider_models` row.
   */
  contextWindow: number | null;
}

async function getRowOrThrow(db: Knex, slug: string): Promise<Chatbot> {
  const row = await getChatbotBySlug(db, slug);
  if (!row) {
    throw new Error(`Chatbot not found: slug="${slug}"`);
  }
  return row;
}

async function reload(db: Knex, slug: string): Promise<Chatbot> {
  const row = await getChatbotBySlug(db, slug);
  if (!row) {
    throw new Error(`Chatbot disappeared after update: slug="${slug}"`);
  }
  return row;
}

/**
 * Set a chatbot's model slug. Validates that the slug resolves against the
 * DB-backed provider registry — both the provider name and the model row
 * must exist. Typos surface here, not on first chat request.
 */
export async function setModel(db: Knex, slug: string, modelSlug: string): Promise<Chatbot> {
  const chatbot = await getRowOrThrow(db, slug);
  const { provider: providerName, model: modelPart } = parseModelSlug(modelSlug);
  const resolved = await findProviderModel(db, providerName, modelPart);
  if (!resolved) {
    throw new Error(
      `model_slug "${modelSlug}" does not resolve against the provider registry. ` +
        `Register the provider with \`sw provider add\` and the model with ` +
        `\`sw provider models add\`.`,
    );
  }
  await db('chatbots').where({ id: chatbot.id }).update({ model_slug: modelSlug });
  return reload(db, slug);
}

/**
 * Set a chatbot's normalised parameters. Validates via Zod — unknown keys
 * and out-of-range values are rejected at admin-set time so bad config
 * never reaches production traffic.
 */
export async function setParameters(db: Knex, slug: string, params: unknown): Promise<Chatbot> {
  const chatbot = await getRowOrThrow(db, slug);
  const parsed = NormalisedParametersSchema.parse(params);
  await db('chatbots')
    .where({ id: chatbot.id })
    .update({ model_parameters: JSON.stringify(parsed) });
  return reload(db, slug);
}

export async function setContextWindow(db: Knex, slug: string, tokens: number): Promise<Chatbot> {
  if (!Number.isInteger(tokens) || tokens <= 0) {
    throw new Error(`context window must be a positive integer (got ${tokens}).`);
  }
  const chatbot = await getRowOrThrow(db, slug);
  await db('chatbots').where({ id: chatbot.id }).update({ model_context_window: tokens });
  return reload(db, slug);
}

/**
 * Resolve a chatbot's chosen model into provider + model + parsed parameters
 * by joining against the DB-backed provider registry. Throws if the chatbot
 * has no `model_slug` set, or if the referenced provider/model isn't
 * registered.
 *
 * Effective context window = chatbot override (if set) ?? provider model's
 * declared window. Operator can still pin a smaller window per-chatbot if
 * they want the budget check to be tighter than the model nominally allows.
 */
export async function resolveModel(db: Knex, chatbot: Chatbot): Promise<ResolvedModel> {
  if (!chatbot.model_slug) {
    throw new Error(`Chatbot "${chatbot.slug}" has no model_slug set.`);
  }
  const { provider: providerName, model: modelPart } = parseModelSlug(chatbot.model_slug);
  const found = await findProviderModel(db, providerName, modelPart);
  if (!found) {
    throw new Error(
      `Chatbot "${chatbot.slug}" references model_slug "${chatbot.model_slug}", which does ` +
        `not resolve against the provider registry. Re-register the provider/model with ` +
        `\`sw provider add\` and \`sw provider models add\`, or set a different model_slug ` +
        `on this chatbot.`,
    );
  }
  const parameters: NormalisedParameters = chatbot.model_parameters
    ? NormalisedParametersSchema.parse(chatbot.model_parameters)
    : {};
  return {
    chatbotId: chatbot.id,
    chatbotSlug: chatbot.slug,
    modelSlug: chatbot.model_slug,
    provider: found.provider,
    providerModel: found.model,
    model: modelPart,
    parameters,
    contextWindow: chatbot.model_context_window ?? found.model.context_window,
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
  chatbotSlug: string;
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
      `system blocks for chatbot "${check.chatbotSlug}" total ~${check.promptTokens} tokens, but ` +
        `model_context_window for "${check.modelSlug}" is ${check.contextWindow}. That leaves ` +
        `only ~${residual} for conversation history + response. ` +
        `Either reduce system blocks or move this chatbot to a larger-context model.`,
    );
  }
}

/**
 * Startup check: every chatbot with a non-NULL model_slug must resolve
 * against the DB-backed provider registry. Caller decides what to do with
 * the thrown error (fail boot, fail CLI command, etc.).
 *
 * `whereSlugs` narrows the scan to a specific subset of chatbots — used by
 * tests that need to assert behaviour against rows they own without being
 * dragged into validating unrelated state in a shared dev DB. Production
 * callers omit it to scan everything.
 */
export async function validateRegistryAgainstChatbots(
  db: Knex,
  whereSlugs?: string[],
): Promise<void> {
  const query = db<Chatbot>('chatbots').whereNotNull('model_slug').select('slug', 'model_slug');
  if (whereSlugs && whereSlugs.length > 0) {
    query.whereIn('slug', whereSlugs);
  }
  const rows = await query;
  const problems: string[] = [];
  for (const row of rows) {
    if (!row.model_slug) continue;
    try {
      const { provider: providerName, model: modelPart } = parseModelSlug(row.model_slug);
      const found = await findProviderModel(db, providerName, modelPart);
      if (!found) {
        problems.push(
          `chatbot "${row.slug}" references model_slug "${row.model_slug}", which does not ` +
            `resolve against the provider registry (missing provider or model row)`,
        );
      }
    } catch (err) {
      problems.push(
        `chatbot "${row.slug}" has invalid model_slug "${row.model_slug}": ${(err as Error).message}`,
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(`Provider registry validation failed:\n  - ${problems.join('\n  - ')}`);
  }
}
