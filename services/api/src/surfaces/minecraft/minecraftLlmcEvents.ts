import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { MC_ACT_TOOL, readActResult } from '../../contracts/minecraftActContract.js';
import { createFoodTrend, type FoodTrend } from './minecraftLlmcLive.js';
import { urgentRange } from './minecraftLlmcUrgent.js';
import { stopFactLines } from './minecraftLlmcFacts.js';
import { sameSpotStops } from './minecraftLlmcStalls.js';
import { calmEnderman, nearThreats, THREAT_SIGHT, threatLine, walledOff, type NearThreat, type ThreatSight } from './minecraftLlmcThreat.js';
import { reflexLines } from './minecraftLlmcReflexHold.js';
import { FACT_WINDOW_MS } from './minecraftLlmcHealth.js';
import { typedFailureAttemptsOf, typedFailureLines, type TypedFailureAttempt } from './minecraftLlmcTypedFailure.js';
import { fillWords, shieldRushWords } from './minecraftLlmcResultWords.js';
import { stopCodesOf, STOP_CODES_KEPT, type StopCode } from './minecraftLlmcRepeat.js';

export interface TaskEvents {
  lines: Array<{ seq: number; line: string }>;
  seq: number;
  read: number;
  arrival: number | null;
  failed: boolean;
  trend: FoodTrend;
  /** r3: the whole texts of results the history keeps short, until the next decision shows them. */
  pending: string[];
  /** r3: why the last result makes the next step urgent (a reflex or a hostile cut the act), or null. */
  cut: string | null;
  /** The last act was refused before it was sent (no hand moved): the refusal's first line, the next input's first line says so. */
  notSent: string | null;
  /** r3: her health at the last decision, for what a fall or a blast took since. */
  health: number | null;
  /** r7: the last act was stopped by its own stopIf (where it stopped is looked at from the shooters near). */
  stopIf: boolean;
  /** Chapter 8: when the last decision read its context (ms), for the promises' 「直前に」; the stops of the results
   * since (`stopFactsOf`),
   * until the next decision shows them. */
  lastAt: number | null;
  stops: Array<string | (() => string)>;
  /** Actual failed hands, bounded in this task; alternatives shown to the model are never recorded as attempts. */
  typedFailures: TypedFailureAttempt[];
  typedFailureCount: number;
  /** Latest rush/fill outcomes, including success and cuts, also shown in compressed decisions. */
  structuredHandFacts: string[];
  /** The codes the head read in the stopped hands of the acts that ended (`stopCodeOf`), newest last, for the codes beside the body's stop lines (`withStopCodes`). */
  stopCodes: StopCode[];
}

export const tasks = new Map<string, TaskEvents>();

export function eventsOf(taskId: string): TaskEvents {
  let state = tasks.get(taskId);
  if (!state) {
    state = {
      lines: [],
      seq: 0,
      read: 0,
      arrival: null,
      failed: false,
      trend: createFoodTrend(),
      pending: [],
      cut: null,
      notSent: null,
      health: null,
      stopIf: false,
      lastAt: null,
      stops: [],
      typedFailures: [],
      typedFailureCount: 0,
      structuredHandFacts: [],
      stopCodes: [],
    };
    tasks.set(taskId, state);
    if (tasks.size > 32) tasks.delete(tasks.keys().next().value as string);
  }
  return state;
}

/**
 * mb-llmc v2: whether the decision a task's tools are now running was an urgent one (its live state was the short one with the
 * answer line 「手は 3 つまで」): the act preflight's urgent limit (`minecraftLlmcHandGuards.ts`) reads it when the act is sent.
 */
export const urgentDecisions = new Map<string, boolean>();

export function noteUrgentDecision(taskId: string, urgent: boolean): void {
  urgentDecisions.delete(taskId);
  urgentDecisions.set(taskId, urgent);
  if (urgentDecisions.size > 32) urgentDecisions.delete(urgentDecisions.keys().next().value as string);
}

export const urgentDecision = (taskId: string): boolean => urgentDecisions.get(taskId) === true;

/** A hostile this near makes a step urgent (a creeper a little farther: its blast reaches about 7 m). */
export const LLMC_URGENT_NEAR_METERS = 8;

