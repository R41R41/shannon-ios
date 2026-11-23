import type { TaskRuntime } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import type { MinecraftControl } from '../surfaces/minecraft/minecraftControl.js';

/** A task is woken for a hit at most this often (a fight that goes on would otherwise start a decision at every tick). */
export const HIT_WAKE_MINIMUM_MILLISECONDS = 15_000;
/** Health lost since the last tick that counts as a hit (one heart is 2). */
export const HIT_LOSS = 1;
/** Below this health a hostile this near is danger by itself (the body stands hurt with it at her side). */
export const HURT_HEALTH = 12;
export const HURT_METERS = 8;
/** A hit counts when the hostile that may have made it is this near. */
export const HIT_METERS = 12;
/** What the woken task is told (an external event of the common task tree, as the in-game words are). */
export const HIT_WAKE_TEXT = '被弾している（体力が減り、敵が近い）。待ちをやめて、いまの live を読み直し、離れる・食べる・隠れる・斬るのどれかの手を出す。';

const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;

/** The body's danger now from its frame: its health, and the nearest hostile's distance (null: none listed). */
function dangerOf(world: Record<string, unknown>): { health: number; near: number | null } | null {
  const health = num(world.health);
  if (health === null) return null;
  const list = Array.isArray(world.nearbyThreats) ? world.nearbyThreats : [];
  const metres = list.map(item => num((item as { distance?: unknown } | null)?.distance)).filter((value): value is number => value !== null);
  return { health, near: metres.length ? Math.min(...metres) : null };
}

/**
 * 11/24 (the night of 11/23: at 22:44 to 22:45 the body, with nothing in its queue and the task waiting, was killed three times by a zombie and a
 * skeleton with no decision at all; `near_death` only moved her words, and the queue's alert wakes a step that has items): a Minecraft task that is
 * waiting is woken, as `fcaMinecraftBodyWake` wakes one for a body that was not there, when its body is hit (health fell by `HIT_LOSS` since the last
 * tick with a hostile within `HIT_METERS`) or stands hurt (health under `HURT_HEALTH`, a hostile within `HURT_METERS`). The wake is one message
 * through `observeExternal`; a task is woken `HIT_WAKE_MINIMUM_MILLISECONDS` apart at most. The cost is a decision (about 4 s, 0.02 USD with the production
 * model) every 15 s at most, and only while she is hurt next to a hostile: nothing is spent in a calm wait.
 */
export function fcaMinecraftHitWake(parts: { control: MinecraftControl; runtime: TaskRuntime; ownerScope: string; now?: () => number;
  log?(line: string): void }) {
  const now = parts.now ?? Date.now, log = parts.log ?? ((line: string) => console.info(line));
  const woken = new Map<string, number>(), healthOf = new Map<string, number>();
  const origin = (taskId: string): string | null => {
    for (const source of parts.runtime.taskSources(parts.ownerScope, taskId)) {
      const id = source.experienceId ?? source.recalledMemoryIds[0];
      if (id) return id;
    }
    return null;
  };
  const wakeTasks = (bodyId: string, why: string): number => {
    let count = 0;
    for (const task of parts.runtime.list(parts.ownerScope)) {
      try {
        if (task.phase !== 'waiting' || task.status === 'paused' || parts.control.store.body(task.id) !== bodyId) continue;
        if (now() - (woken.get(task.id) ?? -Infinity) < HIT_WAKE_MINIMUM_MILLISECONDS) continue;
        const experienceId = origin(task.id);
        if (!experienceId) {
          log(`Shannon Minecraft hit wake skipped task=${task.id} reason=no_origin`);
          continue;
        }
        parts.runtime.observeExternal(parts.ownerScope, task.id, { eventId: `mc-hit:${task.id}:${task.revision}`, experienceIds: [experienceId],
          observedAt: new Date(now()).toISOString(), text: HIT_WAKE_TEXT });
        woken.set(task.id, now());
        if (woken.size > 32) woken.delete(woken.keys().next().value as string);
        count += 1;
        log(`Shannon Minecraft hit wake task=${task.id} why=${why}`);
      } catch (error) {
        log(`Shannon Minecraft hit wake failed task=${task.id} reason=${error instanceof Error ? error.message.slice(0, 60) : 'error'}`);
      }
    }
    return count;
  };
  return {
    /** Wakes the waiting tasks whose body is hit or hurt beside a hostile; how many. Called from the one-second wake tick. */
    tick(): number {
      let count = 0;
      for (const bodyId of parts.control.available()) {
        const world = parts.control.observe(bodyId)?.state.world as Record<string, unknown> | undefined;
        const danger = world ? dangerOf(world) : null;
        if (!danger) continue;
        const before = healthOf.get(bodyId);
        healthOf.set(bodyId, danger.health);
        const hit = before !== undefined && before - danger.health >= HIT_LOSS && danger.near !== null && danger.near <= HIT_METERS;
        const hurt = danger.health < HURT_HEALTH && danger.near !== null && danger.near <= HURT_METERS;
        if (hit || hurt) count += wakeTasks(bodyId, hit ? 'hit' : 'hurt');
      }
      return count;
    },
  };
}
