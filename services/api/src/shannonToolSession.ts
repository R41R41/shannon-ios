import { createHash } from 'node:crypto';
import type { CompanionStateStore } from '@shannon/cognition';
import { CONVERSATION_TOOL_CALLS, type ShannonModelToolSession, type ToolCallOutcome } from './chatModelTools.js';
import type { OthersTextCheck } from './aetherShownText.js';
import { conversationSecrets, othersSecrets, type SecretCheck } from './conversationSecrets.js';
import type { ConversationStore, StoredConversationMessage } from './conversationStore.js';
import { ToolAudienceWatch, type ToolAudienceSource } from './shannonToolAudience.js';
import type { ShannonToolRunner } from './shannonToolRunner.js';
import { toolTraceCall } from './shannonToolTrace.js';
import { InMemoryToolTraces, TOOL_FOLLOW_UP_MILLISECONDS, ToolTurnLog, type ToolTraceStore } from './shannonToolTurns.js';
import { toolSessionMemory } from './shannonToolTypes.js';
import { ownToolsEnabled, providerToolName, toolFailure, toolFromProviderName, toolResultForModel } from './shannonTools.js';
import type { TurnDeadline } from './turnDeadline.js';
import { answersWithPlace, asksForMemo, asksWhichPlace, namesAether } from './memoPlace.js';
export { withMinecraftToolLine } from './shannonMinecraftTools.js';
export { withToolCapabilityLines } from './shannonAetherTools.js';

/**
 * The tools of one conversation turn, for the model adapter (`chatModelTools.ts`). Owner decision 2026-10-05: her
 * study and her folder are offered only while the owner alone can see or hear the reply, so with a guest, with
 * 「友人も一緒」, or with anyone else present the turn has no tools at all and nothing of them can be said to others.
 *
 * With anyone else present only her Aether reading tools are offered (when Aether is configured), with the audience
 * `others`, so the gate holds them to 「シャノン用フォルダ」 (owner decision 2026-10-06); without them nothing is offered.
 * What she reads there reaches the model without the owner's private things (`aetherShownText.ts`, `othersText`).
 *
 * `ownerAlone: 'guests'` is a turn the owner did not speak or write (owner decision 2026-10-06, Syzygy ADR-0007): a friend
 * in 「友人も一緒」, someone else on a platform. It is offered the same Aether reading tools and nothing else; while they
 * are not offered (Aether not configured) it gets nothing and nothing is said about it, exactly as `false`. Its calls
 * are kept in no trace: its turn is never stored in the owner's Talk. `openOnly`: nobody present may release a protected
 * line of the owner's (a turn someone else wrote on a platform), so what she reads carries no marker (his secrets and
 * personal matters are left out of it in every turn with others, `aetherShownText.ts`).
 *
 * `ownerAlone: 'shared'` is the owner's own turn that others can read (app text marked `others`, his turn in a shared
 * platform conversation; owner decision 2026-10-06): like `'others'`, except that while nothing is offered it gets nothing
 * and is told nothing, exactly as `false`.
 *
 * Text offers them in every turn the owner alone reads (unless it forces a web search). Voice offers them when the
 * words are about her writing or her folder (`asksAboutOwnThings`) or ask for a memo without naming Aether, and to the follow-ups of such a talk
 * (`voiceToolOffer`), so that an ordinary spoken turn keeps its speed. `ownerAlone: 'others'` is the owner's own call
 * with someone else listening: a voice turn that would be offered tools is told in one line that they are withheld.
 *
 * Every call is also noted, compactly, in the turn's trace (`shannonToolTrace.ts`), which is kept with the stored turn
 * and replayed to her later turns with the owner alone (`conversationWindow.ts`).
 */
