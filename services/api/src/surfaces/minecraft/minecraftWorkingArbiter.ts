import { createHash } from 'node:crypto';
import { WORKING_ARBITER_V0, arbitrate, cutNote, runningLine, workingEventLines,
  type ArbiterVerdict, type RunningWork, type WorkingEventLog, type WorkingNeed } from '@shannon/mind';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';

/**
 * The Minecraft side of the arbiter (session mb-arch, stage 1; `SHANNON_MINECRAFT_WORKING_EVENTS`). The body tells, while a command
 * runs, what comes into reach and how the command goes (`MinecraftControl.working`); here, on the adapter's 250 ms watch:
 *
 * - the running `mc.*` command is followed under the id the body knows it by (`skill:<sha256 of the operation id>`, as
 *   `fcaMinecraftTools` sends it);
 * - `@shannon/mind`'s rules decide a cut: a command that got nowhere for 20 s, or a calm wait while a need is in reach. A cut tells the
 *   task why in fixed words (its inbox), and the adapter ends the command and the decision (`revision`), so no later call of that
 *   decision runs on a world that changed;
 * - every decision is told what happened since the one before (needs coming and going, stalls), the command running and how it goes,
 *   and the needs in reach now with the tool that takes each.
 *
 * Calm: no `danger`, nothing hostile within 16 m that can reach her, and day (a wait at night is often a shelter's).
 */
export const MINECRAFT_WORKING = Object.freeze({ calmThreatDistance: 16, needsShown: 4 });

const WHAT: Readonly<Record<string, string>> = { bed_wool: '羊', food: '食べ物の動物', iron: '鉄鉱石', wood: '原木' };
const TAKE: Readonly<Record<string, (need: WorkingNeed) => string>> = {
  bed_wool: need => `mc.attack-continuously（entityName=sheep${typeof need.data.color === 'string' ? `、color=${need.data.color}` : ''}、maxKills=1）`,
  food: need => `mc.attack-continuously（entityName=${need.name}、maxKills=2）`,
  iron: need => `mc.mine-block（blockName=${need.name}、searchRadius=24）`,
  wood: need => `mc.mine-block（blockName=${need.name}、count=3）`,
};

/** The id the body knows a skill command by (`fcaMinecraftTools`: `skill:` and the operation id's SHA-256). */
export function minecraftCommandId(operationId: string): string {
  return `skill:${createHash('sha256').update(operationId).digest('hex')}`;
}

/** Whether a call only waits: `mc.wait-time`, and a furnace withdraw told to wait for the end. */
export function minecraftWaitingCall(name: string, input: unknown): boolean {
  if (name === 'mc.wait-time') return true;
  return name === 'mc.withdraw-from-furnace' && !!input && typeof input === 'object' && (input as { waitForCompletion?: unknown }).waitForCompletion === true;
}

/** No danger, no hostile that can reach her within `calmThreatDistance`, and day by the body's own margin. */
export function minecraftCalm(observation: BodyObservation | null): boolean {
  if (!observation || observation.facts.danger === true) return false;
  const world = (observation.state as { world?: { nearbyThreats?: unknown; margin?: { darkInSeconds?: unknown } } }).world;
  const threats = Array.isArray(world?.nearbyThreats) ? world!.nearbyThreats as Array<{ distance?: unknown; canReachMe?: unknown }> : [];
  if (threats.some(threat => typeof threat.distance === 'number' && threat.distance <= MINECRAFT_WORKING.calmThreatDistance && threat.canReachMe !== false)) return false;
  return typeof world?.margin?.darkInSeconds === 'number' && world.margin.darkInSeconds > 0;
}

/** The needs in reach now, as one line with the tool that takes each kind (once); null when none can be got at. */
export function minecraftNeedsLine(needs: readonly WorkingNeed[]): string | null {
  const reachable = needs.filter(need => need.canReach && WHAT[need.need]).slice(0, MINECRAFT_WORKING.needsShown);
  if (!reachable.length) return null;
  const seen = reachable.map(need => `${WHAT[need.need]}${need.need === 'bed_wool' && typeof need.data.color === 'string' ? `（${need.data.color}）` : ''}`
    + `${need.distance !== null ? `${Math.round(need.distance)}m` : ''}${need.data.exposed === false ? '（埋まっている）' : ''}`);
  const take = [...new Set(reachable.map(need => need.need))].map(kind => TAKE[kind]!(reachable.find(need => need.need === kind)!));
  return `近くに要る物（届く）: ${seen.join('・')}。今の作業の区切りで寄って取れる: ${take.join('、')}`;
}

/** A wait is ended for these only: logs are in reach all morning, and a wait cut for each would never let one finish. */
const WAIT_WORTH: ReadonlySet<string> = new Set(['iron', 'bed_wool', 'food']);
const NAME = /^[a-z0-9_]{1,40}$/u;

/**
 * The needs in reach now, from the latest frame (`state.world.nearbyNeeds`, the body's own list): always current, also after an API
 * restart or a new connection, and with whether each can still be got at. The events only say what changed, for the decision's lines.
 */
