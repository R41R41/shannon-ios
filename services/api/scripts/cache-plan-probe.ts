/**
 * A live probe of the foreground cache plan (Syzygy ADR-0009 stage 1, M4). Never run by the tests; it spends a few cents.
 *
 *   cd services/api && npx tsx --env-file-if-exists=../../.env scripts/cache-plan-probe.ts [--compare] [--sonnet]
 *
 * For Haiku (and with `--sonnet` also for Sonnet 5.5) it sends synthetic text-turn requests built exactly as the conversation
 * builds them, each through the same preparation as the transport (`cachePlanRequest` under the plan, `cacheHaikuRequest`
 * without it). The tool offers are those of production: `minimal` is what every text turn with tools carries when Jev chose
 * nothing or is absent (the always-loaded controls through the menu: 6 strict tools with the fixed pair), `typical` adds the
 * two definitions Jev usually selects, `heavy` six.
 *
 * - by default: `plan-plain`, `plan-tools-minimal`, `plan-tools-typical` (the plan as it is now);
 * - `--compare` also: `off-tools-minimal`, `off-tools-typical` (the shape without the plan), `plan-v1-tools-minimal` (the first
 *   superset, every added field nullable: 15 unions, refused on the VM as a grammar too large) and `plan-tools-heavy`.
 *
 * Keys are read from the process environment under the names the server reads (`SHANNON_HAIKU_API_KEY`, else
 * `SHANNON_ANTHROPIC_API_KEY`, else `ANTHROPIC_API_KEY`; Sonnet: the last two) and never printed. Printed per request: the
 * strict-schema counts, the status, the stop reason, the usage counts and an estimated cost; for a refusal the status and its
 * closed class. No content, no key, no provider text. The output ceiling is small, and the probe stops before a request once
 * its estimated spend for the model reaches the cap (Haiku $0.03, Sonnet $0.05). A refused request is not billed.
 */
import Anthropic from '@anthropic-ai/sdk';
import { serverEnvironment } from '../src/infra/config/serverEnvironment.js';
import { planOutputSchema, plannedChatBody } from '../src/infra/models/anthropic/anthropicCachePlan.js';
import { anthropicApiKey, type SonnetSettings } from '../src/infra/models/anthropic/anthropicConfig.js';
import { offerRefusal } from '../src/infra/models/anthropic/anthropicRejection.js';
import { sonnetChatBody } from '../src/infra/models/anthropic/anthropicRequest.js';
import { strictRequestUsage } from '../src/infra/models/anthropic/anthropicToolCapacity.js';
import { cachePlanRequest } from '../src/infra/models/anthropic/cachePlanMarkers.js';
import { cacheHaikuRequest } from '../src/infra/models/anthropic/haikuCache.js';
import { claudeClient } from '../src/infra/models/claude/claudeClient.js';
import { estimatedAnthropicCostUsd, knownCount } from '../src/infra/models/claude/claudeUsage.js';
import type { ShannonChatModelRequest } from '../src/infra/models/chatModel.js';
import type { ShannonModelToolSession } from '../src/infra/models/chatModelTools.js';
import { TEXT_TURN_DEADLINE, TurnDeadline } from '../src/mind/action/respond/turnDeadline.js';
import { withToolMenu } from '../src/mind/tools/shannonToolMenu.js';
import { SHANNON_TOOLS } from '../src/mind/tools/shannonTools.js';

type Body = Anthropic.MessageCreateParamsNonStreaming;

const MAXIMUM_OUTPUT_TOKENS = 256;
const HAIKU: SonnetSettings = { model: 'claude-haiku-5-5', effort: 'low', textThinking: 'adaptive', voiceThinking: 'adaptive' };
const SONNET: SonnetSettings = { model: 'claude-sonnet-5-5', effort: 'low', textThinking: 'adaptive', voiceThinking: 'between_tools' };
const CAPS: Readonly<Record<string, number>> = { [HAIKU.model]: 0.03, [SONNET.model]: 0.05 };
const OFFERS = { minimal: [], typical: ['study_list', 'study_read'],
  heavy: ['study_list', 'study_read', 'aether_search', 'aether_read', 'folder_list', 'folder_read'] } as const;
const ADDED_FIELDS = ['places', 'roomLook', 'appLook', 'minecraftIntent', 'webSearchNeedsInput'];

