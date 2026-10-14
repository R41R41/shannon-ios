import { configuredJevChooser } from '../src/wiring/skillRoutingWiring.js';
import { createConfiguredChatModel } from '../src/infra/models/openAIChatModel.js';
import { createConfiguredBodyReactionSpeaker } from '../src/surfaces/body/bodyReactionModel.js';
import { jevUsdPerCall } from '../src/infra/models/jev/jevUsage.js';
import { AnthropicChatModel } from '../src/infra/models/anthropic/anthropicChatModel.js';
import { anthropicApiKey, haikuVoiceThinking, sonnetSettings } from '../src/infra/models/anthropic/anthropicConfig.js';
import { DatabaseSync } from 'node:sqlite';
import { switchOn } from '@shannon/switches';
import { composedFeeling, strongReplyDailyCap } from '../src/wiring/feelingWiring.js';
import type { LlmUsageEvent } from '../src/infra/models/llmUsage.js';
import type { ShannonChatModel, ShannonChatModelRequest } from '../src/infra/models/chatModel.js';
import { FEELING_SCENES, playScene, sceneDriver, sceneReport } from './support/feelingScenarios.js';

/**
 * The typical scenes against the real models, each once (Syzygy ADR-0013 stage 1; owner 2026-10-14: 「もっと典型的な例を作ってやって
 * ほしい」): Jev for the feeling turn, the conversation's model for replies and touch lines, with feeling events, the feeling turn and the
 * one face on. Billable: run on purpose (`pnpm --filter @shannon/api test:llm-feeling-scenes`) with `TYPESAFE_API_KEY` and the
 * conversation's model key. `SHANNON_FEELING_SCENES` (comma-separated ids) runs a subset. Prints per scene the stances, the
 * presentation ids, AI-register phrases, followed orders, openers and habits, samples, latency and cost (model usage, and Jev at
 * `SHANNON_JEV_USD_PER_CALL` when set).
 */
const usage: LlmUsageEvent[] = [];
const usageStore = { recordLlmUsage: (event: LlmUsageEvent) => { usage.push(event); }, backgroundLlmCostUsd: () => 0 };
let jevCalls = 0;
const chooser = configuredJevChooser(process.env, { trace: () => { jevCalls += 1; } });
if (!chooser) throw new Error('TYPESAFE_API_KEY is required for the live feeling-scene evaluation');
// `SHANNON_FEELING_EVAL_REPLY_MODEL=claude-sonnet-5-5`: the replies (and touch lines) on Sonnet for the evaluation only, with the shared
// Anthropic key as the app's Sonnet routing uses it; the app's default is not changed.
const replyModel = process.env.SHANNON_FEELING_EVAL_REPLY_MODEL?.trim();
const sonnetKey = replyModel?.startsWith('claude-sonnet-') ? anthropicApiKey(process.env) : null;
if (replyModel && !sonnetKey) throw new Error('SHANNON_FEELING_EVAL_REPLY_MODEL takes a claude-sonnet model with the shared Anthropic key');
const conversation: ShannonChatModel = sonnetKey && replyModel ? new AnthropicChatModel({ apiKey: sonnetKey, usageStore,
  settings: { model: replyModel, effort: 'low', textThinking: 'adaptive', voiceThinking: haikuVoiceThinking(process.env) } })
  : createConfiguredChatModel(process.env, usageStore);
if (conversation.mode === 'local-stub') throw new Error('A conversation model credential is required for the live feeling-scene evaluation');
const only = new Set((process.env.SHANNON_FEELING_SCENES ?? '').split(',').map(id => id.trim()).filter(Boolean));
const jevPrice = jevUsdPerCall(process.env);

function recording(inner: () => ShannonChatModel): ShannonChatModel & { requests: ShannonChatModelRequest[] } {
  const requests: ShannonChatModelRequest[] = [];
  return Object.assign(Object.create(conversation) as ShannonChatModel, {
    requests, generate: (request: ShannonChatModelRequest) => { requests.push(request); return inner().generate(request); },
  });
}

