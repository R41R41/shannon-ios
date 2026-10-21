import { MILESTONES, MILESTONE_TARGET_SECONDS, milestoneTargetSeconds } from './minecraftStage.js';
import { lineEntries, mapText, partEntries, positionOf, type MapEntry } from './minecraftMapRead.js';
import { woodAdvice } from './minecraftWoodAdvice.js';

/**
 * Her route to the Nether, planned once by a strong model (owner 2026-10-20: 「30分でスムーズにネザーに行くために…どれだけ大規模な改修
 * になっても良い」; the route stays iron armour → diamond pickaxe → obsidian → gate). From where she spawned and what the body knows of
 * the land around it (`world.mapSummary`, `rememberedPlaces`, `biomesSeen`): which place serves each step (a village's beds, bread and
 * smith's chest, a cave for iron, a lava pool for the obsidian, a ruined portal), in the owner's order, with a time for each. Planned
 * at the task's first decision and again only when a step is late by `lateSeconds` (at most `replans` times, `minGapSeconds` apart):
 * the strong model is asked rarely, and its answer is shown at every decision as fixed lines (`routeLines`). Pure: the call itself is
 * the wiring's (`minecraftRouteWiring.ts`), and nothing here touches the body.
 */
export const ROUTE_PLAN = Object.freeze({ lateSeconds: 240, minGapSeconds: 300, replans: 2, legs: 8, inputCharacters: 6_000, giveUpMs: 90_000, asks: 4 });

export interface RouteLeg { milestone: string; goal: string; where: string; x?: number; y?: number; z?: number; targetSeconds: number }
export interface MinecraftRoute { legs: readonly RouteLeg[]; plannedAtSeconds: number; replans: number; reason: 'start' | 'late' }

/** The steps of the owner's order a leg may name: the overworld's, from the first wood to the Nether. */
const ROUTE_STEPS: readonly string[] = MILESTONES.map(milestone => milestone.name).filter(name => name in MILESTONE_TARGET_SECONDS);
const TEXT = (value: unknown, limit: number) => typeof value === 'string' ? value.replace(/[\r\n\t]+/gu, ' ').trim().slice(0, limit) : '';
const record = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const coordinate = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 30_000_000 ? value : undefined;

/** The answer's shape (the background route's supported subset of JSON schema). */
export const ROUTE_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['legs'],
  properties: {
    legs: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['milestone', 'goal', 'where', 'targetSeconds'],
      properties: { milestone: { type: 'string', enum: ROUTE_STEPS }, goal: { type: 'string' }, where: { type: 'string' },
        x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' }, targetSeconds: { type: 'integer' } } } },
  },
});

/** The fixed instructions: the order is the owner's, the places and times are the planner's. */
export const ROUTE_SYSTEM = [
  'あなたはマイクラの体を動かすシャノンの、ルートを立てる係。目標は、タスク開始から30分（1,800秒）以内にネザーへ入ること。',
  '節目の順番は変えない: 木 → 木と石のツルハシ → 石の斧 → 木材 → 食料と羊とベッド → 鉄 → バケツ → 鉄の全身の防具 → ダイヤ → 黒曜石 → ゲート → ネザー。',
  'それぞれの節目を、どの場所で済ませるかを決める。地図の要約・場所の記憶・通ったバイオームにある物だけを使い、無い物を作り出さない。',
  '使える出どころ: 村（家のベッド・パン・干し草・鍛冶屋の箱の鉄と黒曜石）、荒廃したポータル（枠の黒曜石・箱の火打ち金や金）、'
    + '洞窟の入口（底へ歩いて下りられる。階段掘りより早い）と y=16 前後（鉄）、y=-58（ダイヤ）、溶岩の溜まり（水バケツで黒曜石）、砂利（火打石）、'
    + '置かれたベッド（壊せば持てる）。',
  '近い順にまとめ、行ったり来たりを減らす。羊の出ない所（雪原・荒野・砂漠・海・氷）では羊を探さず、村か草地へ向かう。防具を着ていれば夜は地下で掘り続ける。',
  '木: 砂漠・荒野・海・川・浜には木がほぼ無い。通ったバイオームに川や海があるだけで「川沿いの木」と決めない。入力の「木と木材の出どころ」に木が無い時、'
    + '最初の行（木）は、難破船・廃坑・村など木材の出どころが近ければそれ、無ければ木の生えるバイオーム（森・タイガ・ジャングル・サバンナ）の方角へ木を探しに出る、と書く。',
  'x・y・z は開始時の見立て。後で近くに見える候補（溶岩・鉱石）があればそちらが優先される。確かでない座標は入れない。',
  'legs は済ませる順に最大8つ。milestone は上の節目の名前。goal はそこでする事を30字以内、where は場所を30字以内（方角と距離）。分かる時だけ x・y・z を入れる。',
  'targetSeconds はタスク開始からの秒で、その節目を済ませる目安。下の既定の目安より遅くしない。',
].join('\n');