const base: ShannonChatModelRequest = {
  scopeKey: 'probe', systemPrompt: '合成された人格の層。これは接続確認のための合成の会話です。',
  profilePrompt: '合成された持ち主の層', history: [], message: 'こんにちは。短く返事をしてください。',
  turnContext: '合成された今のターンの文脈', offerReplyFeeling: true,
};

function offer(chosen: readonly string[]): ShannonModelToolSession {
  const definitions = SHANNON_TOOLS.filter(tool => tool.surfaces.includes('text'));
  const session: ShannonModelToolSession = {
    definitions, maximumCalls: 1, deadline: new TurnDeadline(TEXT_TURN_DEADLINE), call: async () => JSON.stringify({ ok: false }),
  };
  return withToolMenu(session, chosen);
}

/** The first superset: every added field nullable (an `anyOf` with null), as it was refused on the VM. */
function firstSuperset(body: Body): Body {
  const schema = planOutputSchema() as { properties: Record<string, Record<string, unknown>> };
  for (const name of ADDED_FIELDS) {
    const { description, ...shape } = schema.properties[name]!;
    schema.properties[name] = { ...(description === undefined ? {} : { description }), anyOf: [shape, { type: 'null' }] };
  }
  const format = { type: 'json_schema' as const, schema };
  return { ...body, output_config: { ...body.output_config, format } };
}

interface Probe {
  name: string;
  body(settings: SonnetSettings): Body;
}

const planned = (request: ShannonChatModelRequest) => (settings: SonnetSettings) => cachePlanRequest(plannedChatBody(settings, request, undefined));
const without = (request: ShannonChatModelRequest) => (settings: SonnetSettings) => cacheHaikuRequest(sonnetChatBody(settings, request, undefined));

function probes(compare: boolean): Probe[] {
  const tools = (chosen: readonly string[]) => ({ ...base, tools: offer(chosen) });
  const always: Probe[] = [
    { name: 'plan-plain', body: planned(base) },
    { name: 'plan-tools-minimal', body: planned(tools(OFFERS.minimal)) },
    { name: 'plan-tools-typical', body: planned(tools(OFFERS.typical)) },
  ];
  if (!compare) return always;
  return [...always,
    { name: 'off-tools-minimal', body: without(tools(OFFERS.minimal)) },
    { name: 'off-tools-typical', body: without(tools(OFFERS.typical)) },
    { name: 'plan-v1-tools-minimal', body: settings => cachePlanRequest(firstSuperset(plannedChatBody(settings, tools(OFFERS.minimal), undefined))) },
    { name: 'plan-tools-heavy', body: planned(tools(OFFERS.heavy)) },
  ];
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

async function send(client: Anthropic, settings: SonnetSettings, probe: Probe, spent: { usd: number }): Promise<void> {
  const body = { ...probe.body(settings), max_tokens: MAXIMUM_OUTPUT_TOKENS };
  const line = { model: settings.model, request: probe.name, strict: strictRequestUsage(body) };
  if (spent.usd >= CAPS[settings.model]!) {
    console.log(JSON.stringify({ ...line, skipped: 'spend_cap' }));
    return;
  }
  try {
    const message = await client.messages.create(body, { headers: { 'anthropic-beta': 'inline-tools-2026-09-15' } });
    const usd = cost(settings.model, message.usage);
    spent.usd += usd;
    console.log(JSON.stringify({ ...line, status: 200, stop: message.stop_reason, usage: usageLine(message.usage), usd }));
  } catch (error) {
    const status = error instanceof Anthropic.APIError ? error.status ?? null : null;
    console.log(JSON.stringify({ ...line, status, class: offerRefusal(error) ?? 'other' }));
  }
}

async function run(settings: SonnetSettings, apiKey: string | null, compare: boolean): Promise<number> {
  if (!apiKey) {
    console.log(JSON.stringify({ model: settings.model, skipped: 'no_key' }));
    return 0;
  }
  const client = claudeClient({ apiKey, timeoutMilliseconds: 60_000 });
  const spent = { usd: 0 };
  for (const probe of probes(compare)) await send(client, settings, probe, spent);
  return spent.usd;
}

const environment = serverEnvironment();
const compare = process.argv.includes('--compare');
let total = await run(HAIKU, environment.SHANNON_HAIKU_API_KEY?.trim() || anthropicApiKey(environment), compare);
if (process.argv.includes('--sonnet')) total += await run(SONNET, anthropicApiKey(environment), compare);
console.log(JSON.stringify({ estimatedSpendUsd: Math.round(total * 1e6) / 1e6 }));