/**
 * Her feeling port as the server composes it: with `SHANNON_FEELING_STRONG_REPLY_MODEL=on` the strong turns' replies go to the app's
 * Sonnet (its settings and the shared Anthropic key), at most the day's cap.
 */
function feelingConfigured(now: () => string) {
  const apiKey = anthropicApiKey(process.env);
  const sonnet = switchOn(process.env, 'SHANNON_FEELING_STRONG_REPLY_MODEL') && apiKey
    ? new AnthropicChatModel({ apiKey, usageStore, settings: sonnetSettings(process.env) }) : null;
  return composedFeeling({ database: new DatabaseSync(':memory:'), now, timeZone: 'Asia/Tokyo', chooser, turn: true, singleFace: true,
    ...(sonnet ? { strong: { cap: strongReplyDailyCap(process.env), model: sonnet } } : {}) });
}

const reports = [];
for (const scene of FEELING_SCENES.filter(item => !only.size || only.has(item.id))) {
  const usedBefore = usage.length, jevBefore = jevCalls;
  let wrapped: ShannonChatModel = conversation;
  const driver = await sceneDriver({ port: now => { const configured = feelingConfigured(now); wrapped = configured.wrap(conversation); return configured.port; },
    chatModel: recording(() => wrapped),
    speaker: createConfiguredBodyReactionSpeaker(replyModel ? { ...process.env, SHANNON_LLM_MODEL: 'claude-haiku-5-5' } : process.env, usageStore) });
  const result = await playScene(driver, scene);
  const modelUsd = usage.slice(usedBefore).reduce((sum, event) => sum + event.estimatedCostUsd, 0);
  const jev = jevCalls - jevBefore;
  const used = usage.slice(usedBefore);
  const input = used.reduce((sum, event) => sum + event.inputTokens, 0), cached = used.reduce((sum, event) => sum + event.cachedInputTokens, 0);
  const byModel = Object.fromEntries([...new Set(used.map(event => event.model))].map(model => {
    const rows = used.filter(event => event.model === model);
    return [model, { calls: rows.length, usd: Math.round(rows.reduce((sum, event) => sum + event.estimatedCostUsd, 0) * 10_000) / 10_000,
      minCachedTokens: Math.min(...rows.map(event => event.cachedInputTokens)), maxInputTokens: Math.max(...rows.map(event => event.inputTokens)) }];
  }));
  const report = { ...sceneReport(result), byModel, modelUsd: Math.round(modelUsd * 10_000) / 10_000, jevCalls: jev, modelCalls: used.length,
    usdPerTurn: Math.round((modelUsd / Math.max(1, result.turns.length)) * 10_000) / 10_000, cacheHit: input ? Math.round((cached / input) * 100) / 100 : null,
    jevUsd: jevPrice === null ? null : Math.round(jev * jevPrice * 10_000) / 10_000 };
  reports.push(report);
  console.log(JSON.stringify(report, null, 2));
}
const latencies = reports.flatMap(report => report.latencyMs).sort((a, b) => a - b);
const percentile = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] ?? null;
console.log(JSON.stringify({
  replyModel: replyModel ?? 'configured', scenes: reports.length, textLatencyMs: { p50: percentile(0.5), p95: percentile(0.95), max: latencies.at(-1) ?? null },
  modelUsd: Math.round(reports.reduce((sum, report) => sum + report.modelUsd, 0) * 10_000) / 10_000,
  jevCalls: reports.reduce((sum, report) => sum + report.jevCalls, 0),
  aiRegister: reports.reduce((sum, report) => sum + report.aiRegister, 0),
  ownerOnlyInPublic: reports.reduce((sum, report) => sum + report.ownerOnlyInPublic, 0),
}, null, 2));