/** The input: where and when she is, what she carries, and what the body knows of the land (cut to `inputCharacters`). */
export function routeInput(world: Record<string, unknown>, elapsedSeconds: number, milestone: string | null): string {
  const inventory = (Array.isArray(world.inventory) ? world.inventory : []).slice(0, 40).map(item => {
    const stack = record(item);
    return stack ? `${TEXT(stack.name, 40)}×${Number(stack.count ?? 1)}` : TEXT(item, 40);
  }).filter(Boolean).join('、');
  const part = (label: string, value: unknown, limit: number) => {
    const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value);
    return text ? [`${label}: ${text.slice(0, limit)}`] : [];
  };
  return [
    `経過: ${Math.round(elapsedSeconds)}秒。今の節目: ${milestone ?? '不明'}。`,
    `既定の目安（秒）: ${ROUTE_STEPS.map(name => `${name} ${MILESTONE_TARGET_SECONDS[name]}`).join('、')}`,
    ...part('位置', world.position, 80), ...part('バイオーム', world.biome, 60), ...part('時刻', world.time, 20),
    ...part('持ち物', inventory, 800), ...part('木と木材の出どころ（地図に木の行が無ければ、木は見えていない）',
      hasMap(world) ? woodAdvice(world).lines.join(' ／ ') : '', 900),
    ...part('地図の要約', world.mapSummary, 3_000), ...part('場所の記憶', world.rememberedPlaces, 1_200), ...part('通ったバイオーム', world.biomesSeen, 600),
  ].join('\n').slice(0, ROUTE_PLAN.inputCharacters);
}

/** The planner's answer as a route, or null: only the order's steps, in the order's order, at most `legs`, each time no earlier than the default. */
export function routeFrom(answer: unknown, plannedAtSeconds: number, replans: number, reason: MinecraftRoute['reason']): MinecraftRoute | null {
  const legs = (Array.isArray(record(answer)?.legs) ? record(answer)!.legs as unknown[] : []).flatMap(item => {
    const leg = record(item), milestone = TEXT(leg?.milestone, 40);
    if (!leg || !ROUTE_STEPS.includes(milestone)) return [];
    // Never later than the owner's budget; a replan when late may give each step until a minute after it, never past the Nether's.
    const base = milestoneTargetSeconds(milestone)!, target = Number(leg.targetSeconds);
    const cap = reason === 'late' ? Math.min(MILESTONE_TARGET_SECONDS['ネザー']!, Math.max(base, plannedAtSeconds + 60)) : base;
    const [x, y, z] = [coordinate(leg.x), coordinate(leg.y), coordinate(leg.z)];
    return [{ milestone, goal: TEXT(leg.goal, 60), where: TEXT(leg.where, 60), ...(x !== undefined && y !== undefined && z !== undefined ? { x, y, z } : {}),
      targetSeconds: Number.isSafeInteger(target) && target > 0 ? Math.min(target, cap) : cap }];
  }).reduce<RouteLeg[]>((kept, leg) => !kept.length || ROUTE_STEPS.indexOf(leg.milestone) >= ROUTE_STEPS.indexOf(kept.at(-1)!.milestone)
    ? [...kept, leg] : kept, [])
    .slice(0, ROUTE_PLAN.legs);
  return legs.length ? { legs, plannedAtSeconds: Math.round(plannedAtSeconds), replans, reason } : null;
}

