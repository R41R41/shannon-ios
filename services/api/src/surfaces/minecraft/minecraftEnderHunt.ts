import { readActResult } from '../../contracts/minecraftActContract.js';
import { carried } from './minecraftConditions.js';
import { eyeBasisOf } from './minecraftEyeSpare.js';
import { PEARL_TARGET } from './minecraftPearlFacts.js';

/**
 * The enderman hunt said as numbers (11/3, the pearl forest scenes: with 18 gold and two endermen in ten minutes the model fought on and never set
 * the wait against the other ways). The head keeps three things, from the frame and the fights it saw: when endermen came near, the pearls
 * carried then, and the deaths since. An enderman drops 0 or 1 pearl, 0.5 on average. The line is numbers and that average; it names no place and no hand.
 */
const PEARLS_PER_KILL = 0.5;
const NEAR_BLOCKS = 32;
const SHOW_AFTER_MS = 2 * 60_000;
const QUIET_MS = 3 * 60_000;
const KEEP_KILLS = 40;

/** What the fights at one enderman came to, as the body tallied them (its words, from the second hand at it on). */
export interface EndermanTries { id: number; hands: number; seconds: number; landed: number }
interface HuntState { v: 1; since: number | null; lastNear: number; pearls0: number; kills: Array<{ key: string; at: number }>; tries?: EndermanTries[] }
const KEEP_TRIES = 4;
/**
 * 1115b c1: #5496 (3,227〜3,711 s) and #6796 (4,046〜4,497 s) were waited for from a roof hand after hand, about 900 s with no blow, each stop told on
 * its own; out of the roof #6796 fell in 3.5 s. The body tallies the fights at one individual (「#6796 へは 4 回目の fight・計 396 秒・打撃 計 0」);
 * the newest of each is kept and said while that one is near, so the next hand is chosen knowing what waiting at it came to.
 */
const TRIES = /#(\d+) へは (\d+) 回目の fight・計 (\d+) 秒・打撃 計 (\d+)/u;
export function triesInLine(text: unknown): EndermanTries | null {
  const found = typeof text === 'string' ? TRIES.exec(text) : null;
  return found ? { id: Number(found[1]), hands: Number(found[2]), seconds: Number(found[3]), landed: Number(found[4]) } : null;
}
/** The words for the tries at the nearest enderman that has some (from its second fight; empty when none is near). */
export function triesWords(tries: readonly EndermanTries[], nearIds: readonly unknown[]): string {
  const one = nearIds.map(id => tries.find(item => item.id === id)).find(item => item && item.hands >= 2);
  if (!one) return '';
  const advice = one.landed === 0 ? '。待っても当たっていない: 同じ待ち方を続けず、体力 16 以上で 1 体なら屋根の外で迎えるか、別の個体を選ぶ' : '';
  return `。#${one.id} へ fight ${one.hands} 回・計 ${one.seconds} 秒・打撃 ${one.landed}${advice}`;
}
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const pearlsOf = (counts: ReadonlyMap<string, number>): number => carried(counts, 'ender_pearl') + carried(counts, 'ender_eye');

/** The endermen in the frame within reach (both lists, an id counted once), nearest first. */
export function endermenNear(world: Record<string, unknown>): Array<{ id: unknown; distance: number }> {
  const seen = new Set<unknown>();
  const out: Array<{ id: unknown; distance: number }> = [];
  for (const list of [world.nearbyThreats, world.nearbyEntities]) {
    for (const item of Array.isArray(list) ? list : []) {
      const entry = item && typeof item === 'object' ? item as { id?: unknown; name?: unknown; distance?: unknown } : null;
      if (entry?.name !== 'enderman' || !finite(entry.distance) || entry.distance > NEAR_BLOCKS || (entry.id !== undefined && seen.has(entry.id))) continue;
      seen.add(entry.id);
      out.push({ id: entry.id, distance: entry.distance });
    }
  }
  return out.sort((a, b) => a.distance - b.distance);
}

function storedOf(saved: unknown): HuntState {
  const raw = saved && typeof saved === 'object' && (saved as { v?: unknown }).v === 1 ? saved as Partial<HuntState> : null;
  const kills = Array.isArray(raw?.kills) ? raw.kills.filter(item => item && typeof item.key === 'string' && finite(item.at)).slice(-KEEP_KILLS) : [];
  const tries = (Array.isArray(raw?.tries) ? raw.tries : []).filter(item => item && [item.id, item.hands, item.seconds, item.landed].every(finite))
    .slice(-KEEP_TRIES);
  return { v: 1, since: finite(raw?.since) ? raw.since : null, lastNear: finite(raw?.lastNear) ? raw.lastNear : 0,
    pearls0: finite(raw?.pearls0) ? raw.pearls0 : 0, kills, tries };
}

/** The kills one fight line says: the body watches on after a kill and says "N 体倒した" when it killed more than one in the same hand. */
export function killsInLine(text: unknown): number {
  const many = typeof text === 'string' ? /(\d+) 体倒した/u.exec(text) : null;
  return many ? Math.max(1, Math.min(20, Number(many[1]))) : 1;
}

