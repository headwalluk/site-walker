import type { ProviderEntry } from '../config/site-walker-config.js';
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
 * Build a protocol adapter from a registry entry.
 *
 * Implemented:
 *  - ollama-native (M5)
 *  - openrouter   (0.9.0)
 *
 * Still to land:
 *  - anthropic           — direct Messages API (planned alongside Gemini/OpenAI cluster)
 *  - openai-compatible   — generic OpenAI-clone provider (reserved)
 */
export function buildAdapter(entry: ProviderEntry): ProtocolAdapter {
  switch (entry.protocol) {
    case 'ollama-native': {
      if (!entry.base_url) {
        throw new Error(
          `provider "${entry.name}" (ollama-native) requires base_url in site-walker.toml`,
        );
      }
      return new OllamaNativeAdapter(entry.base_url);
    }
    case 'openrouter': {
      if (!entry.api_key) {
        throw new Error(
          `provider "${entry.name}" (openrouter) requires api_key in site-walker.toml`,
        );
      }
      return new OpenRouterAdapter({
        apiKey: entry.api_key,
        baseUrl: entry.base_url,
      });
    }
    case 'anthropic':
    case 'openai-compatible':
      throw new Error(
        `provider "${entry.name}" uses protocol "${entry.protocol}", which is not implemented yet. ` +
          `Use openrouter to reach Anthropic models in the meantime.`,
      );
    default: {
      const exhaustiveCheck: never = entry.protocol;
      throw new Error(`unknown protocol "${exhaustiveCheck as string}"`);
    }
  }
}
