import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { doneFacts } from './minecraftConditions.js';

/**
 * The stall record (the coordinator's list for 11/4, item 1; S5 captures the same fields on leg 2b): one line a stall writes to the server log when
 * the plan is asked for again, and one when the body has got out of it, so that a run's stalls can be read without the decision record: what was
 * found (the kind, the seconds without progress), what the head did (the strong model's wait, the wait for the gap, the node's count against its
 * cap), and what the body was in (health, hunger, the dimension, the hostiles within 16 m). Facts only; nothing here decides.
 * The platform's gaps are the map's, read by S5's capture, not by the head.
 */
export interface StallVitals { hp: number | null; hunger: number | null; dimension: string | null; enemies16: number }
export interface StallRecord {
  kind: string;
  node: string;
  idleSeconds: number | null;
  /** `changed`, `unchanged`, `refused`, `failed`, or `skipped:<gap|hour|run|node>`. */
  outcome: string;
  /** The strong model's wait (ms), 0 when it was not asked. */
  askMs: number;
  /** How long the stall waited for a slot (ms of the task's running clock). */
  gapWaitMs: number;
  nodeAsks: number;
  nodeCap: number;
  vitals: StallVitals;
}

const HOSTILE = /^#\d+ \S+ ([\d.]+)m/u;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** What the frame says of the body now, for a record; nulls where it says nothing. */
export function stallVitals(frame: BodyObservation | null): StallVitals {
  const facts = doneFacts(frame), world = frame?.state.world as { threats?: unknown; urgent?: unknown } | undefined;
  const lines = [world?.threats, world?.urgent].flatMap(list => Array.isArray(list) ? list : []).filter((line): line is string => typeof line === 'string');
  const near = new Set(lines.flatMap(line => {
    const meters = HOSTILE.exec(line)?.[1];
    return meters !== undefined && Number(meters) <= 16 ? [line.split(' ')[0]!] : [];
  }));
  return { hp: finite(facts?.hp) ? facts.hp : null, hunger: finite(facts?.hunger) ? facts.hunger : null, dimension: facts?.dimension ?? null,
    enemies16: near.size };
}

/** The record as one log line. */
export function stallRecordLine(taskId: string, record: StallRecord): string {
  return `Shannon Minecraft stall record task=${taskId} ${JSON.stringify(record)}`;
}

/** The line written when the node the last record was for is no longer the current one: the body got out of it, and whether that plan did it. */
export function stallEscapedLine(taskId: string, last: { node: string; outcome: string; at: number }, nowMs: number): string {
  const seconds = Math.round(Math.max(0, nowMs - last.at) / 1000);
  return `Shannon Minecraft stall escaped task=${taskId} node=${last.node} afterSeconds=${seconds} replan=${last.outcome}`;
}
