import type { Knex } from 'knex';
import type { ProviderEntry, ProviderRegistry } from '../config/site-walker-config.js';
import { buildAdapter } from '../providers/index.js';
import type { ChatMessage, ProtocolAdapter } from '../providers/index.js';
import { estimateTokens } from '../utils/tokens.js';
import { appendMessage, findSessionByToken, listMessages, type Message } from './sessions.js';
import { defaultHeadroom, resolveModel, type ResolvedModel } from './models.js';
import { assemblePrompt, loadDiskBlocks } from './system-blocks.js';
import { getChatbotById } from './chatbots.js';

export const MAX_MESSAGE_CHARS = 8000;

export type ChatErrorCode =
  | 'invalid_token'
  | 'message_required'
  | 'message_too_long'
  | 'context_overflow'
  | 'model_not_configured'
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

export type AdapterFactory = (entry: ProviderEntry) => ProtocolAdapter;

export interface RunChatInput {
  db: Knex;
  registry: ProviderRegistry;
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

export async function runChat(input: RunChatInput): Promise<RunChatResult> {
  const { db, registry, sessionToken, message, blocksBaseDir, adapterFactory } = input;
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
    resolved = resolveModel(chatbot, registry);
  } catch (err) {
    throw new ChatError('model_not_configured', (err as Error).message);
  }

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

  const adapter = makeAdapter(resolved.provider);

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
