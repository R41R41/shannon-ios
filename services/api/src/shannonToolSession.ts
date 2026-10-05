import { createHash } from 'node:crypto';
import type { CompanionStateStore } from '@shannon/cognition';
import { CONVERSATION_TOOL_CALLS, type ShannonModelToolSession } from './chatModelTools.js';
import { conversationSecrets, type SecretCheck } from './conversationSecrets.js';
import type { ConversationStore } from './conversationStore.js';
import { ToolAudienceWatch, type ToolAudienceSource } from './shannonToolAudience.js';
import type { ShannonToolRunner } from './shannonToolRunner.js';
import { toolSessionMemory } from './shannonToolTypes.js';
import { ownToolsEnabled, toolFromProviderName, toolResultForModel } from './shannonTools.js';

/**
 * The tools of one conversation turn, for the model adapter (`chatModelTools.ts`). Owner decision 2026-10-05: her
 * study and her folder are offered only while the owner alone can see or hear the reply, so with a guest, with
 * 「友人も一緒」, or with anyone else present the turn has no tools at all and nothing of them can be said to others.
 *
 * Text offers them in every turn the owner alone reads (unless it forces a web search). Voice offers them only when
 * the words are about her writing or her folder (`asksAboutOwnThings`), so that an ordinary spoken turn keeps its speed.
 */
export function conversationTools(
  autonomy: { tools?: ShannonToolRunner } | undefined, scopeKey: string, surface: 'text' | 'voice', ownerAlone: boolean,
  server: Partial<ConversationToolServer> = {},
  /** The owner's message this turn answers (thread and words): a retry of it does not write the same piece twice. */
  turn?: string,
): { tools?: ShannonModelToolSession; toolsWithheld?: true } {
  const runner = autonomy?.tools;
  if (!runner || !ownerAlone || !ownToolsEnabled()) return {};
  // What the client said is not enough: what the server knows of others present vetoes the offer, and she is told so.
  if (server.audience?.othersKnown(scopeKey) !== false) return { toolsWithheld: true };
  const definitions = runner.offered(surface, 'owner_alone');
  if (!definitions.length) return {};
  const memory = toolSessionMemory(turn ? createHash('sha256').update(`${scopeKey}\n${turn}`).digest('hex') : undefined);
  let check: SecretCheck | null | undefined;
  const session = { definitions, maximumCalls: CONVERSATION_TOOL_CALLS } as ShannonModelToolSession;
  // Not enumerable: two turns that offer the same tools are the same request (what the model is asked), whoever runs the calls.
  Object.defineProperty(session, 'call', {
    enumerable: false,
    value: async (providerName: string, argumentsJson: string, signal?: AbortSignal) => {
      const tool = toolFromProviderName(providerName);
      // What must reach nobody but the owner, read at the moment of the call; a list that cannot be read is null, and writes are then refused.
      // Read once a turn; a list that could not be read is tried again at the next call.
      if (!check) { try { check = server.secrets?.(scopeKey); } catch { check = null; } }
      const secrets = check;
      const result = await runner.call(tool?.name ?? providerName.slice(0, 80), argumentsJson, { scopeKey, surface, audience: 'owner_alone', memory, ...(secrets !== undefined ? { secrets } : {}) }, signal);
      return toolResultForModel(result);
    },
  });
  return { tools: session };
}

/**
 * Words of a spoken turn that are about her own writing or her folder: the voice turn then offers her tools. Her study
 * and her folder are named outright; a story, a note or a file only with words that make it hers.
 */
const HER_PLACES = /(?:書斎|下書き|原稿|草稿|ゴミ箱|(?:君|きみ|キミ|シャノン|自分|ボク|ぼく|お前)の(?:フォルダ|ファイル))/u;
const HER_WORK = /(?:物語|お話|メモ|ノート|ファイル|フォルダ|話の続き)/u;
const MAKES_IT_HERS = /(?:君|きみ|キミ|シャノン|自分|ボク|ぼく|お前)(?:の|が)|書いた(?:の|もの|やつ)|書いてる|書いている|書き直/u;

export function asksAboutOwnThings(transcript: string): boolean {
  return HER_PLACES.test(transcript) || (HER_WORK.test(transcript) && MAKES_IT_HERS.test(transcript));
}

/** What the server, not the client, knows when it offers her tools in a conversation. */
export interface ConversationToolServer {
  audience: Pick<ToolAudienceWatch, 'othersKnown' | 'noteOthers'>;
  secrets: (scopeKey: string) => SecretCheck | null;
}

export function conversationToolServer(
  body: ToolAudienceSource | null, stateStore: Pick<CompanionStateStore, 'snapshot'>, conversations: Pick<ConversationStore, 'experienceCandidates'>, now: () => string,
): ConversationToolServer {
  return {
    audience: new ToolAudienceWatch(body, now),
    secrets: scopeKey => { try { return conversationSecrets(stateStore.snapshot(scopeKey), conversations, scopeKey); } catch { return null; } },
  };
}
