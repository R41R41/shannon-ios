import { createHash } from 'node:crypto';
import type { CompanionStateStore } from '@shannon/cognition';
import { CONVERSATION_TOOL_CALLS, type ShannonModelToolSession } from './chatModelTools.js';
import { conversationSecrets, type SecretCheck } from './conversationSecrets.js';
import type { ConversationStore, StoredConversationMessage } from './conversationStore.js';
import { ToolAudienceWatch, type ToolAudienceSource } from './shannonToolAudience.js';
import type { ShannonToolRunner } from './shannonToolRunner.js';
import { toolTraceCall } from './shannonToolTrace.js';
import { InMemoryToolTraces, TOOL_FOLLOW_UP_MILLISECONDS, ToolTurnLog } from './shannonToolTurns.js';
import { toolSessionMemory } from './shannonToolTypes.js';
import { ownToolsEnabled, toolFromProviderName, toolResultForModel } from './shannonTools.js';
import type { TurnDeadline } from './turnDeadline.js';

/**
 * The tools of one conversation turn, for the model adapter (`chatModelTools.ts`). Owner decision 2026-10-05: her
 * study and her folder are offered only while the owner alone can see or hear the reply, so with a guest, with
 * 「友人も一緒」, or with anyone else present the turn has no tools at all and nothing of them can be said to others.
 *
 * Text offers them in every turn the owner alone reads (unless it forces a web search). Voice offers them when the
 * words are about her writing or her folder (`asksAboutOwnThings`), and to the follow-ups of such a talk
 * (`voiceToolOffer`), so that an ordinary spoken turn keeps its speed. `ownerAlone: 'others'` is the owner's own call
 * with someone else listening: a voice turn that would be offered tools is told in one line that they are withheld.
 *
 * Every call is also noted, compactly, in the turn's trace (`shannonToolTrace.ts`), which is kept with the stored turn
 * and replayed to her later turns with the owner alone (`conversationWindow.ts`).
 */
