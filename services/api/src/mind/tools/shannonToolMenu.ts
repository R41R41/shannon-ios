import type { ShannonModelToolSession, ToolCallOutcome } from '../../infra/models/chatModelTools.js';
import { providerToolName, toolSummary, type ShannonToolDefinition, type ToolInputSchema } from './shannonTools.js';

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
export function withToolMenu(base: ShannonModelToolSession, chosen: readonly string[]): ShannonModelToolSession {
  const offered = base.definitions;
  const visible = new Set(offered.filter(tool => chosen.includes(providerToolName(tool.name))).map(tool => tool.name));
  const open = toolOpenDefinition(offered);
  const current = () => [...offered.filter(tool => visible.has(tool.name)), open];
  const session = { maximumCalls: base.maximumCalls } as Record<string, unknown>;
  Object.defineProperty(session, 'definitions', { enumerable: true, get: current });
  const hidden = (name: string, value: unknown) => Object.defineProperty(session, name, { enumerable: false, value });
  hidden('deadline', base.deadline);
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
  choose(request: { scopeKey: string; surface: 'text' | 'voice'; words: string; menu: readonly { name: string; summary: string; group: string }[] }): Promise<{ menu: { chosen: readonly string[] } | null }>;
}

/** Starts the menu question for the tools a turn would offer (`toolMenuCandidates`); null when there is no chooser or nothing to offer. */
export function startToolMenu(
  chooser: ToolMenuChooser | undefined | null, request: { scopeKey: string; surface: 'text' | 'voice'; words: string },
  candidates: () => readonly ShannonToolDefinition[],
): Promise<{ menu: { chosen: readonly string[] } | null }> | null {
  if (!chooser) return null;
  const menu = menuCandidatesOf(candidates());
  return menu.length ? chooser.choose({ ...request, menu }) : null;
}

/** The turn's offer narrowed by the menu's answer, or the offer as it is (no menu, no tools, or Jev could not choose). */
export async function offerWithMenu<T extends { tools?: ShannonModelToolSession }>(offer: T, choices: Promise<{ menu: { chosen: readonly string[] } | null }> | null): Promise<T> {
  if (!choices || !offer.tools) return offer;
  const { menu } = await choices;
  return menu ? { ...offer, tools: withToolMenu(offer.tools, menu.chosen) } : offer;
}
