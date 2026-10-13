import { createHash } from 'node:crypto';
import { skillRoutingSwitches } from '@shannon/learning';
import { serverEnvironment } from '../../infra/config/serverEnvironment.js';
import type { ToolExecutionEvidence } from '../../contracts/toolEvidenceContract.js';
import type { CompanionStateStore } from '@shannon/cognition';
import { CONVERSATION_TOOL_CALLS, type ShannonModelToolSession, type ToolCallOutcome } from '../../infra/models/chatModelTools.js';
import type { OthersTextCheck } from '../inhibition/disclosurePorts.js';
import { conversationSecrets, othersSecrets, type SecretCheck } from '../inhibition/disclosurePorts.js';
import type { ConversationStore, StoredConversationMessage } from '../memory/memoryPorts.js';
import { ToolAudienceWatch, type ToolAudienceSource } from '../inhibition/disclosurePorts.js';
import { wasWithheld, type ShannonToolRunner } from './shannonToolRunner.js';
import { toolTraceCall, type TracedOperationOutcomes } from './shannonToolTrace.js';
export type { TracedOperationOutcomes } from './shannonToolTrace.js';
import { InMemoryToolTraces, TOOL_FOLLOW_UP_MILLISECONDS, ToolTurnLog, type ToolTraceStore } from './shannonToolTurns.js';
import { toolSessionMemory } from './shannonToolTypes.js';
import { webReadResult } from './shannonReadTools.js';
import { webSearchFailure, type WebSearchResult } from '../../infra/models/webSearch.js';
import { baseToolSession, nothingFound, sourcesLine, startToolMenu, type ToolMenuChooser } from './shannonToolMenu.js';
import { isReadToolDomain, ownToolsEnabled, providerToolName, toolFailure, toolSummary, toolFromProviderName, toolResultForModel, type ReadToolDomain, type ShannonToolDefinition } from './shannonTools.js';
import type { TurnDeadline } from '../action/respond/respondPorts.js';
import { answersWithPlace, asksForMemo, asksWhichPlace, namesAether } from '../action/respond/respondPorts.js';
import { SKILL_LIMITS, SKILL_NAME } from '../memory/memoryPorts.js';
import { observedStep } from '../../infra/observer/observerContext.js';
export { withMinecraftToolLine } from './shannonMinecraftTools.js';
export { withToolCapabilityLines } from './shannonAetherTools.js';
export { skillProfilePrompt, turnSkillIndex, type SkillTurnPorts } from './shannonSkillTools.js';

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
  options: { withoutDomains?: readonly string[]; openOnly?: boolean; reads?: ReadToolOffer;
    /** Syzygy ADR-0008 stage 2: a search or read that found nothing names the places this turn can look in (`sourcesLine`). */
    sourceHints?: boolean } = {},
): { tools?: ShannonModelToolSession; toolsWithheld?: true } {
  return observedStep('toolOffer', () => { // Timed for the turn's steps line (`turnSteps.ts`).
  const runner = autonomy?.tools;
  // Without what the server knows of the audience, nothing is offered (and nothing said about it).
  if (!runner || ownerAlone === false || !ownToolsEnabled() || !server.audience) return {};
  const threadId = turn.slice(0, Math.max(0, turn.indexOf('\n')));
  const words = turn.slice(turn.indexOf('\n') + 1);
  // Words about Minecraft count only while her Minecraft body's request tool is offered here (review B2, 2026-10-06); words
  // that name Aether only while her Aether tools are.
  const offer = surface === 'voice' ? voiceToolOffer(words, server, scopeKey, threadId, offersMinecraftRequest(runner, scopeKey, surface), offersAether(runner, scopeKey, surface), offersDevice(runner, scopeKey))
      ?? commonVoiceOffer(runner, scopeKey, words) : 'text';
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
    .filter(tool => (offer !== 'common_fca' || COMMON_FCA_VOICE_DOMAINS.has(tool.domain)) && (writes || tool.effect === 'read') && !options.withoutDomains?.includes(tool.domain) && readOffered(tool, options.reads));
  if (!definitions.length) return {};
  const trace = ownerAlone === 'guests' ? undefined : server.turns?.open(scopeKey, threadId, words, offer === 'asked', voice.utteranceId);
  // Tools his words ask for by name are loaded with the turn, not left behind `tool_open` (`withToolMenu`): one model round less.
  const preload = askedToolNames(words).filter(name => definitions.some(tool => tool.name === name));
  const memory = toolSessionMemory(createHash('sha256').update(`${scopeKey}\n${turn}`).digest('hex'));
  // The existing verifier switch owns this additive projection; OFF keeps historical tool-result bytes.
  const evidenceEnabled = skillRoutingSwitches(serverEnvironment()).turnVerify;
  let lifecycleCall = 0;
  let check: SecretCheck | null | undefined;
  let others: OthersTextCheck | null | undefined;
  const session = { definitions, maximumCalls: CONVERSATION_TOOL_CALLS } as unknown as ShannonModelToolSession;
  TURN_WEB_READS.set(session, () => webReadResult(memory));
  Object.defineProperty(session, 'deadline', { enumerable: false, value: deadline });
  if (preload.length) Object.defineProperty(session, 'preload', { enumerable: false, value: Object.freeze(preload) });
  if (!writes) Object.defineProperty(session, 'writesWithheld', { enumerable: false, value: true });
  if (othersPresent) Object.defineProperty(session, 'othersPresent', { enumerable: false, value: true });
  if (ownerAlone === 'guests') Object.defineProperty(session, 'guestTurn', { enumerable: false, value: true });
  /** A call of a name this turn does not offer, with the reason that is true for it. */
  const refuse = (providerName: string): string => {
    if (providerName === 'web_search') WEB_REFUSED.add(session);
    // As this server has it: without the Aether client an Aether name is a name that does not exist (as before Aether).
    const tool = runner.knownTool(providerName);
    const refusal = !tool ? { why: 'そういう名前の道具はない', wouldWork: '出してある道具の名前（folder_list のような形）で呼ぶ' }
      : !toolFromProviderName(providerName) ? { why: '道具の名前の形が違う', wouldWork: `${providerToolName(tool.name)} という名前で呼ぶ` }
        : !writes && tool.effect === 'write' ? { why: '聞き取りが確かでないので、書く・消す道具は出していない', wouldWork: 'ライ氏がはっきり確かめた次の返事で' }
          : { why: 'この返事ではその道具は出していない', wouldWork: '出してある道具だけを使う' };
    // A rule stopped it (ADR-0008 §14): her words not trusted to write, or someone else here; a name she got wrong is not withheld.
    const reason = !tool || !toolFromProviderName(providerName) ? null : !writes && tool.effect === 'write' ? 'unreliable_words' as const
      : othersPresent && !tool.audiences.includes('others') ? 'audience' as const : null;
    return toolResultForModel(runner.refused(providerName.slice(0, 80), scopeKey, toolFailure('not_offered', 'この返事ではその道具は出していない。', { retryable: false, refusal }),
      reason ? { surface, tool: tool!.name, reason } : undefined));
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
    // Lifecycle actions are distinct invocations; start → stop → start must not reuse the first start receipt.
    // Other tools retain whole-turn dedupe and their shared session read state.
    const callMemory = tool.domain === 'minecraft_lifecycle' ? { ...memory, turnKey: `${memory.turnKey}:lifecycle:${++lifecycleCall}` } : memory;
    const result = await runner.call(tool?.name ?? providerName.slice(0, 80), argumentsJson, {
      scopeKey, surface, audience, memory: callMemory, threadId, ...(secrets !== undefined ? { secrets } : {}), ...(others !== undefined ? { othersText: others } : {}),
      ...(timeMilliseconds !== undefined ? { timeMilliseconds } : {}),
    }, signal);
    if (result.ok && writesHerOwnThings(definitions.find(item => item.name === tool.name))) WROTE_HER_OWN_THINGS.add(session);
    // What ran, as closed values, for the turn's verifier and her conversation choices (Syzygy ADR-0008 stage 2).
    // A skill she opened is named by its closed name (stage 2, step 6: her use of it is noted as `skill.use`).
    const subject = tool.domain === 'skill_read' && result.ok ? skillNameOf(argumentsJson) : null;
    // A call a rule stopped (ADR-0008 §14) is marked: it is never learned as a choice of hers.
    TURN_RESULTS.set(session, [...TURN_RESULTS.get(session) ?? [], { name: tool.name, effect: tool.effect === 'write' ? 'write' : 'read', ok: result.ok, ...(subject ? { subject } : {}),
      ...(evidenceEnabled && result.evidence ? { evidence: result.evidence } : {}),
      ...(wasWithheld(result) ? { withheld: true as const } : {}) }]);
    const hint = options.sourceHints && tool.effect === 'read' && nothingFound(result) ? sourcesLine(definitions) : null;
    const shown = hint ? { ...result, text: `${result.text}\n${hint}` } : result;
    return { output: toolResultForModel(shown, evidenceEnabled), note: () => trace?.called(toolTraceCall(tool?.name ?? providerName.slice(0, 80), argumentsJson, result, secrets)) };
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
  });
}

/**
 * Syzygy ADR-0008 stage 2, step 3: which of her read tools a turn offers, by the rules its own projections follow
 * (`conversationCapabilities.ts`); absent, none (fail closed). Only with the owner alone: the registry lists them for him alone.
 */
export type ReadToolOffer = Partial<Record<ReadToolDomain, boolean>>;

function readOffered(tool: ShannonToolDefinition, reads: ReadToolOffer | undefined): boolean {
  return !isReadToolDomain(tool.domain) || reads?.[tool.domain] === true;
}

/** The calls that ran in each turn's session, in the order they ended: name, effect, whether it worked, and the skill a `skill.read` opened. */
const TURN_RESULTS = new WeakMap<object, ReadonlyArray<TurnToolResult>>();
const WEB_REFUSED = new WeakSet<object>();
/** Closed, successful write receipts preserve confirmations without leaking private result text or unshown story titles. */
export function turnCompletedWriteReceipts(tools: ShannonModelToolSession | undefined): readonly string[] {
  return turnToolResults(tools).filter(result => result.ok && result.effect === 'write').map(result =>
    `${result.evidence?.outcome === 'queued' ? '受付済み（目的の完了は未確認）' : result.evidence?.outcome === 'unknown' ? '結果未確認' : '実行済み'}: ${toolSummary(result)}`);
}
const TURN_WEB_READS = new WeakMap<object, () => WebSearchResult | null>();
/** Actual search receipts remain server-owned; a model's source list cannot replace them. */
export function turnWebSearchResult(tools: ShannonModelToolSession | undefined): WebSearchResult | null {
  if (!tools) return null;
  const session = baseToolSession(tools), receipt = TURN_WEB_READS.get(session)?.();
  return receipt ?? (WEB_REFUSED.has(session) || turnToolResults(tools).some(result => result.name === 'web.search' && !result.ok) ? webSearchFailure('not_searched') : null);
}
export interface TurnToolResult { name: string; effect: 'read' | 'write'; ok: boolean; subject?: string; withheld?: true; evidence?: ToolExecutionEvidence }

/** The name of the skill a `skill.read` call asked for, when it is a skill's closed name. */
function skillNameOf(argumentsJson: string): string | null {
  try {
    const name = (JSON.parse(argumentsJson) as { name?: unknown }).name;
    return typeof name === 'string' && name.length <= SKILL_LIMITS.name && SKILL_NAME.test(name.trim()) ? name.trim() : null;
  } catch { return null; }
}

/** Syzygy ADR-0008 stage 2: what her tools did in this turn (closed values), for the verifier and her conversation choices. */
export function turnToolResults(tools: ShannonModelToolSession | undefined): ReadonlyArray<TurnToolResult> {
  return tools ? TURN_RESULTS.get(baseToolSession(tools)) ?? TURN_RESULTS.get(tools) ?? [] : [];
}

/** Whether the turn offered her a write (and its words could be trusted to write): where the verifier checks her claims. */
export function turnOffersWrites(tools: ShannonModelToolSession | undefined): boolean {
  if (!tools || tools.writesWithheld) return false;
  return (tools.menu?.offered ?? tools.definitions).some(tool => tool.effect === 'write');
}

/** The tool sessions of turns in which a write of hers to her own places, or a proposal to the owner's Aether, worked. */
const WROTE_HER_OWN_THINGS = new WeakSet<object>();

/** A write with her own tools: her study, her Aether folder, her PC or Mac folder, or a proposal to the owner's Aether inbox. */
function writesHerOwnThings(tool: ShannonToolDefinition | undefined): boolean {
  return tool?.effect === 'write' && (tool.domain === 'aether_study' || tool.domain === 'host_folder' || tool.domain === 'aether_proposal' || tool.domain === 'task_runtime');
}

/**
 * Whether a write with her own tools worked in this turn (`writesHerOwnThings`). Such a turn has done what the owner asked
 * with her own hands, so the turn proposes no agent task (2026-10-06: after `aetherFolder.create` wrote 「シャノンのやりたいことリスト」
 * the same reply also proposed a Codex task to write it). A code request in the same words is asked again in the next turn.
 */
export function turnWroteHerOwnThings(tools: ShannonModelToolSession | undefined): boolean {
  return tools !== undefined && (WROTE_HER_OWN_THINGS.has(tools) || WROTE_HER_OWN_THINGS.has(baseToolSession(tools)));
}

/**
 * Syzygy ADR-0008 stage 2, the tool menu: the tools `conversationTools` would offer this turn, decided the same way and
 * changing nothing (no trace is opened), as if every write were allowed: the menu may run before a voice turn knows whether its
 * words can be trusted, and a tool the turn does not offer in the end is never given (`withToolMenu` keeps only offered ones).
 * Empty when the turn would offer nothing.
 */
export function toolMenuCandidates(
  autonomy: { tools?: ShannonToolRunner } | undefined, scopeKey: string, surface: 'text' | 'voice', ownerAlone: boolean | 'others' | 'guests' | 'shared',
  server: Partial<ConversationToolServer>, turn: string, options: { withoutDomains?: readonly string[]; reads?: ReadToolOffer } = {},
): readonly ShannonToolDefinition[] {
  try {
    const runner = autonomy?.tools;
    if (!runner || ownerAlone === false || !ownToolsEnabled() || !server.audience) return [];
    const threadId = turn.slice(0, Math.max(0, turn.indexOf('\n')));
    const words = turn.slice(turn.indexOf('\n') + 1);
    const offer = surface === 'voice' ? voiceToolOffer(words, server, scopeKey, threadId, offersMinecraftRequest(runner, scopeKey, surface), offersAether(runner, scopeKey, surface), offersDevice(runner, scopeKey))
      ?? commonVoiceOffer(runner, scopeKey, words) : 'text';
    if (!offer) return [];
    const othersPresent = ownerAlone === 'others' || ownerAlone === 'guests' || ownerAlone === 'shared' || server.audience.othersKnown(scopeKey);
    return runner.offered(surface, othersPresent ? 'others' : 'owner_alone', scopeKey).filter(tool => (offer !== 'common_fca' || COMMON_FCA_VOICE_DOMAINS.has(tool.domain)) && !options.withoutDomains?.includes(tool.domain) && readOffered(tool, options.reads));
  } catch { return []; }
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

/**
 * What a spoken turn without words about her things is offered while the common FCA runs (`common_fca`): her task and memory
 * tools as before, and, since the 2026-10-13 daily evals, her everyday reads (the weather, a route, the morning brief) and her
 * device tools. Without them 「明日、傘いる？」 went to research and 「1時間後に起こして」 had no timer to open.
 */
const COMMON_FCA_VOICE_DOMAINS: ReadonlySet<string> = new Set(['task_runtime', 'memory_read', 'daily_read', 'device_action']);

/**
 * A spoken turn without words about her things: her task and memory tools while the common FCA runs, and, for a weather question,
 * her everyday reads also without it (a turn whose words could not be trusted has no FCA turn: 「東京都 博多の天気」, 2026-10-13).
 */
function commonVoiceOffer(runner: ShannonToolRunner, scopeKey: string, words: string): 'common_fca' | null {
  const offered = runner.offered('voice', 'owner_alone', scopeKey);
  return offered.some(tool => tool.domain === 'task_runtime') || (WEATHER_REQUEST.test(words) && offered.some(tool => tool.domain === 'daily_read'))
    ? 'common_fca' : null;
}

/** A music word (not 作曲・編曲) followed, within a short phrase, by what to do with it: play, stop, change or skip. */
const MUSIC_REQUEST = /(?<![作編])(?:音楽|曲|BGM|プレイリスト|アルバム)[^。！？!?\n]{0,12}?(?:かけて|かけよう|流して|再生して|聴かせて|聞かせて|止めて|とめて|変えて|替えて|スキップ|飛ばして)|(?:次|前)の曲/iu;
// A clock time as 「9時20分」「9時半」 or 「9:20」, with or without 「に」 (owner test 2026-10-13: 「明日の9:20に起こして。」 matched neither, and
// she declined; review: 「7時ごろ起こして」「9:20起こして」).
const CLOCK_TIME = '(?:[0-9０-９一二三四五六七八九十]+時(?:[0-9０-９一二三四五六七八九十]+分|半)?|[0-9０-９]{1,2}[:：][0-9０-９]{2})(?:頃|ごろ)?';
const REMINDER_REQUEST = new RegExp(`リマインド|リマインダー|忘れないように|${CLOCK_TIME}に?(?:教えて|知らせて|声をかけて|声かけて|起こして)|通知して`, 'u');
// 「1時間後に起こして」 and an alarm are a timer too (2026-10-13 daily evals D1: only minutes were read, and she had no timer).
// 「起こして」 only with a time (「朝」「明日」「〜後」「〜時」): 「問題を起こして」 is no alarm.
const TIMER_REQUEST = /タイマー|アラーム|目覚まし|[0-9０-９一二三四五六七八九十]+(?:分|時間|秒)半?(?:後に|後で|後、|たったら|経ったら)|(?:朝|明日|あした|あさって|後|時|分|半)[にはでも、]?\s*起こして/u;
const CALENDAR_REQUEST = /予定(?:を|に)?(?:入れて|入れといて|入れておいて|追加)|カレンダーに/u;
const WEATHER_REQUEST = /天気|天候|予報|気温|降水|傘|雨|雪|晴れ|曇り|くもり/u;

/**
 * The tools his words ask for by name (registry names), loaded with the turn wherever it offers them: a timer, a reminder, an
 * event, music, the weather. Anything else is the menu's to choose.
 */
export function askedToolNames(words: string): string[] {
  return [
    ...(TIMER_REQUEST.test(words) || REMINDER_REQUEST.test(words) ? ['timer.start', 'reminder.create'] : []),
    ...(CALENDAR_REQUEST.test(words) ? ['calendar.create_event'] : []),
    ...(MUSIC_REQUEST.test(words) ? ['music.search', 'music.recent', 'music.play', 'music.control'] : []),
    ...(WEATHER_REQUEST.test(words) ? ['weather.forecast'] : []),
  ];
}

/**
 * Explicit device intents only (music, a reminder, a timer, a calendar entry): a voice turn is offered her tools while her
 * device tools exist. Loose words (話しかけて, 出かけて, 電話かけて, 聞き流して, 再生可能, 作曲) keep the plain path's speed;
 * a yes to her own music proposal is matched where this is called.
 */
export function asksForDeviceAction(transcript: string): boolean {
  return [MUSIC_REQUEST, REMINDER_REQUEST, TIMER_REQUEST, CALENDAR_REQUEST].some(pattern => pattern.test(transcript));
}

const proposesMusic = (reply: string) => /曲|音楽|かけ(?:ましょう|ようか|ても)|流し(?:ましょう|ようか|ても)/u.test(reply);

/** Whether the runner has her device tools for this scope (the owner's, switched on). */
function offersDevice(runner: ShannonToolRunner | undefined, scopeKey: string): boolean {
  try { return runner?.offered('voice', 'owner_alone', scopeKey).some(tool => tool.domain === 'device_action') ?? false; } catch { return false; }
}

/** Whether a spoken turn of the owner alone has her weather tool (its port is wired and her tools are on). */
export function weatherToolAvailable(autonomy: { tools?: ShannonToolRunner } | undefined, scopeKey: string, ownerAlone: boolean): boolean {
  try {
    const offered = ownerAlone && ownToolsEnabled() ? autonomy?.tools?.offered('voice', 'owner_alone', scopeKey) ?? [] : [];
    return offered.some(tool => tool.name === 'weather.forecast');
  } catch { return false; }
}

/** Whether the runner offers her Aether tools on this surface now (Aether configured). */
function offersAether(runner: ShannonToolRunner | undefined, scopeKey: string, surface: 'text' | 'voice'): boolean {
  try { return runner?.offered(surface, 'owner_alone', scopeKey).some(tool => tool.name === 'aether.search') ?? false; } catch { return false; }
}

/** A body request or lifecycle login enables Minecraft voice intent, including an offline body/server. */
function offersMinecraftRequest(runner: ShannonToolRunner | undefined, scopeKey: string, surface: 'text' | 'voice'): boolean {
  try { return runner?.offered(surface, 'owner_alone', scopeKey).some(tool => tool.name === 'minecraft.request' || tool.name === 'minecraft.login') ?? false; } catch { return false; }
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
  minecraftBodyPresent = false, aetherOffered = false, deviceOffered = false): 'asked' | 'follow_up' | null {
  // Music, a reminder, a timer or an event (`docs/device-actions-contract.md`), and his yes to a song she proposed.
  if (deviceOffered && (asksForDeviceAction(words) || (confirms(words) && lastReplyAsks(server, scopeKey, threadId, proposesMusic)))) return 'asked';
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
  /** How her accepted Minecraft lifecycle operations ended, for the traces of later turns (`ToolTurnLog`). */
  operationOutcomes?: TracedOperationOutcomes,
): ConversationToolServer {
  // The SQLite store keeps the traces (`sqliteToolTraces.ts`); a store without them keeps them in memory.
  const kept = conversations as Partial<ToolTraceStore>;
  const traces: ToolTraceStore = kept.saveToolTrace && kept.toolTraces && kept.deleteToolTraces && kept.toolTraceScopes && kept.pruneToolTraces
    ? kept as ToolTraceStore : new InMemoryToolTraces();
  return {
    audience: new ToolAudienceWatch(body, now),
    secrets: scopeKey => { try { return conversationSecrets(stateStore.snapshot(scopeKey), conversations, scopeKey); } catch { return null; } },
    othersText: (scopeKey, openOnly) => { try { return { ...othersSecrets(stateStore.snapshot(scopeKey), conversations, scopeKey), openOnly }; } catch { return null; } },
    turns: new ToolTurnLog(traces, now, operationOutcomes),
    lastMessage: (scopeKey, threadId) => (conversations.recentMessages?.(scopeKey, threadId, 1) ?? conversations.conversationHistory(scopeKey, threadId).slice(-1)).at(-1),
    now,
  };
}

export { offerWithMenu, type ToolMenuChooser, type TurnChoiceAnswer } from './shannonToolMenu.js';

/** Syzygy ADR-0008 stage 2: the menu question for the tools this turn would offer (`toolMenuCandidates`), or null. */
export function startTurnToolMenu(
  chooser: ToolMenuChooser | undefined | null, autonomy: { tools?: ShannonToolRunner } | undefined, scopeKey: string, surface: 'text' | 'voice',
  ownerAlone: boolean | 'others' | 'guests' | 'shared', server: Partial<ConversationToolServer>, turn: string, options: { withoutDomains?: readonly string[]; reads?: ReadToolOffer } = {},
  extra: readonly { name: string; summary: string; group: string }[] = [],
) {
  if (!chooser) return null;
  // Her last reply in this Talk (ten minutes, the owner alone only): Jev reads it for the retry-or-correction question.
  const threadId = turn.slice(0, Math.max(0, turn.indexOf('\n')));
  let previous: StoredConversationMessage | undefined;
  try { previous = ownerAlone === true && chooser.difficulty ? server.lastMessage?.(scopeKey, threadId) : undefined; } catch { previous = undefined; }
  const recent = previous?.role === 'assistant' && Date.parse(server.now?.() ?? '') - Date.parse(previous.observedAt) < TOOL_FOLLOW_UP_MILLISECONDS;
  return startToolMenu(chooser, { scopeKey, surface, words: turn.slice(turn.indexOf('\n') + 1), ...(recent ? { previousReply: previous!.content.slice(0, 600) } : {}) },
    () => toolMenuCandidates(autonomy, scopeKey, surface, ownerAlone, server, turn, options), extra);
}

/**
 * Syzygy ADR-0008 stage 2, step 3: the read tools a voice turn offers. With the owner alone every one (his voice projections
 * read all of them for him alone); anyone else present, none (the voice projections stay as they were). They exist at all only
 * while the runner has their ports.
 */
export function ownerAloneReads(ownerAlone: boolean | 'others' | 'guests' | 'shared'): { reads?: ReadToolOffer } {
  return ownerAlone === true ? { reads: { notion_read: true, voyager_read: true, schedule_read: true, places_search: true, web_search: true } } : {};
}
