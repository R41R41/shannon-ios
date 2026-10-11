import { readFileSync } from 'node:fs';
import type Anthropic from '@anthropic-ai/sdk';
import {
  SHANNON_CAPABILITIES, SHANNON_FCA_SHARED_CAPABILITY, SHANNON_FCA_TASK_CAPABILITY, SHANNON_MINECRAFT_LIFECYCLE_CAPABILITY,
  withAetherAccessCapability, withMinecraftBodyCapability, withReadToolsCapability, withSkillsCapability,
} from '@shannon/cognition';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cachePlanApplies, planOutputSchema, planToolPair, plannedChatBody, splitCapabilityLines, splitSkillIndex, stableLayers,
} from '../src/infra/models/anthropic/anthropicCachePlan.js';
import { CACHE_PLAN_BREAKPOINTS, cachePlanRequest } from '../src/infra/models/anthropic/cachePlanMarkers.js';
import { cacheReceiptsView, recordCacheReceipt, resetCacheReceipts } from '../src/infra/models/anthropic/cacheReceipts.js';
import { warmDayLine } from '../src/infra/models/anthropic/cacheWarmTurns.js';
import { ANTHROPIC_STRICT_LIMITS, strictRequestUsage } from '../src/infra/models/anthropic/anthropicToolCapacity.js';
import { chatTurnResult, parsedChatTurn } from '../src/infra/models/chatModelTurn.js';
import type { ShannonChatModelRequest } from '../src/infra/models/chatModel.js';
import { withToolMenu } from '../src/mind/tools/shannonToolMenu.js';
import { SHANNON_TOOLS } from '../src/mind/tools/shannonTools.js';
import { SKILL_INDEX_HEADER } from '../src/mind/memory/skillDocument.js';
import { PLAN_TALK_SCENARIO } from './support/claudePlanScenarios.js';
import { HAIKU, SONNET, tools, type Settings } from './support/claudeForegroundScenarios.js';

/**
 * The foreground cache plan (Syzygy ADR-0009 stage 1, M4): what stays the same on every text turn of a Talk, where the
 * breakpoints go, that each turn's request repeats the previous turn's cached prefix byte for byte, and what `GET /v1/ops`
 * counts of it. The request shapes themselves are held by the goldens (`plan-*` in `tests/fixtures/claude-requests/`).
 */
type Body = Anthropic.MessageCreateParamsNonStreaming;
afterEach(() => resetCacheReceipts());

const identity = SHANNON_CAPABILITIES.map(item => `- ${item.text}\n`).join('');
const base: ShannonChatModelRequest = { scopeKey: 'owner', systemPrompt: `合成された人格\n${identity}`, profilePrompt: '合成された持ち主の層',
  history: [], message: 'こんにちは', turnContext: '合成された文脈' };
const skillIndex = `${SKILL_INDEX_HEADER} 1/20（目次。中身は skill_read で開く）]\n- 合成スキル: 説明`;

function everyLine(prompt: string): string {
  const inserted = withSkillsCapability(withReadToolsCapability(withAetherAccessCapability(withMinecraftBodyCapability(prompt))));
  return [inserted, SHANNON_MINECRAFT_LIFECYCLE_CAPABILITY.text, SHANNON_FCA_TASK_CAPABILITY.text, SHANNON_FCA_SHARED_CAPABILITY.text].join('\n\n');
}

/** Turns as different as a Talk has them. */
const variants: Record<string, ShannonChatModelRequest> = {
  plain: base,
  feeling: { ...base, offerReplyFeeling: true, offerRoomLook: true, offerAppLook: true, offerMinecraftIntent: true, generateThreadTitle: true },
  tools: { ...base, systemPrompt: everyLine(base.systemPrompt), profilePrompt: `${base.profilePrompt}\n\n${skillIndex}`,
    tools: withToolMenu(tools(['study.list', 'skill.read']), ['study_list']) },
  required: { ...base, requireWebSearch: true, tools: withToolMenu(tools(['web.search', 'study.list']), ['web_search']) },
  withheld: { ...base, toolsWithheld: true },
  web: { ...base, useWebSearch: true },
  place: { ...base, placeSearch: { latitude: 1, longitude: 2 } },
  attachment: { ...base, attachments: [{ name: 'memo.txt', mimeType: 'text/plain', text: '合成の添付' }] },
};

function sent(request: ShannonChatModelRequest, settings: Settings = HAIKU): Body {
  return cachePlanRequest(plannedChatBody(settings, request, undefined));
}

/** Everything the provider's cache key covers before a message index, in its order, with the breakpoint markers left out. */
function renderedPrefix(body: Body, lastMessage: number): string {
  const { model, tools: offered, tool_choice: choice, thinking, output_config: output, system } = body;
  const strip = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null), (key, child: unknown) => key === 'cache_control' ? undefined : child);
  return JSON.stringify(strip({ model, offered, choice, thinking, output, system, messages: body.messages.slice(0, lastMessage + 1) }));
}