/** A route kept in the checkpoint (`minecraftRoute`), checked again as the planner's answer is. */
export function keptRoute(value: unknown): MinecraftRoute | null {
  const kept = record(value);
  if (!kept) return null;
  const reason = kept.reason === 'late' ? 'late' : 'start', replans = Number(kept.replans), at = Number(kept.plannedAtSeconds);
  return routeFrom(kept, Number.isFinite(at) && at >= 0 ? at : 0, Number.isSafeInteger(replans) && replans >= 0 ? replans : 0, reason);
}

/** Why a plan is asked now: none yet ('start'), or the step is late by `lateSeconds` with replans left and the last plan old enough. */
export function planWanted(route: MinecraftRoute | null, milestone: string | null, elapsedSeconds: number): MinecraftRoute['reason'] | null {
  if (!milestone || !(milestone in MILESTONE_TARGET_SECONDS) || !Number.isFinite(elapsedSeconds)) return null;
  if (!route) return 'start';
  const target = route.legs.find(leg => leg.milestone === milestone)?.targetSeconds ?? milestoneTargetSeconds(milestone)!;
  const late = elapsedSeconds - target >= ROUTE_PLAN.lateSeconds;
  return late && route.replans < ROUTE_PLAN.replans && elapsedSeconds - route.plannedAtSeconds >= ROUTE_PLAN.minGapSeconds ? 'late' : null;
}

/**
 * A leg's coordinates are the plan's guess at the start, not an order (mb-r24, Minecraft run 24: at the obsidian the line "溶岩の溜まりのそば
 * （-21,-55,128）" from the first minute was followed to a pool 76 m away while two were in sight at 20 m and 44 m; 111 s of digging, then
 * 180 s more). The place now in sight comes first; the plan's place is for when none is.
 */
export const ROUTE_COORDINATES_NOTE = 'ルートの座標は開始時の見立て（参考）。いま見えている近い候補（find-blocks の結果・地図の近い順）を先に使い、'
  + '座標へ向かうのは近くに無い時だけ。大きさ・覆いの分かる候補は、10個の黒曜石に足りる大きさのものを選ぶ';
/** The map's lines that tell, for a step, what is in sight: the head of the line and the label. */
const SIGHT: Readonly<Record<string, { head: string; part?: string; label: string }>> = Object.freeze({
  '黒曜石': { head: '溶岩の溜まり', label: '溶岩' }, 'ゲート': { head: '溶岩の溜まり', label: '溶岩' },
  'ダイヤ': { head: '鉱石', part: 'ダイヤ', label: 'ダイヤ' }, '鉄': { head: '鉱石', part: '鉄', label: '鉄' },
});

/** What the map shows in sight for a step, nearer to her than the leg's own place: the nearest two, with what the body says of each. */
function nearerCandidates(leg: RouteLeg, world: Record<string, unknown> | null | undefined): string {
  const sight = SIGHT[leg.milestone], here = positionOf(world), map = mapText(world?.mapSummary);
  if (!sight || !here || leg.x === undefined || leg.z === undefined || !map) return '';
  const away = Math.hypot(leg.x - here.x, leg.z - here.z);
  const found = sight.part ? partEntries(map, sight.head, sight.part) : lineEntries(map, sight.head);
  const near = found.filter(entry => entry.distance < away - 4).slice(0, 2);
  const words = (entry: MapEntry) => `${entry.distance}m ${entry.direction} (${entry.at.x},${entry.at.y},${entry.at.z})${entry.extra}`;
  return near.length ? `　←いま見える近い${sight.label}: ${near.map(words).join('、')}（座標は今から${Math.round(away)}m）` : '';
}

