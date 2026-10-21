import { createHash } from 'node:crypto';
import { WORKING_ARBITER_V0, arbitrate, cutNote, runningLine, workingEventLines,
  type ArbiterVerdict, type RunningWork, type WorkingEventLog, type WorkingNeed } from '@shannon/mind';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { EDIBLE_FOOD, carriedItemCounts, countMatching } from './minecraftItems.js';
import { FOOD_STOCK } from './minecraftStage.js';

/** A placed bed this many blocks above or below her is not "in reach" (a basement or a roof: the way there is rock or a climb, not a walk). */
export const BED_HEIGHT_REACH = 12;

/**
 * The Minecraft side of the arbiter (session mb-arch, stage 1; `SHANNON_MINECRAFT_WORKING_EVENTS`). The body tells, while a command
 * runs, what comes into reach and how the command goes (`MinecraftControl.working`); here, on the body's 250 ms watch
 * (`minecraftWorkingBody.ts`):
 *
 * - the running `mc.*` command is followed under the id the body knows it by (`skill:<sha256 of the operation id>`, as
 *   `fcaMinecraftTools` sends it);
 * - `@shannon/mind`'s rules decide a cut: a command that got nowhere for 20 s, or a calm wait while a need is in reach. A cut tells the
 *   task why in fixed words (its inbox); the watch ends the command and the decision, so no later call of that decision runs on a
 *   world that changed;
 * - every decision is told what happened since the one before (needs coming and going, stalls), the command running and how it goes,
 *   and the needs in reach now with the tool that takes each.
 *
 * Calm: no `danger`, nothing hostile within 16 m that can reach her, and day (a wait at night is often a shelter's).
 */
export const MINECRAFT_WORKING = Object.freeze({ calmThreatDistance: 16, needsShown: 4 });

const WHAT: Readonly<Record<string, string>> = {
  bed: '置かれたベッド', bed_wool: '羊', food: '食べ物の動物', iron: '鉄鉱石', fuel: '石炭', wood: '原木',
};
const colour = (need: WorkingNeed) => typeof need.data.color === 'string' ? need.data.color : null;
const TAKE: Readonly<Record<string, (need: WorkingNeed) => string>> = {
  // Run 19: an igloo's bed stood 13 m off for the whole run; dug, a bed is carried (and the night is skipped with it).
  // dig-block-at keeps off a bed (equipment) unless told to take it, and does not walk: move to it first.
  bed: need => `mc.move-to（x=${need.data.x}、y=${need.data.y}、z=${need.data.z}、goalType=block）→ mc.dig-block-at（x=${need.data.x}、`
    + `y=${need.data.y}、z=${need.data.z}、takeEquipment=true。掘れば持てる）`,
  bed_wool: need => `mc.attack-continuously（entityName=sheep${colour(need) ? `、color=${colour(need)}` : ''}、maxKills=1）`,
  food: need => `mc.attack-continuously（entityName=${need.name}、maxKills=2）`,
  iron: need => `mc.mine-block（blockName=${need.name}、searchRadius=24）`,
  fuel: need => `mc.mine-block（blockName=${need.name}、count=4）`,
  wood: need => `mc.mine-block（blockName=${need.name}、count=3）`,
};
/** A wait is ended for these only: logs are in reach all morning, and a wait cut for each would never let one finish. */
const WAIT_WORTH: ReadonlySet<string> = new Set(['bed', 'iron', 'bed_wool', 'food']);
const NAME = /^[a-z0-9_]{1,40}$/u;

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
  const near = (threat: { distance?: unknown; canReachMe?: unknown }) =>
    typeof threat.distance === 'number' && threat.distance <= MINECRAFT_WORKING.calmThreatDistance && threat.canReachMe !== false;
  if (threats.some(near)) return false;
  return typeof world?.margin?.darkInSeconds === 'number' && world.margin.darkInSeconds > 0;
}

/**
 * A hostile within `calmThreatDistance` + 8 m whether or not it can reach her (in a shelter a spider at the slit cannot), or the body's
 * danger flag: a wait is then not ended for a need in reach (the executor does not go out to a pig or an ore with an enemy at the door).
 */
export function minecraftEnemyInSight(observation: BodyObservation | null): boolean {
  if (!observation) return false;
  if (observation.facts.danger === true) return true;
  const world = (observation.state as { world?: { nearbyThreats?: unknown } }).world;
  const threats = Array.isArray(world?.nearbyThreats) ? world!.nearbyThreats as Array<{ distance?: unknown }> : [];
  return threats.some(threat => typeof threat.distance === 'number' && threat.distance <= MINECRAFT_WORKING.calmThreatDistance + 8);
}

