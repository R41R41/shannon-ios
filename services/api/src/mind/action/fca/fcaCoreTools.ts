import { createHash } from 'node:crypto';
import { providerToolName } from '../../tools/toolRegistryPorts.js';
import type { FcaToolDefinition } from './fcaPorts.js';
import type { FcaToolState } from './fcaToolState.js';

/**
 * `SHANNON_FCA_OBS_MODE` (Minecraft observation redesign, P2). `legacy` is the production behaviour, byte for byte. `transient`
 * applies to a body task only: its core tools are declared at the top level and stay byte-identical for a whole epoch, and every
 * other tool is only ever appended (`anthropicFcaCoreTools.ts`). A task keeps the mode it started with (`FcaToolState.obsMode`).
 */
export type FcaObsMode = 'legacy' | 'transient';
export function fcaObsMode(value: string | undefined): FcaObsMode {
  return value?.trim().toLowerCase() === 'transient' ? 'transient' : 'legacy';
}

/**
 * The tools a body task declares at the top level: everything `keepBodyTools` keeps (the body's own tools), the task and goal tools,
 * `skill.read` and the memory read tools. `minecraft.reflex` only exists while an image can be had, so it stays an addition.
 */
export function isFcaCoreTool(tool: Pick<FcaToolDefinition, 'name' | 'domain'>): boolean {
  if (tool.name === 'minecraft.reflex') return false;
  return tool.domain === 'minecraft_body' || tool.domain === 'task_runtime' || tool.domain === 'memory_read'
    || tool.name === 'skill.read' || /^(task|goal)\./u.test(tool.name);
}

/**
 * The core tools one epoch declared. The signatures of thinking blocks bind the set of tools, so these definitions are kept (in the
 * task's checkpoint) and sent unchanged until the epoch ends; `anchor` is the digest of the epoch's first replayed message.
 */
export interface FcaCorePin {
  hash: string; anchor: string | null; tools: FcaToolDefinition[];
  /** Steps the epoch has lived (0 at its first). */
  steps: number;
}

const digest = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

/** The core set of a catalog, in a fixed (provider name) order. The anchor is set when the step commits (`withCoreAnchor`). */
export function pinFcaCoreTools(catalog: readonly FcaToolDefinition[]): FcaCorePin {
  const tools = catalog.filter(isFcaCoreTool).map(tool => ({ ...tool }))
    .sort((left, right) => compare(providerToolName(left.name), providerToolName(right.name)));
  return { hash: digest(tools), anchor: null, tools, steps: 0 };
}
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

/** The digest of a replay's first message, null for an empty replay (the task's first decision). */
export function replayAnchor(history: readonly unknown[]): string | null {
  return history.length ? digest(history[0]) : null;
}

/**
 * Whether this step continues the epoch the pin was made in: the replay starts with the same message. A summary, a clipped or a
 * fallback replay starts a new epoch with a new bootstrap, and holds no signed block of the old one, so only then may the core change.
 */
export function continuesFcaEpoch(pin: FcaCorePin | undefined, history: readonly unknown[]): pin is FcaCorePin {
  return !!pin && pin.anchor !== null && pin.anchor === replayAnchor(history);
}

/** This step's pin: the epoch's own while it continues, else the current catalog's core set. */
export function fcaCoreForStep(previous: FcaCorePin | undefined, catalog: readonly FcaToolDefinition[],
  history: readonly unknown[]): { pin: FcaCorePin; newEpoch: boolean } {
  return continuesFcaEpoch(previous, history) ? { pin: { ...previous, steps: previous.steps + 1 }, newEpoch: false }
    : { pin: pinFcaCoreTools(catalog), newEpoch: true };
}

/** The pin with the anchor of the replay this step leaves behind: what the next step's replay starts with. */
export function withCoreAnchor(pin: FcaCorePin, replay: readonly unknown[], appended: readonly unknown[]): FcaCorePin {
  return { ...pin, anchor: replayAnchor(replay.length ? replay : appended) };
}

