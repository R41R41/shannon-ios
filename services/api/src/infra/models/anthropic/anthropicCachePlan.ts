import type Anthropic from '@anthropic-ai/sdk';
import { switchOn } from '@shannon/switches';
import {
  SHANNON_AETHER_ACCESS_CAPABILITY, SHANNON_FCA_SHARED_CAPABILITY, SHANNON_FCA_TASK_CAPABILITY, SHANNON_MINECRAFT_BODY_CAPABILITY,
  SHANNON_MINECRAFT_LIFECYCLE_CAPABILITY, SHANNON_READ_TOOLS_CAPABILITY, SHANNON_SKILLS_CAPABILITY,
} from '@shannon/cognition';
import { serverEnvironment } from '../../config/serverEnvironment.js';
import { SKILL_INDEX_HEADER } from '../../../mind/memory/skillDocument.js';
import { toolOpenDefinition } from '../../../mind/tools/shannonToolMenu.js';
import type { ShannonChatModelRequest } from '../chatModel.js';
import { TOOLS_WITHHELD_INSTRUCTIONS, toolInstructions } from '../chatModelTools.js';
import {
  chatTurnRequestBody, offerInstructions, offeredReplyFields, offersTools, TURN_REPLY_FIELDS, withoutTurnInstructions, type TurnReplyField,
} from '../chatModelTurn.js';
import type { SonnetSettings } from './anthropicConfig.js';
import { appendForegroundMenu, stableOpener } from './anthropicForegroundMenu.js';
import {
  conversationEffort, SONNET_TEXT_LINES, sonnetMessages, sonnetTool, sonnetTools, WEB_ANSWER_LINE, WEB_SEARCH_NEEDS_INPUT,
} from './anthropicRequest.js';
import { structuredSchema } from './anthropicSchema.js';
import { TOOL_CALL_SCHEMA } from './anthropicToolCapacity.js';
import { isAppendOnlyAnthropicModel } from './haikuConfig.js';

/**
 * The cache plan of a foreground text turn (Syzygy ADR-0009 stage 1, M4; `SHANNON_CLAUDE_CACHE_PLAN`, off by default). Core:
 * response path. Everything before the owner's words is the same on every text turn of a Talk, so the next turn reads what
 * this one wrote:
 *
 * - tools: always the fixed pair `tool_open` / `tool_call` with `tool_choice: auto`, also in a turn that offers no tool (the
 *   turn's own lines then say so). The menu and the selected definitions follow the words, as before (`appendForegroundMenu`).
 * - output: one superset schema for the text surface. Every field a turn may ask for is present and nullable; the turn's
 *   lines say which ones it uses, and the reader still takes only what the turn offered (`chatTurnResult`). A change of
 *   `output_config.format` invalidates the provider's cache for the thread, so the schema must not vary.
 * - system: her identity, the fixed instructions and what she knows of the owner, without anything that depends on the turn.
 *   The tool-dependent capability lines, the skill index, the reply-feeling and tool instructions and the web-answer line move
 *   into the turn's own system message after the words.
 * - effort and thinking: as configured (Haiku at medium), never changed by the turn.
 *
 * Where the breakpoints go is the transport's (`cachePlanMarkers.ts`).
 */
export type PlanEnvironment = Readonly<Record<string, string | undefined>>;

/** Whether text turns of this model follow the plan: the switch is on and the model keeps an append-only, inline-tool session. */
export function cachePlanApplies(model: string, environment: PlanEnvironment = serverEnvironment()): boolean {
  return isAppendOnlyAnthropicModel(model) && switchOn(environment, 'SHANNON_CLAUDE_CACHE_PLAN');
}


export const PLAN_NO_TOOLS_LINE = '[ボクの道具] この返事では道具を出していない。tool_open と tool_call は呼ばずに、そのまま答える。';

type Schema = Record<string, unknown> & { properties: Record<string, Record<string, unknown>>; required: string[] };

function nullable(property: Record<string, unknown>): Record<string, unknown> {
  const type = property.type;
  if (typeof type !== 'string') return property;
  return { ...property, type: [type, 'null'] };
}