/** The needs in reach now, as one line with the tool that takes each kind (once); null when none can be got at. */
export function minecraftNeedsLine(needs: readonly WorkingNeed[]): string | null {
  // A standing bed first, however far: four runs in a row ended without a bed (runs 16 to 19), the nearer logs can wait.
  const ordered = [...needs].sort((a, b) => Number(b.need === 'bed') - Number(a.need === 'bed'));
  const reachable = ordered.filter(need => need.canReach && WHAT[need.need]).slice(0, MINECRAFT_WORKING.needsShown);
  if (!reachable.length) return null;
  const seen = reachable.map(need => `${WHAT[need.need]}${need.need === 'bed_wool' && colour(need) ? `（${colour(need)}）` : ''}`
    + `${need.distance !== null ? `${Math.round(need.distance)}m` : ''}${need.data.exposed === false ? '（埋まっている）' : ''}`);
  const take = [...new Set(reachable.map(need => need.need))].map(kind => TAKE[kind]!(reachable.find(need => need.need === kind)!));
  return `近くに要る物（届く）: ${seen.join('・')}。今の作業の区切りで寄って取れる: ${take.join('、')}`;
}

/** What a need says besides its kind and distance: the wool's colour, out of sight, and its cell. */
function needData(need: Record<string, unknown>): Record<string, string | number | boolean> {
  const data: Record<string, string | number | boolean> = {};
  if (typeof need.color === 'string' && NAME.test(need.color)) data.color = need.color;
  if (need.exposed === false) data.exposed = false;
  const position = need.position && typeof need.position === 'object' ? need.position as Record<string, unknown> : null;
  if (position && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(position[axis]))) Object.assign(data, { x: position.x, y: position.y, z: position.z });
  return data;
}

/**
 * One entry of the frame's list, checked: one of the kinds known here, names of the game's own form, a distance in reach (a standing
 * bed is said up to 96 m). Null if not.
 */
function frameNeed(item: unknown, at: string): (WorkingNeed & { distance: number }) | null {
  const need = item && typeof item === 'object' ? item as Record<string, unknown> : null;
  const distance = Number(need?.distance);
  if (!need || !WHAT[String(need.need)] || typeof need.name !== 'string' || !NAME.test(need.name)) return null;
  if (!Number.isFinite(distance) || distance < 0 || distance > 100) return null;
  const id = typeof need.id === 'string' ? need.id.slice(0, 160) : `${String(need.need)}:${need.name}:${distance}`;
  const data = needData(need);
  // A bed is taken where it stands: without its cell there is nothing to say.
  if (need.need === 'bed' && data.x === undefined) return null;
  return { id, need: String(need.need), name: need.name, distance, canReach: need.canReach === true, at, data };
}

/**
 * The needs in reach now, from the latest frame (`state.world.nearbyNeeds`, the body's own list): always current, also after an API
 * restart or a new connection, and with whether each can still be got at. The events only say what changed, for the decision's lines.
 */
export function minecraftFrameNeeds(observation: BodyObservation | null): WorkingNeed[] {
  type World = { nearbyNeeds?: unknown; rememberedPlaces?: unknown; position?: unknown };
  const world = observation ? (observation.state as { world?: World }).world : undefined;
  const list = Array.isArray(world?.nearbyNeeds) ? (world!.nearbyNeeds as unknown[]).slice(0, 16) : [];
  const own = respawnCell(world?.rememberedPlaces);
  // mb-r23 (run 23): no food animal is offered while the pack holds the stock (the opening's procedure stops hunting there, and the planner
  // chased a cow and chickens for 18 s on the line "attack-continuously で寄って取れる"); a bed far above or below her stands in rock or on a roof.
  const food = observation ? countMatching(carriedItemCounts(world as Record<string, unknown>, observation.facts), EDIBLE_FOOD) : 0;
  const height = typeof (world?.position as { y?: unknown } | undefined)?.y === 'number' ? (world!.position as { y: number }).y : null;
  return list.flatMap(item => frameNeed(item, observation!.stateAt) ?? [])
    .filter(need => !(need.need === 'food' && food >= FOOD_STOCK))
    .map(need => need.need === 'bed' && height !== null && typeof need.data.y === 'number' && Math.abs(need.data.y - height) > BED_HEIGHT_REACH
      ? { ...need, canReach: false } : need)
    // The bed she slept in and left standing is her respawn point, not a bed to take (mb-r20: the procedures leave it where it stands).
    .filter(need => !(own && need.need === 'bed' && typeof need.data.x === 'number' && typeof need.data.y === 'number' && typeof need.data.z === 'number'
      && Math.hypot(need.data.x - own.x, need.data.z - own.z) <= 3 && Math.abs(need.data.y - own.y) <= 2))
    .sort((a, b) => a.distance - b.distance);
}