export function minecraftFrameNeeds(observation: BodyObservation | null): WorkingNeed[] {
  const world = observation ? (observation.state as { world?: { nearbyNeeds?: unknown } }).world : undefined;
  const list = Array.isArray(world?.nearbyNeeds) ? (world!.nearbyNeeds as unknown[]).slice(0, 16) : [];
  return list.flatMap(item => {
    const need = item && typeof item === 'object' ? item as Record<string, unknown> : null;
    const distance = Number(need?.distance);
    if (!need || !WHAT[String(need.need)] || typeof need.name !== 'string' || !NAME.test(need.name) || !Number.isFinite(distance) || distance < 0 || distance > 64) return [];
    return [{ id: typeof need.id === 'string' ? need.id.slice(0, 160) : `${String(need.need)}:${need.name}:${distance}`, need: String(need.need), name: need.name,
      distance, canReach: need.canReach === true, at: observation!.stateAt,
      data: { ...(typeof need.color === 'string' && NAME.test(need.color) ? { color: need.color } : {}), ...(need.exposed === false ? { exposed: false } : {}) } }];
  }).sort((a, b) => a.distance - b.distance);
}

/** Per task, across its steps (each step builds its own adapter): the cuts made (never the same command twice, two a minute) and how far its decisions have read the events. */
const memories = new Map<string, { cuts: Array<{ at: number; subject: string }>; cursor: number | null }>();
function taskMemory(taskId: string) {
  let memory = memories.get(taskId);
  if (!memory) {
    memory = { cuts: [], cursor: null };
    memories.set(taskId, memory);
    if (memories.size > 32) memories.delete(memories.keys().next().value as string);
  }
  return memory;
}

export interface MinecraftWorkingArbiter {
  /** A call of hers begins (`noteCall`); only `mc.*` skills are followed. */
  begin(call: { name: string; input: unknown }, operationId: string): void;
  /** The call ended (`noteResult`). */
  end(name: string): void;
  /** On the watch: the verdict for the running command now. A cut is told to the task and logged here; the caller ends the command. */
  check(observation: BodyObservation | null): ArbiterVerdict;
  /** For the next decision: what happened since the last one, what runs, and the needs in reach. Empty when nothing to say. */
  fields(observation: BodyObservation | null): { working?: { running?: string; events?: string[]; needs?: string } };
}

export function createMinecraftWorkingArbiter(parts: {
  log(): WorkingEventLog | null; now(): number; taskId: string; stepId: string;
  send(text: string, id: string): void; line(text: string): void;
}): MinecraftWorkingArbiter {
  let running: RunningWork | null = null;
  const memory = taskMemory(parts.taskId);
  memory.cursor ??= parts.log()?.cursor() ?? 0;
  const cuts = memory.cuts;
  return {
    begin(call, operationId) {
      if (!call.name.startsWith('mc.')) return;
      const milliseconds = call.name === 'mc.wait-time' && call.input && typeof call.input === 'object' ? Number((call.input as { milliseconds?: unknown }).milliseconds) : NaN;
      running = { subject: minecraftCommandId(operationId), tool: call.name, waiting: minecraftWaitingCall(call.name, call.input), startedAt: parts.now(),
        remainingMs: Number.isFinite(milliseconds) ? milliseconds : null };
    },
    end(name) { if (running?.tool === name) running = null; },
    check(observation) {
      const log = parts.log();
      if (!log || !running) return { act: 'none' };
      const now = parts.now();
      const work = running.remainingMs === null ? running : { ...running, remainingMs: running.remainingMs - (now - running.startedAt) };
      const verdict = arbitrate({ now, running: work, progress: log.progress(running.subject), needs: minecraftFrameNeeds(observation), calm: minecraftCalm(observation),
        recentCuts: cuts, cutFor: need => WAIT_WORTH.has(need.need) });
      if (verdict.act !== 'cut') return verdict;
      cuts.push({ at: now, subject: verdict.subject });
      if (cuts.length > 8) cuts.shift();
      const note = JSON.stringify({ kind: 'body.working_cut', rule: verdict.rule, tool: verdict.tool, note: cutNote(verdict) });
      try { parts.send(note, `${parts.stepId}:working:${createHash('sha256').update(verdict.subject).digest('hex').slice(0, 16)}`); } catch { /* the cut stands */ }
      try {
        parts.line(`Shannon Minecraft working cut task=${parts.taskId} rule=${verdict.rule} tool=${verdict.tool}`
          + (verdict.rule === 'stalled' ? ` sinceProgressMs=${verdict.sinceProgressMs} distance=${verdict.distance ?? '-'}` : ` need=${verdict.need.need} distance=${verdict.need.distance ?? '-'}`)
          + ` elapsedMs=${now - running.startedAt}`);
      } catch { /* logging never fails a step */ }
      return verdict;
    },
    fields(observation) {
      const log = parts.log();
      if (!log) return {};
      const since = log.since(memory.cursor ?? 0);
      memory.cursor = since.cursor;
      const events = workingEventLines(since.events, WORKING_ARBITER_V0.lines);
      const line = runningLine(running, running ? log.progress(running.subject) : null, parts.now());
      const needs = minecraftNeedsLine(minecraftFrameNeeds(observation));
      if (!events.length && !line && !needs) return {};
      return { working: { ...(line ? { running: line } : {}), ...(events.length ? { events } : {}), ...(needs ? { needs } : {}) } };
    },
  };
}