/**
 * The route as the decision carries it (`route`): one line a leg, the step now marked, with its time; the coordinates as the start's guess
 * (how far from here they lie, and the places in sight that are nearer), and, early on with no tree in sight, where wood may be.
 */
export function routeLines(route: MinecraftRoute, milestone: string | null, world?: Record<string, unknown> | null): string[] {
  const now = route.legs.findIndex(leg => leg.milestone === milestone), here = positionOf(world);
  const lines = route.legs.map((leg, index) => {
    const far = here && leg.x !== undefined && leg.z !== undefined ? `・今から${Math.round(Math.hypot(leg.x - here.x, leg.z - here.z))}m` : '';
    const at = leg.x !== undefined ? `（開始時の見立て ${leg.x},${leg.y},${leg.z}${far}）` : '';
    const mark = index === now ? '▶' : index < now ? '済' : '・', nearer = index === now ? nearerCandidates(leg, world) : '';
    return `${mark} ${leg.milestone}: ${leg.goal}／${leg.where}${at}／${leg.targetSeconds}秒まで${nearer}`;
  });
  return [`ルート（${route.reason === 'late' ? '遅れで立て直し' : '最初の計画'}、${route.plannedAtSeconds}秒）:`, ...lines,
    ...(route.legs.some(leg => leg.x !== undefined) ? [ROUTE_COORDINATES_NOTE] : []), ...woodLines(milestone, world)];
}
/** The steps of the wood: the line about where wood is shows only while one of them is the step now. */
const WOOD_STEPS: ReadonlySet<string> = new Set(['木', '木と石のツルハシ', '石の斧', '木材']);

/** Whether the body sends its map (or the biomes it has passed): without one, "no tree in sight" is not known. */
const hasMap = (world: Record<string, unknown> | null | undefined) => typeof world?.mapSummary === 'string' || typeof world?.biomesSeen === 'string';

/** Where wood is, while a step of the wood is the step now and no tree is in sight (also before the route is planned: the first 20 s). */
export function woodLines(milestone: string | null, world: Record<string, unknown> | null | undefined): string[] {
  const wood = milestone !== null && WOOD_STEPS.has(milestone) && hasMap(world) ? woodAdvice(world!) : null;
  return wood && !wood.trees ? wood.lines : [];
}


/** What one task's route planning holds, across the task's steps (each step makes its own `createRoutePlanning`). */
interface Pending { abort: AbortController; at: number; reason: MinecraftRoute['reason']; startedAt: number }
interface Slot { route: MinecraftRoute | null; asks: number; pending: Pending | null }
const slots = new Map<string, Slot>();

/** Newer by its replans, then by the time it was asked. */
const newer = (a: MinecraftRoute, b: MinecraftRoute) => a.replans > b.replans || (a.replans === b.replans && a.plannedAtSeconds > b.plannedAtSeconds);

function slotOf(taskId: string, route: MinecraftRoute | null, asks: number): Slot {
  let slot = slots.get(taskId);
  if (!slot) {
    slot = { route, asks, pending: null };
    slots.set(taskId, slot);
    if (slots.size > 32) slots.delete(slots.keys().next().value as string);
    return slot;
  }
  if (route && (!slot.route || newer(route, slot.route))) slot.route = route;
  slot.asks = Math.max(slot.asks, asks);
  return slot;
}

/** The route the task holds now, answered a moment ago or kept from earlier steps: what a procedure reads for a step's budget while it runs. */
export function liveRoute(taskId: string): MinecraftRoute | null {
  return slots.get(taskId)?.route ?? null;
}
/** For tests: no task holds a route or a request. */
export function forgetRoutes(): void {
  for (const slot of slots.values()) slot.pending?.abort.abort();
  slots.clear();
}

/**
 * One step's part of the route: the route the task holds (kept from earlier steps, or answered since), a plan asked at the first
 * context when one is wanted, and kept in the checkpoint. The answer is taken the moment it comes, in whatever step and in the middle
 * of a procedure: run 20 took it only at the close of the step that asked, so a route asked at the start read as 89, 186 and 191 s
 * late (the steps' lengths), the first procedure ran without it, and a late replan held a decision for 14 s at its close. A request
 * that is not answered goes on past the step; it ends when it answers, after `giveUpMs`, or when a stopped step closes.
 */