export function conversationTools(
  autonomy: { tools?: ShannonToolRunner } | undefined, scopeKey: string, surface: 'text' | 'voice', ownerAlone: boolean | 'others' | 'guests' | 'shared',
  server: Partial<ConversationToolServer>,
  /** The owner's message this turn answers, `${threadId}\n${words}`: a retry of it does not write the same piece twice. */
  turn: string,
  /** The turn's one deadline, from the request's arrival (`turnDeadline.ts`): every round and call takes its time from it. */
  deadline: TurnDeadline,
  /** A spoken turn: how far its words can be trusted (`transcriptTrust`), and the client's utterance id. */
  voice: { trust: 'reliable' | 'uncertain' | 'unknown'; utteranceId?: string } = { trust: 'reliable' },
  /** A surface that has its own way to a domain (her Minecraft body's game chat asks it through the turn's intent). */
  options: { withoutDomains?: readonly string[]; openOnly?: boolean } = {},
): { tools?: ShannonModelToolSession; toolsWithheld?: true } {
  const runner = autonomy?.tools;
  // Without what the server knows of the audience, nothing is offered (and nothing said about it).
  if (!runner || ownerAlone === false || !ownToolsEnabled() || !server.audience) return {};
  const threadId = turn.slice(0, Math.max(0, turn.indexOf('\n')));
  const words = turn.slice(turn.indexOf('\n') + 1);
  // Words about Minecraft count only while her Minecraft body's request tool is offered here (review B2, 2026-10-06); words
  // that name Aether only while her Aether tools are.
  const offer = surface === 'voice' ? voiceToolOffer(words, server, scopeKey, threadId, offersMinecraftRequest(runner, scopeKey, surface), offersAether(runner, scopeKey, surface)) : 'text';
  if (!offer) return {};
  // What the client said is not enough: what the server knows of others present vetoes the offer, and she is told so. Only
  // her Aether reading tools stay, held by the gate to 「シャノン用フォルダ」 (owner decision 2026-10-06, Syzygy ADR-0007).
  const othersPresent = ownerAlone === 'others' || ownerAlone === 'guests' || ownerAlone === 'shared' || server.audience.othersKnown(scopeKey);
  const audience = othersPresent ? 'others' as const : 'owner_alone' as const;
  if (othersPresent && !runner.offered(surface, 'others', scopeKey).some(tool => !options.withoutDomains?.includes(tool.domain))) return ownerAlone === 'guests' || ownerAlone === 'shared' ? {} : { toolsWithheld: true };
  // Words that could not be trusted write nothing: an uncertain turn reads only. With no score at all (the router fell
  // back), a write waits for his explicit yes to a reply of hers that asked for it (「はい、お願いします」).
  // His answer to her question where a memo goes (「書斎に」) is such a yes too.
  const writes = surface === 'text' || voice.trust === 'reliable'
    || (voice.trust === 'unknown' && ((confirms(words) && lastReplyAsksToConfirm(server, scopeKey, threadId))
      || (answersWithPlace(words) && lastReplyAsks(server, scopeKey, threadId, asksWhichPlace))));
  const definitions = runner.offered(surface, audience, scopeKey)
    .filter(tool => (writes || tool.effect === 'read') && !options.withoutDomains?.includes(tool.domain));
  if (!definitions.length) return {};
  const trace = ownerAlone === 'guests' ? undefined : server.turns?.open(scopeKey, threadId, words, offer === 'asked', voice.utteranceId);
  const memory = toolSessionMemory(createHash('sha256').update(`${scopeKey}\n${turn}`).digest('hex'));
  let check: SecretCheck | null | undefined;
  let others: OthersTextCheck | null | undefined;
  const session = { definitions, maximumCalls: CONVERSATION_TOOL_CALLS } as unknown as ShannonModelToolSession;
  Object.defineProperty(session, 'deadline', { enumerable: false, value: deadline });
  if (!writes) Object.defineProperty(session, 'writesWithheld', { enumerable: false, value: true });
  if (othersPresent) Object.defineProperty(session, 'othersPresent', { enumerable: false, value: true });
  if (ownerAlone === 'guests') Object.defineProperty(session, 'guestTurn', { enumerable: false, value: true });
  /** A call of a name this turn does not offer, with the reason that is true for it. */
  const refuse = (providerName: string): string => {
    // As this server has it: without the Aether client an Aether name is a name that does not exist (as before Aether).
    const tool = runner.knownTool(providerName);
    const refusal = !tool ? { why: 'そういう名前の道具はない', wouldWork: '出してある道具の名前（folder_list のような形）で呼ぶ' }
      : !toolFromProviderName(providerName) ? { why: '道具の名前の形が違う', wouldWork: `${providerToolName(tool.name)} という名前で呼ぶ` }
        : !writes && tool.effect === 'write' ? { why: '聞き取りが確かでないので、書く・消す道具は出していない', wouldWork: 'ライ氏がはっきり確かめた次の返事で' }
          : { why: 'この返事ではその道具は出していない', wouldWork: '出してある道具だけを使う' };
    return toolResultForModel(runner.refused(providerName.slice(0, 80), scopeKey, toolFailure('not_offered', 'この返事ではその道具は出していない。', { retryable: false, refusal })));
  };
  Object.defineProperty(session, 'refuse', { enumerable: false, value: refuse });
  /** Runs one call; its note in the turn's trace is left to `note()`, so a step's calls are noted in the model's order. */
  const start = async (providerName: string, argumentsJson: string, signal?: AbortSignal, timeMilliseconds?: number): Promise<ToolCallOutcome> => {
    const tool = toolFromProviderName(providerName);
    // Only a provider name this turn offers runs (`folder.create` is not `folder_create`); a refusal is recorded like any call.
    if (!tool || !definitions.some(item => item.name === tool.name)) return { output: refuse(providerName), note: () => {} };
    // What must reach nobody but the owner, read at the moment of the call; a list that cannot be read is null, and writes are then refused.
    // Read once a turn; a list that could not be read is tried again at the next call.
    if (!check) { try { check = server.secrets?.(scopeKey); } catch { check = null; } }
    const secrets = check;
    // With anyone else present: what of the owner's must not reach the model from what she reads, read the same way. It is
    // read before the call is awaited, so each of a step's parallel calls is handed its own check and filtered by it.
    if (othersPresent && !others) { try { others = server.othersText?.(scopeKey, options.openOnly === true) ?? null; } catch { others = null; } }
    const result = await runner.call(tool?.name ?? providerName.slice(0, 80), argumentsJson, {
      scopeKey, surface, audience, memory, threadId, ...(secrets !== undefined ? { secrets } : {}), ...(others !== undefined ? { othersText: others } : {}),
      ...(timeMilliseconds !== undefined ? { timeMilliseconds } : {}),
    }, signal);
    return { output: toolResultForModel(result), note: () => trace?.called(toolTraceCall(tool?.name ?? providerName.slice(0, 80), argumentsJson, result, secrets)) };
  };
  // Not enumerable: two turns that offer the same tools are the same request (what the model is asked), whoever runs the calls.
  Object.defineProperty(session, 'start', { enumerable: false, value: start });
  Object.defineProperty(session, 'call', {
    enumerable: false,
    value: async (providerName: string, argumentsJson: string, signal?: AbortSignal, timeMilliseconds?: number) => {
      const outcome = await start(providerName, argumentsJson, signal, timeMilliseconds);
      outcome.note();
      return outcome.output;
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

/** Words about her Minecraft body or the game. They offer a voice turn her tools only while her body is in the game (`voiceToolOffer`). */
export function asksAboutMinecraftBody(transcript: string): boolean {
  return /マイクラ|マインクラフト|minecraft/iu.test(transcript);
}

/** Whether the runner offers her Aether tools on this surface now (Aether configured). */
function offersAether(runner: ShannonToolRunner | undefined, scopeKey: string, surface: 'text' | 'voice'): boolean {
  try { return runner?.offered(surface, 'owner_alone', scopeKey).some(tool => tool.name === 'aether.search') ?? false; } catch { return false; }
}

/** Whether the runner offers `minecraft.request` on this surface now: her Minecraft body configured for the scope and in the game. */
function offersMinecraftRequest(runner: ShannonToolRunner | undefined, scopeKey: string, surface: 'text' | 'voice'): boolean {
  try { return runner?.offered(surface, 'owner_alone', scopeKey).some(tool => tool.name === 'minecraft.request') ?? false; } catch { return false; }
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
export function voiceToolOffer(words: string, server: Partial<ConversationToolServer>, scopeKey: string, threadId: string,
  minecraftBodyPresent = false, aetherOffered = false): 'asked' | 'follow_up' | null {
  // A memo he asks for may go to her study or her folder (or she asks where): not only Aether (owner decision 2026-10-05).
  // Words that name Aether ask about its documents while her Aether tools are offered; 「Aetherにメモして」 stays the note command.
  if (asksAboutOwnThings(words) || (minecraftBodyPresent && asksAboutMinecraftBody(words)) || (asksForMemo(words) && !namesAether(words))
    || (aetherOffered && namesAether(words) && !asksForMemo(words))) return 'asked';
  if (server.turns?.recent(scopeKey, threadId)) return 'follow_up';
  return lastReplyAsks(server, scopeKey, threadId, reply => asksToConfirmToolAction(reply) || asksWhichPlace(reply)) ? 'follow_up' : null;
}

const lastReplyAsksToConfirm = (server: Partial<ConversationToolServer>, scopeKey: string, threadId: string) =>
  lastReplyAsks(server, scopeKey, threadId, asksToConfirmToolAction);

/** Her newest message in the Talk, in the last ten minutes, asked him something about her tools (to confirm, or where). */
function lastReplyAsks(server: Partial<ConversationToolServer>, scopeKey: string, threadId: string, asks: (reply: string) => boolean): boolean {
  let last: StoredConversationMessage | undefined;
  try { last = server.lastMessage?.(scopeKey, threadId); } catch { last = undefined; }
  const recent = last?.role === 'assistant' && Date.parse(server.now?.() ?? '') - Date.parse(last.observedAt) < TOOL_FOLLOW_UP_MILLISECONDS;
  return recent && asks(last!.content);
}

/** A short, explicit yes: 「はい、お願いします」「うん、やって」「いいよ」. Nothing that adds or changes what is asked. */
// 「いいです」 alone may be a no (「いいです、やめておきます」 shortened); it is a yes only before お願い or して.
const YES = /^(?:はい|うん|ええ|おう|いいよ|いいね|どうぞ|お願い|おねがい|やって|頼む|たのむ|オッケー|ok|了解|そうして|いいです(?=お願い|おねがい|して))(?:お願い|おねがい|します|して|です|ね|よ|やって|どうぞ|ください|いいよ|頼む)*$/u;

export function confirms(words: string): boolean {
  const said = words.normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu, '');
  return said.length > 0 && said.length <= 20 && YES.test(said);
}

/**
 * The reader of what her tools did, for the replay of a turn: only while the server itself knows nobody else is there
 * (BLOCKER of the 2026-10-05 review: the client's word that the owner is alone is not enough).
 */
export function toolTraceReader(server: Partial<ConversationToolServer> | undefined, scopeKey: string): ToolTurnLog | undefined {
  if (!server?.turns || !server.audience) return undefined;
  try { return server.audience.othersKnown(scopeKey) ? undefined : server.turns; } catch { return undefined; }
}

/** What the server, not the client, knows when it offers her tools in a conversation. */
export interface ConversationToolServer {
  audience: Pick<ToolAudienceWatch, 'othersKnown' | 'noteOthers'>;
  secrets: (scopeKey: string) => SecretCheck | null;
  /** With anyone else present: what of the owner's must not reach the model from what she reads of Aether (`aetherShownText.ts`). */
  othersText: (scopeKey: string, openOnly: boolean) => OthersTextCheck | null;
  /** The tool calls of each turn until it is stored, their traces after, and which Talks are in a talk about her things. */
  turns: ToolTurnLog;
  /** The newest message of a Talk, for a reply of hers that asked him to confirm. */
  lastMessage: (scopeKey: string, threadId: string) => StoredConversationMessage | undefined;
  now: () => string;
}

export function conversationToolServer(
  body: ToolAudienceSource | null, stateStore: Pick<CompanionStateStore, 'snapshot'>,
  conversations: Pick<ConversationStore, 'experienceCandidates' | 'conversationHistory' | 'recentMessages'> & Partial<ToolTraceStore>, now: () => string,
): ConversationToolServer {
  // The SQLite store keeps the traces (`sqliteToolTraces.ts`); a store without them keeps them in memory.
  const kept = conversations as Partial<ToolTraceStore>;
  const traces: ToolTraceStore = kept.saveToolTrace && kept.toolTraces && kept.deleteToolTraces && kept.toolTraceScopes && kept.pruneToolTraces
    ? kept as ToolTraceStore : new InMemoryToolTraces();
  return {
    audience: new ToolAudienceWatch(body, now),
    secrets: scopeKey => { try { return conversationSecrets(stateStore.snapshot(scopeKey), conversations, scopeKey); } catch { return null; } },
    othersText: (scopeKey, openOnly) => { try { return { ...othersSecrets(stateStore.snapshot(scopeKey), conversations, scopeKey), openOnly }; } catch { return null; } },
    turns: new ToolTurnLog(traces, now),
    lastMessage: (scopeKey, threadId) => (conversations.recentMessages?.(scopeKey, threadId, 1) ?? conversations.conversationHistory(scopeKey, threadId).slice(-1)).at(-1),
    now,
  };
}