export function conversationTools(
  autonomy: { tools?: ShannonToolRunner } | undefined, scopeKey: string, surface: 'text' | 'voice', ownerAlone: boolean | 'others',
  server: Partial<ConversationToolServer>,
  /** The owner's message this turn answers, `${threadId}\n${words}`: a retry of it does not write the same piece twice. */
  turn: string,
  /** The turn's one deadline, from the request's arrival (`turnDeadline.ts`): every round and call takes its time from it. */
  deadline: TurnDeadline,
): { tools?: ShannonModelToolSession; toolsWithheld?: true } {
  const runner = autonomy?.tools;
  // Without what the server knows of the audience, nothing is offered (and nothing said about it).
  if (!runner || ownerAlone === false || !ownToolsEnabled() || !server.audience) return {};
  const threadId = turn.slice(0, Math.max(0, turn.indexOf('\n')));
  const words = turn.slice(turn.indexOf('\n') + 1);
  const offer = surface === 'voice' ? voiceToolOffer(words, server, scopeKey, threadId) : 'text';
  if (!offer) return {};
  // What the client said is not enough: what the server knows of others present vetoes the offer, and she is told so.
  if (ownerAlone === 'others' || server.audience.othersKnown(scopeKey)) return { toolsWithheld: true };
  const definitions = runner.offered(surface, 'owner_alone');
  if (!definitions.length) return {};
  const trace = server.turns?.open(scopeKey, threadId, words, offer === 'asked');
  const memory = toolSessionMemory(createHash('sha256').update(`${scopeKey}\n${turn}`).digest('hex'));
  let check: SecretCheck | null | undefined;
  const session = { definitions, maximumCalls: CONVERSATION_TOOL_CALLS } as ShannonModelToolSession;
  Object.defineProperty(session, 'deadline', { enumerable: false, value: deadline });
  // Not enumerable: two turns that offer the same tools are the same request (what the model is asked), whoever runs the calls.
  Object.defineProperty(session, 'call', {
    enumerable: false,
    value: async (providerName: string, argumentsJson: string, signal?: AbortSignal, timeMilliseconds?: number) => {
      const tool = toolFromProviderName(providerName);
      // What must reach nobody but the owner, read at the moment of the call; a list that cannot be read is null, and writes are then refused.
      // Read once a turn; a list that could not be read is tried again at the next call.
      if (!check) { try { check = server.secrets?.(scopeKey); } catch { check = null; } }
      const secrets = check;
      const result = await runner.call(tool?.name ?? providerName.slice(0, 80), argumentsJson, {
        scopeKey, surface, audience: 'owner_alone', memory, ...(secrets !== undefined ? { secrets } : {}), ...(timeMilliseconds !== undefined ? { timeMilliseconds } : {}),
      }, signal);
      trace?.called(toolTraceCall(tool?.name ?? providerName.slice(0, 80), argumentsJson, result, secrets));
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

/** Her reply offered something she would do with her tools and asks him to say yes (「中を見てみましょうか？」). */
const HER_THING = /(?:メモ|ノート|物語|お話|ファイル|フォルダ|書斎|下書き|原稿|ゴミ箱)/u;
const HER_ACT = /(?:作|書|消|残|保存|読|見|開|移|直|まとめ|置|戻)/u;
const ASKS_YES = /(?:(?:ましょう|ます|ても|ていい|でいい|いいです|よろしいです|します|しましょう)か|どうしますか|[？?])[。．\s]*$/u;

export function asksToConfirmToolAction(reply: string): boolean {
  const last = reply.trim().split(/(?<=[。！!])/u).slice(-2).join('');
  return HER_THING.test(last) && HER_ACT.test(last) && ASKS_YES.test(last);
}

/**
 * Whether a spoken turn of the owner alone is offered her tools: `asked` when his words are about her things;
 * `follow_up` when the same Talk had, in the last ten minutes, a turn that asked about them or used them (「もっとよく
 * 見て」「はい、お願いします」 name nothing of hers), or when her last reply, in that time, asked him to confirm
 * something she would do with them. Otherwise null: the turn keeps the plain path's speed.
 */
export function voiceToolOffer(words: string, server: Partial<ConversationToolServer>, scopeKey: string, threadId: string): 'asked' | 'follow_up' | null {
  if (asksAboutOwnThings(words)) return 'asked';
  if (server.turns?.recent(scopeKey, threadId)) return 'follow_up';
  let last: StoredConversationMessage | undefined;
  try { last = server.lastMessage?.(scopeKey, threadId); } catch { last = undefined; }
  const recent = last?.role === 'assistant' && Date.parse(server.now?.() ?? '') - Date.parse(last.observedAt) < TOOL_FOLLOW_UP_MILLISECONDS;
  return recent && asksToConfirmToolAction(last!.content) ? 'follow_up' : null;
}

/** What the server, not the client, knows when it offers her tools in a conversation. */
export interface ConversationToolServer {
  audience: Pick<ToolAudienceWatch, 'othersKnown' | 'noteOthers'>;
  secrets: (scopeKey: string) => SecretCheck | null;
  /** The tool calls of each turn until it is stored, their traces after, and which Talks are in a talk about her things. */
  turns: ToolTurnLog;
  /** The newest message of a Talk, for a reply of hers that asked him to confirm. */
  lastMessage: (scopeKey: string, threadId: string) => StoredConversationMessage | undefined;
  now: () => string;
}

export function conversationToolServer(
  body: ToolAudienceSource | null, stateStore: Pick<CompanionStateStore, 'snapshot'>,
  conversations: Pick<ConversationStore, 'experienceCandidates' | 'conversationHistory' | 'recentMessages' | 'saveToolTrace' | 'toolTraces'>, now: () => string,
): ConversationToolServer {
  const traces = conversations.saveToolTrace && conversations.toolTraces
    ? { saveToolTrace: conversations.saveToolTrace.bind(conversations), toolTraces: conversations.toolTraces.bind(conversations) } : new InMemoryToolTraces();
  return {
    audience: new ToolAudienceWatch(body, now),
    secrets: scopeKey => { try { return conversationSecrets(stateStore.snapshot(scopeKey), conversations, scopeKey); } catch { return null; } },
    turns: new ToolTurnLog(traces, now),
    lastMessage: (scopeKey, threadId) => (conversations.recentMessages?.(scopeKey, threadId, 1) ?? conversations.conversationHistory(scopeKey, threadId).slice(-1)).at(-1),
    now,
  };
}