/** The schema of a turn that offers nothing: the fields every text turn has. */
function baseSchema(): Schema {
  const body = chatTurnRequestBody('', { scopeKey: '', systemPrompt: '', history: [], message: '' }, undefined);
  return (body.text as { format: { schema: Schema } }).format.schema;
}

/** Every field a turn may add, nullable, with `feeling` right after `reply` (the streamed reply never waits for it). */
function supersetSchema(): Record<string, unknown> {
  const base = baseSchema();
  const { reply, ...fixed } = base.properties;
  const { feeling, ...rest } = TURN_REPLY_FIELDS as unknown as Record<string, Record<string, unknown>>;
  const later = Object.fromEntries(Object.entries({ ...rest, webSearchNeedsInput: { ...WEB_SEARCH_NEEDS_INPUT } })
    .map(([name, property]) => [name, nullable(property)]));
  const properties = { reply: reply!, feeling: nullable(feeling!), ...fixed, ...later };
  const required = ['reply', 'feeling', ...base.required.filter(name => name !== 'reply'), ...Object.keys(later)];
  return structuredSchema({ ...base, properties, required }) as Record<string, unknown>;
}

let schemaOnce: Record<string, unknown> | undefined;
let pairOnce: readonly Anthropic.Tool[] | undefined;

/** The one output schema of the text surface under the plan (built on first use: its parts load in a cycle). */
export function planOutputSchema(): Record<string, unknown> {
  schemaOnce ??= supersetSchema();
  return structuredClone(schemaOnce);
}

/** The fixed tool pair, the same bytes `appendForegroundMenu` leaves for a turn with tools. */
export function planToolPair(): Anthropic.Tool[] {
  pairOnce ??= Object.freeze([stableOpener(sonnetTool(toolOpenDefinition([]))), TOOL_CALL_SCHEMA]);
  return structuredClone([...pairOnce]);
}

/** Capability lines `withToolCapabilityLines` puts inside her identity (after an anchor line) for a turn that offers their tools. */
const INSERTED_LINES = [SHANNON_MINECRAFT_BODY_CAPABILITY, SHANNON_AETHER_ACCESS_CAPABILITY, SHANNON_READ_TOOLS_CAPABILITY,
  SHANNON_SKILLS_CAPABILITY].map(item => item.text);
/** Capability blocks it appends to her identity. */
const APPENDED_BLOCKS = [SHANNON_MINECRAFT_LIFECYCLE_CAPABILITY, SHANNON_FCA_TASK_CAPABILITY, SHANNON_FCA_SHARED_CAPABILITY].map(item => item.text);

export interface StableLayers {
  systemPrompt: string;
  profilePrompt?: string;
  /** What was taken out, in the words she reads, for the turn's own message. */
  turnLines: string[];
}

/** Her identity without the turn's capability lines, and those lines. */
export function splitCapabilityLines(systemPrompt: string): { stable: string; lines: string[] } {
  let stable = systemPrompt;
  const lines: string[] = [];
  for (const text of INSERTED_LINES) {
    const line = `- ${text}\n`;
    if (!stable.includes(line)) continue;
    stable = stable.replace(line, '');
    lines.push(`- ${text}`);
  }
  for (const text of APPENDED_BLOCKS) {
    const block = `\n\n${text}`;
    if (!stable.includes(block)) continue;
    stable = stable.replace(block, '');
    lines.push(text);
  }
  return { stable, lines };
}

/** What she knows of the owner without the skill index, which `withSkillIndex` appends last, and the index. */
export function splitSkillIndex(profilePrompt: string | undefined): { stable?: string; index: string } {
  if (!profilePrompt) return { index: '' };
  if (profilePrompt.startsWith(SKILL_INDEX_HEADER)) return { index: profilePrompt };
  const at = profilePrompt.lastIndexOf(`\n\n${SKILL_INDEX_HEADER}`);
  if (at < 0) return { stable: profilePrompt, index: '' };
  return { stable: profilePrompt.slice(0, at), index: profilePrompt.slice(at + 2) };
}

