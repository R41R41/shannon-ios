import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { DifficultyAnswers } from '@shannon/learning';
import { AnthropicChatModel } from '../src/infra/models/anthropic/anthropicChatModel.js';
import { plannedChatBody } from '../src/infra/models/anthropic/anthropicCachePlan.js';
import { claudeTextBody } from '../src/infra/models/anthropic/anthropicRequest.js';
import { sonnetSettings } from '../src/infra/models/anthropic/anthropicConfig.js';
import type { ShannonChatModel, ShannonChatModelRequest } from '../src/infra/models/chatModel.js';
import type { ShannonModelToolSession } from '../src/infra/models/chatModelTools.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { TEXT_TURN_DEADLINE, TurnDeadline } from '../src/mind/action/respond/turnDeadline.js';
import { textThinkingCase, textTurnThinking, type RoutedTier } from '../src/mind/action/respond/turnRouting.js';
import type { TurnChooser } from '../src/mind/selectors/turnChoices.js';
import { withToolMenu } from '../src/mind/tools/shannonToolMenu.js';
import { shannonTool } from '../src/mind/tools/shannonTools.js';
import { createLocalApiKernel } from '../src/wiring/apiKernelWiring.js';
import { createInMemoryAutonomyService } from '../src/wiring/autonomyServiceWiring.js';
import { configuredTurnRouting } from '../src/wiring/turnRoutingWiring.js';
import { anthropicFixture, scriptedAnthropic, type AnthropicMessage } from './support/anthropicFixtures.js';

/**
 * Owner decision 2026-10-14 (「軽い会話だけ考えるのを切る」): a light text turn, or one read aloud, answers without thinking;
 * a hard or research turn, and every turn with `SHANNON_TEXT_LIGHT_NO_THINKING=off`, thinks exactly as before.
 */
const HAIKU = { model: 'claude-haiku-5-5', effort: 'low', textThinking: 'adaptive', voiceThinking: 'disabled' } as const;
const base: ShannonChatModelRequest = { scopeKey: 'owner', systemPrompt: '[シャノン]', profilePrompt: '[ライ氏のこと]', turnContext: '[いまの文脈]',
  history: [{ role: 'user', content: 'ただいま' }, { role: 'assistant', content: 'おかえりなさい。' }], message: 'ねえ、きいて' };

const tier = (extra: Partial<RoutedTier>): RoutedTier => ({
  tier: 'luna', served: 'luna', reason: 'plain', mappedDown: 'none', rethinks: 0, verify: false, escalateOnTrouble: false, kind: 'chat', ...extra,
});
const SMALL_TALK = tier({ tier: 'jev_only', reason: 'small_talk' });

function tools(names = ['study.list', 'memory.search', 'memory.read']): ShannonModelToolSession {
  return { definitions: names.map(name => shannonTool(name)!), maximumCalls: 6, deadline: new TurnDeadline(TEXT_TURN_DEADLINE),
    async call() { return JSON.stringify({ ok: true, text: 'ok', retryable: false }); } };
}

afterEach(() => { vi.unstubAllEnvs(); });

