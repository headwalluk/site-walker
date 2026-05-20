import { DEFAULT_OPENROUTER_BASE_URL } from './openrouter.js';

/**
 * Minimum shape needed to ask a provider for its available models. Structural
 * — both DB `Provider` rows and lightweight test objects satisfy it.
 */
export interface ProviderForListing {
  name: string;
  protocol: string;
  base_url: string;
}

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

async function listOpenRouterModels(baseUrl: string | undefined): Promise<ModelListing[]> {
  const url = `${(baseUrl ?? DEFAULT_OPENROUTER_BASE_URL).replace(/\/$/, '')}/models`;
  const data = await fetchJson<OpenRouterModelsResponse>(url, {});
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
 * provider name into `sw chatbot set-model <slug> <provider>/<id>`. The
 * openrouter discovery endpoint is public; no api_key is sent (and none
 * is needed) — the live chat path is what actually uses the BYO key.
 */
export async function listProviderModels(entry: ProviderForListing): Promise<ModelListing[]> {
  switch (entry.protocol) {
    case 'ollama-native':
      return listOllamaModels(entry.base_url);
    case 'openrouter':
      return listOpenRouterModels(entry.base_url);
    default:
      throw new Error(
        `provider "${entry.name}" uses protocol "${entry.protocol}", which doesn't support model discovery.`,
      );
  }
}