/** The cell of her respawn bed (`rememberedPlaces.respawn`: `<n>m <方角> (x,y,z)`), or null. */
function respawnCell(places: unknown): { x: number; y: number; z: number } | null {
  const row = places && typeof places === 'object' ? (places as Record<string, unknown>).respawn : null;
  const found = typeof row === 'string' ? /\((-?\d+),\s*(-?\d+),\s*(-?\d+)\)/u.exec(row) : null;
  return found ? { x: Number(found[1]), y: Number(found[2]), z: Number(found[3]) } : null;
}

/**
 * Per task, across its steps (each step builds its own body): the cuts made (never the same command twice, two a minute) and how far
 * its decisions have read the events.
 */
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

/** The content-free journal line of a cut: the rule, the tool and the numbers it went by. */
function cutLine(taskId: string, verdict: Exclude<ArbiterVerdict, { act: 'none' }>, elapsedMs: number): string {
  const by = verdict.rule === 'stalled' ? `sinceProgressMs=${verdict.sinceProgressMs} distance=${verdict.distance ?? '-'}`
    : `need=${verdict.need.need} distance=${verdict.need.distance ?? '-'}`;
  return `Shannon Minecraft working cut task=${taskId} rule=${verdict.rule} tool=${verdict.tool} ${by} elapsedMs=${elapsedMs}`;
}

