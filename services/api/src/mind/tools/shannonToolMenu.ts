import type { ShannonModelToolSession, ToolCallOutcome } from '../../infra/models/chatModelTools.js';
import { ALWAYS_LOADED_TOOL_NAMES, providerToolName, toolSummary, type ShannonToolDefinition, type ToolInputSchema } from './shannonTools.js';

/**
 * The tool menu applied to a turn's session (Syzygy ADR-0008 stage 2, §8 「道具は名前と短い説明だけを毎回渡し、使うときに定義を
 * 取り寄せる」; `docs/skill-and-routing-contract.md`). Core: response path.
 *
 * Jev chose from the tools this turn offers (`mind/selectors/toolMenu.ts`). The model is then given the schemas of the chosen
 * tools only, plus `tool_open`, which opens any other tool this turn offers, never one it does not: the offer, the audience and
 * the gate are exactly the turn's (`conversationTools`), and every call still runs through the same session and runner. The
 * model reads every offered tool's name and summary in its instructions (`toolInstructions`), so it knows what it can open.
 *
 * Opening is not a tool call: it runs nothing, is not counted against the turn's calls, takes no time, and is not written to
 * the activity record or the turn's trace. An opened tool is in the request from the next round on.
 */
export const TOOL_OPEN_NAME = 'tool.open';
export const TOOL_OPEN_PROVIDER_NAME = providerToolName(TOOL_OPEN_NAME);

/**
 * The owner's voice turn (the only offer that holds `web.research`) also always loads her everyday lookups (2026-10-13: after
 * 「博多の天気を調べて」 the follow-up 「うん、お願い」 had no weather tool, and an event question had no research tool, so she said
 * she could not look). A follow-up without keywords keeps them.
 */
export const OWNER_VOICE_LOADED_TOOL_NAMES: readonly string[] = Object.freeze(['weather.forecast', 'web.research']);

/** The always-loaded names for an offer (registry names). */
export function alwaysLoadedToolNames(offered: readonly Pick<ShannonToolDefinition, 'name'>[]): readonly string[] {
  return offered.some(tool => tool.name === 'web.research') ? [...ALWAYS_LOADED_TOOL_NAMES, ...OWNER_VOICE_LOADED_TOOL_NAMES] : ALWAYS_LOADED_TOOL_NAMES;
}

/** The meta-tool, its enum the provider names of the tools the turn offers. */
export function toolOpenDefinition(offered: readonly ShannonToolDefinition[]): ShannonToolDefinition {
  const input: ToolInputSchema = Object.freeze({
    type: 'object' as const,
    properties: Object.freeze({
      name: Object.freeze({ type: 'string' as const, description: '開く道具の名前（[ボクの道具・献立] にある名前）', enum: Object.freeze(offered.map(tool => providerToolName(tool.name))) }),
    }),
    required: Object.freeze(['name']),
    additionalProperties: false as const,
  });
  return Object.freeze({
    name: TOOL_OPEN_NAME,
    description: 'いま定義を渡していない道具を開く。開いた道具は、次の呼び出しから使える。開くこと自体は何もしない。',
    input, domain: 'meta' as const, effect: 'read' as const, cost: 'none' as const, audiences: Object.freeze(['owner_alone' as const, 'others' as const]),
    surfaces: Object.freeze(['text' as const, 'voice' as const]),
  });
}

/** What she reads about the menu: every offered tool by its provider name and summary, and how to open one. */
export function toolMenuInstructions(offered: readonly ShannonToolDefinition[]): string {
  return [
    '[ボクの道具・献立] この返事では、使いそうな道具の定義だけを渡している。下の道具はどれも使ってよい。定義のない道具が要る時は、先に tool_open に名前を書いて開き、次の呼び出しで使う。',
    ...offered.map(tool => `- ${providerToolName(tool.name)}: ${toolSummary(tool)}`),
  ].join('\n');
}

const OPENED = (name: string) => JSON.stringify({ ok: true, text: `${name} を開いた。次の呼び出しから使える。`, retryable: false });
const NOT_OPENABLE = JSON.stringify({ ok: false, text: 'その名前の道具は、この返事では出していないので開けない。', failure: 'not_offered', retryable: false,
  why: 'この返事で出している道具の一覧にない', wouldWork: '[ボクの道具・献立] にある名前で開く' });