export const CREEPER_URGENT_METERS = 10;

/** Health at or below this with a hostile within 16 m makes a step urgent (the body's own flight starts at 8). */
export const LOW_HEALTH = 8;

/**
 * Why a step is urgent now, or none (r3; run 27: the step after a creeper stopped her act at 3.9 m took 12.8 s,
 * and the blast came
 * first): a hostile within 8 m (a creeper within 10), health 8 or less beside a hostile within 16, and the last
 * act cut by a reflex or by a
 * hostile (its `stopIf.hostileWithin`, or the head's urgent cut).
 */
export function urgentReasons(observation: BodyObservation | null, cut: string | null): string[] {
  return urgentFacts(observation, cut).reasons;
}

/** The skeleton's kin: they keep 7.5 to 15 m and shoot; a lone one is closed in on with a shield and a sword. */
const SKELETON_KIN = new Set(['skeleton', 'stray', 'bogged']);
/** How many blocks of a shield an arrow takes (its damage, about 3 to 4, plus one). */
const SHIELD_PER_ARROW = 4;
/** The most shooter lines an urgent step says. */
const SHOOTER_LINES = 2;
/**
 * Run 8 (11/13: skeletons shot her from 4.4 to 13 m for about 158 s; the urgent line named the nearest hostile alone, the body's
 * `closeInAdvised` was read nowhere, and the decisions after a stop took 5 to 10 s to a fight, or went round out of the line for 65 s): the
 * shooters that hit her in the last ten seconds (the blows' record, `by`), nearest first, two at most, each with the reach facts of its line
 * (`threatLine`), how many times it hit, how many arrows the shield still takes, and, when the body says a lone skeleton can be closed in on
 * (iron or a shield, a sword, health) and there is a way to it, that it can, with why and the fight that does it (an urgent decision reads the
 * standing 「離れる・間に置く」, and a skeleton shoots on within 15 m however she runs). The skeleton's kin only (the design's R1): a blaze's or a
 * ghast's hit from afar would make every decision at a spawner an urgent one; the other shooters keep the near hostile's line (8 m, in sight).
 */
function shooterLines(observation: BodyObservation | null, open: readonly NearThreat[], known: (threat: NearThreat) => ThreatSight | undefined,
  hits: readonly { by: string | null }[]): Array<{ id: number; text: string }> {
  const shots = new Map<number, number>();
  for (const hit of hits) {
    const id = /#(\d+)/u.exec(hit.by ?? '')?.[1];
    if (id) shots.set(Number(id), (shots.get(Number(id)) ?? 0) + 1);
  }
  if (!shots.size) return [];
  const shooters = open.filter(threat => threat.id !== null && SKELETON_KIN.has(threat.name) && shots.has(threat.id)).slice(0, SHOOTER_LINES);
  if (!shooters.length) return [];
  const facts = (observation?.facts ?? {}) as { closeInAdvised?: unknown };
  const worn = String((observation?.state.world as { worn?: unknown } | undefined)?.worn ?? '');
  const shieldLeft = /shield\(残り(\d+)\/\d+\)/u.exec(worn)?.[1];
  const shield = shieldLeft !== undefined ? `・盾 残り約 ${Math.floor(Number(shieldLeft) / SHIELD_PER_ARROW)} 本受けられる` : '';
  return shooters.map(threat => {
    const way = threat.canReachMe !== false && threat.reach !== 'walled' && Math.abs(threat.dy ?? 0) <= 3;
    const close = facts.closeInAdvised === true && shooters.length === 1 && way
      ? `・剣・防具（鉄 3 部位か盾）・体力 10 以上・射手は骸骨 1 体で、詰めて斬れる（離れても 15m の中は射たれ続ける。fight target=#${threat.id} range=16 seconds=15 を先に）` : '';
    return { id: threat.id!, text: `撃ってきた射手: ${shooterHead(threat, known(threat))}・${FACT_WINDOW_MS / 1000} 秒で ${shots.get(threat.id!)} 回当たった${shield}${close}` };
  });
}