/** The layers of the cached system, and the turn's lines taken out of them. */
export function stableLayers(request: Pick<ShannonChatModelRequest, 'systemPrompt' | 'profilePrompt'>): StableLayers {
  const identity = splitCapabilityLines(request.systemPrompt);
  const profile = splitSkillIndex(request.profilePrompt);
  const capabilities = identity.lines.length ? [['[この返事で使える道具によるボクの能力]', ...identity.lines].join('\n')] : [];
  return {
    systemPrompt: identity.stable, ...(profile.stable ? { profilePrompt: profile.stable } : {}),
    turnLines: [...capabilities, ...(profile.index ? [profile.index] : [])],
  };
}

const SUPERSET_FIELDS: readonly TurnReplyField[] = [...Object.keys(TURN_REPLY_FIELDS) as TurnReplyField[], 'webSearchNeedsInput'];

function fieldsLine(request: ShannonChatModelRequest): string {
  const used = new Set(offeredReplyFields(request));
  const unused = SUPERSET_FIELDS.filter(field => !used.has(field));
  return unused.length ? `[このターンの返答の欄] ${unused.join('、')} はこのターンでは使わないので null にする。` : '';
}

function toolLine(request: ShannonChatModelRequest): string {
  if (offersTools(request)) return '';
  return request.toolsWithheld ? TOOLS_WITHHELD_INSTRUCTIONS : PLAN_NO_TOOLS_LINE;
}

/** The lines of this turn alone, in the order she reads them after the turn's context. */
export function planTurnLines(request: ShannonChatModelRequest, layers: StableLayers): string[] {
  const web = !offersTools(request) && Boolean(request.useWebSearch || request.placeSearch);
  return [
    ...layers.turnLines, ...offerInstructions(request), toolLine(request),
    ...(web ? [WEB_ANSWER_LINE] : []), fieldsLine(request),
  ].filter(Boolean);
}

/** The lines joined to the turn's context message after the words, or a message of their own. */
function withTurnLines(messages: Anthropic.MessageParam[], lines: readonly string[]): Anthropic.MessageParam[] {
  if (!lines.length) return messages;
  const last = messages.at(-1);
  const text = lines.join('\n\n');
  if (last?.role === 'system' && typeof last.content === 'string') return [...messages.slice(0, -1), { role: 'system', content: `${last.content}\n\n${text}` }];
  return [...messages, { role: 'system', content: text } as unknown as Anthropic.MessageParam];
}

function cachedSystem(text: string): Anthropic.TextBlockParam[] {
  return [{ type: 'text', text, cache_control: { type: 'ephemeral', ttl: '1h' } }];
}

/** The text turn's request under the plan (non-streaming shape; the stream sends the same body). */
export function plannedChatBody(settings: SonnetSettings, request: ShannonChatModelRequest,
  agentHostHint: string | undefined): Anthropic.MessageCreateParamsNonStreaming {
  const layers = stableLayers(request);
  const fixed = { ...withoutTurnInstructions(request), systemPrompt: layers.systemPrompt, profilePrompt: layers.profilePrompt };
  const luna = chatTurnRequestBody(settings.model, fixed, agentHostHint);
  const body: Anthropic.MessageCreateParamsNonStreaming = {
    model: settings.model,
    max_tokens: 16_000,
    system: cachedSystem([String(luna.instructions), SONNET_TEXT_LINES].join('\n\n')),
    messages: withTurnLines(sonnetMessages(luna.input as unknown[]), planTurnLines(request, layers)),
    tools: planToolPair(),
    tool_choice: { type: 'auto' },
    thinking: { type: settings.textThinking } as Anthropic.ThinkingConfigParam,
    output_config: { effort: conversationEffort(settings), format: { type: 'json_schema', schema: planOutputSchema() } },
  };
  if (!offersTools(request)) return body;
  // A native 5.5 session always carries the menu here (`boundedToolMenu`); without its opener this throws, as before.
  return appendForegroundMenu({ ...body, tools: sonnetTools(request.tools) }, toolInstructions(request.tools!, false));
}
