import type Anthropic from '@anthropic-ai/sdk';
import { shannonIdentityPrompt } from '@shannon/cognition';
import { decideTier, type DifficultyAnswers } from '@shannon/learning';
import { AnthropicChatModel } from '../../src/infra/models/anthropic/anthropicChatModel.js';
import { activeAnthropicToolNames } from '../../src/infra/models/anthropic/anthropicForegroundMenu.js';
import { TOOL_CALL_PROVIDER_NAME } from '../../src/infra/models/anthropic/anthropicToolCapacity.js';
import { sonnetSettings } from '../../src/infra/models/anthropic/anthropicConfig.js';
import type { ShannonChatModelResult } from '../../src/infra/models/chatModel.js';
import { CONVERSATION_TOOL_CALLS, type ShannonModelToolSession } from '../../src/infra/models/chatModelTools.js';
import { TEXT_TURN_DEADLINE, TurnDeadline, VOICE_TURN_DEADLINE } from '../../src/mind/action/respond/turnDeadline.js';
import { verifyWriteClaims } from '../../src/mind/selectors/turnVerifier.js';
import { providerToolName, shannonTool, type ShannonToolDefinition } from '../../src/mind/tools/shannonTools.js';
import {
  TIER_CASES, TIER_SCENARIOS, scoredCheck, type ReachCheckResult, type ReachDriver, type ReachScenarioDefinition, type TierCase,
} from '../../../../packages/evaluation/src/reach/index.js';
import { message, scriptedAnthropic, type AnthropicMessage } from '../support/anthropicFixtures.js';
import { REACH_YEN_PER_USD, ReachUsage } from './reachConversation.js';

/**
 * The driver of the `tier.*` set (Syzygy ADR-0008 stage 2, step 5): one owner turn through the real Sonnet adapter
 * (`AnthropicChatModel`, streamed as in production) with stub tools, judged from outside. Model-free, a script answers
 * (a call of the needed tool with its required fields, then the answer); live, Anthropic does, with the key from the
 * environment (never printed). The tuning knobs are the adapter's settings (`SHANNON_SONNET_EFFORT`, `SHANNON_SONNET_TEXT_THINKING`,
 * `SHANNON_SONNET_VOICE_THINKING`, `SHANNON_SONNET_MODEL`), kept in each record's inputs, so two runs compare only like with like.
 */
type Environment = Readonly<Record<string, string | undefined>>;
const SCOPE = 'reach:tier';

/** What a stub tool answers: content-free fixtures that read like her places. */
const STUB_RESULTS: Readonly<Record<string, string>> = {
  'study.list': '- id: p1｜メモ「雨の日」（下書きではない）\n- id: p2｜物語「灯台」（下書き）',
  'study.search': '- id: p1｜メモ「雨の日」: …雨の音を聞いていた…',
  'study.read': 'メモ「雨の日」（第1版）\n雨の音を聞いていた。',
  'study.create': '書いた。id: p3',
  'study.update': '書き直した。第2版',
  'schedule.upcoming': "[Owner's upcoming items] - 予定: 10/9(木) 10:00 歯医者\n- 予定: 10/11(土) 旅行（京都）",
  'notion.read': '{"kind":"page","title":"キャラ設定","excerpt":"シャノン: 好奇心が強い。"}',
  'voyager.tasks': '[{"title":"引っ越しの見積もり","status":"open"}]',
};

