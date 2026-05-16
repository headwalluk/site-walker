import type { ProviderEntry } from '../config/site-walker-config.js';
import { OllamaNativeAdapter } from './ollama-native.js';
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
 * Build a protocol adapter from a registry entry. M5 ships ollama-native
 * only; openrouter / anthropic / openai-compatible land in M8.
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
    case 'anthropic':
    case 'openrouter':
    case 'openai-compatible':
      throw new Error(
        `provider "${entry.name}" uses protocol "${entry.protocol}", which is not implemented in M5. ` +
          `openrouter and anthropic land in M8.`,
      );
    default: {
      const exhaustiveCheck: never = entry.protocol;
      throw new Error(`unknown protocol "${exhaustiveCheck as string}"`);
    }
  }
}
