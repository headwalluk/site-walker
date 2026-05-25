import type { Knex } from 'knex';
import { buildAdapter } from '../providers/index.js';
import type { ChatMessage, ProtocolAdapter } from '../providers/index.js';
import type { Provider } from './providers.js';
import { decrypt } from '../utils/crypto.js';
import { loadEncryptionKey } from '../config/secrets.js';
import { computeCostUsd } from './cost.js';
import { estimateTokens } from '../utils/tokens.js';
import { appendMessage, findSessionByToken, listMessages, type Message } from './sessions.js';
import { defaultHeadroom, resolveModel, type ResolvedModel } from './models.js';
import { assemblePrompt, loadDiskBlocks, loadHandoffBlock } from './system-blocks.js';
import { getChatbotById, type Chatbot } from './chatbots.js';
import { getSessionSpend, isSessionBudgetExhausted, parseCapDecimal } from './budget.js';
import { notifyHandoff } from './handoff-webhook.js';
import { env as runtimeEnv } from '../config/env.js';

export const MAX_MESSAGE_CHARS = 8000;

/**
 * Fallback when the chatbot has no HANDOFF_HARD.md on disk. Returned to
 * the visitor when their session is terminated (after the M20 hard-cap
 * was hit). Operator-templated content in HANDOFF_HARD.md overrides this.
 */
export const DEFAULT_HARD_HANDOFF =
  'I think it would be better to talk to a human representative. ' +
  'Please leave your email address and someone will be in touch soon.';

/**
 * M23.6 final-turn wind-down hint, injected into the system prompt for the
 * turn that's about to trip the hard cap. Tells the LLM not to end with a
 * follow-up question — the widget will disable the input after this reply,
 * so any "what else can I help with?" prompt would dead-end the visitor.
 *
 * Hardcoded for v1. Operators who want to customise can ask; a `HANDOFF_FINAL.md`
 * file override is a focused additive change if a real customer raises it.
 */
export const HANDOFF_FINAL_HINT_CONTENT =
  'This is your final reply in this conversation. After your reply, the visitor ' +
  'will not be able to send another message — the chat widget will disable its ' +
  'input. Conclude your response naturally and do NOT end with a question or an ' +
  'invitation to continue the conversation.';

/**
 * M23.6: a session is considered "in the final-turn danger zone" once spend
 * is past this percentage of the configured session cap. Any reply we
 * generate at or beyond this point gets the HANDOFF_FINAL hint so the LLM
 * winds the conversation down gracefully rather than asking a follow-up
 * question on what turns out to be the last turn.
 *
 * Set at 95% (vs the default soft-handoff trigger at 80%) so there's a
 * clear hand-off-to-human zone between soft and final. False positives are
 * the safer side: an over-cautious wind-down is a much smaller UX problem
 * than a trailing question the visitor can't answer.
 */
export const FINAL_TURN_DANGER_THRESHOLD_PCT = 95;

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
  /**
   * M23.5 simulation hooks for acceptance testing. Per-field override of
   * `runtimeEnv.sim`. Each field:
   *   - `undefined` (omitted) → fall back to runtimeEnv.sim
   *   - `null`                → explicit force-off, overrides any env value
   *   - number                → explicit threshold, overrides any env value
   *
   * Tests use `null` to immunise themselves from a dev shell that has
   * `SW_SIM_*` env vars set for live acceptance testing.
   */
  sim?: {
    softHandoffAfterUserTurns?: number | null;
    hardHandoffAfterUserTurns?: number | null;
  };
}

/**
 * Resolve a sim threshold from per-call opts vs env. See `RunChatInput.sim`
 * for the contract: undefined → env, null/number → that value.
 */
export function resolveSimValue(
  optsValue: number | null | undefined,
  envValue: number | null,
): number | null {
  return optsValue === undefined ? envValue : optsValue;
}

export interface RunChatResult {
  reply: string;
  message_id: number;
  tokens_used?: { prompt: number; completion: number };
  /**
   * M20: true when the session is closed and no further LLM calls will be
   * processed. The visitor's widget surfaces an email-capture input when
   * this is set. Two cases trigger it: (a) the session was already
   * terminated before this turn (canned response, message_id = 0); (b) the
   * just-written assistant reply pushed session spend over the cap — the
   * caller got their final natural reply, but the next turn would be
   * refused. Either way, the widget treats this as the final exchange.
   */
  session_terminated?: boolean;
}

function historyToChatMessages(history: Message[]): ChatMessage[] {
  return history.map((m) => ({ role: m.role, content: m.content }));
}