/** The stub session of a case: the registry definitions it offers, each call recorded and answered from the fixtures. */
export function stubSession(item: TierCase): { session: ShannonModelToolSession | undefined; calls: Array<{ name: string; ok: boolean; effect: 'read' | 'write' }> } {
  const definitions = item.tools.map(name => shannonTool(name)).filter((tool): tool is ShannonToolDefinition => tool !== null);
  const calls: Array<{ name: string; ok: boolean; effect: 'read' | 'write' }> = [];
  if (!definitions.length) return { session: undefined, calls };
  const session: ShannonModelToolSession = {
    definitions, maximumCalls: CONVERSATION_TOOL_CALLS,
    deadline: new TurnDeadline(item.surface === 'voice' ? VOICE_TURN_DEADLINE : TEXT_TURN_DEADLINE),
    async call(providerName) {
      const tool = definitions.find(definition => providerToolName(definition.name) === providerName);
      if (!tool) return JSON.stringify({ ok: false, text: 'この返事ではその道具は出していない。', failure: 'not_offered', retryable: false });
      calls.push({ name: tool.name, ok: true, effect: tool.effect === 'write' ? 'write' : 'read' });
      return JSON.stringify({ ok: true, text: STUB_RESULTS[tool.name] ?? 'できた。', retryable: false });
    },
  };
  return { session, calls };
}

/** A call's input with the required fields filled, as the script writes it. */
function scriptedInput(tool: ShannonToolDefinition): Record<string, unknown> {
  return Object.fromEntries(tool.input.required.map(name => {
    const property = tool.input.properties[name]!;
    return [name, property.type === 'string' ? property.enum?.[0] ?? 'テスト' : property.type === 'integer' ? property.minimum : false];
  }));
}

/** The model-free answers of a case: the needed call first, then the reply (claiming a write only when one ran). */
export function tierScript(item: TierCase, body?: Anthropic.MessageCreateParamsNonStreaming): AnthropicMessage[] {
  const tool = item.expectTool ? shannonTool(item.expectTool) : null;
  const write = tool?.effect === 'write';
  const reply = write ? '書斎に保存しました。' : 'はい、分かりました。';
  const answer = item.surface === 'text'
    ? message([{ type: 'text', text: JSON.stringify({ reply, feeling: null, threadSummary: null, threadTitle: null, taskDecision: { disposition: 'none', reason: '会話' },
      taskProposal: null, intentPlan: null, artifacts: null }), citations: null }], 'end_turn')
    : message([{ type: 'text', text: reply, citations: null }], 'end_turn');
  if (!tool) return [answer];
  const name = providerToolName(tool.name), input = scriptedInput(tool);
  const active = body ? activeAnthropicToolNames(body) : [];
  // Follow the real request's transport. The adapter may carry a selected schema as data to fit provider limits;
  // the bridge must still run the original registry tool. An absent bridge does not grant a new calling path.
  const bridged = body && !active.includes(name) && active.includes(TOOL_CALL_PROVIDER_NAME);
  return [message([{ type: 'tool_use', id: 'toolu_script', name: bridged ? TOOL_CALL_PROVIDER_NAME : name,
    input: bridged ? { name, argumentsJson: JSON.stringify(input) } : input }], 'tool_use'), answer];
}

