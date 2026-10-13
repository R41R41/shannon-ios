import { readFileSync } from 'node:fs';
import type Anthropic from '@anthropic-ai/sdk';
import { SHANNON_CAPABILITIES, SHANNON_FCA_TASK_CAPABILITY, withSkillsCapability } from '@shannon/cognition';
import { afterEach, describe, expect, it } from 'vitest';
import { planToolPair, planSchemaOf, plannedChatBody } from '../src/infra/models/anthropic/anthropicCachePlan.js';
import { plannedVoiceBody, voicePlanApplies, voicePlanCovers, voiceStableSystem } from '../src/infra/models/anthropic/anthropicVoicePlan.js';
import { cachePlanRequest } from '../src/infra/models/anthropic/cachePlanMarkers.js';
import { CLAUDE_VOICE_LINES, claudeVoiceBody } from '../src/infra/models/anthropic/anthropicRequest.js';
import { cacheReceiptsView, recordCacheReceipt, resetCacheReceipts } from '../src/infra/models/anthropic/cacheReceipts.js';
import { warmDayLine } from '../src/infra/models/anthropic/cacheWarmTurns.js';
import { VOICE_REPLY_INSTRUCTIONS, type ShannonVoiceModelRequest } from '../src/infra/models/chatModel.js';
import { VOICE_NATURAL_INSTRUCTIONS } from '../src/mind/action/respond/respondInstructions.js';
import { withToolMenu } from '../src/mind/tools/shannonToolMenu.js';
import { SKILL_INDEX_HEADER } from '../src/mind/memory/skillDocument.js';
import { VOICE_PLAN_TALK_SCENARIO } from './support/claudeVoicePlanScenarios.js';
import { HAIKU, SONNET, tools, type Settings } from './support/claudeForegroundScenarios.js';

/**
 * The voice cache plan (Syzygy ADR-0009 stage 1, M6): what stays the same on every voice turn of a Talk, that the voice
 * instructions are kept whole, that each turn's request repeats the previous turn's cached prefix byte for byte, that the plan
 * adds no request, and the voice lanes of `GET /v1/ops`. The request shapes are held by the goldens `plan-voice-*`.
 */
type Body = Anthropic.MessageCreateParamsNonStreaming;
afterEach(() => resetCacheReceipts());

const identity = `合成された人格\n${SHANNON_CAPABILITIES.map(item => `- ${item.text}\n`).join('')}`;
const skillIndex = `${SKILL_INDEX_HEADER} 1/20（目次。中身は skill_read で開く）]\n- 合成スキル: 説明`;
const base: ShannonVoiceModelRequest = { scopeKey: 'owner', systemPrompt: identity, history: [], message: 'おはよう', turnContext: '合成された文脈',
  useWebSearch: false, conversationClass: 'direct' };

/** Voice turns as different as a Talk has them (the memory skill brings what she knows of the owner; tools bring their lines). */
const variants: Record<string, ShannonVoiceModelRequest> = {
  plain: base,
  memory: { ...base, profilePrompt: '合成された持ち主の層' },
  tools: { ...base, systemPrompt: `${withSkillsCapability(identity)}\n\n${SHANNON_FCA_TASK_CAPABILITY.text}`, profilePrompt: `合成された持ち主の層\n\n${skillIndex}`,
    tools: withToolMenu(tools(['study.list', 'skill.read']), ['study_list']), conversationClass: 'skill_simple' },
  withheld: { ...base, toolsWithheld: true },
  greeting: { ...base, conversationClass: 'greeting', precedingReply: 'わっ。' },
  complex: { ...base, conversationClass: 'skill_complex' },
};

function sent(request: ShannonVoiceModelRequest, settings: Settings = HAIKU): Body {
  return cachePlanRequest(plannedVoiceBody(settings, request, 300));
}

function renderedPrefix(body: Body, lastMessage: number): string {
  const { model, tools: offered, tool_choice: choice, thinking, output_config: output, system } = body;
  const strip = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null), (key, child: unknown) => key === 'cache_control' ? undefined : child);
  return JSON.stringify(strip({ model, offered, choice, thinking, output, system, messages: body.messages.slice(0, lastMessage + 1) }));
}