/**
 * `provider_models.input_per_million_usd` / `output_per_million_usd` are
 * DECIMAL(10,6) — mysql2 returns them as strings to preserve precision.
 * computeCostUsd takes numbers, so we convert here. NULL stays NULL (the
 * unmetered signal).
 */
function parseNullableDecimal(value: string | null): number | null {
  return value === null ? null : Number(value);
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

  // M20: a session that was previously hard-capped returns the canned
  // HANDOFF_HARD.md content without invoking the LLM. The visitor's widget
  // sees session_terminated: true and renders the email-capture input.
  if (session.terminated_at !== null) {
    const cannedHard =
      (blocksBaseDir
        ? await loadHandoffBlock(chatbot.slug, 'hard', blocksBaseDir)
        : await loadHandoffBlock(chatbot.slug, 'hard')) ?? DEFAULT_HARD_HANDOFF;
    return {
      reply: cannedHard,
      message_id: 0,
      session_terminated: true,
    };
  }

  let resolved: ResolvedModel;
  try {
    resolved = await resolveModel(db, chatbot);
  } catch (err) {
    throw new ChatError('model_not_configured', (err as Error).message);
  }

  // The daily cap is enforced at session-mint (POST /sessions, GET
  // /sessions/can-start) and deliberately NOT here. Once a session has a
  // token, the visitor in front of the widget shouldn't be cut off
  // mid-conversation because *other* sessions pushed the chatbot over its
  // daily cap. The session cap (below) is what bounds any individual
  // conversation; effective max daily spend at the chatbot is therefore
  // `daily_budget_usd + (live_sessions × session_budget_usd)`, which the
  // operator sizes accordingly.

  // Surface a missing api_key for metered providers before we do any further
  // work (assemble blocks, count tokens). Caller gets a clean 503.
  const apiKey = decryptChatbotApiKey(chatbot, resolved.provider);

  const diskBlocks = blocksBaseDir
    ? await loadDiskBlocks(chatbot.slug, blocksBaseDir)
    : await loadDiskBlocks(chatbot.slug);

  // M23.5: resolve sim thresholds for this turn. Per-request `input.sim`
  // wins over env so tests can dial values per-test without mutating
  // process.env (the env module is a module-load singleton). An explicit
  // `null` in opts forces sim off regardless of env — tests use that to
  // immunise themselves from a dev shell that has SW_SIM_* set.
  const simSoftAfter = resolveSimValue(
    input.sim?.softHandoffAfterUserTurns,
    runtimeEnv.sim.softHandoffAfterUserTurns,
  );
  const simHardAfter = resolveSimValue(
    input.sim?.hardHandoffAfterUserTurns,
    runtimeEnv.sim.hardHandoffAfterUserTurns,
  );

  // Load history early — used for both the M23.5 user-turn sim count AND
  // the context-overflow check + adapter call further down.
  const history = await listMessages(db, session.id);
  // +1 because the incoming user message hasn't been written yet but is
  // part of this turn from the sim trigger's point of view.
  const userTurnCount = history.filter((m) => m.role === 'user').length + 1;

  // M20 + M21: session cap source depends on whether this is an admin-mode
  // session (admin_session_budget_usd) or a customer session (session_budget_usd).
  // The soft-handoff inject + webhook firing are also suppressed for admin
  // sessions — the "wind down to a human" cue is meaningless when the
  // visitor IS the human.
  const sessionCap = parseCapDecimal(
    session.is_admin_mode ? chatbot.admin_session_budget_usd : chatbot.session_budget_usd,
  );
  const sessionSpendBefore = sessionCap !== null ? await getSessionSpend(db, session.id) : 0;
  const softThresholdUsd =
    !session.is_admin_mode && sessionCap !== null
      ? (sessionCap * chatbot.handoff_threshold_pct) / 100
      : null;
  const realSoftTriggered = softThresholdUsd !== null && sessionSpendBefore >= softThresholdUsd;
  // M23.5 sim trigger: fires when user-turn count crosses the configured
  // threshold. Admin-mode still suppresses — sim doesn't override semantic
  // decisions, just lowers the trigger threshold for testing.
  const simSoftTriggered =
    !session.is_admin_mode && simSoftAfter !== null && userTurnCount >= simSoftAfter;
  const softTriggered = realSoftTriggered || simSoftTriggered;
  const extraBlocks: { name: string; content: string }[] = [];
  if (softTriggered) {
    const softContent = blocksBaseDir
      ? await loadHandoffBlock(chatbot.slug, 'soft', blocksBaseDir)
      : await loadHandoffBlock(chatbot.slug, 'soft');
    if (softContent !== null) {
      extraBlocks.push({ name: 'HANDOFF_SOFT', content: softContent });
    }
  }

  // M23.6 final-turn predictor: if this turn is likely to trip the hard
  // cap (either the real spend-based cap or the M23.5 sim threshold),
  // inject a built-in wind-down hint so the LLM doesn't sign off with
  // "anything else?" right before the widget disables the visitor's input.
  //
  // Two paths feed it:
  //   - real spend: we're already past FINAL_TURN_DANGER_THRESHOLD_PCT of
  //     the session cap. A heuristic — any non-trivial reply at this
  //     spend level is plausibly the one that crosses the cap.
  //   - sim hard:   the user-turn count has reached the configured sim
  //     threshold. Exact prediction (the sim trigger is itself turn-count
  //     based), so the hint fires on the same turn that will terminate.
  //
  // Admin-mode suppresses (consistent with M21 + the soft handoff): an
  // admin testing the bot doesn't need a wind-down. Their hard sim still
  // terminates the session, but the LLM doesn't need to wind down for it.
  const realFinalTriggered =
    sessionCap !== null &&
    sessionSpendBefore >= (sessionCap * FINAL_TURN_DANGER_THRESHOLD_PCT) / 100;
  const simFinalTriggered = simHardAfter !== null && userTurnCount >= simHardAfter;
  const finalTriggered = !session.is_admin_mode && (realFinalTriggered || simFinalTriggered);
  if (finalTriggered) {
    extraBlocks.push({ name: 'HANDOFF_FINAL', content: HANDOFF_FINAL_HINT_CONTENT });
  }

  const assembled = assemblePrompt({
    persona: chatbot.persona,
    diskBlocks,
    extraBlocks: extraBlocks.length > 0 ? extraBlocks : undefined,
  });

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

  await appendMessage(db, session.id, 'user', trimmed, { chatbotId: chatbot.id });

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

  // M18: record token + USD cost on the assistant row. Cache fields stay
  // NULL until the post-M20 cache-marker wiring milestone teaches the
  // OpenRouter adapter to surface them; today every row's cache cells are
  // NULL and computeCostUsd degenerates to the two-bucket case.
  const tokensIn = response.tokensUsed?.prompt ?? null;
  const tokensOut = response.tokensUsed?.completion ?? null;
  const inputPrice = parseNullableDecimal(resolved.providerModel.input_per_million_usd);
  const outputPrice = parseNullableDecimal(resolved.providerModel.output_per_million_usd);
  const costUsd = computeCostUsd({
    tokensIn,
    tokensOut,
    inputPerMillionUsd: inputPrice,
    outputPerMillionUsd: outputPrice,
  });

  const assistant = await appendMessage(db, session.id, 'assistant', response.reply, {
    chatbotId: chatbot.id,
    tokensIn,
    tokensOut,
    costUsd,
  });

  const result: RunChatResult = { reply: response.reply, message_id: assistant.id };
  if (response.tokensUsed) {
    result.tokens_used = response.tokensUsed;
  }

  // M20: session-cap check is AFTER writing the assistant reply, by design
  // — a visitor who's one message over cap gets that one final reply
  // rather than being cut off mid-thought. If we just crossed the cap,
  // terminate the session: the next POST /chat returns the canned hard-
  // handoff message without invoking the LLM.
  // M23.5: the sim trigger fires alongside the real one; whichever
  // condition is true terminates the session.
  const sessionSpendAfter = sessionSpendBefore + costUsd;
  const realHardTriggered =
    sessionCap !== null && isSessionBudgetExhausted(sessionSpendAfter, sessionCap);
  const simHardTriggered = simHardAfter !== null && userTurnCount >= simHardAfter;
  if (realHardTriggered || simHardTriggered) {
    await db('sessions').where({ id: session.id }).update({ terminated_at: db.fn.now() });
    result.session_terminated = true;
    // M21: admin-mode sessions terminate normally (safety belt) but DO NOT
    // fire the handoff webhook — the operator would just be receiving a
    // notification about themselves.
    if (!session.is_admin_mode) {
      // Fire-and-forget webhook (does nothing if handoff_webhook_url unset).
      // We refetch the session to pick up the freshly-set terminated_at; if
      // the visitor has captured an email earlier the webhook carries it.
      const refreshed = await findSessionByToken(db, sessionToken);
      if (refreshed) {
        void notifyHandoff({
          db,
          chatbot,
          session: refreshed,
          spendUsd: sessionSpendAfter,
        });
      }
    }
  }

  return result;
}