describe('the rule', () => {
  it('lets small talk that asks for no tool answer without thinking', () => {
    expect(textThinkingCase({ tier: SMALL_TALK, tools: undefined, readAloud: undefined, research: [] })).toBe('light');
    // Only the always-loaded tools and tool_open after Jev's menu (or the FCA selector) chose nothing.
    expect(textThinkingCase({ tier: SMALL_TALK, tools: withToolMenu(tools(), []), readAloud: undefined, research: [] })).toBe('light');
  });

  it('keeps thinking for small talk that asks for a tool, or whose tools nothing narrowed', () => {
    expect(textThinkingCase({ tier: SMALL_TALK, tools: withToolMenu(tools(), ['study_list']), readAloud: undefined, research: [] })).toBeNull();
    expect(textThinkingCase({ tier: SMALL_TALK, tools: tools(), readAloud: undefined, research: [] })).toBeNull();
  });

  it('keeps thinking for every turn that is not small talk unless it is read aloud', () => {
    for (const routed of [null, tier({}), tier({ reason: 'middle', escalateOnTrouble: true }), tier({ reason: 'no_answers' })]) {
      expect(textThinkingCase({ tier: routed, tools: undefined, readAloud: undefined, research: [] })).toBeNull();
      expect(textThinkingCase({ tier: routed, tools: undefined, readAloud: true, research: [] })).toBe('read_aloud');
    }
    // Only `true` reads aloud.
    expect(textThinkingCase({ tier: tier({}), tools: undefined, readAloud: 'yes', research: [] })).toBeNull();
  });

  it('keeps thinking for hard and research turns, read aloud or not', () => {
    const hard = [tier({ tier: 'sonnet', served: 'luna_plus', reason: 'strong', mappedDown: 'unavailable' }), tier({ tier: 'sonnet', served: 'sonnet', reason: 'strong' }),
      tier({ tier: 'luna_plus', served: 'luna_plus', reason: 'multi_step' }), tier({ reason: 'explore', escalateOnTrouble: true }),
      tier({ tier: 'sonnet', served: 'luna_plus', reason: 'luna_weak', mappedDown: 'unavailable' })];
    for (const routed of hard) for (const readAloud of [undefined, true]) {
      expect(textThinkingCase({ tier: routed, tools: undefined, readAloud, research: [] })).toBeNull();
    }
    for (const research of [[true], [{ id: 'work' }], [1], [undefined, true]]) for (const readAloud of [undefined, true]) {
      expect(textThinkingCase({ tier: SMALL_TALK, tools: undefined, readAloud, research })).toBeNull();
    }
    expect(textThinkingCase({ tier: SMALL_TALK, tools: undefined, readAloud: undefined, research: [null, undefined, 0, false] })).toBe('light');
  });

  it('is on by default and off with the switch', () => {
    const light = { tier: SMALL_TALK, tools: undefined, readAloud: true, research: [] };
    expect(textTurnThinking(light, {})).toEqual({ skipThinking: true });
    expect(textTurnThinking(light, { SHANNON_TEXT_LIGHT_NO_THINKING: 'off' })).toEqual({});
    expect(textTurnThinking({ ...light, tier: tier({ reason: 'strong', tier: 'sonnet', served: 'luna_plus' }) }, {})).toEqual({});
  });
});

describe('the Claude request', () => {
  it('changes only `thinking`: tools, system, messages, effort and schema keep their bytes', () => {
    const request = { ...base, tools: withToolMenu(tools(['study.list']), ['study_list']) };
    for (const build of [claudeTextBody, plannedChatBody]) {
      const thinking = build(HAIKU, request, undefined);
      const light = build(HAIKU, { ...request, skipThinking: true }, undefined);
      expect(thinking.thinking).toEqual({ type: 'adaptive' });
      expect(light.thinking).toEqual({ type: 'disabled' });
      expect({ ...light, thinking: thinking.thinking }).toEqual(thinking);
      expect(JSON.stringify(light.tools)).toBe(JSON.stringify(thinking.tools));
      expect(JSON.stringify(light.system)).toBe(JSON.stringify(thinking.system));
    }
  });

  it('turns the Sonnet tier off with between_tools, which it accepts, never with disabled', () => {
    expect(claudeTextBody(sonnetSettings({}), { ...base, skipThinking: true }, undefined).thinking).toEqual({ type: 'between_tools' });
    expect(claudeTextBody(sonnetSettings({}), base, undefined).thinking).toEqual({ type: 'adaptive' });
  });

  it('keeps thinking off on every round of the tool loop of a light turn, and on every round of a turn that thinks', async () => {
    const haiku = (value: AnthropicMessage): AnthropicMessage => ({ ...value, model: HAIKU.model,
      usage: { ...value.usage, cache_creation_input_tokens: 0, cache_read_input_tokens: 900, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } } });
    for (const skipThinking of [true, undefined]) {
      const transport = scriptedAnthropic([haiku(anthropicFixture('tool-call')), haiku(anthropicFixture('structured-answer'))]);
      const chat = new AnthropicChatModel({ apiKey: 'test-only', settings: HAIKU, fetch: transport.fetcher,
        usageStore: { recordLlmUsage: () => {}, backgroundLlmCostUsd: () => 0 } });
      await chat.generate({ ...base, tools: tools(['study.list']), ...(skipThinking ? { skipThinking } : {}) });
      expect(transport.bodies).toHaveLength(2);
      expect(transport.bodies.map(body => body.thinking)).toEqual(Array(2).fill({ type: skipThinking ? 'disabled' : 'adaptive' }));
    }
  });
});