function markedWordsIndex(body: Body): number {
  return body.messages.findIndex(message => message.role === 'user' && Array.isArray(message.content)
    && message.content.some(block => block.type === 'text' && 'cache_control' in block && block.cache_control));
}

function systemText(body: Body): string {
  return (body.system as Anthropic.TextBlockParam[]).map(block => block.text).join('\n\n');
}

describe('the voice plan switch', () => {
  it('is off unless SHANNON_CLAUDE_CACHE_PLAN_VOICE is on, apart from the text switch, and only for the native 5.5 models', () => {
    expect(voicePlanApplies('claude-haiku-5-5', {})).toBe(false);
    expect(voicePlanApplies('claude-haiku-5-5', { SHANNON_CLAUDE_CACHE_PLAN: 'on' })).toBe(false);
    expect(voicePlanApplies('claude-haiku-5-5', { SHANNON_CLAUDE_CACHE_PLAN_VOICE: 'on' })).toBe(true);
    expect(voicePlanApplies('claude-sonnet-5-5', { SHANNON_CLAUDE_CACHE_PLAN_VOICE: 'true' })).toBe(true);
    expect(voicePlanApplies('claude-haiku-4-5', { SHANNON_CLAUDE_CACHE_PLAN_VOICE: 'on' })).toBe(false);
  });

  it('leaves a turn with a native web search in its own shape', () => {
    expect(voicePlanCovers(base)).toBe(true);
    expect(voicePlanCovers({ ...base, useWebSearch: true })).toBe(false);
  });
});

describe('the stable voice prefix', () => {
  it.each([['Haiku', HAIKU], ['Sonnet', SONNET]] as const)('is the same tools, choice, system, thinking and effort in every kind of voice turn (%s)', (_name, settings) => {
    const bodies = Object.values(variants).map(request => sent(request, settings));
    for (const body of bodies) {
      expect(body.tools).toEqual(planToolPair());
      expect(body.tool_choice).toEqual({ type: 'auto' });
      expect(body.system).toEqual(bodies[0]!.system);
      expect(body.thinking).toEqual(bodies[0]!.thinking);
      expect(body.output_config).toEqual(bodies[0]!.output_config);
      expect(body.output_config!.format).toBeUndefined();
      expect(body.cache_control).toBeUndefined();
      expect(planSchemaOf(plannedVoiceBody(settings, base, 300))).toBe('common');
    }
  });

  it('keeps the voice instructions whole and in the order the request without the plan has them', () => {
    const planned = systemText(sent(base));
    const off = systemText(cachePlanRequest(claudeVoiceBody(HAIKU, base, 300) as never));
    for (const line of [VOICE_REPLY_INSTRUCTIONS, VOICE_NATURAL_INSTRUCTIONS, CLAUDE_VOICE_LINES]) {
      expect(planned).toContain(line);
      expect(off).toContain(line);
    }
    const order = (text: string) => [VOICE_REPLY_INSTRUCTIONS, VOICE_NATURAL_INSTRUCTIONS, CLAUDE_VOICE_LINES].map(line => text.indexOf(line));
    expect(order(planned)).toEqual([...order(planned)].sort((a, b) => a - b));
    expect(voiceStableSystem(variants.tools!.systemPrompt)).toBe(voiceStableSystem(identity));
  });

  it('moves the turn\'s capability lines, what she knows of the owner, the skill index and the tool line after the words', () => {
    const tooled = sent(variants.tools!);
    const after = JSON.stringify(tooled.messages.slice(markedWordsIndex(tooled) + 1));
    for (const line of [SHANNON_FCA_TASK_CAPABILITY.text, SKILL_INDEX_HEADER, '合成された持ち主の層', '[ボクの道具・献立]']) {
      expect(systemText(tooled)).not.toContain(line);
      expect(after).toContain(line);
    }
    expect(JSON.stringify(sent(variants.plain!).messages.at(-1))).toContain('tool_open と tool_call は呼ばずに');
    expect(JSON.stringify(sent(variants.withheld!).messages.at(-1))).toContain('いまはライ氏以外の人もいるかもしれない');
  });

  it('offers the text plan\'s tool pair, so text and voice turns of a Talk share the cached tools', () => {
    const text = cachePlanRequest(plannedChatBody(HAIKU, { ...base, history: [] }, undefined));
    expect(sent(base).tools).toEqual(text.tools);
    expect(sent(variants.tools!).tools).toEqual(text.tools);
  });
});