function markedWordsIndex(body: Body): number {
  return body.messages.findIndex(message => message.role === 'user' && Array.isArray(message.content)
    && message.content.some(block => block.type === 'text' && 'cache_control' in block && block.cache_control));
}

function countMarkers(value: unknown): number {
  return (JSON.stringify(value).match(/"cache_control"/gu) ?? []).length;
}

describe('the cache plan switch', () => {
  it('is off unless SHANNON_CLAUDE_CACHE_PLAN is on, and only for the native 5.5 models', () => {
    expect(cachePlanApplies('claude-haiku-5-5', {})).toBe(false);
    expect(cachePlanApplies('claude-haiku-5-5', { SHANNON_CLAUDE_CACHE_PLAN: 'on' })).toBe(true);
    expect(cachePlanApplies('claude-sonnet-5-5', { SHANNON_CLAUDE_CACHE_PLAN: 'true' })).toBe(true);
    expect(cachePlanApplies('claude-haiku-4-5', { SHANNON_CLAUDE_CACHE_PLAN: 'on' })).toBe(false);
  });
});

describe('the stable prefix', () => {
  it.each([['Haiku', HAIKU], ['Sonnet', SONNET]] as const)('is the same tools, choice, system, schema and effort in every kind of turn (%s)', (_name, settings) => {
    const bodies = Object.values(variants).map(request => sent(request, settings));
    for (const body of bodies) {
      expect(body.tools).toEqual(planToolPair());
      expect(body.tool_choice).toEqual({ type: 'auto' });
      expect(body.system).toEqual(bodies[0]!.system);
      expect(body.output_config).toEqual(bodies[0]!.output_config);
      expect(body.thinking).toEqual(bodies[0]!.thinking);
      expect(body.cache_control).toBeUndefined();
    }
  });

  it('keeps the turn\'s capability lines, skill index, feeling, tool and web lines out of the system and after the words', () => {
    const tooled = sent(variants.tools!);
    const system = JSON.stringify(tooled.system);
    const after = JSON.stringify(tooled.messages.slice(markedWordsIndex(tooled) + 1));
    for (const line of [SHANNON_FCA_TASK_CAPABILITY.text, SKILL_INDEX_HEADER, '[ボクの道具・献立]']) {
      expect(system).not.toContain(line);
      expect(after).toContain(line);
    }
    const feeling = sent(variants.feeling!);
    expect(JSON.stringify(feeling.system)).not.toContain('[この返答での気持ち]');
    expect(JSON.stringify(feeling.messages.at(-1))).toContain('[この返答での気持ち]');
    expect(JSON.stringify(sent(variants.web!).messages.at(-1))).toContain('[Web検索の回答]');
    expect(JSON.stringify(sent(variants.plain!).messages.at(-1))).toContain('tool_open と tool_call は呼ばずに');
    expect(JSON.stringify(sent(variants.withheld!).messages.at(-1))).toContain('いまはライ氏以外の人もいるかもしれない');
  });

  it('takes out exactly what the turn added to her identity and profile', () => {
    expect(splitCapabilityLines(everyLine(base.systemPrompt)).stable).toBe(base.systemPrompt);
    expect(splitCapabilityLines(everyLine(base.systemPrompt)).lines).toHaveLength(7);
    expect(splitCapabilityLines(base.systemPrompt)).toEqual({ stable: base.systemPrompt, lines: [] });
    expect(splitSkillIndex(`${base.profilePrompt}\n\n${skillIndex}`)).toEqual({ stable: base.profilePrompt, index: skillIndex });
    expect(splitSkillIndex(skillIndex)).toEqual({ index: skillIndex });
    expect(stableLayers({ systemPrompt: 'x', profilePrompt: 'y' })).toEqual({ systemPrompt: 'x', profilePrompt: 'y', turnLines: [] });
  });

  it('fits the provider\'s strict limits with one superset schema, also with the whole registry offered', () => {
    const schema = planOutputSchema() as { required: string[]; properties: Record<string, unknown> };
    expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
    const whole = withToolMenu(tools(SHANNON_TOOLS.filter(tool => tool.surfaces.includes('text')).map(tool => tool.name)), []);
    for (const request of [base, { ...base, tools: whole }]) {
      const usage = strictRequestUsage(sent(request));
      expect(usage.tools).toBeLessThanOrEqual(ANTHROPIC_STRICT_LIMITS.tools);
      expect(usage.optional).toBeLessThanOrEqual(ANTHROPIC_STRICT_LIMITS.optional);
      expect(usage.unions).toBeLessThanOrEqual(ANTHROPIC_STRICT_LIMITS.unions);
    }
    expect(strictRequestUsage(sent(base))).toEqual({ tools: 2, optional: 0, unions: 15 });
  });
});

