import type Anthropic from '@anthropic-ai/sdk';
import { switchOn } from '@shannon/switches';
import {
  SHANNON_AETHER_ACCESS_CAPABILITY, SHANNON_FCA_SHARED_CAPABILITY, SHANNON_FCA_TASK_CAPABILITY, SHANNON_MINECRAFT_BODY_CAPABILITY,
  SHANNON_MINECRAFT_LIFECYCLE_CAPABILITY, SHANNON_READ_TOOLS_CAPABILITY, SHANNON_SKILLS_CAPABILITY, SHANNON_DEVICE_ACTIONS_CAPABILITY,
} from '@shannon/cognition';
import { serverEnvironment } from '../../config/serverEnvironment.js';
import { RICH_TEXT_BLOCK_INSTRUCTIONS } from '../../../mind/action/respond/respondInstructions.js';
import { SKILL_INDEX_HEADER } from '../../../mind/memory/skillDocument.js';
import { toolOpenDefinition } from '../../../mind/tools/shannonToolMenu.js';
import type { ShannonChatModelRequest } from '../chatModel.js';
import { TOOLS_WITHHELD_INSTRUCTIONS, toolInstructions } from '../chatModelTools.js';
import {
  chatTurnInstructions, chatTurnSchema, offerInstructions, offeredReplyFields, offersTools, withCommonOffers, withoutTurnInstructions,
} from '../chatModelTurn.js';
import type { ClaudeChatSettings } from './anthropicConfig.js';
import { appendForegroundMenu, stableOpener } from './anthropicForegroundMenu.js';
import {
  claudeTextBody, claudeTool, claudeTools, claudeTurnMessages, conversationEffort, CLAUDE_TEXT_LINES, spokenReplyLines, textThinking,
  textTurnConversation, WEB_ANSWER_LINE,
} from './anthropicRequest.js';
import { structuredSchema } from './anthropicSchema.js';
import { conversationTool, TOOL_CALL_SCHEMA } from './anthropicToolCapacity.js';
import { isAppendOnlyAnthropicModel } from './haikuConfig.js';

/**
 * The cache plan of a foreground text turn (Syzygy ADR-0009 stage 1, M4; `SHANNON_CLAUDE_CACHE_PLAN`, off by default). Core:
 * response path. Everything before the owner's words is the same on every text turn of a Talk, so the next turn reads what
 * this one wrote:
 *
 * - tools: always the fixed pair `tool_open` / `tool_call` with `tool_choice: auto`, also in a turn that offers no tool (the
 *   turn's own lines then say so). The menu and the selected definitions follow the words, as before (`appendForegroundMenu`).
 * - output: the common schema (an owner turn's: the base fields and her feeling) on every turn that offers no rarer field. The
 *   provider says a change of `output_config.format` invalidates the prompt cache for the thread, so the format must not vary
 *   from turn to turn. A turn that offers a rarer field (a place search, a look, the Minecraft intent, the required web read)
 *   is an exception: it sends the schema it has without the plan, accepting that turn's miss (`exceptionTurn`).
 * - system: her identity, the fixed instructions and what she knows of the owner, without anything that depends on the turn.
 *   The tool-dependent capability lines, the skill index, the reply-feeling and tool instructions and the web-answer line move
 *   into the turn's own system message after the words.
 * - effort: as configured, never changed by the turn. Thinking: as configured, except a light or read-aloud turn answers without
 *   it (`textThinking`, owner decision 2026-10-14). Tools and system stay the same bytes; the provider may not reuse the cached
 *   messages across a turn whose thinking differs from the one before (cost, not speed: the 2026-10-13 probe).
 *
 * Where the breakpoints go is the transport's (`cachePlanMarkers.ts`).
 */
export type PlanEnvironment = Readonly<Record<string, string | undefined>>;

/** Whether text turns of this model follow the plan: the switch is on and the model keeps an append-only, inline-tool session. */
export function cachePlanApplies(model: string, environment: PlanEnvironment = serverEnvironment()): boolean {
  return isAppendOnlyAnthropicModel(model) && switchOn(environment, 'SHANNON_CLAUDE_CACHE_PLAN');
}


export const PLAN_NO_TOOLS_LINE = '[ボクの道具] この返事では道具を出していない。tool_open と tool_call は呼ばずに、そのまま答える。';

/**
 * The common schema: exactly the one an owner turn that offers only her feeling has without the plan (the base fields and
 * `feeling`). A turn that does not offer her feeling uses it too, with `feeling` null. M4 grammar fix: one schema with every
 * rare field (places, the looks, the Minecraft intent, the required web read's field) was refused with the always-loaded
 * tools as a grammar too large, while the plan-off schema with the same tool, optional and union counts passed (VM probe,
 * 2026-10-12), so the rare fields are not in it.
 */
function commonSchema(): Record<string, unknown> {
  return structuredSchema(chatTurnSchema(withCommonOffers({ scopeKey: '', systemPrompt: '', history: [], message: '' }))) as Record<string, unknown>;
}

/**
 * A turn that offers a field outside the common schema is an exception: it sends the schema it has without the plan (the
 * output format changes for that turn; tools, system and the breakpoints stay). Counted per turn (`planSchemaOf`).
 */
export function exceptionTurn(request: ShannonChatModelRequest): boolean {
  return offeredReplyFields(request).some(field => field !== 'feeling');
}

let schemaOnce: Record<string, unknown> | undefined;
let pairOnce: readonly Anthropic.Tool[] | undefined;

/** The common output schema of the text surface under the plan (built on first use: its parts load in a cycle). */
export function planOutputSchema(): Record<string, unknown> {
  schemaOnce ??= commonSchema();
  return structuredClone(schemaOnce);
}

