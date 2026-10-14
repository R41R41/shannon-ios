import { createHash } from 'node:crypto';
import { observerHandoff } from '../../../infra/observer/observerContext.js';
import type { FcaToolSelector } from '../../selectors/selectorsPorts.js';
import { providerToolName, toolFailure, type ShannonToolDefinition, type ToolResult } from '../../tools/toolRegistryPorts.js';
import type { FcaModelInput } from './fcaPorts.js';

export interface FcaToolState {
  version: 1; key: string; inputKey: string; names: string[]; opened: string[]; refresh: boolean;
  recentResults: Array<{ name: string; ok: boolean; summary: string }>;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Selection changes only with new admitted input, task/child context, catalog definitions, or a known tool failure. */
export async function selectFcaTools(input: FcaModelInput, catalog: readonly ShannonToolDefinition[], prior: unknown,
  selector: FcaToolSelector, scopeKey: string, signal: AbortSignal, options: { keepBodyTools?: boolean } = {}): Promise<FcaToolState> {
  const previous = readState(prior);
  const inputKey = input.messages.length ? digest(input.messages) : previous?.inputKey ?? '';
  const { id, title, goal, completionCriteria } = input.task;
  const key = digest({ task: { id, title, goal, completionCriteria }, children: input.children ?? [], inputKey, catalog });
  const known = new Set(catalog.map(tool => tool.name));
  if (previous && !previous.refresh && previous.key === key && [...previous.names, ...previous.opened].every(name => known.has(name))) return previous;
  let result: { names: readonly string[]; source: 'jev' | 'fallback' };
  try {
    observerHandoff('context', 'jevt', { phase: 'fca_selection', offeredCount: catalog.length });
    result = await selector.select({ scopeKey, signal, goal: `${input.task.goal}\nCompletion criteria: ${input.task.completionCriteria}`,
      state: JSON.stringify({ children: input.children ?? [], messages: input.messages }),
      recentResults: previous?.recentResults ?? [], tools: catalog.map(tool => ({ name: tool.name, description: tool.description })) });
  } catch {
    signal.throwIfAborted();
    result = { names: catalog.map(tool => tool.name), source: 'fallback' };
  }
  signal.throwIfAborted();
  const valid = Array.isArray(result?.names) && result.names.every(name => typeof name === 'string' && known.has(name))
    && new Set(result.names).size === result.names.length && ['jev', 'fallback'].includes(result.source);
  const chosen = new Set(valid ? result.names : [...known]);
  const wanted = options.keepBodyTools ? keptBodyTools(chosen, catalog, previous) : chosen;
  observerHandoff('jevt', 'context', { phase: 'fca_selection_result', source: valid ? result.source : 'fallback', selectedCount: wanted.size });
  return { version: 1, key, inputKey, names: catalog.filter(tool => wanted.has(tool.name)).map(tool => tool.name),
    opened: previous?.key === key ? previous.opened.filter(name => known.has(name)) : [],
    refresh: false, recentResults: previous?.recentResults ?? [] };
}

/**
 * A body task's tools (`keepBodyTools`: a task with a bound body, or made from a Minecraft request) are never all left out while the
 * catalog offers them; any other task keeps the selector's choice (review of 0efd5acb: a single connected body puts its tools in
 * every task's catalog):
 * Minecraft run 9 (2026-10-14), after an interrupted move the selection was made again without any `mc.*` tool, and she reported
 * that her body's tools were gone and waited. Then the body tools of the previous selection are kept, or all of them without one.
 */
function keptBodyTools(wanted: Set<string>, catalog: readonly ShannonToolDefinition[], previous: FcaToolState | null): Set<string> {
  const body = catalog.filter(tool => tool.domain === 'minecraft_body').map(tool => tool.name);
  if (!body.length || body.some(name => wanted.has(name))) return wanted;
  const kept = previous?.names.filter(name => body.includes(name)) ?? [];
  for (const name of kept.length ? kept : body) wanted.add(name);
  return wanted;
}

export function selectedFcaTools(catalog: readonly ShannonToolDefinition[], state: FcaToolState): ShannonToolDefinition[] {
  const names = new Set([...state.names, ...state.opened]);
  return catalog.filter(tool => names.has(tool.name) || tool.domain === 'memory_read');
}

/** Opening adds visibility for the next model decision only; it never executes or authorizes a tool. */
export function openFcaTool(input: unknown, catalog: readonly ShannonToolDefinition[], state: FcaToolState): ToolResult {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null;
  if (!value || Object.keys(value).length !== 1 || typeof value.name !== 'string') return toolFailure('invalid_input', '開く道具の名前を指定してください。');
  const tool = catalog.find(item => providerToolName(item.name) === value.name);
  if (!tool) return toolFailure('not_offered', 'その道具は現在の一覧にありません。');
  if (!state.opened.includes(tool.name)) state.opened.push(tool.name);
  return { ok: true, text: `${providerToolName(tool.name)} の定義を次の呼び出しに追加します。開くこと自体は何も実行しません。`, retryable: false };
}

function readState(value: unknown): FcaToolState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Partial<FcaToolState>;
  const strings = (list: unknown): list is string[] => Array.isArray(list) && list.every(name => typeof name === 'string');
  if (item.version !== 1 || typeof item.key !== 'string' || typeof item.inputKey !== 'string' || typeof item.refresh !== 'boolean'
    || !strings(item.names) || !strings(item.opened) || !Array.isArray(item.recentResults)
    || item.recentResults.some(result => !result || typeof result.name !== 'string' || typeof result.ok !== 'boolean' || typeof result.summary !== 'string')) return null;
  return { ...item as FcaToolState, names: [...item.names], opened: [...item.opened], recentResults: item.recentResults.slice(-8).map(result => ({ ...result })) };
}
