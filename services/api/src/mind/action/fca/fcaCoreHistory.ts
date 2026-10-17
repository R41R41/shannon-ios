import { providerToolName } from '../../tools/toolRegistryPorts.js';
import { readFcaCorePin, pinFcaCoreTools, type FcaCorePin, type FcaObsMode } from './fcaCoreTools.js';
import { FCA_HISTORY_POLICY } from './fcaHistory.js';
import type { FcaHistoryCodec, FcaHistoryPolicy } from './fcaHistoryPorts.js';
import type { FcaToolDefinition } from './fcaPorts.js';

/** The least a transient task's replay may be allowed once its core definitions are taken off the budget (tokens). */
export const FCA_TRANSIENT_MINIMUM_REPLAY_TOKENS = 20_000;

/**
 * What a transient body task's history preparation needs (`SHANNON_FCA_OBS_MODE`, `fcaCoreTools.ts`), decided before the step's
 * tool selection from the task's checkpoint and the current catalog; null for any other task.
 *
 * - The core definitions are declared at the top level, so the replay's token budget (`maximumReplayTokens`) no longer holds them
 *   (as an inline definitions message it did); their estimate comes off it, or replay, core, instructions and the decision could pass
 *   the 100,000-token price step together.
 * - `forceEpoch`: the epoch's pinned core is no longer the catalog's (a body tool's schema or description changed, or a catalog tool now
 *   shares a provider name with a pinned one). The model keeps seeing the pinned definitions for the whole epoch, and the executor
 *   checks inputs against the current ones, so the next replay starts a new epoch by a real summary and the core is pinned again.
 */
export interface FcaTransientHistory { policy: Partial<FcaHistoryPolicy>; forceEpoch: boolean; reason: 'definitions_changed' | 'name_conflict' | null }

export interface FcaTransientPorts {
  obsMode?: FcaObsMode; keepBodyTools?(): boolean; selector?: unknown; history?: { codec: FcaHistoryCodec; policy?: Partial<FcaHistoryPolicy> };
}
export function fcaTransientHistory(prior: Record<string, unknown>, catalog: readonly FcaToolDefinition[],
  ports: FcaTransientPorts): FcaTransientHistory | null {
  const pin = pinOfCheckpoint(prior.fcaToolSelection, ports.obsMode === 'transient' && ports.keepBodyTools?.() === true && !!ports.selector);
  if (pin === null || !ports.history) return null;
  const current = pinFcaCoreTools(catalog), basis = pin ?? current;
  const tokens = ports.history.codec.tokens?.(basis.tools) ?? 0;
  const base = ports.history.policy?.maximumReplayTokens ?? FCA_HISTORY_POLICY.maximumReplayTokens;
  const policy = { ...ports.history.policy, maximumReplayTokens: Math.max(FCA_TRANSIENT_MINIMUM_REPLAY_TOKENS, base - tokens) };
  return { policy, ...staleness(pin, current, catalog) };
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

type Staleness = Pick<FcaTransientHistory, 'forceEpoch' | 'reason'>;
function staleness(pin: FcaCorePin | undefined, current: FcaCorePin, catalog: readonly FcaToolDefinition[]): Staleness {
  if (!pin) return { forceEpoch: false, reason: null };
  // Without any body tool in the catalog (the body is away) the pinned set stays: a call of it is turned away as not offered.
  const bodyHere = current.tools.some(tool => tool.domain === 'minecraft_body');
  if (bodyHere && pin.hash !== current.hash) return { forceEpoch: true, reason: 'definitions_changed' };
  if (conflictingProviderNames(pin, catalog).length) return { forceEpoch: true, reason: 'name_conflict' };
  return { forceEpoch: false, reason: null };
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