/** The fixed tool pair, the same bytes `appendForegroundMenu` leaves for a turn with tools. */
export function planToolPair(): Anthropic.Tool[] {
  pairOnce ??= Object.freeze([stableOpener(claudeTool(toolOpenDefinition([]))), TOOL_CALL_SCHEMA]);
  return structuredClone([...pairOnce]).map(conversationTool);
}

/** Capability lines `withToolCapabilityLines` puts inside her identity (after an anchor line) for a turn that offers their tools. */
const INSERTED_LINES = [SHANNON_MINECRAFT_BODY_CAPABILITY, SHANNON_AETHER_ACCESS_CAPABILITY, SHANNON_READ_TOOLS_CAPABILITY,
  SHANNON_SKILLS_CAPABILITY].map(item => item.text);
/** Capability blocks it appends to her identity. */
const APPENDED_BLOCKS = [SHANNON_MINECRAFT_LIFECYCLE_CAPABILITY, SHANNON_FCA_TASK_CAPABILITY, SHANNON_FCA_SHARED_CAPABILITY,
  SHANNON_DEVICE_ACTIONS_CAPABILITY].map(item => item.text);

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

/**
 * The field line of a turn on the common schema that does not offer her feeling: `feeling` is null. An exception turn sends
 * the schema it has without the plan and needs no line.
 */
export function fieldsLines(request: ShannonChatModelRequest): string[] {
  if (exceptionTurn(request) || offeredReplyFields(request).includes('feeling')) return [];
  return ['[このターンの返答の欄] feeling はこのターンでは使わないので null にする。'];
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
    ...(web ? [WEB_ANSWER_LINE] : []), ...fieldsLines(request),
  ].filter(Boolean);
}

/** The lines joined to the turn's context message after the words, or a message of their own. */
export function withTurnLines(messages: Anthropic.MessageParam[], lines: readonly string[]): Anthropic.MessageParam[] {
  if (!lines.length) return messages;
  const last = messages.at(-1);
  const text = lines.join('\n\n');
  if (last?.role === 'system' && typeof last.content === 'string') return [...messages.slice(0, -1), { role: 'system', content: `${last.content}\n\n${text}` }];
  return [...messages, { role: 'system', content: text } as unknown as Anthropic.MessageParam];
}

const PLANNED = Symbol('shannon.cachePlan');

/** Which schema a plan body carries: the common one, or the exception turn's own. */
export type PlanSchema = 'common' | 'exception';

/**
 * Whether a request body was built under the plan. The mark is a symbol property: object spreads (the tool rounds' requests)
 * keep it, and JSON never sends it, so the transport places the plan's breakpoints on exactly these bodies and the one-hour
 * cache of every other request on the rest (the plan's fallbacks to the shape without it among them).
 */
export function isPlannedBody(body: object): boolean {
  return planSchemaOf(body) !== null;
}

/** The schema a plan body carries, or null for a body built without the plan. */
export function planSchemaOf(body: object): PlanSchema | null {
  const mark = (body as Record<symbol, unknown>)[PLANNED];
  return mark === 'common' || mark === 'exception' ? mark : null;
}

/** The body marked as built under the plan (`isPlannedBody`); voice turns carry `common`, having no output schema. */
export function planned(body: Anthropic.MessageCreateParamsNonStreaming, schema: PlanSchema): Anthropic.MessageCreateParamsNonStreaming {
  return Object.assign(body, { [PLANNED]: schema });
}

/** The output format of a plan turn: the common schema, or for an exception turn the format it has without the plan. */
function planFormat(settings: ClaudeChatSettings, request: ShannonChatModelRequest, agentHostHint: string | undefined) {
  if (!exceptionTurn(request)) return { type: 'json_schema' as const, schema: planOutputSchema() };
  const own = claudeTextBody(settings, { ...request, tools: undefined }, agentHostHint).output_config?.format;
  return own as { type: 'json_schema'; schema: Record<string, unknown> };
}

export function cachedSystem(text: string): Anthropic.TextBlockParam[] {
  return [{ type: 'text', text, cache_control: { type: 'ephemeral', ttl: '1h' } }];
}

/** The text turn's request under the plan (non-streaming shape; the stream sends the same body). */
export function plannedChatBody(settings: ClaudeChatSettings, request: ShannonChatModelRequest,
  agentHostHint: string | undefined): Anthropic.MessageCreateParamsNonStreaming {
  const layers = stableLayers(request);
  const fixed = { ...withoutTurnInstructions(request), systemPrompt: layers.systemPrompt, profilePrompt: layers.profilePrompt };
  const instructions = chatTurnInstructions(fixed, agentHostHint);
  const body: Anthropic.MessageCreateParamsNonStreaming = {
    model: settings.model,
    max_tokens: 16_000,
    // Rich chat's lines depend on the surface, not the turn (the app's Talk always, other surfaces never): they stay in the system.
    system: cachedSystem([instructions, CLAUDE_TEXT_LINES, ...(request.richBlocks ? [RICH_TEXT_BLOCK_INSTRUCTIONS] : []),
      ...spokenReplyLines(request)].join('\n\n')),
    messages: withTurnLines(claudeTurnMessages(textTurnConversation(fixed)), planTurnLines(request, layers)),
    tools: planToolPair(),
    tool_choice: { type: 'auto' },
    thinking: textThinking(settings, request),
    output_config: { effort: conversationEffort(settings), format: planFormat(settings, request, agentHostHint) },
  };
  const schema: PlanSchema = exceptionTurn(request) ? 'exception' : 'common';
  if (!offersTools(request)) return planned(body, schema);
  // A native 5.5 session always carries the menu here (`boundedToolMenu`); without its opener this throws, as before.
  return planned(appendForegroundMenu({ ...body, tools: claudeTools(request.tools) }, toolInstructions(request.tools!, false)), schema);
}