describe('the breakpoints', () => {
  it('mark the static system, the latest words and the latest tool result, at most three, on copies', () => {
    const body = plannedChatBody(HAIKU, variants.tools!, undefined);
    const round: Body = { ...body, messages: [...body.messages,
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'study_list', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '合成結果' }] }] };
    const before = JSON.stringify(round);
    const prepared = cachePlanRequest(round);
    expect(JSON.stringify(round)).toBe(before);
    expect(countMarkers(prepared)).toBe(CACHE_PLAN_BREAKPOINTS);
    expect((prepared.system as Anthropic.TextBlockParam[]).map(block => Boolean(block.cache_control))).toEqual([false, true]);
    expect(markedWordsIndex(prepared)).toBe(0);
    expect(JSON.stringify(prepared.messages.at(-1))).toContain('"cache_control"');
    expect(() => cachePlanRequest({ ...round, cache_control: { type: 'ephemeral', ttl: '1h' } })).toThrow('HAIKU_CACHE_PROTOCOL_INVALID');
  });
});

describe('a Talk under the plan (golden plan-text-talk)', () => {
  const golden = JSON.parse(readFileSync(new URL(`./fixtures/claude-requests/${PLAN_TALK_SCENARIO}.json`, import.meta.url), 'utf8')) as {
    requests: Array<{ body: Body }>;
  };
  const text = golden.requests.map(request => request.body).filter(body => (body.tools ?? []).some(tool => 'name' in tool && tool.name === 'tool_open'));
  const firsts = [text[0]!, text[1]!, text[3]!];

  it('has three turns, the second with one tool round', () => {
    expect(text).toHaveLength(4);
    expect(firsts.map(markedWordsIndex)).toEqual([0, 2, 4]);
  });

  it('repeats each turn\'s cached prefix byte for byte up to that turn\'s words (BP2)', () => {
    for (let turn = 1; turn < firsts.length; turn++) {
      const cachedUpTo = markedWordsIndex(firsts[turn - 1]!);
      expect(renderedPrefix(firsts[turn]!, cachedUpTo)).toBe(renderedPrefix(firsts[turn - 1]!, cachedUpTo));
    }
  });

  it('keeps a turn\'s later round append-only after its first request', () => {
    const [first, second] = [text[1]!, text[2]!];
    expect(renderedPrefix(second, first.messages.length - 1)).toBe(renderedPrefix(first, first.messages.length - 1));
  });
});

describe('the warm-turn view of GET /v1/ops', () => {
  const body = sent(base);
  const usage = (read: number, write: number) => ({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: read, cache_creation_input_tokens: write,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: write } });

  it('counts follow-up turns within the hour of their Talk, the creation they paid and the first-token time by cache read', () => {
    const turn = (thread: string, firstTokenMs?: number) => ({ thread, cachePlan: true, ...(firstTokenMs === undefined ? {} : { firstTokenMs }) });
    recordCacheReceipt('text', body, usage(0, 3_000), 0, '2026-10-12T01:00:00.000Z', turn('a', 900));
    recordCacheReceipt('text', body, usage(3_000, 200), 0, '2026-10-12T01:20:00.000Z', turn('a', 300));
    recordCacheReceipt('text', body, usage(3_000, 100), 1, '2026-10-12T01:20:05.000Z', turn('a'));
    recordCacheReceipt('text', body, usage(0, 3_000), 0, '2026-10-12T02:30:00.000Z', turn('a', 1_000));
    recordCacheReceipt('text', body, usage(0, 3_000), 0, '2026-10-12T02:31:00.000Z', turn('b', 800));
    recordCacheReceipt('text', body, usage(3_000, 0), 0, '2026-10-12T02:31:00.000Z');
    const view = cacheReceiptsView();
    expect(view.foregroundText['2026-10-12']).toEqual({ plan: {
      turns: 4, warmTurns: 1, warmTurnsWithCacheRead: 1, warmCacheRead: 3_000, warmCacheCreation: 200, warmReadRate: 1, creationPerWarmTurn: 200,
      firstTokenMs: { cacheRead: { count: 1, p50: 300, p80: 300 }, noCacheRead: { count: 3, p50: 900, p80: 1_000 } },
    } });
    expect(view.recent[0]!.thread).toMatch(/^[0-9a-f]{8}$/u);
    expect(JSON.stringify(view)).not.toContain('"a"');
    expect(warmDayLine('2026-10-12')).toBe('plan=1/1');
    expect(warmDayLine('2026-10-11')).toBe('none');
  });
});

describe('reading a superset answer', () => {
  it('takes only the fields the turn offered', () => {
    const raw = JSON.stringify({ reply: '合成の返事', feeling: { kind: 'happy', strength: 'subtle' }, threadSummary: null, threadTitle: '題',
      taskDecision: { disposition: 'none', reason: '合成' }, taskProposal: null, intentPlan: null, artifacts: null,
      places: [{ name: '店', address: '住所', reason: '理由', mapQuery: '店' }], roomLook: 'curious', appLook: 'curious_back',
      minecraftIntent: { kind: 'task', goal: '木を集める' }, webSearchNeedsInput: null });
    const read = chatTurnResult(HAIKU.model, base, { output_text: raw }, parsedChatTurn({ output_text: raw }));
    expect(read).toEqual({ mode: 'openai', model: HAIKU.model, reply: '合成の返事', taskDecision: { disposition: 'none', reason: '合成' } });
  });
});
