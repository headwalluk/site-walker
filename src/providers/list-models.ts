import type { ProviderEntry } from '../config/site-walker-config.js';
import { DEFAULT_OPENROUTER_BASE_URL } from './openrouter.js';

export interface ModelListing {
  /** The model string the operator passes as the part after the provider slash. */
  id: string;
  /** Human-readable label if the provider supplies one. */
  label?: string;
  /** Native context window in tokens, if the provider tells us. */
  contextWindow?: number;
}

interface OllamaTagsResponse {
  models?: Array<{ name?: string }>;
}

interface OpenRouterModelsResponse {
  data?: Array<{ id?: string; name?: string; context_length?: number }>;
}

async function fetchJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GET ${url} failed (${res.status} ${res.statusText}): ${text.slice(0, 500)}`);
  }
  return (await res.json()) as T;
}

async function listOllamaModels(baseUrl: string): Promise<ModelListing[]> {
  const url = `${baseUrl.replace(/\/$/, '')}/api/tags`;
  const data = await fetchJson<OllamaTagsResponse>(url);
  if (!Array.isArray(data.models)) return [];
  return data.models
    .map((m) => (typeof m.name === 'string' ? { id: m.name } : null))
    .filter((m): m is ModelListing => m !== null);
}

async function listOpenRouterModels(
  baseUrl: string | undefined,
  apiKey: string | undefined,
): Promise<ModelListing[]> {
  const url = `${(baseUrl ?? DEFAULT_OPENROUTER_BASE_URL).replace(/\/$/, '')}/models`;
  const headers: Record<string, string> = {};
  // The public /models endpoint doesn't strictly require auth, but sending
  // the key is harmless and lets OpenRouter attribute the lookup.
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const data = await fetchJson<OpenRouterModelsResponse>(url, headers);
  if (!Array.isArray(data.data)) return [];
  return data.data
    .map((m): ModelListing | null => {
      if (typeof m.id !== 'string') return null;
      const out: ModelListing = { id: m.id };
      if (typeof m.name === 'string') out.label = m.name;
      if (typeof m.context_length === 'number') out.contextWindow = m.context_length;
      return out;
    })
    .filter((m): m is ModelListing => m !== null);
}

/**
 * Ask a configured provider for the list of models it can serve. Protocols
 * that don't expose a discovery endpoint throw with a clear message.
 *
 * The returned `id` is the model string the operator pastes after the
 * provider name into `sw website set-model <slug> <provider>/<id>`.
 */
export async function listProviderModels(entry: ProviderEntry): Promise<ModelListing[]> {
  switch (entry.protocol) {
    case 'ollama-native': {
      if (!entry.base_url) {
        throw new Error(
          `provider "${entry.name}" (ollama-native) requires base_url in site-walker.toml`,
        );
      }
      return listOllamaModels(entry.base_url);
    }
    case 'openrouter': {
      return listOpenRouterModels(entry.base_url, entry.api_key);
    }
    case 'anthropic':
    case 'openai-compatible':
      throw new Error(
        `provider "${entry.name}" uses protocol "${entry.protocol}", which doesn't yet support model listing.`,
      );
    default: {
      const exhaustiveCheck: never = entry.protocol;
      throw new Error(`unknown protocol "${exhaustiveCheck as string}"`);
    }
  }
}