export function createEnderHunt(saved: unknown) {
  let state = storedOf(saved);
  return {
    /** An act's result came back: the deaths of endermen in it are counted once each. */
    note(id: string | undefined, resultJson: string | undefined, now: number): void {
      const result = readActResult(resultJson);
      if (!result) return;
      for (const line of result.lines) {
        if (line.do !== 'fight') continue;
        const tried = triesInLine(line.line);
        const killedId = line.code === 'target_killed' ? Number(/enderman #(\d+)/u.exec(line.line)?.[1]) : NaN;
        const others = (state.tries ?? []).filter(item => item.id !== tried?.id && item.id !== killedId);
        state = { ...state, tries: tried && tried.id !== killedId ? [...others, tried].slice(-KEEP_TRIES) : others };
      }
      if (state.since === null) return;
      const killed = result.lines.filter(line => line.do === 'fight' && line.code === 'target_killed' && /enderman/u.test(line.line));
      killed.forEach((line, index) => {
        const base = `${id ?? 'none'}:${line.i ?? index}`.slice(0, 72);
        for (let k = 0; k < killsInLine(line.line); k++) {
          const key = k === 0 ? base : `${base}#${k}`;
          if (!state.kills.some(item => item.key === key)) state.kills = [...state.kills, { key, at: now }].slice(-KEEP_KILLS);
        }
      });
    },
    /** The frame of a decision: the hunt starts when an enderman comes near in the Nether or the overworld, and ends when none was near for a while. */
    line(world: Record<string, unknown>, counts: ReadonlyMap<string, number>, dimension: string | null, now: number): string | null {
      const near = dimension === 'the_nether' || dimension === 'overworld' ? endermenNear(world) : [];
      if (near.length > 0) {
        if (state.since === null) state = { ...state, since: now, pearls0: pearlsOf(counts), kills: [] };
        state.lastNear = now;
      } else if (state.since !== null && (!dimension || now - state.lastNear > QUIET_MS)) {
        state = { v: 1, since: null, lastNear: 0, pearls0: 0, kills: [], tries: state.tries };
      }
      if (state.since === null || near.length === 0) return null;
      const line = huntLine({ near: near.length, nearest: near[0]!.distance, elapsedMs: now - state.since, kills: state.kills.length,
        gained: Math.max(0, pearlsOf(counts) - state.pearls0), have: pearlsOf(counts), target: dimension === 'overworld' ? eyeBasisOf(world).need : PEARL_TARGET });
      return line && `${line}${triesWords(state.tries ?? [], near.map(item => item.id))}`;
    },
    checkpoint: () => ({ minecraftEnderHunt: { ...state, kills: state.kills.map(item => ({ ...item })), tries: (state.tries ?? []).map(item => ({ ...item })) } }),
  };
}
export type EnderHunt = ReturnType<typeof createEnderHunt>;

/** `target`: the number to hold (`eyeBasisOf` in the overworld: 12 plus the spare, or the empty frames when found; the Nether's pearl target otherwise). */
export interface HuntNumbers { near: number; nearest: number; elapsedMs: number; kills: number; gained: number; have: number; target?: number }

/**
 * 11/26 (Haiku, the Nether pearl stage): the body's reflex (floor melee) killed two of the three endermen of the stage and its words carry no kill into the
 * results the head sees (the ledger line says "1 体倒した" in the body's own log only), so the line said 撃破 0 and "about 66 minutes" for a stage that went at
 * a third of that. The kills are not countable from what reaches the head; the line says so, and the estimate says it is a high one.
 *
 * The line from the numbers (pure): null before two minutes, and once the pearls are enough. */
export function huntLine(n: HuntNumbers): string | null {
  const target = n.target ?? PEARL_TARGET;
  if (n.have >= target || n.elapsedMs < SHOW_AFTER_MS) return null;
  const minutes = Math.max(1, Math.round(n.elapsedMs / 60_000));
  const missing = target - n.have;
  const base = `エンダーマン狩り ${minutes} 分: いま近くに ${n.near} 体（最寄り ${Math.round(n.nearest)}m）・撃破 ${n.kills} 体`
    + `・パール +${n.gained}（${n.have}/${target}）。`
    + `撃破は fight の結果に出た分だけ（体の反射が倒した分は結果に載らず、入っていない）。`
    + `1 体の落とし物は平均 ${PEARLS_PER_KILL} 個（0〜1）`;
  if (n.kills === 0) return base;
  const perMinute = n.kills / (n.elapsedMs / 60_000) * PEARLS_PER_KILL;
  const rate = (n.kills / (n.elapsedMs / 60_000)).toFixed(1);
  return `${base}。この速さ（撃破 ${rate} 体/分）ならあと ${missing} 個に約 ${Math.ceil(missing / perMinute)} 分（反射の撃破を含まないので、実際はこれより速いことがある）`;
}