/** The pin as a checkpoint holds it, or undefined when it is not one. */
export function readFcaCorePin(value: unknown): FcaCorePin | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Partial<FcaCorePin>;
  if (typeof item.hash !== 'string' || !(item.anchor === null || typeof item.anchor === 'string') || !Array.isArray(item.tools)) return undefined;
  if (item.tools.some(tool => !tool || typeof tool !== 'object' || typeof tool.name !== 'string')) return undefined;
  const steps = typeof item.steps === 'number' && Number.isSafeInteger(item.steps) && item.steps >= 0 ? item.steps : 0;
  return { hash: item.hash, anchor: item.anchor, tools: item.tools.map(tool => ({ ...tool })), steps };
}

/** The state with its transient fields read back only whole from a checkpoint's item; otherwise they are dropped (a legacy task). */
export function withTransientFields(state: FcaToolState, item: Partial<FcaToolState>): FcaToolState {
  const core = readFcaCorePin(item.core), announced = item.announced ?? [];
  const whole = item.obsMode === 'transient' && core && Array.isArray(announced) && announced.every(name => typeof name === 'string');
  const { obsMode: _mode, core: _core, announced: _announced, ...legacy } = state;
  if (item.obsMode === 'transient' && !whole) throw new Error('FCA_CORE_TOOLS_STATE_INVALID');
  return whole ? { ...legacy, obsMode: 'transient', core, announced: [...announced] } : legacy;
}

/** The epoch's pinned core definitions as they were pinned, then the declared and chosen others from the current catalog. */
export function selectedTransientTools(catalog: readonly FcaToolDefinition[], state: FcaToolState): FcaToolDefinition[] {
  const pinned = state.core?.tools ?? [], core = new Set(pinned.map(tool => tool.name));
  const others = new Set([...state.names, ...state.opened, ...state.announced ?? []]);
  return [...pinned, ...catalog.filter(tool => !core.has(tool.name) && (others.has(tool.name) || tool.domain === 'memory_read'))];
}

/** Content-free line for a new epoch's core set: whether it differs from the previous epoch's. */
export function coreEpochLog(taskId: string, pin: FcaCorePin, previous: FcaCorePin | undefined): Record<string, unknown> {
  return { event: 'fca_core_tools', taskId, epoch: 'new', hash: pin.hash.slice(0, 12), coreToolCount: pin.tools.length,
    changed: previous ? previous.hash !== pin.hash : null };
}

/**
 * A transient task's tool state for this step: the epoch's core pin (renewed from the catalog only when the epoch is new), the tools
 * opened so far (never forgotten), and the tools declared since the epoch began, which only grow until it ends. What the selector
 * chose (`names`) is kept as it is, so that a new epoch declares again only what is chosen now and what was opened.
 */
export function transientToolState(state: FcaToolState, previous: FcaToolState | null, catalog: readonly FcaToolDefinition[],
  history: readonly unknown[], taskId: string): FcaToolState {
  const { pin, newEpoch } = fcaCoreForStep(previous?.core, catalog, history);
  if (newEpoch) console.info(JSON.stringify(coreEpochLog(taskId, pin, previous?.core)));
  const core = new Set(pin.tools.map(tool => tool.name)), known = new Set(catalog.map(tool => tool.name));
  const opened = unionNames((previous?.opened ?? []).filter(name => known.has(name)), state.opened);
  const lazy = (names: readonly string[]) => names.filter(name => !core.has(name));
  const announced = unionNames(newEpoch ? [] : previous?.announced ?? [], lazy(state.names), lazy(opened));
  return { ...state, obsMode: 'transient', core: pin, opened, announced };
}

/** The names of a union, in first-seen order. */
export function unionNames(...lists: ReadonlyArray<readonly string[]>): string[] {
  return [...new Set(lists.flat())];
}
