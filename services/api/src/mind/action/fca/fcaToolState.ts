import { createHash } from 'node:crypto';
import { observerHandoff } from '../../../infra/observer/observerContext.js';
import type { FcaToolSelector } from '../../selectors/selectorsPorts.js';
import { providerToolName, toolFailure, type ShannonToolDefinition, type ToolResult } from '../../tools/toolRegistryPorts.js';
import type { FcaModelInput } from './fcaPorts.js';
import { readFcaCorePin, selectedTransientTools, transientToolState, withTransientFields, type FcaCorePin, type FcaObsMode } from './fcaCoreTools.js';

export interface FcaToolState {
  version: 1; key: string; inputKey: string; names: string[]; opened: string[]; refresh: boolean;
  recentResults: Array<{ name: string; ok: boolean; summary: string }>;
  /**
   * `transient` (`SHANNON_FCA_OBS_MODE`, `fcaCoreTools.ts`): the task declares its core tools at the top level for each epoch
   * (`core`) and only appends the others (`announced`: those declared since the epoch began). Absent: the legacy menu. Fixed when the
   * task's first step is selected, never changed after it.
   */
  obsMode?: 'transient'; core?: FcaCorePin; announced?: string[];
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * Selection changes only with new admitted input, task/child context, catalog definitions, or a known tool failure. A body task whose
 * mode is `transient` (`SHANNON_FCA_OBS_MODE`; the mode it started with) also has its core tools pinned per epoch and its others appended.
 */
export async function selectFcaTools(input: FcaModelInput, catalog: readonly ShannonToolDefinition[], prior: unknown,
  selector: FcaToolSelector, scopeKey: string, signal: AbortSignal, options: { keepBodyTools?: boolean; obsMode?: FcaObsMode } = {}): Promise<FcaToolState> {
  const previous = readState(prior);
  const state = await legacySelection(input, catalog, previous, selector, scopeKey, signal, options);
  const transient = previous ? previous.obsMode === 'transient' : options.obsMode === 'transient' && options.keepBodyTools === true;
  return transient ? transientToolState(state, previous, catalog, input.history, input.task.id) : state;
}

async function legacySelection(input: FcaModelInput, catalog: readonly ShannonToolDefinition[], previous: FcaToolState | null,
  selector: FcaToolSelector, scopeKey: string, signal: AbortSignal, options: { keepBodyTools?: boolean }): Promise<FcaToolState> {
  const inputKey = input.messages.length ? digest(input.messages) : previous?.inputKey ?? '';
  const { id, title, goal, completionCriteria } = input.task;
  const key = digest({ task: { id, title, goal, completionCriteria }, children: input.children ?? [], inputKey, catalog });
  const known = new Set(catalog.map(tool => tool.name));
  if (previous && !previous.refresh && previous.key === key && [...previous.names, ...previous.opened].every(name => known.has(name))) return previous;
  let result: { names: readonly string[]; source: 'jev' | 'fallback' | 'catalog' };
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
    && new Set(result.names).size === result.names.length && ['jev', 'fallback', 'catalog'].includes(result.source);
  const fallback = !valid || result.source === 'fallback';
  const chosen = fallback ? fallbackFcaTools(catalog, previous, options.keepBodyTools === true) : new Set(result.names);
  // A fallback menu adds companions inside its own definition bound (`fallbackFcaTools`); a selector's answer gets them whole.
  const wanted = fallback ? chosen : withToolCompanions(options.keepBodyTools ? keptBodyTools(chosen, catalog, previous) : chosen, catalog);
  observerHandoff('jevt', 'context', { phase: 'fca_selection_result', source: fallback ? 'fallback' : result.source, selectedCount: wanted.size });
  // A fallback menu is asked again at the next decision instead of being kept until the input changes.
  return { version: 1, key, inputKey, names: catalog.filter(tool => wanted.has(tool.name)).map(tool => tool.name),
    opened: previous?.key === key ? previous.opened.filter(name => known.has(name)) : [],
    refresh: fallback, recentResults: previous?.recentResults ?? [] };
}

/**
 * The characters of tool definitions a fallback menu may add (each definition as JSON). Minecraft run 10 (2026-10-14, task
 * 74a32315): four selections that timed out or fell back put all 139 tools (~89k characters of definitions) in the request, which
 * passed Haiku's 100k-token price step (101,703–109,898 estimated tokens). A Jev selection of that task added 38–46k.
 */
export const FCA_FALLBACK_DEFINITION_CHARACTERS = 40_000;

/**
 * The menu when the selector timed out, fell back or answered invalidly: the task tools, then the previous selection, then (a body
 * task) the body's tools, until `FCA_FALLBACK_DEFINITION_CHARACTERS`. Every other tool stays listed in the catalog and can be opened
 * with `tool_open`; `memory_read` tools are always offered (`selectedFcaTools`).
 */
export function fallbackFcaTools(catalog: readonly ShannonToolDefinition[], previous: Pick<FcaToolState, 'names'> | null, body: boolean): Set<string> {
  const byName = new Map(catalog.map(tool => [tool.name, tool]));
  const core = catalog.filter(tool => tool.domain === 'task_runtime' || /^(task|goal)\./u.test(tool.name)).map(tool => tool.name);
  const bodyTools = body ? catalog.filter(tool => tool.domain === 'minecraft_body').map(tool => tool.name) : [];
  const chosen = new Set<string>();
  let used = 0;
  const add = (name: string): void => {
    const tool = byName.get(name);
    if (!tool || chosen.has(name)) return;
    const size = JSON.stringify({ name: tool.name, description: tool.description, input: tool.input }).length;
    if (used + size > FCA_FALLBACK_DEFINITION_CHARACTERS) return;
    chosen.add(name);
    used += size;
  };
  for (const name of [...core, ...previous?.names ?? [], ...bodyTools]) add(name);
  // Companions of what was chosen come last, and only while they fit the bound.
  for (const name of toolCompanions(chosen)) add(name);
  return chosen;
}

/**
 * Tools that make one procedure and are offered together (Minecraft run 14, 2026-10-17: `mc.start-smelting` and `mc.check-furnace`
 * were in the selection but `mc.withdraw-from-furnace` was not, so taking the result out cost a `tool_open` step). When any tool of
 * a group is selected, the whole group is. Names are the body catalog's own; a name the catalog lacks is skipped.
 */
export const FCA_TOOL_COMPANIONS: readonly (readonly string[])[] = Object.freeze([
  Object.freeze(['mc.start-smelting', 'mc.check-furnace', 'mc.withdraw-from-furnace']),
]);
function toolCompanions(chosen: ReadonlySet<string>): string[] {
  return FCA_TOOL_COMPANIONS.filter(group => group.some(name => chosen.has(name))).flat().filter(name => !chosen.has(name));
}
function withToolCompanions(wanted: Set<string>, catalog: readonly ShannonToolDefinition[]): Set<string> {
  const known = new Set(catalog.map(tool => tool.name));
  for (const name of toolCompanions(wanted)) if (known.has(name)) wanted.add(name);
  return wanted;
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
  if (state.obsMode === 'transient' && state.core) return selectedTransientTools(catalog, state);
  const names = new Set([...state.names, ...state.opened]);
  return catalog.filter(tool => names.has(tool.name) || tool.domain === 'memory_read');
}

/**
 * Whether a failed call asks the selector again (for another tool). A transient task's core tools are all declared already (the body's own
 * among them), so a failed core call gains nothing from a new menu (run 15, 2026-10-19: Jev's 0.2-0.7 s on about a third of its decisions).
 */
export function failureRefreshes(state: Pick<FcaToolState, 'core'>, name: string): boolean {
  return !state.core?.tools.some(tool => tool.name === name);
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
  // A transient task's history is shaped for its pinned core: a checkpoint without a valid one is never read as another mode.
  if (item.obsMode === 'transient' && !readFcaCorePin(item.core)) throw new Error('FCA_CORE_TOOLS_STATE_INVALID');
  const strings = (list: unknown): list is string[] => Array.isArray(list) && list.every(name => typeof name === 'string');
  if (item.version !== 1 || typeof item.key !== 'string' || typeof item.inputKey !== 'string' || typeof item.refresh !== 'boolean'
    || !strings(item.names) || !strings(item.opened) || !Array.isArray(item.recentResults)
    || item.recentResults.some(result => !result || typeof result.name !== 'string' || typeof result.ok !== 'boolean' || typeof result.summary !== 'string')) return null;
  const state: FcaToolState = { ...item as FcaToolState, names: [...item.names], opened: [...item.opened], recentResults: item.recentResults.slice(-8).map(result => ({ ...result })) };
  return withTransientFields(state, item);
}