/** The milliseconds a `mc.wait-time` call asks for, or null for any other call. */
function waitMilliseconds(call: { name: string; input: unknown }): number | null {
  if (call.name !== 'mc.wait-time' || !call.input || typeof call.input !== 'object') return null;
  const milliseconds = Number((call.input as { milliseconds?: unknown }).milliseconds);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

/** A call's cell (x, y, z), when it names one. */
function cellOf(input: unknown): string | null {
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : null;
  if (!value || !['x', 'y', 'z'].every(axis => typeof value[axis] === 'number' && Number.isFinite(value[axis]))) return null;
  return `${Math.floor(value.x as number)},${Math.floor(value.y as number)},${Math.floor(value.z as number)}`;
}

/**
 * The work a call asks for, whatever id it got: the tool and its target (a cell, the block or the animal it names). Run 19 asked the same
 * furnace again under a new id and the arbiter cut it again; on the same topic a cut is made once.
 */
export function minecraftWorkTopic(call: { name: string; input: unknown }): string {
  const value = call.input && typeof call.input === 'object' ? call.input as Record<string, unknown> : {};
  const target = cellOf(call.input) ?? [value.blockName, value.entityName, value.itemName].find(item => typeof item === 'string') ?? '';
  return `${call.name}@${String(target).slice(0, 80)}`;
}

/**
 * How long the furnace a withdraw waits for still has (`world.jobs`, the body's smelting jobs and their estimated end): the job at the
 * call's cell, else the soonest; null when the body has none. Run 19 cut a withdraw with about 3 s left, not knowing it.
 */
export function minecraftFurnaceRemaining(observation: BodyObservation | null, input: unknown): number | null {
  const world = observation ? (observation.state as { world?: { jobs?: unknown } }).world : undefined;
  const jobs = (Array.isArray(world?.jobs) ? world!.jobs as Array<Record<string, unknown>> : [])
    .filter(job => typeof job.remainingEstimateMs === 'number' && Number.isFinite(job.remainingEstimateMs));
  if (!jobs.length) return null;
  const cell = cellOf(input);
  // A furnace named and not among the jobs (the list was cut, or it is not tracked): not known, so not cut.
  if (cell) return (jobs.find(job => cellOf(job.position) === cell)?.remainingEstimateMs as number | undefined) ?? null;
  return Math.min(...jobs.map(job => job.remainingEstimateMs as number));
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

interface Running extends RunningWork { input: unknown; waitMs: number | null; cursor: number | null }

/**
 * The needs that came into reach after the wait began. The body judged the wait when it began (it refuses a wait while there is other
 * work, wait_refused): what it knew then is its call. The arbiter ends a wait only for what is new since.
 */
function freshNeedIds(log: WorkingEventLog, cursor: number | null): Set<string> {
  // No log when the wait began: nothing is known to be new since.
  if (cursor === null) return new Set();
  return new Set(log.since(cursor).events.filter(event => event.kind === 'need.appeared').map(event => event.subject));
}

export function createMinecraftWorkingArbiter(parts: {
  log(): WorkingEventLog | null; now(): number; taskId: string; stepId: string;
  send(text: string, id: string): void; line(text: string): void;
  /**
   * The executor's: a need that came into reach during a wait is taken by it and the wait resumed (`preemptForNeed`). True when it
   * did: then nothing is cut and the task is not told (the call's own result says it).
   */
  onWaitNeed?(need: WorkingNeed): boolean;
  /**
   * The executor's procedure (`mc.run-procedure`): a cut of its running item stops that item only and the procedure goes on. True when it
   * did: the cut counts against the topic as any, but the task is not told and the decision stays current.
   */
  onCut?(): boolean;
}): MinecraftWorkingArbiter {
  let running: Running | null = null;
  const memory = taskMemory(parts.taskId);
  // A task reads from its first step on: what the body told before the task began is not its news.
  if (memory.cursor === null) memory.cursor = parts.log()?.cursor() ?? null;
  const cuts = memory.cuts;
  const tell = (verdict: Exclude<ArbiterVerdict, { act: 'none' }>, now: number, startedAt: number) => {
    const note = JSON.stringify({ kind: 'body.working_cut', rule: verdict.rule, tool: verdict.tool, note: cutNote(verdict) });
    const id = `${parts.stepId}:working:${createHash('sha256').update(verdict.subject).digest('hex').slice(0, 16)}`;
    try {
      parts.send(note, id);
    } catch { /* the cut stands */ }
    try {
      parts.line(cutLine(parts.taskId, verdict, now - startedAt));
    } catch { /* logging never fails a step */ }
  };
  const remaining = (work: Running, observation: BodyObservation | null, now: number): number | null => {
    if (work.tool === 'mc.withdraw-from-furnace') return minecraftFurnaceRemaining(observation, work.input);
    return work.waitMs === null ? null : work.waitMs - (now - work.startedAt);
  };
  return {
    begin(call, operationId) {
      if (!call.name.startsWith('mc.')) return;
      running = { subject: minecraftCommandId(operationId), topic: minecraftWorkTopic(call), tool: call.name, input: call.input,
        waiting: minecraftWaitingCall(call.name, call.input), startedAt: parts.now(), remainingMs: null, waitMs: waitMilliseconds(call),
        cursor: parts.log()?.cursor() ?? null };
    },
    end(name) {
      if (running?.tool === name) running = null;
    },
    check(observation) {
      const log = parts.log();
      if (!log || !running) return { act: 'none' };
      const now = parts.now();
      const work = { ...running, remainingMs: running.waiting ? remaining(running, observation, now) : null };
      const fresh = running.waiting ? freshNeedIds(log, running.cursor) : new Set<string>();
      // A wait in a shelter, or with an enemy in sight (reaching her or not), is not cut for a thing in reach (mb-r20: a wait for a
      // furnace in a slit shelter, a spider at the door, was cut for a pig 22 m off; the next decision built the shelter again).
      const sheltered = minecraftEnemyInSight(observation);
      const verdict = arbitrate({ now, running: work, progress: log.progress(running.subject), needs: minecraftFrameNeeds(observation),
        calm: minecraftCalm(observation), recentCuts: cuts, cutFor: need => !sheltered && WAIT_WORTH.has(need.need) && fresh.has(need.id) });
      if (verdict.act !== 'cut') return verdict;
      // A need the executor takes is no cut: nothing is recorded against the wait's topic, and the task is not told.
      if (verdict.rule === 'need_during_wait' && parts.onWaitNeed?.(verdict.need)) {
        try {
          parts.line(`Shannon Minecraft working take task=${parts.taskId} need=${verdict.need.need} tool=${verdict.tool}`);
        } catch { /* logging never fails a step */ }
        return { act: 'none' };
      }
      cuts.push({ at: now, subject: running.topic ?? verdict.subject });
      if (cuts.length > 8) cuts.shift();
      if (parts.onCut?.()) {
        try {
          parts.line(`${cutLine(parts.taskId, verdict, now - running.startedAt)} inProcedure=true`);
        } catch { /* logging never fails a step */ }
        return { act: 'none' };
      }
      tell(verdict, now, running.startedAt);
      return verdict;
    },
    fields(observation) {
      const log = parts.log();
      if (!log) return {};
      // No body bound when the task began: it reads from the first decision that has one.
      memory.cursor ??= log.cursor();
      const since = log.since(memory.cursor);
      memory.cursor = since.cursor;
      const events = workingEventLines(since.events, WORKING_ARBITER_V0.lines);
      const line = runningLine(running, running ? log.progress(running.subject) : null, parts.now());
      const needs = minecraftNeedsLine(minecraftFrameNeeds(observation));
      if (!events.length && !line && !needs) return {};
      return { working: { ...(line ? { running: line } : {}), ...(events.length ? { events } : {}), ...(needs ? { needs } : {}) } };
    },
  };
}