/** A shooter's line: `threatLine` when the body's sight looked at it; else its id, distance, height and the body's own `canSee` (the id is what a fight names). */
function shooterHead(threat: NearThreat, sight: ThreatSight | undefined): string {
  if (sight) return threatLine(threat, sight);
  const height = threat.dy !== null && threat.dy !== 0 ? `・${threat.dy > 0 ? '上' : '下'} ${Math.abs(threat.dy)}` : '';
  return `${threat.name} #${threat.id} ${threat.distance.toFixed(1)}m${height}${threat.canSee === true ? '・見える（射線の中）' : ''}`;
}

/** How near a hostile makes a step urgent (a creeper a little farther). */
export const urgentMeters = (name: string) => (name === 'creeper' ? CREEPER_URGENT_METERS : LLMC_URGENT_NEAR_METERS);

/**
 * r7 (runs 29–31: 「blaze 4.0m」 first in the live state at almost every step, the blaze 2–6 up behind the bricks;
 * 3 of 3 runs fought
 * before the check): the reasons with what the body's sight found of each near hostile (`sights`, by id; none:
 * as r3 said them), and
 * the hostiles that can neither see her nor come (`walledOff`), which make no step urgent and are said after the plan's now
 * (`unreachable`). `inSight`: after a stopIf stop, that a hostile sees her where she stopped, said first (run 31).
 */
export function urgentFacts(
  observation: BodyObservation | null,
  cut: string | null,
  sights: ReadonlyMap<number, ThreatSight> | null = null,
  inSight: string | null = null,
  hits: readonly { by: string | null }[] = [],
): { reasons: string[]; unreachable: string[] } {
  const world = (observation?.state.world ?? {}) as { health?: unknown };
  const known = (threat: NearThreat) => (threat.id !== null ? sights?.get(threat.id) : undefined);
  const threats = nearThreats(observation),
    walled = threats.filter((threat) => walledOff(threat, known(threat)));
  const open = threats.filter((threat) => !walled.includes(threat));
  const reasons: string[] = inSight ? [inSight] : [];
  const near = open.find((item) => item.distance <= urgentRange(item, urgentMeters(item.name)));
  const shooting = shooterLines(observation, open, known, hits);
  if (near && !shooting.some(line => line.id === near.id)) reasons.push(`${threatLine(near, known(near))}${near.name === 'creeper' ? '（爆発は約7m まで届く）' : ''}`);
  reasons.push(...shooting.map(line => line.text));
  const health = typeof world.health === 'number' && Number.isFinite(world.health) ? world.health : null;
  if (health !== null && health <= LOW_HEALTH && open.some((item) => item.distance <= 16 && !calmEnderman(item)))
    reasons.push(`体力 ${Math.round(health * 10) / 10} で敵が近い`);
  if (cut) reasons.push(cut);
  // r10 (H2): while a multi-hand reflex holds the body, an urgent decision is told so first; its act is sent after
  // the reflex lets go.
  if (reasons.length) reasons.unshift(...reflexLines(observation));
  const unreachable = walled
    .filter((item) => item.distance <= urgentMeters(item.name))
    .slice(0, THREAT_SIGHT.max)
    .map((item) => threatLine(item, known(item)));
  return { reasons, unreachable };
}

/**
 * Why a result makes the next step urgent: a reflex or a hostile cut the act (r3). r7 (run 31: the health stop
 * at 8.7 left her standing
 * in the blaze's line, burning, and the next decision took 8 s): a stopIf on health too.
 */
/** Melee foes whose health a wooden or stone sword does not take down quickly (vanilla max health). */
const HEAVY_MELEE_FOES = new Map([['hoglin', 40], ['zoglin', 40], ['piglin_brute', 50]]);
const MELEE_FOES = new Set(['magma_cube', 'wither_skeleton', 'piglin_brute', 'hoglin', 'zoglin', 'zombie', 'husk', 'drowned']);

/**
 * A vertical down was refused for a missing `liquid`; the next decision had the refusal in its history and still stretched a bridge.
 * An act refused whole (`この act は全体を送っていない`, the body's words) is told at the head of the next input, as a fact with what is wrong, as
 * 「反射が止めた」 is for an urgent one. Null for any other result.
 */
