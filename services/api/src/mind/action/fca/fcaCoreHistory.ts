import { providerToolName } from '../../tools/toolRegistryPorts.js';
import { continuesFcaEpoch, readFcaCorePin, pinFcaCoreTools, type FcaCorePin, type FcaObsMode } from './fcaCoreTools.js';
import { FCA_HISTORY_POLICY } from './fcaHistory.js';
import type { FcaHistoryCodec, FcaHistoryPolicy } from './fcaHistoryPorts.js';
import type { FcaToolDefinition } from './fcaPorts.js';

/** The least a transient task's replay may be allowed once its core definitions are taken off the budget (tokens). */
export const FCA_TRANSIENT_MINIMUM_REPLAY_TOKENS = 20_000;
/**
 * Steps an epoch must have lived before a stale core may end it by a summary (a flapping catalog would otherwise summarize every
 * step). It stays below the five consecutive failed steps that stop a task, which is what a stale definition can cost meanwhile.
 */
export const FCA_CORE_COOLDOWN_STEPS = 3;

/**
 * What a transient body task's history preparation needs (`SHANNON_FCA_OBS_MODE`, `fcaCoreTools.ts`), decided before the step's
 * tool selection from the task's checkpoint and the current catalog; null for any other task.
 *
 * - The core definitions are declared at the top level, so the replay's token budget (`maximumReplayTokens`) no longer holds them
 *   (as an inline definitions message it did); their estimate comes off it, or replay, core, instructions and the decision could pass
 *   the 100,000-token price step together.
 * - `stale`: the epoch's pinned core is no longer the catalog's (a body tool's schema or description changed, or a renamed tool's
 *   provider name is now another tool's). The model keeps seeing the pinned definitions for the whole epoch and the executor checks
 *   inputs against the current ones, so the replay may start a new epoch by a real summary and pin the core again
 *   (`shouldForceFcaEpoch` decides, once the replay is known).
 */
export interface FcaTransientHistory {
  policy: Partial<FcaHistoryPolicy>; stale: 'definitions_changed' | 'name_conflict' | null; pin: FcaCorePin | undefined;
}

export interface FcaTransientPorts {
  obsMode?: FcaObsMode; keepBodyTools?(): boolean; selector?: unknown; history?: { codec: FcaHistoryCodec; policy?: Partial<FcaHistoryPolicy> };
}
/**
 * Whether this step belongs to a transient body task (the mode it started with, or starts with now). Its decision carries no recall
 * packet until P5 brings the past episodes as one-line live state, so the recall is not even started: no memory is fetched, and none is
 * recorded as a source of a decision that never showed it.
 */
export function isFcaTransientTask(prior: Record<string, unknown>, ports: FcaTransientPorts): boolean {
  return pinOfCheckpoint(prior.fcaToolSelection, ports.obsMode === 'transient' && ports.keepBodyTools?.() === true && !!ports.selector) !== null;
}
export function fcaTransientHistory(prior: Record<string, unknown>, catalog: readonly FcaToolDefinition[],
  ports: FcaTransientPorts): FcaTransientHistory | null {
  const pin = pinOfCheckpoint(prior.fcaToolSelection, ports.obsMode === 'transient' && ports.keepBodyTools?.() === true && !!ports.selector);
  if (pin === null || !ports.history) return null;
  const current = pinFcaCoreTools(catalog), basis = pin ?? current;
  const tokens = ports.history.codec.tokens?.(basis.tools) ?? 0;
  const base = ports.history.policy?.maximumReplayTokens ?? FCA_HISTORY_POLICY.maximumReplayTokens;
  const policy = { ...ports.history.policy, maximumReplayTokens: Math.max(FCA_TRANSIENT_MINIMUM_REPLAY_TOKENS, base - tokens) };
  return { policy, stale: pin ? staleness(pin, current, catalog) : null, pin };
}

/**
 * Whether this replay (the epoch replay before any compaction) is to start a new epoch by a summary now: the core is stale; the replay
 * still starts with the message the pin was made for (else a summary already began a new epoch, the failed decision after it being
 * retried: no summary of a summary); and the epoch has lived `FCA_CORE_COOLDOWN_STEPS`. Logs content-free, once for each summary.
 */
export function shouldForceFcaEpoch(state: FcaTransientHistory, replay: readonly unknown[], taskId: string): boolean {
  const { pin, stale } = state;
  if (!stale || !pin || !continuesFcaEpoch(pin, replay) || pin.steps < FCA_CORE_COOLDOWN_STEPS) return false;
  console.info(JSON.stringify({ event: 'fca_core_tools_stale', taskId, reason: stale }));
  return true;
}

/**
 * The pin a checkpoint holds: undefined for a task that has none yet and starts transient (`start`), null when the task is not
 * transient. A checkpoint that says transient with no valid core is never taken for anything else (`FCA_CORE_TOOLS_STATE_INVALID`).
 */
function pinOfCheckpoint(selection: unknown, start: boolean): FcaCorePin | null | undefined {
  const isObject = !!selection && typeof selection === 'object' && !Array.isArray(selection);
  const state = isObject ? selection as { obsMode?: unknown; core?: unknown } : null;
  if (!state) return start ? undefined : null;
  if (state.obsMode !== 'transient') return null;
  const pin = readFcaCorePin(state.core);
  if (!pin) throw new Error('FCA_CORE_TOOLS_STATE_INVALID');
  return pin;
}

type Stale = FcaTransientHistory['stale'];
function staleness(pin: FcaCorePin, current: FcaCorePin, catalog: readonly FcaToolDefinition[]): Stale {
  // The body is away (no skill of it is in the core any more, observe and minecraft.reflex apart): the pinned set stays, and a call of
  // it is turned away as not offered. Pinning again would pin a core without the body.
  const bodyHere = current.tools.some(tool => tool.domain === 'minecraft_body' && tool.name !== 'minecraft.observe');
  if (!bodyHere) return null;
  if (pin.hash !== current.hash) return 'definitions_changed';
  return conflictingProviderNames(pin, catalog).length ? 'name_conflict' : null;
}
/**
 * The provider names a catalog tool shares with a pinned core tool of another name that the catalog no longer has: pinning again
 * settles it (a tool renamed). Two live tools with one provider name stay a conflict the model's request leaves out (never an epoch).
 */
export function conflictingProviderNames(pin: FcaCorePin, catalog: readonly FcaToolDefinition[]): string[] {
  const live = new Set(catalog.map(tool => tool.name));
  const pinned = new Map(pin.tools.filter(tool => !live.has(tool.name)).map(tool => [providerToolName(tool.name), tool.name]));
  return catalog.map(tool => providerToolName(tool.name)).filter((name, index) => pinned.has(name) && pinned.get(name) !== catalog[index]!.name);
}
