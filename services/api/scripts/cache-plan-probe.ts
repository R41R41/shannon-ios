/**
 * A live probe of the foreground cache plan (Syzygy ADR-0009 stage 1, M4). Never run by the tests; it spends a few cents.
 *
 *   cd services/api && npx tsx --env-file-if-exists=../../.env scripts/cache-plan-probe.ts [--sonnet]
 *
 * For Haiku (and with `--sonnet` also for Sonnet 5.5) it sends two synthetic text-turn requests in the plan's shape, built and
 * marked exactly as the conversation sends them (`plannedChatBody`, `cachePlanRequest`): `plan-text-plain` (no tool), then
 * `plan-text-tools` (the whole text registry offered through the menu). The second should read the first's static prefix
 * (tools and system). Keys are read from the process environment under the names the server reads (`SHANNON_HAIKU_API_KEY`,
 * else `SHANNON_ANTHROPIC_API_KEY`, else `ANTHROPIC_API_KEY`; Sonnet: the last two) and never printed. Only the status, the
 * stop reason, the usage counts and an estimated cost are printed: no content, no key, no provider error text. The output
 * ceiling is small, and the probe stops before a request once its estimated spend reaches the cap.
 */
import Anthropic from '@anthropic-ai/sdk';
import { serverEnvironment } from '../src/infra/config/serverEnvironment.js';
import { plannedChatBody } from '../src/infra/models/anthropic/anthropicCachePlan.js';
import { anthropicApiKey, type SonnetSettings } from '../src/infra/models/anthropic/anthropicConfig.js';
import { offerRefusal } from '../src/infra/models/anthropic/anthropicRejection.js';
import { cachePlanRequest } from '../src/infra/models/anthropic/cachePlanMarkers.js';
import { claudeClient } from '../src/infra/models/claude/claudeClient.js';
import { estimatedAnthropicCostUsd, knownCount } from '../src/infra/models/claude/claudeUsage.js';
import type { ShannonChatModelRequest } from '../src/infra/models/chatModel.js';
import type { ShannonModelToolSession } from '../src/infra/models/chatModelTools.js';
import { TEXT_TURN_DEADLINE, TurnDeadline } from '../src/mind/action/respond/turnDeadline.js';
import { withToolMenu } from '../src/mind/tools/shannonToolMenu.js';
import { SHANNON_TOOLS } from '../src/mind/tools/shannonTools.js';

const MAXIMUM_OUTPUT_TOKENS = 256;
const SPEND_CAP_USD = 0.05;
const HAIKU: SonnetSettings = { model: 'claude-haiku-5-5', effort: 'low', textThinking: 'adaptive', voiceThinking: 'adaptive' };
const SONNET: SonnetSettings = { model: 'claude-sonnet-5-5', effort: 'low', textThinking: 'adaptive', voiceThinking: 'between_tools' };

const base: ShannonChatModelRequest = {
  scopeKey: 'probe', systemPrompt: '合成された人格の層。これは接続確認のための合成の会話です。',
  profilePrompt: '合成された持ち主の層', history: [], message: 'こんにちは。短く返事をしてください。',
  turnContext: '合成された今のターンの文脈',
};

function wholeRegistry(): ShannonModelToolSession {
  const definitions = SHANNON_TOOLS.filter(tool => tool.surfaces.includes('text'));
  const session: ShannonModelToolSession = {
    definitions, maximumCalls: 1, deadline: new TurnDeadline(TEXT_TURN_DEADLINE), call: async () => JSON.stringify({ ok: false }),
  };
  return withToolMenu(session, []);
}

function body(settings: SonnetSettings, request: ShannonChatModelRequest): Anthropic.MessageCreateParamsNonStreaming {
  return { ...cachePlanRequest(plannedChatBody(settings, request, undefined)), max_tokens: MAXIMUM_OUTPUT_TOKENS };
}

function usageLine(usage: Anthropic.Message['usage']): Record<string, number> {
  return {
    input: knownCount(usage.input_tokens), output: knownCount(usage.output_tokens), cacheRead: knownCount(usage.cache_read_input_tokens),
    cacheCreation: knownCount(usage.cache_creation_input_tokens), creation5m: knownCount(usage.cache_creation?.ephemeral_5m_input_tokens),
    creation1h: knownCount(usage.cache_creation?.ephemeral_1h_input_tokens),
  };
}

function cost(model: string, usage: Anthropic.Message['usage']): number {
  const counts = usageLine(usage);
  return estimatedAnthropicCostUsd(model, { input: counts.input!, cacheWrite: counts.cacheCreation!, cacheRead: counts.cacheRead!,
    output: counts.output!, searches: 0, cacheWrite5m: counts.creation5m!, cacheWrite1h: counts.creation1h! });
}

let spent = 0;

async function probe(client: Anthropic, settings: SonnetSettings, name: string, request: ShannonChatModelRequest): Promise<void> {
  if (spent >= SPEND_CAP_USD) {
    console.log(JSON.stringify({ model: settings.model, request: name, skipped: 'spend_cap' }));
    return;
  }
  try {
    const message = await client.messages.create(body(settings, request), { headers: { 'anthropic-beta': 'inline-tools-2026-09-15' } });
    const usd = cost(settings.model, message.usage);
    spent += usd;
    console.log(JSON.stringify({ model: settings.model, request: name, status: 200, stop: message.stop_reason, usage: usageLine(message.usage), usd }));
  } catch (error) {
    const status = error instanceof Anthropic.APIError ? error.status ?? null : null;
    console.log(JSON.stringify({ model: settings.model, request: name, status, class: offerRefusal(error) ?? 'other' }));
  }
}

async function run(settings: SonnetSettings, apiKey: string | null): Promise<void> {
  if (!apiKey) {
    console.log(JSON.stringify({ model: settings.model, skipped: 'no_key' }));
    return;
  }
  const client = claudeClient({ apiKey, timeoutMilliseconds: 60_000 });
  await probe(client, settings, 'plan-text-plain', base);
  await probe(client, settings, 'plan-text-tools', { ...base, tools: wholeRegistry() });
}

const environment = serverEnvironment();
await run(HAIKU, environment.SHANNON_HAIKU_API_KEY?.trim() || anthropicApiKey(environment));
if (process.argv.includes('--sonnet')) await run(SONNET, anthropicApiKey(environment));
console.log(JSON.stringify({ estimatedSpendUsd: Math.round(spent * 1e6) / 1e6 }));