describe('a voice Talk under the plan (golden plan-voice-talk)', () => {
  const golden = JSON.parse(readFileSync(new URL(`./fixtures/claude-requests/${VOICE_PLAN_TALK_SCENARIO}.json`, import.meta.url), 'utf8')) as {
    requests: Array<{ body: Body }>;
  };
  const bodies = golden.requests.map(request => request.body);
  const firsts = [bodies[0]!, bodies[1]!, bodies[3]!];

  it('has three turns, the second with one tool round, and no request more than the turns and their round', () => {
    expect(bodies).toHaveLength(4);
    expect(firsts.map(markedWordsIndex)).toEqual([0, 2, 4]);
  });

  it('repeats each turn\'s cached prefix byte for byte up to that turn\'s words (BP2)', () => {
    for (let turn = 1; turn < firsts.length; turn++) {
      const cachedUpTo = markedWordsIndex(firsts[turn - 1]!);
      expect(renderedPrefix(firsts[turn]!, cachedUpTo)).toBe(renderedPrefix(firsts[turn - 1]!, cachedUpTo));
    }
  });
});

describe('voice latency under the plan', () => {
  it('sends as many requests as without the plan (the goldens of the same turns)', () => {
    const requests = (name: string) => (JSON.parse(readFileSync(new URL(`./fixtures/claude-requests/${name}.json`, import.meta.url), 'utf8')) as {
      requests: unknown[] }).requests.length;
    expect(requests('plan-voice-plain')).toBe(requests('voice-plain-streamed'));
    expect(requests('plan-voice-tools')).toBe(requests('voice-tools'));
    expect(requests('plan-voice-tools-withheld')).toBe(requests('voice-tools-withheld'));
    expect(requests('plan-voice-web-search')).toBe(requests('voice-web-search'));
    expect(requests('plan-sonnet-voice')).toBe(requests('sonnet-voice'));
  });

  it('builds its request as fast as without the plan (local work only, well under a millisecond a turn)', () => {
    const time = (build: () => unknown) => {
      for (let index = 0; index < 50; index++) build();
      const started = performance.now();
      for (let index = 0; index < 400; index++) build();
      return (performance.now() - started) / 400;
    };
    const planned = time(() => cachePlanRequest(plannedVoiceBody(HAIKU, variants.tools!, 300)));
    const off = time(() => claudeVoiceBody(HAIKU, variants.tools!, 300));
    expect(planned).toBeLessThan(Math.max(2, off * 3));
  });
});

describe('the voice lanes of GET /v1/ops', () => {
  const usage = (read: number, write: number) => ({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: read, cache_creation_input_tokens: write,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: write } });
  const at = (time: string) => `2026-10-13T${time}:00.000Z`;

  it('counts warm voice turns apart from text, under the plan and without it', () => {
    const turn = (thread: string, historyMessages: number, cachePlan = true) => ({ thread, cachePlan, ...(cachePlan ? { planSchema: 'common' as const } : {}),
      historyMessages, firstTokenMs: 400 });
    const voice = sent(base);
    recordCacheReceipt('voice', voice, usage(2_000, 900), 0, at('01:00'), turn('v', 0));
    recordCacheReceipt('voice', voice, usage(3_000, 200), 0, at('01:05'), turn('v', 2));
    recordCacheReceipt('text', cachePlanRequest(plannedChatBody(HAIKU, { ...base, history: [] }, undefined)), usage(2_000, 900), 0, at('01:06'), turn('v', 4));
    recordCacheReceipt('voice', claudeVoiceBody(HAIKU, base, 300), usage(0, 3_000), 0, at('01:10'), turn('w', 0, false));
    const day = cacheReceiptsView().foregroundText.days['2026-10-13']!;
    expect(day.voice_plan).toMatchObject({ turns: 2, warmTurns: 1, warmTurnsWithHistoryRead: 1, historyReadRate: 1 });
    expect(day.plan).toMatchObject({ turns: 1, warmTurns: 0 });
    expect(day.voice_base).toMatchObject({ turns: 1, warmTurns: 0 });
    expect(warmDayLine('2026-10-13')).toBe('voice_plan=1/1,plan=0/0,voice_base=0/0');
  });
});
