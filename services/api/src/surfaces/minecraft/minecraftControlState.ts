import { type ActionLease } from '@shannon/mind';
import type { BodyObservation, BodyTaskContext } from '../../contracts/bodyControlContract.js';
import type {
  MinecraftControlCommand,
  MinecraftControlPoll,
  MinecraftControlReceipt,
  MinecraftQueueEnvelope,
} from '../../contracts/minecraftControlContract.js';
import { type OperationState } from '../../contracts/continueContract.js';
import type { UsesSnapshot } from './minecraftLlmcPromises.js';
import { type OperationRow } from './store/minecraftControlStore.js';

export interface Frame {
  poll: MinecraftControlPoll;
  received: number;
}

export type ArrivalKind = 'login' | 'death' | 'reconnect' | 'dimension';

export const dimensionOf = (observation: BodyObservation) => {
  const world = (observation.state as { world?: { dimension?: unknown } } | undefined)?.world;
  const value = observation.facts.dimension ?? world?.dimension;
  return typeof value === 'string' ? value.replace(/^minecraft:/u, '') : null;
};

/** The observation's death counter (`state.life`'s `deathEpoch` and `deathSeq`), or an empty one when it has none (`deathBetween`
 * then reads no death). */
export const deathCounterOf = (observation: BodyObservation): { deathEpoch?: unknown; deathSeq?: unknown } =>
  (observation.state as { life?: { deathEpoch?: unknown; deathSeq?: unknown } } | undefined)?.life ?? {};

/**
 * Whether a frame is an arrival after `old` (null: the first), and of what kind; null when the body is where it was. Continue
 * contract 5: a death is a rise of `deathSeq` within
 * one `deathEpoch` (`death`, from `deathBetween`), never the life number alone nor a change of epoch (the file
 * made again: the pack
 * is whole); the body coming up alive again after
 * it is the same death, and a dimension it comes up in is the death's, not a portal's.
 */
export function arrivalOf(
  old: BodyObservation | undefined,
  now: BodyObservation,
  newConnection: boolean,
  death: boolean,
): ArrivalKind | null {
  if (!old) return 'login';
  if (death) return 'death';
  if (newConnection || (!old.connected && now.connected)) return 'reconnect';
  if (old.facts.alive === false) return null;
  const [before, after] = [dimensionOf(old), dimensionOf(now)];
  return before !== null && after !== null && before !== after ? 'dimension' : null;
}

/** After a capture of this connection came back without a picture, short visual control is not offered for this long. */
export const MINECRAFT_CAPTURE_RETRY_MILLISECONDS = 10 * 60_000;

/** A body's first frames after a login, a new connection or a respawn: its facts (health, threats) are not settled yet. */
export const MINECRAFT_SPAWN_GRACE_MILLISECONDS = 10_000;

/** A wait step that took this much longer than asked means the API's thread was blocked (a stall), not that time
 * passed for the body. */
export const MINECRAFT_STALL_MILLISECONDS = 250;

/** How long a newer connection must be silent before a connection it replaced is taken again (`retiredConnection`). */
export const MINECRAFT_RETIRED_CONNECTION_MS = 5_000;

/** The receipts a body sends in one poll at most (`controlLoop.ts`): a fuller list may leave one out. */
export const RECEIPTS_PER_POLL = 16;

/** One command being waited for: when the wait gave it up, so the next poll cancels it (`command`). */
export interface Waiting {
  expired: boolean;
}

/** Commands of the task queue one reply hands over at most (the body takes them in order; one runs and two wait). */
export const QUEUE_COMMANDS_PER_REPLY = 3;

/** What a command is made from (`command`, `enqueue`). */
export interface ControlCommandInput {
  id: string;
  context: BodyTaskContext;
  lease: ActionLease;
  kind: MinecraftControlCommand['kind'];
  skill?: string;
  arguments?: Readonly<Record<string, unknown>>;
  operation?: MinecraftControlCommand['operation'];
  stop?: MinecraftControlCommand['stop'];
  milliseconds?: number;
  queue?: MinecraftQueueEnvelope;
  /** Continue contract 3: the definitions of the promises the act says it uses, as they are when it is sent; kept
   * with the command. */
  uses?: readonly UsesSnapshot[];
  /** Run 45's resume: the command this one sends again (kept with the command, so a result can say it is that one's second try). */
  resumeOf?: string;
}

/** What a receipt did to a command's result state, told to the listeners (the queue reads its items' results from
 * the store, not from
 * the order they came in). */
export interface SettledEvent {
  id: string;
  command: MinecraftControlCommand;
  receipt: MinecraftControlReceipt;
  from: OperationState | null;
  to: OperationState;
}

/** A command released without a receipt of its own (the cleanup or the new connection proved it), or held for the operator. */
export interface ReleasedEvent {
  row: OperationRow;
  by: 'cleanup' | 'reconnect';
}

export const ioTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A paired body supplies observations and executes exact commands; the shared FCA owns all long-term decisions. */
/** A release that names a hold to end (`context.incident.resume` or `cancel`, run 44). */
export function namesHold(context: { incident?: { resume?: unknown; cancel?: unknown } } | undefined): boolean {
  return (
    (typeof context?.incident?.resume === 'string' && context.incident.resume.length > 0) ||
    (typeof context?.incident?.cancel === 'string' && context.incident.cancel.length > 0)
  );
}