/**
 * The session of a turn as the menu narrows it. `chosen` are the provider names Jev chose (an empty list: none); a name the
 * turn does not offer is ignored. Everything that is not the schema list is the base session's.
 */
export function withToolMenu(base: ShannonModelToolSession, chosen: readonly string[], options?: { deferMemoryReads?: boolean }): ShannonModelToolSession {
  const offered = base.definitions;
  // What Jev chose, and always the ways to stop and to ask for approval (`alwaysLoadedToolNames`) when the turn offers them.
  // And the tools his words asked for by name (`askedToolNames`: a timer, an event, music, the weather), so that no `tool_open`
  // round comes before the call (2026-10-13 daily evals D1).
  const loaded = [...alwaysLoadedToolNames(offered), ...(base as { preload?: readonly string[] }).preload ?? []];
  const visible = new Set(offered.filter(tool => chosen.includes(providerToolName(tool.name)) || (loaded.includes(tool.name) && !(options?.deferMemoryReads && ['memory.search', 'memory.read'].includes(tool.name)))).map(tool => tool.name));
  const open = toolOpenDefinition(offered);
  const current = () => [...offered.filter(tool => visible.has(tool.name)), open];
  const session = { maximumCalls: base.maximumCalls } as Record<string, unknown>;
  Object.defineProperty(session, 'definitions', { enumerable: true, get: current });
  const hidden = (name: string, value: unknown) => Object.defineProperty(session, name, { enumerable: false, value });
  hidden('deadline', base.deadline);
  const preload = (base as { preload?: readonly string[] }).preload;
  if (preload) hidden('preload', preload);
  if (base.writesWithheld) hidden('writesWithheld', true);
  if (base.othersPresent) hidden('othersPresent', true);
  if (base.guestTurn) hidden('guestTurn', true);
  const refuse = (providerName: string) => base.refuse?.(providerName) ?? NOT_OPENABLE;
  hidden('refuse', refuse);
  const shown = (providerName: string) => offered.some(tool => visible.has(tool.name) && providerToolName(tool.name) === providerName);
  const start = async (providerName: string, argumentsJson: string, signal?: AbortSignal, timeMilliseconds?: number): Promise<ToolCallOutcome> => {
    // A tool the turn offers but has not opened is refused like a name it does not offer; nothing runs.
    if (!shown(providerName)) return { output: refuse(providerName), note: () => {} };
    if (base.start) return base.start(providerName, argumentsJson, signal, timeMilliseconds);
    return { output: await base.call(providerName, argumentsJson, signal, timeMilliseconds), note: () => {} };
  };
  hidden('start', start);
  hidden('call', async (providerName: string, argumentsJson: string, signal?: AbortSignal, timeMilliseconds?: number) => {
    const outcome = await start(providerName, argumentsJson, signal, timeMilliseconds);
    outcome.note();
    return outcome.output;
  });
  hidden('menu', Object.freeze({ offered }));
  hidden('base', base);
  /** `tool_open`: answered at once; any other name is not the menu's. */
  hidden('meta', (providerName: string, argumentsJson: string): string | null => {
    if (providerName !== TOOL_OPEN_PROVIDER_NAME) return null;
    let name: unknown;
    try { name = (JSON.parse(argumentsJson) as { name?: unknown }).name; } catch { name = undefined; }
    const tool = typeof name === 'string' ? offered.find(item => providerToolName(item.name) === name) : undefined;
    if (!tool) return NOT_OPENABLE;
    visible.add(tool.name);
    return OPENED(providerToolName(tool.name));
  });
  return session as unknown as ShannonModelToolSession;
}

/** The session a menu session narrowed, or the session itself. */
export function baseToolSession(session: ShannonModelToolSession): ShannonModelToolSession {
  return (session as { base?: ShannonModelToolSession }).base ?? session;
}

/** The tools a turn offers as Jev's menu reads them: the provider name, the summary, and the area that groups them. */
export function menuCandidatesOf(definitions: readonly ShannonToolDefinition[]): readonly { name: string; summary: string; group: string }[] {
  return definitions.map(tool => Object.freeze({ name: providerToolName(tool.name), summary: toolSummary(tool), group: tool.name.split('.')[0]! }));
}