export function notSentLine(text: string): string | null {
  if (!/この act は全体を送っていない/u.test(text)) return null;
  const wrong = (text.split(String.fromCharCode(10))[0] ?? '').replace(/\s+/gu, ' ').trim().slice(0, 240);
  return `前の act は送られていない（どの手も動いていない）: ${wrong}。足りない所だけ直した同じ手を出し直す（別の手に変えると、元の手は動かないまま）`;
}

export function cutOf(text: string, bodyReflex: boolean): string | null {
  if (/急ぎ: .+ が近づいたので act を止めた/u.test(text)) return '前の act は敵が近づいて止めた';
  if (bodyReflex) return '前の act は体の反射が止めた';
  if (/stopIf: hostileWithin/u.test(text)) {
    // end1109f19/f20: after a stop on a magma cube, Haiku re-sent the same go with accept [magma_cube] both times
    // (the DANGER line was far away); the next step is said here, beside the stop, for a melee foe.
    const foe = /stopIf: hostileWithin:([a-z_]+) #(\d+) ([\d.]+)m/u.exec(text);
    // 11/26 (four hoglins, a wooden sword): this line said "attack untilDead first" for a hoglin too, and Haiku leans on the
    // line beside the stop. A foe of 40〜50 health takes 10 blows of a wooden sword, so the count comes first here.
    const heavy = foe ? HEAVY_MELEE_FOES.get(foe[1]) : undefined;
    if (foe && heavy)
      return `前の act は stopIf（${foe[1]} #${foe[2]} ${foe[3]}m）で止まった。${foe[1]} は体力 ${heavy} で近接が強い（1 撃 3.5〜9）。`
        + `「打撃数」の行で倒すのに要る打撃を見る: 8 打撃を超える（木・石の剣）か、近くに同じ敵が 2 体以上なら斬り合わず、`
        + `その敵と逆の向きへ go で 16m 以上離れる（行き先や route の立ち位置が敵の側なら使わない）。`
        + `1 体だけで 8 打撃以内なら attack target=#${foe[2]} untilDead を先頭の手に（開けた所で）`;
    if (foe && MELEE_FOES.has(foe[1]))
      return `前の act は stopIf（${foe[1]} #${foe[2]} ${foe[3]}m）で止まった。近接敵なので accept に入れて横を通らない（歩く・掘る手が続いて殴られる）: `
        + `attack target=#${foe[2]} untilDead を先頭の手に（「押されたら落ちる」の無い開けた所で）、縁なら先に空所から離れる。`
        + '体も、4m 内の自分を狙う敵が 2 体まで・8m 内が 4 体までなら accept が無くても自分で倒す';
    return '前の act は stopIf（敵が近い）で止まった';
  }
  return /stopIf: hpBelow/u.test(text) ? '前の act は stopIf（体力）で止まった' : null;
}

/**
 * What happened to the body since the task's last decision that no tool result says (a reflex that took the
 * body, a death, a login, a new
 * dimension): told in the live state (`events`) once, and the reason a recall runs (design 2.3: recall only on an event).
 */
