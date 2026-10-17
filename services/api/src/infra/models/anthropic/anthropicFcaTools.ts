import type Anthropic from '@anthropic-ai/sdk';
import type { BetaRequestToolAdditionBlock, BetaRequestToolRemovalBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { FcaModelInput } from '../../../mind/action/fca/fcaPorts.js';
import { providerToolName, toolOpenDefinition, TOOL_OPEN_NAME } from '../../../mind/tools/toolRegistryPorts.js';
import { claudeTool } from './anthropicRequest.js';

export const FCA_MENU_INSTRUCTIONS = `The decision messages contain the full allowed tool catalog by provider name and description:
the current one, or the latest full one when the current one is {"unchanged":true}.
Only selected tools currently have loaded schemas. If another catalog tool is needed, call tool_open with its provider name first; its definition is available from the next decision.
Opening a definition executes nothing and grants no new authority. An unavailable or unselected tool is not evidence that the task cannot be done.`;

/** Stable opening schema: the runner validates the name against the current catalog, independent of cached declarations. */
const open = toolOpenDefinition([]);
const openTool = claudeTool({ ...open, input: { ...open.input,
  properties: { name: { type: 'string', description: 'The provider name of a tool in the current allowed catalog.' } } } });

type Change = BetaRequestToolAdditionBlock | BetaRequestToolRemovalBlock;

/** One catalog definition as the provider receives it (not strict: see `nativeFcaTools`). */
export function fcaNativeTool(definition: FcaModelInput['tools'][number]): Anthropic.Tool {
  return definition.nativeInputSchema ? {
    name: providerToolName(definition.name), description: definition.description, strict: false,
    input_schema: definition.nativeInputSchema as Anthropic.Tool.InputSchema,
  } : { ...claudeTool(definition), strict: false };
}
export { openTool as fcaOpenTool };

/** The installed SDK's inline-tool protocol changes active schemas by append, never by editing a signed prefix. */
export function nativeFcaTools(input: FcaModelInput, history: readonly Anthropic.MessageParam[], controls: readonly Anthropic.Tool[], auxiliary: readonly Anthropic.Tool[] = []) {
  const names = new Map<string, string>();
  const catalog = input.catalog ?? input.tools;
  for (const tool of catalog) {
    const name = providerToolName(tool.name);
    if (names.has(name) || [...controls, ...auxiliary].some(control => control.name === name) || name === openTool.name) throw new Error('FCA_MODEL_TOOL_CONFLICT');
    names.set(name, tool.name);
  }
  const selected = new Map<string, Anthropic.Tool>();
  for (const definition of input.tools) {
    // Only the fixed control schemas are strict. Strict catalog definitions broke the provider's per-request limits in
    // production (live 400s, 2026-10-12: "Too many strict tools (40)", "too many optional parameters (30)", and with a
    // 20-tool budget "The compiled grammar is too large"). Catalog inputs keep their schema, with the constraints in words,
    // and the original executor validates every input.
    const tool = fcaNativeTool(definition);
    if (names.get(tool.name) !== definition.name || selected.has(tool.name)) throw new Error('FCA_MODEL_TOOL_CONFLICT');
    selected.set(tool.name, tool);
  }
  for (const tool of auxiliary) selected.set(tool.name, tool);
  if (!input.catalog) return { names, tools: [...selected.values(), ...controls], appended: [] as Anthropic.MessageParam[] };
  names.set(openTool.name, TOOL_OPEN_NAME);
  const active = new Map<string, Anthropic.Tool>();
  for (const message of history) {
    if (message.role !== 'system' || !Array.isArray(message.content)) continue;
    for (const change of message.content as unknown as Change[]) {
      if (change.type === 'tool_removal' && change.tool.type === 'tool_reference') active.delete(change.tool.name);
      else if (change.type === 'tool_addition' && change.tool.type === 'tool_definition') {
        const definition = change.tool.definition;
        if ('name' in definition) active.set(definition.name, definition as Anthropic.Tool);
      }
    }
  }
  const changes: Change[] = [];
  for (const [name, definition] of active) {
    if (!selected.has(name) || JSON.stringify(selected.get(name)) !== JSON.stringify(definition)) {
      changes.push({ type: 'tool_removal', tool: { type: 'tool_reference', name } });
      active.delete(name);
    }
  }
  for (const [name, definition] of selected) if (!active.has(name)) {
    changes.push({ type: 'tool_addition', tool: { type: 'tool_definition', definition } });
  }
  return { names, tools: [openTool, ...controls], appended: changes.length
    ? [{ role: 'system' as const, content: changes as unknown as Anthropic.ContentBlockParam[] }] : [] };
}

/** Only our SDK-supported tool changes may use the system role in persisted FCA history. */
export function isFcaToolChangeMessage(value: Record<string, unknown>): boolean {
  return value.role === 'system' && Array.isArray(value.content) && value.content.length > 0 && value.content.every(block => {
    if (!block || typeof block !== 'object') return false;
    const change = block as { type?: unknown; tool?: { type?: unknown; definition?: { name?: unknown }; name?: unknown } };
    return change.type === 'tool_addition' && change.tool?.type === 'tool_definition' && typeof change.tool.definition?.name === 'string'
      || change.type === 'tool_removal' && change.tool?.type === 'tool_reference' && typeof change.tool.name === 'string';
  });
}
