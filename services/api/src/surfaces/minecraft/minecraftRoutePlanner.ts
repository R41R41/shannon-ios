import { MILESTONES, MILESTONE_TARGET_SECONDS, milestoneTargetSeconds } from './minecraftStage.js';

/**
 * Her route to the Nether, planned once by a strong model (owner 2026-10-20: 「30分でスムーズにネザーに行くために…どれだけ大規模な改修
 * になっても良い」; the route stays iron armour → diamond pickaxe → obsidian → gate). From where she spawned and what the body knows of
 * the land around it (`world.mapSummary`, `rememberedPlaces`, `biomesSeen`): which place serves each step (a village's beds, bread and
 * smith's chest, a cave for iron, a lava pool for the obsidian, a ruined portal), in the owner's order, with a time for each. Planned
 * at the task's first decision and again only when a step is late by `lateSeconds` (at most `replans` times, `minGapSeconds` apart):
 * the strong model is asked rarely, and its answer is shown at every decision as fixed lines (`routeLines`). Pure: the call itself is
 * the wiring's (`minecraftRouteWiring.ts`), and nothing here touches the body.
 */
export const ROUTE_PLAN = Object.freeze({ lateSeconds: 240, minGapSeconds: 300, replans: 2, legs: 8, inputCharacters: 6_000, waitMs: 30_000, asks: 4 });

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
    + '洞窟と y=16 前後（鉄）、y=-58（ダイヤ）、溶岩の溜まり（水バケツで黒曜石）、砂利（火打石）、置かれたベッド（壊せば持てる）。',
  '近い順にまとめ、行ったり来たりを減らす。羊の出ない所（雪原・荒野・砂漠・海・氷）では羊を探さず、村か草地へ向かう。防具を着ていれば夜は地下で掘り続ける。',
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
    ...part('持ち物', inventory, 800), ...part('地図の要約', world.mapSummary, 3_000), ...part('場所の記憶', world.rememberedPlaces, 1_200),
    ...part('通ったバイオーム', world.biomesSeen, 600),
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

/** The route as the decision carries it (`route`): one line a leg, the step now marked, with its time. */
export function routeLines(route: MinecraftRoute, milestone: string | null): string[] {
  const now = route.legs.findIndex(leg => leg.milestone === milestone);
  return [`ルート（${route.reason === 'late' ? '遅れで立て直し' : '最初の計画'}、${route.plannedAtSeconds}秒）:`, ...route.legs.map((leg, index) => {
    const at = leg.x !== undefined ? `（${leg.x},${leg.y},${leg.z}）` : '';
    return `${index === now ? '▶' : index < now ? '済' : '・'} ${leg.milestone}: ${leg.goal}／${leg.where}${at}／${leg.targetSeconds}秒まで`;
  })];
}

/**
 * One step's part of the route: the route kept from earlier steps, a plan asked at the first context when one is wanted (never
 * waited for by the decision), taken at the step's close within `waitMs` of its start, and kept in the checkpoint.
 */
export function createRoutePlanning(parts: {
  kept: unknown; keptAsks?: unknown; planner?: (system: string, input: string, signal: AbortSignal) => Promise<unknown>;
  log(line: string): void; taskId: string;
}) {
  let route = keptRoute(parts.kept), pending: { promise: Promise<unknown>; at: number; reason: MinecraftRoute['reason']; startedAt: number } | null = null;
  // Every ask counts, answered or not (a planner that keeps failing is not asked again at every step).
  let asks = Number.isSafeInteger(Number(parts.keptAsks)) && Number(parts.keptAsks) > 0 ? Number(parts.keptAsks) : 0;
  const abort = new AbortController();
  return {
    /** At the decision's context: starts a plan when one is wanted; the lines of the route held now. */
    context(world: Record<string, unknown> | null, milestone: string | null, elapsedSeconds: number): string[] {
      const reason = parts.planner && world && !pending && asks < ROUTE_PLAN.asks ? planWanted(route, milestone, elapsedSeconds) : null;
      if (reason) {
        let input: string;
        try { input = routeInput(world!, elapsedSeconds, milestone); } catch { return route ? routeLines(route, milestone) : []; }
        asks += 1;
        pending = { promise: parts.planner!(ROUTE_SYSTEM, input, abort.signal).catch(() => null), at: elapsedSeconds, reason, startedAt: Date.now() };
        parts.log(`Shannon Minecraft route asked task=${parts.taskId} reason=${reason} at=${Math.round(elapsedSeconds)}`);
      }
      return route ? routeLines(route, milestone) : [];
    },
    /** The decision's situation with the route's lines (`route`), asking a plan when one is wanted; the seconds come from the situation. */
    situate<T extends { milestoneName?: string | null; elapsedSeconds?: number | null }>(situation: T, world: unknown): T & { route?: readonly string[] } {
      const lines = this.context(record(world), situation.milestoneName ?? null, situation.elapsedSeconds ?? Number.NaN);
      return lines.length ? { ...situation, route: lines } : situation;
    },
    /** At the step's close: the plan asked in this step, if it came within `waitMs` of being asked; a stopped step does not wait. */
    async close(stopped = false): Promise<void> {
      if (!pending) return;
      const left = stopped ? 0 : Math.max(0, ROUTE_PLAN.waitMs - (Date.now() - pending.startedAt));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), left); });
      const answer = await Promise.race([pending.promise, late]).finally(() => clearTimeout(timer));
      if (answer === null) abort.abort();
      const replans = pending.reason === 'late' ? (route?.replans ?? 0) + 1 : 0;
      const planned = answer === null ? null : routeFrom(answer, pending.at, replans, pending.reason);
      parts.log(`Shannon Minecraft route ${planned ? 'planned' : 'missing'} task=${parts.taskId} legs=${planned?.legs.length ?? 0}`);
      if (planned) route = planned;
      pending = null;
    },
    checkpoint(): { minecraftRoute?: MinecraftRoute; minecraftRouteAsks?: number } {
      return { ...(route ? { minecraftRoute: route } : {}), ...(asks ? { minecraftRouteAsks: asks } : {}) };
    },
  };
}