const SPOKEN_MARKUP = /```|\*\*|^#|https?:\/\/|^\s*[{[]/mu;

export function tierDriver(definition: ReachScenarioDefinition, item: TierCase, mode: 'scripted' | 'live', environment: Environment): ReachDriver {
  return async ({ signal }) => {
    const settings = sonnetSettings(environment);
    const usage = new ReachUsage();
    const scripted = mode === 'scripted' ? scriptedAnthropic((body, index) => tierScript(item, body as unknown as Anthropic.MessageCreateParamsNonStreaming)[index]!) : null;
    const apiKey = mode === 'live' ? environment.SHANNON_ANTHROPIC_API_KEY?.trim() || environment.ANTHROPIC_API_KEY?.trim() || '' : 'scripted';
    if (!apiKey) return { pending: 'credential: ANTHROPIC_API_KEY or SHANNON_ANTHROPIC_API_KEY is not set' };
    const model = new AnthropicChatModel({ apiKey, settings, usageStore: usage, ...(scripted ? { fetch: scripted.fetcher } : {}) });
    const { session, calls } = stubSession(item);
    const decision = decideTier({ surface: item.surface, answers: item.answers as DifficultyAnswers, lunaCompetence: null, sonnetAvailable: true,
      ...(item.surface === 'voice' ? { voice: { remainingMs: item.remainingMs ?? 0, sonnetFirstTokenMs: null } } : {}) });
    const base = { scopeKey: SCOPE, systemPrompt: shannonIdentityPrompt('owner'), history: [], message: item.words, turnContext: `[いまの時刻] 2026-10-07 12:00（${item.surface === 'voice' ? '声' : '文字'}）`,
      ...(session ? { tools: session } : {}) };
    const started = performance.now();
    let firstWord: number | null = null;
    let result: ShannonChatModelResult | null = null;
    let failure: string | null = null;
    const heard = () => { firstWord ??= performance.now() - started; };
    try {
      result = item.surface === 'text'
        ? await model.generateStreaming({ ...base, ...(item.web ? { useWebSearch: true } : {}) }, heard)
        : await model.generateVoiceStreaming({ ...base, useWebSearch: item.web === true, conversationClass: decision.served === 'sonnet' ? 'skill_complex' : 'direct' }, heard, signal);
    } catch (error) {
      failure = error instanceof Error ? error.name : 'error';
    }
    const latency = model.firstTokenLatency.estimate() ?? firstWord ?? Number.POSITIVE_INFINITY;
    const reply = result?.reply ?? '';
    const checks: ReachCheckResult[] = [
      // The tier as served: a Sonnet the voice turn cannot wait for is luna.
      scoredCheck(definition, 'policy.tier', (decision.tier === 'sonnet' && decision.served !== 'sonnet' ? decision.served : decision.tier) === item.expectTier ? 1 : 0, 'build', `${decision.tier}/${decision.served}`),
      scoredCheck(definition, 'request.accepted', failure === null ? 1 : 0, failure === 'BadRequestError' || failure === 'SonnetRefusalError' ? 'build' : 'tool', failure ?? undefined),
      scoredCheck(definition, 'answer.shape', result && !result.outOfTime && reply.trim() && (item.surface === 'text' || !SPOKEN_MARKUP.test(reply)) ? 1 : 0, 'model_judgment'),
      scoredCheck(definition, 'tool.expected', item.expectTool ? calls.some(call => call.name === item.expectTool) ? 1 : 0 : calls.length === 0 ? 1 : 0, 'model_judgment',
        `calls:${calls.map(call => call.name).join(',') || 'none'}`),
      scoredCheck(definition, 'claims.verified', verifyWriteClaims(reply, calls) === 'ok' ? 1 : 0, 'model_judgment'),
      ...(item.surface === 'voice' ? [scoredCheck(definition, 'latency.first_token', latency <= 4_000 ? 1 : 0, 'timeout', `ms:${Number.isFinite(latency) ? Math.round(latency) : -1}`)] : []),
    ];
    const tokens = usage.events.reduce((sum, event) => ({ input: sum.input + event.inputTokens, cached: sum.cached + event.cachedInputTokens, output: sum.output + event.outputTokens, usd: sum.usd + event.estimatedCostUsd }),
      { input: 0, cached: 0, output: 0, usd: 0 });
    const promptCharacters = (scripted?.bodies ?? []).reduce((sum, body) => sum + JSON.stringify(body).length, 0);
    return {
      checks, steps: Math.max(1, usage.events.length),
      cost: { calls: usage.events.length, inputTokens: tokens.input, outputTokens: tokens.output, cachedInputTokens: tokens.cached,
        yen: Math.round(tokens.usd * REACH_YEN_PER_USD * 100) / 100, measured: mode === 'live', promptCharacters },
      metrics: { firstTokenMs: Number.isFinite(latency) ? Math.round(latency) : -1, toolCalls: calls.length, rounds: usage.events.length },
      inputs: { model: settings.model, effort: settings.effort, textThinking: settings.textThinking, voiceThinking: settings.voiceThinking, mode },
    };
  };
}

export function tierDrivers(mode: 'scripted' | 'live', environment: Environment = {}): Record<string, () => ReachDriver> {
  return Object.fromEntries(TIER_SCENARIOS.map(definition => [definition.id, () => tierDriver(definition, TIER_CASES.find(item => `tier.${item.id}` === definition.id)!, mode, environment)]));
}
