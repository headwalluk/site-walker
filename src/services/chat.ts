import type { Knex } from 'knex';
import { buildAdapter } from '../providers/index.js';
import type { ChatMessage, ProtocolAdapter } from '../providers/index.js';
import type { Provider } from './providers.js';
import { decrypt } from '../utils/crypto.js';
import { loadEncryptionKey } from '../config/secrets.js';
import { estimateTokens } from '../utils/tokens.js';
import { appendMessage, findSessionByToken, listMessages, type Message } from './sessions.js';
import { defaultHeadroom, resolveModel, type ResolvedModel } from './models.js';
import { assemblePrompt, loadDiskBlocks } from './system-blocks.js';
import { getChatbotById, type Chatbot } from './chatbots.js';

export const MAX_MESSAGE_CHARS = 8000;

export type ChatErrorCode =
  | 'invalid_token'
  | 'message_required'
  | 'message_too_long'
  | 'context_overflow'
  | 'model_not_configured'
  | 'chatbot_api_key_missing'
  | 'model_error';

/**
 * Service-layer errors carry a stable `code` the route handler maps to a
 * status code. Keeps HTTP concerns out of the service.
 */
export class ChatError extends Error {
  readonly code: ChatErrorCode;
  readonly detail?: Record<string, unknown>;

  constructor(code: ChatErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

export type AdapterFactory = (provider: Provider, apiKey?: string) => ProtocolAdapter;

export interface RunChatInput {
  db: Knex;
  sessionToken: string;
  message: string;
  /** Override the system-blocks base directory (tests use this). */
  blocksBaseDir?: string;
  /** Replace the adapter factory (tests inject a fake here). */
  adapterFactory?: AdapterFactory;
}

export interface RunChatResult {
  reply: string;
  message_id: number;
  tokens_used?: { prompt: number; completion: number };
}

function historyToChatMessages(history: Message[]): ChatMessage[] {
  return history.map((m) => ({ role: m.role, content: m.content }));
}

/**
 * Decrypt the chatbot's stored API key, if present. Returns undefined when
 * the chatbot hasn't set one. Throws ChatError('chatbot_api_key_missing')
 * when the provider is metered and the chatbot has no key — caller does
 * not need to handle that case itself.
 */
function decryptChatbotApiKey(chatbot: Chatbot, provider: Provider): string | undefined {
  const { provider_api_key_ciphertext, provider_api_key_nonce, provider_api_key_auth_tag } =
    chatbot;

  if (provider_api_key_ciphertext && provider_api_key_nonce && provider_api_key_auth_tag) {
    const key = loadEncryptionKey();
    return decrypt(
      {
        ciphertext: provider_api_key_ciphertext,
        nonce: provider_api_key_nonce,
        authTag: provider_api_key_auth_tag,
      },
      key,
    );
  }

  if (provider.is_metered) {
    throw new ChatError(
      'chatbot_api_key_missing',
      `chatbot "${chatbot.slug}" targets metered provider "${provider.name}" but has no api_key set. ` +
        `Run \`sw chatbot set-api-key ${chatbot.slug}\` to provide one.`,
      { chatbot: chatbot.slug, provider: provider.name },
    );
  }

  return undefined;
}

export async function runChat(input: RunChatInput): Promise<RunChatResult> {
  const { db, sessionToken, message, blocksBaseDir, adapterFactory } = input;
  const makeAdapter: AdapterFactory = adapterFactory ?? buildAdapter;

  const trimmed = message.trim();
  if (trimmed.length === 0) {
    throw new ChatError('message_required', 'message must be a non-empty string');
  }
  if (trimmed.length > MAX_MESSAGE_CHARS) {
    throw new ChatError(
      'message_too_long',
      `message must be at most ${MAX_MESSAGE_CHARS} characters (got ${trimmed.length})`,
      { limit: MAX_MESSAGE_CHARS, length: trimmed.length },
    );
  }

  const session = await findSessionByToken(db, sessionToken);
  if (!session) {
    throw new ChatError('invalid_token', 'session token is invalid');
  }

  const chatbot = await getChatbotById(db, session.chatbot_id);
  if (!chatbot) {
    // Session FK CASCADE should prevent this, but stay defensive.
    throw new ChatError('invalid_token', 'session is orphaned');
  }

  let resolved: ResolvedModel;
  try {
    resolved = await resolveModel(db, chatbot);
  } catch (err) {
    throw new ChatError('model_not_configured', (err as Error).message);
  }

  // Surface a missing api_key for metered providers before we do any further
  // work (assemble blocks, count tokens). Caller gets a clean 503.
  const apiKey = decryptChatbotApiKey(chatbot, resolved.provider);

  const diskBlocks = blocksBaseDir
    ? await loadDiskBlocks(chatbot.slug, blocksBaseDir)
    : await loadDiskBlocks(chatbot.slug);
  const assembled = assemblePrompt({
    persona: chatbot.persona,
    diskBlocks,
  });

  const history = await listMessages(db, session.id);

  if (resolved.contextWindow !== null) {
    const historyTokens = history.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    const userTokens = estimateTokens(trimmed);
    const totalPromptTokens = assembled.estimatedTokens + historyTokens + userTokens;
    const headroom = defaultHeadroom(resolved.contextWindow);
    if (totalPromptTokens + headroom > resolved.contextWindow) {
      throw new ChatError(
        'context_overflow',
        `assembled prompt + history + new message ~${totalPromptTokens} tokens leaves no headroom ` +
          `against model_context_window=${resolved.contextWindow} for model "${resolved.modelSlug}".`,
        {
          system_tokens: assembled.estimatedTokens,
          history_tokens: historyTokens,
          user_tokens: userTokens,
          total_prompt_tokens: totalPromptTokens,
          context_window: resolved.contextWindow,
          headroom_tokens: headroom,
        },
      );
    }
  }

  await appendMessage(db, session.id, 'user', trimmed);

  const messages: ChatMessage[] = [
    { role: 'system', content: assembled.prompt },
    ...historyToChatMessages(history),
    { role: 'user', content: trimmed },
  ];

  const adapter = makeAdapter(resolved.provider, apiKey);

  let response;
  try {
    response = await adapter.chat({
      model: resolved.model,
      messages,
      parameters: resolved.parameters,
    });
  } catch (err) {
    throw new ChatError('model_error', (err as Error).message);
  }

  const assistant = await appendMessage(db, session.id, 'assistant', response.reply);

  const result: RunChatResult = { reply: response.reply, message_id: assistant.id };
  if (response.tokensUsed) {
    result.tokens_used = response.tokensUsed;
  }
  return result;
}
