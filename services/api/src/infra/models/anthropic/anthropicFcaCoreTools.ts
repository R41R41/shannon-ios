import type Anthropic from '@anthropic-ai/sdk';
import type { BetaRequestToolAdditionBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { FcaModelInput } from '../../../mind/action/fca/fcaPorts.js';
import { providerToolName, TOOL_OPEN_NAME } from '../../../mind/tools/toolRegistryPorts.js';
import { fcaNativeTool, fcaOpenTool } from './anthropicFcaTools.js';

/**
 * Transient mode (`SHANNON_FCA_OBS_MODE=transient`, `fcaCoreTools.ts`): the system's reading of the catalog changes with it. Its text
 * is part of the cached instructions, and only a transient body task's requests carry it.
 */
export const FCA_CORE_MENU_INSTRUCTIONS = [
  'The core tools are always loaded: the task and goal tools, skill.read, the memory read tools, observe and every tool of the body.'
    + ' They are not listed in the catalog, and tool_open is never needed for them.',
  'The catalog lists the other tools. A tool opened by tool_open stays loaded: its definition is added once and is never removed or announced again.',
].join('\n');

type Change = { type?: string; tool?: { type?: string; definition?: { name?: string } } };

/** The provider names of the tool definitions the replay already declared inline. */
function declaredInline(history: readonly Anthropic.MessageParam[]): Set<string> {
  const declared = new Set<string>();
  for (const message of history) {
    if (message.role !== 'system' || !Array.isArray(message.content)) continue;
    for (const change of message.content as unknown as Change[]) {
      if (change.type === 'tool_addition' && change.tool?.type === 'tool_definition' && change.tool.definition?.name) declared.add(change.tool.definition.name);
    }
  }
  return declared;
}

/**
 * The provider names of a request, each for one tool. The pinned core claims its names first; a catalog tool that shares a provider
 * name with a pinned core tool of another name is skipped (the pin was made before it existed; the runner starts a new epoch for it,
 * `fcaCoreHistory.ts`) and logged, never declared. Two other tools with one name remain a conflict.
 */
function claimedNames(input: FcaModelInput, controls: readonly Anthropic.Tool[], auxiliary: readonly Anthropic.Tool[]) {
  const names = new Map<string, string>();
  const reserved = new Set([...controls, ...auxiliary].map(tool => tool.name));
  const claim = (internal: string) => {
    const name = providerToolName(internal);
    const taken = names.has(name) && names.get(name) !== internal;
    if (taken || reserved.has(name) || name === fcaOpenTool.name) throw new Error('FCA_MODEL_TOOL_CONFLICT');
    names.set(name, internal);
  };
  // A pinned core tool the catalog no longer lists stays declared; a call of it is turned away by the runner as not offered.
  for (const definition of input.coreTools ?? []) claim(definition.name);
  const skipped = new Set<string>(), pinned = new Set((input.coreTools ?? []).map(definition => definition.name));
  for (const tool of input.catalog ?? input.tools) {
    const owner = names.get(providerToolName(tool.name));
    if (owner !== undefined && owner !== tool.name && pinned.has(owner)) {
      skipped.add(tool.name);
      continue;
    }
    claim(tool.name);
  }
  logConflicts(input.task.id, skipped);
  return { names, skipped };
}

/** Known behaviour: such a tool is silently left out of the request; the log says so once per task and change (never per request). */
const loggedConflicts = new Map<string, string>();
function logConflicts(taskId: string, skipped: ReadonlySet<string>): void {
  const signature = [...skipped].sort().join('|');
  if ((loggedConflicts.get(taskId) ?? '') === signature) return;
  loggedConflicts.delete(taskId);
  if (loggedConflicts.size >= 200) loggedConflicts.delete(loggedConflicts.keys().next().value as string);
  loggedConflicts.set(taskId, signature);
  if (skipped.size) console.info(JSON.stringify({ event: 'fca_core_tools_conflict', taskId, skipped: skipped.size }));
}
/**
 * The tools of a transient body task's request. The top level holds `tool_open`, the control tools, the auxiliary `fca_context` (always,
 * with or without a shared context) and the epoch's pinned core definitions, in that order and byte for byte the same for the whole
 * epoch: the signatures of thinking blocks bind the set of tools. Every other selected tool is appended as an inline definition the
 * first time the replay lacks it; nothing is ever removed or declared again within the epoch. A new epoch (a summary) replays no
 * addition, so what it needs is declared again at its start, beside its bootstrap.
 */
export function transientFcaTools(input: FcaModelInput, history: readonly Anthropic.MessageParam[], controls: readonly Anthropic.Tool[],
  auxiliary: readonly Anthropic.Tool[], fixed?: readonly string[]) {
  const { names, skipped } = claimedNames(input, controls, auxiliary);
  const core = (input.coreTools ?? []).map(fcaNativeTool), coreNames = new Set(core.map(tool => tool.name));
  const others = new Map<string, Anthropic.Tool>();
  for (const definition of input.tools) {
    if (skipped.has(definition.name)) continue;
    const tool = fcaNativeTool(definition);
    if (names.get(tool.name) !== definition.name || others.has(tool.name)) throw new Error('FCA_MODEL_TOOL_CONFLICT');
    if (!coreNames.has(tool.name)) others.set(tool.name, tool);
  }
  // mb-llmc v2: a fixed menu (`fixed`: the provider names in the order they are declared, the controls after them) has no
  // tool_open and no fca_context; what changes between decisions is only what follows the cached prefix.
  if (!fixed) names.set(fcaOpenTool.name, TOOL_OPEN_NAME);
  const declared = declaredInline(history);
  const additions = [...others].filter(([name]) => !declared.has(name))
    .map(([, definition]) => ({ type: 'tool_addition', tool: { type: 'tool_definition', definition } }) as BetaRequestToolAdditionBlock);
  const appended: Anthropic.MessageParam[] = additions.length
    ? [{ role: 'system' as const, content: additions as unknown as Anthropic.ContentBlockParam[] }] : [];
  if (fixed) return { names, tools: [...fixed.flatMap(name => core.filter(tool => tool.name === name)), ...controls], appended };
  return { names, tools: [fcaOpenTool, ...controls, ...auxiliary, ...core], appended };
}