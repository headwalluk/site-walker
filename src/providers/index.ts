import type { Provider } from '../services/providers.js';
import { OllamaNativeAdapter } from './ollama-native.js';
import { OpenRouterAdapter } from './openrouter.js';
import type { ProtocolAdapter } from './types.js';

export type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  NormalisedParameters,
  ProtocolAdapter,
} from './types.js';
export { NormalisedParametersSchema, parseModelSlug } from './types.js';

/**
 * Build a protocol adapter for a single chat request. The provider row is
 * the DB-loaded `providers` row resolved from the chatbot's model_slug; the
 * apiKey is the decrypted plaintext from `chatbots.provider_api_key_*` (or
 * undefined for unmetered providers where the chatbot has no key set).
 *
 * Adapters are per-request instances — they hold the apiKey for the lifetime
 * of the chat call, and are thrown away afterwards. Cheap; lifecycle is
 * obvious; no shared mutable state between requests.
 */
export function buildAdapter(provider: Provider, apiKey?: string): ProtocolAdapter {
  switch (provider.protocol) {
    case 'ollama-native':
      return new OllamaNativeAdapter(provider.base_url);
    case 'openrouter':
      if (!apiKey) {
        throw new Error(
          `provider "${provider.name}" (openrouter) requires a chatbot-level api_key. ` +
            `Set one with \`sw chatbot set-api-key <slug>\`.`,
        );
      }
      return new OpenRouterAdapter({
        apiKey,
        baseUrl: provider.base_url,
      });
    default: {
      // SUPPORTED_PROTOCOLS narrows provider.protocol; this is the
      // exhaustiveness guard.
      const exhaustive: never = provider.protocol;
      throw new Error(`unknown protocol "${exhaustive as string}"`);
    }
  }
}