export function createRoutePlanning(parts: {
  kept: unknown; keptAsks?: unknown; planner?: (system: string, input: string, signal: AbortSignal) => Promise<unknown>;
  log(line: string): void; taskId: string;
}) {
  // Every ask counts, answered or not (a planner that keeps failing is not asked again at every step).
  const keptAsks = Number.isSafeInteger(Number(parts.keptAsks)) && Number(parts.keptAsks) > 0 ? Number(parts.keptAsks) : 0;
  const slot = slotOf(parts.taskId, keptRoute(parts.kept), keptAsks);
  const finish = (pending: Pending, answer: unknown) => {
    if (slot.pending !== pending) return;
    slot.pending = null;
    const replans = pending.reason === 'late' ? (slot.route?.replans ?? 0) + 1 : 0;
    const planned = answer === null || answer === undefined ? null : routeFrom(answer, pending.at, replans, pending.reason);
    const askedMs = Date.now() - pending.startedAt;
    try {
      parts.log(`Shannon Minecraft route ${planned ? 'planned' : 'missing'} task=${parts.taskId} legs=${planned?.legs.length ?? 0}`
        + ` reason=${pending.reason} askedMs=${askedMs}`);
    } catch { /* logging never fails a step */ }
    if (planned) slot.route = planned;
  };
  return {
    /** At the decision's context: starts a plan when one is wanted; the lines of the route held now. */
    context(world: Record<string, unknown> | null, milestone: string | null, elapsedSeconds: number): string[] {
      const route = slot.route;
      const reason = parts.planner && world && !slot.pending && slot.asks < ROUTE_PLAN.asks ? planWanted(route, milestone, elapsedSeconds) : null;
      if (reason) {
        let input: string;
        try { input = routeInput(world!, elapsedSeconds, milestone); } catch { return route ? routeLines(route, milestone, world) : []; }
        slot.asks += 1;
        const pending: Pending = { abort: new AbortController(), at: elapsedSeconds, reason, startedAt: Date.now() };
        slot.pending = pending;
        const timer = setTimeout(() => pending.abort.abort(), ROUTE_PLAN.giveUpMs);
        timer.unref?.();
        parts.planner!(ROUTE_SYSTEM, input, pending.abort.signal).then(answer => answer, () => null)
          .then(answer => finish(pending, pending.abort.signal.aborted ? null : answer)).finally(() => clearTimeout(timer));
        parts.log(`Shannon Minecraft route asked task=${parts.taskId} reason=${reason} at=${Math.round(elapsedSeconds)}`);
      }
      return slot.route ? routeLines(slot.route, milestone, world) : woodLines(milestone, world);
    },
    /** The decision's situation with the route's lines (`route`), asking a plan when one is wanted; the seconds come from the situation. */
    situate<T extends { milestoneName?: string | null; elapsedSeconds?: number | null }>(situation: T, world: unknown): T & { route?: readonly string[] } {
      const lines = this.context(record(world), situation.milestoneName ?? null, situation.elapsedSeconds ?? Number.NaN);
      return lines.length ? { ...situation, route: lines } : situation;
    },
    /**
     * At the step's close: nothing is waited for. A stopped step ends the request still out (the task is stopping); that ask is given
     * back (a request the task's stop cut off is no failed ask of the planner, and a task that goes on after a pause may ask again).
     */
    async close(stopped = false): Promise<void> {
      const pending = slot.pending;
      if (!stopped || !pending) return;
      pending.abort.abort();
      slot.asks = Math.max(0, slot.asks - 1);
      finish(pending, null);
    },
    checkpoint(): { minecraftRoute?: MinecraftRoute; minecraftRouteAsks?: number } {
      return { ...(slot.route ? { minecraftRoute: slot.route } : {}), ...(slot.asks ? { minecraftRouteAsks: slot.asks } : {}) };
    },
  };
}