export function createLlmcEvents(taskId: string, now: () => number = Date.now) {
  const state = eventsOf(taskId);
  let shown: string[] = [],
    results: string[] = [],
    healthLost = 0,
    stops: string[] = [],
    since: string | undefined;
  const note = (line: string) => {
    state.seq += 1;
    state.lines.push({ seq: state.seq, line: line.slice(0, 200) });
    if (state.lines.length > 24) state.lines.splice(0, state.lines.length - 24);
  };
  return {
    note,
    /** A body that arrived (login, respawn, reconnection, another dimension) since the last look, by its arrival time and kind. */
    arrival(at: number | null, kind: string | null) {
      if (at === null || at === state.arrival) return;
      const first = state.arrival === null;
      state.arrival = at;
      if (!first || kind === 'death')
        note(kind === 'death' ? '死んでリスポーンした（持ち物を落とした所へ戻るか決める）' : `体が着いた: ${kind ?? '不明'}`);
    },
    /** A tool result: a reflex that cut it is an event; a failure makes the next decision worth a recall; a cut act
     * makes it urgent. */
    result(name: string, ok: boolean, bodyReflex: boolean, text = '') {
      if (bodyReflex) note(`反射が ${name} を止めた`);
      state.failed = !ok;
      if (name === MC_ACT_TOOL) {
        state.cut = cutOf(text, bodyReflex);
        state.notSent = ok ? null : notSentLine(text);
        state.stopIf = /（stopIf: /u.test(text);
      }
    },
    /** r7: whether the last act was stopped by its own stopIf. */
    stoppedByStopIf: () => state.stopIf,
    /** r3: a result's whole text the history keeps short, for the next decision's live state. */
    keep(text: string) {
      state.pending.push(text);
      if (state.pending.length > 6) state.pending.splice(0, state.pending.length - 6);
    },
    /**
     * At a decision's context: the events since the last one, now read, and the results to show once. r8, `again`:
     * the context of a
     * decision asked again after an interrupt is the same decision's, so what the first showed once is shown again.
     */
    take(health: number | null = null, again = false): string[] {
      if (again) return shown;
      shown = state.lines.filter((item) => item.seq > state.read).map((item) => item.line);
      state.read = state.seq;
      results = state.pending.splice(0);
      // The stuck go's sentence counts the stops at its place when it is read, after the stall watch has counted this
      // result; a line said twice is said once.
      stops = state.stops
        .splice(0)
        .map((entry) => (typeof entry === 'function' ? entry() : entry))
        .filter((line, index, all) => all.indexOf(line) === index);
      since = state.lastAt === null ? undefined : new Date(state.lastAt).toISOString();
      state.lastAt = now();
      healthLost = health !== null && state.health !== null ? Math.max(0, state.health - health) : 0;
      if (health !== null) state.health = health;
      return shown;
    },
    shown: () => shown,
    results: () => results,
    /** Chapter 8: where a go or a vertical of the results shown this once stopped (`stopFactsOf`); and the time of
     * the decision before this one (ISO), or undefined. */
    stops: () => stops,
    since: () => since,
    /** An act's result (the receipt's JSON) that came after the last decision: its stops are told with the next one. */
    noteStops(resultJson: string | undefined) {
      for (const line of stopFactLines(resultJson, (at) => sameSpotStops(taskId, at))) state.stops.push(line);
      if (state.stops.length > 4) state.stops.splice(0, state.stops.length - 4);
      state.stopCodes = [...state.stopCodes, ...stopCodesOf(resultJson)].slice(-STOP_CODES_KEPT);
    },
    /** The codes of the stopped hands read so far (newest last): the live state puts them beside the body's stop lines. */
    stopCodes: (): readonly StopCode[] => state.stopCodes,
    /** A known act result, once at queue settlement. A success/other outcome breaks a consecutive failure run. */
    noteFailures(resultJson: string | undefined, observation: BodyObservation | null, input: unknown) {
      state.structuredHandFacts = (readActResult(resultJson)?.lines ?? [])
        .map(line => line.do === 'fill' ? fillWords(line) : shieldRushWords(line)).filter(words => words.length).slice(-4).flat();
      const attempts = typedFailureAttemptsOf(resultJson, observation, input);
      state.typedFailures = attempts.length ? [...state.typedFailures, ...attempts].slice(-24) : [];
      state.typedFailureCount = Math.min(attempts.length, 24);
    },
    /** Latest result's facts, also for urgent/compressed inputs; candidate freshness is checked at use time. */
    failureFacts(observation: BodyObservation | null): string[] {
      const start = state.typedFailures.length - state.typedFailureCount;
      return [...state.structuredHandFacts, ...state.typedFailures.slice(start).slice(-4).flatMap((attempt, index, shown) => {
        const before = state.typedFailures.length - shown.length + index;
        return typedFailureLines(attempt, observation, state.typedFailures.slice(0, before));
      })];
    },
    healthLost: () => healthLost,
    /** Why the last result makes the next step urgent, or null. */
    cut: () => state.cut,
    /** The line for an act that was refused before it was sent, or null (the last act went, or was not refused). */
    notSent: () => state.notSent,
    trend: state.trend,
  };
}

export type LlmcEvents = ReturnType<typeof createLlmcEvents>;