const directory = mkdtempSync(join(tmpdir(), 'shannon-text-thinking-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
let files = 0;

class RecordingModel implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly all: ShannonChatModelRequest[] = [];
  async generate(request: ShannonChatModelRequest) { this.all.push(request); return { mode: this.mode, model: this.model, reply: 'うん、聞いてるよ。' }; }
}

function kernel(answers: Partial<DifficultyAnswers>) {
  const now = () => '2026-10-14T00:00:00.000Z';
  const path = join(directory, `turn-${files += 1}.sqlite`);
  const store = new SQLiteShannonStore({ path, now, predictionLedger: true, choiceLedger: true, cognitionDefer: task => task(), predictionShadowDefer: task => task() });
  const database = new DatabaseSync(path);
  const routing = configuredTurnRouting({}, { databasePath: null, database, choices: store.choiceLedger(), defer: task => task() })!;
  const chooser: TurnChooser = { difficulty: true, choose: async () => ({ menu: { chosen: [] },
    difficulty: { taskKind: 'chat', needsStrongModel: 0.02, needsVerification: 0.02, multiStep: 0.02, ...answers }, retry: null }) };
  const model = new RecordingModel();
  const api = createLocalApiKernel(now, { chatModel: model, autonomy: createInMemoryAutonomyService(now), turnChooser: chooser, turnRouting: routing.routing });
  const turn = async (body: Record<string, unknown> = {}) => {
    const response = await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'thread', message: 'ねえ、きいて', ...body } });
    return { status: response.status, request: model.all.at(-1) };
  };
  return { turn, close: () => { store.close(); database.close(); } };
}

describe('a text turn through the kernel', () => {
  it('sends a light turn without thinking', async () => {
    const k = kernel({});
    expect((await k.turn()).request).toMatchObject({ skipThinking: true });
    k.close();
  });

  it('keeps a hard or strong turn as it was, also when it is read aloud', async () => {
    for (const answers of [{ needsStrongModel: 0.95 }, { multiStep: 0.95 }, { taskKind: 'analysis' as const, needsStrongModel: 0.5 }]) {
      const k = kernel(answers);
      expect((await k.turn()).request).not.toHaveProperty('skipThinking');
      if (answers.taskKind !== 'analysis') expect((await k.turn({ readAloud: true })).request).not.toHaveProperty('skipThinking');
      k.close();
    }
  });

  it('sends a read-aloud turn that is neither hard nor research without thinking, and a research turn with it', async () => {
    const k = kernel({ taskKind: 'analysis', needsStrongModel: 0.5 });
    expect((await k.turn({ readAloud: true })).request).toMatchObject({ skipThinking: true });
    expect((await k.turn({ readAloud: true, webSearch: true })).request).not.toHaveProperty('skipThinking');
    expect((await k.turn({ readAloud: false })).request).not.toHaveProperty('skipThinking');
    expect((await k.turn({ readAloud: 'yes' })).status).toBe(400);
    k.close();
  });

  it('keeps every turn as it was with the switch off', async () => {
    vi.stubEnv('SHANNON_TEXT_LIGHT_NO_THINKING', 'off');
    const k = kernel({});
    expect((await k.turn()).request).not.toHaveProperty('skipThinking');
    expect((await k.turn({ readAloud: true })).request).not.toHaveProperty('skipThinking');
    k.close();
  });
});