/** What the menu needs of the turn's Jev call (`mind/selectors/turnChoices.ts`), by shape. */
export interface ToolMenuChooser {
  /** Whether it asks the difficulty questions (step 4): then it is asked in every turn, with or without tools. */
  readonly difficulty?: boolean;
  choose(request: TurnChoiceAsk): Promise<TurnChoiceAnswer>;
}
export interface TurnChoiceAsk {
  scopeKey: string; surface: 'text' | 'voice'; words: string; menu: readonly { name: string; summary: string; group: string }[];
  /** Her last reply in this Talk, only in a turn of the owner alone: for the retry-or-correction question (step 4). */
  previousReply?: string;
}
export interface TurnChoiceAnswer {
  menu: { chosen: readonly string[] } | null;
  /** Step 4: Jev's difficulty answers (null: none asked or unusable) and the probability that he retried or corrected her. */
  difficulty?: { taskKind: string; needsStrongModel: number; needsVerification: number; multiStep: number } | null;
  retry?: number | null;
}

/**
 * Starts the turn's Jev call: the menu for the tools a turn would offer (`toolMenuCandidates`), and with step 4's difficulty
 * questions in every turn. Null when there is no chooser, or nothing to ask.
 */
export function startToolMenu(
  chooser: ToolMenuChooser | undefined | null, request: Omit<TurnChoiceAsk, 'menu'>,
  candidates: () => readonly ShannonToolDefinition[],
  /** Capability entries beside the tools (web search, step 3), only in a turn that offers tools. */
  extra: readonly { name: string; summary: string; group: string }[] = [],
): Promise<TurnChoiceAnswer> | null {
  if (!chooser) return null;
  const tools = menuCandidatesOf(candidates());
  return tools.length || chooser.difficulty ? chooser.choose({ ...request, menu: tools.length ? [...tools, ...extra] : [] }) : null;
}

/** The turn's offer narrowed by the menu's answer, or the offer as it is (no menu, no tools, or Jev could not choose). */
export async function offerWithMenu<T extends { tools?: ShannonModelToolSession }>(offer: T, choices: Promise<TurnChoiceAnswer> | null): Promise<T> {
  if (!choices || !offer.tools) return offer;
  const { menu } = await choices;
  return menu ? { ...offer, tools: withToolMenu(offer.tools, menu.chosen) } : offer;
}

/**
 * The places a turn can look in, by the reading tools it offers (Syzygy ADR-0008 stage 2): said after a search or a read that found
 * nothing, so that "not found here" does not read as "cannot look". Areas without a reading tool in this turn are not named.
 */
const SOURCE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  study: '書斎', folder: 'PCやMacのボクのフォルダ', aether: 'Aether', aetherFolder: 'Aetherのシャノン用フォルダ', notion: 'Notion', voyager: 'Voyagerのタスク',
  schedule: 'これからの予定', places: 'お店や施設（Web）', skill: 'ボクのスキル', minecraft: 'マイクラの体の様子',
});
/** The whole text of an empty answer of her reading executors (never a body that only contains such words). */
const NOTHING_FOUND = /^(?:「[^\n]*」は見つからなかった。|見つからなかった。|当てはまるところはなかった。|当てはまるものはない。|何もない。|シャノン用フォルダはまだ空。|（何も見つからなかった）)$/u;

export function nothingFound(result: { ok: boolean; text: string; failure?: string }): boolean {
  return result.failure === 'not_found' || (result.ok && NOTHING_FOUND.test(result.text));
}

/** The line added to such a result: the areas this turn can read, each with one of its reading tools. */
export function sourcesLine(offered: readonly ShannonToolDefinition[]): string | null {
  const areas = new Map<string, string>();
  for (const tool of offered) {
    const area = tool.name.split('.')[0]!;
    if (tool.effect !== 'read' || !SOURCE_LABELS[area] || areas.has(area)) continue;
    areas.set(area, `${SOURCE_LABELS[area]}（${providerToolName(tool.name)}）`);
  }
  return areas.size ? `ここで見つからなかっただけで、探せないのではない。この返事で探せるところ: ${[...areas.values()].join('、')}` : null;
}
