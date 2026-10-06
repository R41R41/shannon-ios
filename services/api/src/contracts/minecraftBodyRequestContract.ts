import { MINECRAFT_INTENT_GOAL_CHARACTERS } from '../surfaces/minecraft/minecraftIntent.js';

/**
 * Phase 4 of her Minecraft body (`docs/minecraft-body-contract.md`, "Requests"): the wire shapes of the request
 * queue that her tools and the owner's game-chat intent fill, and that the body claims, works on and reports.
 * Everything the body may send is closed: a phase and a short step label, an outcome, a reason code, and counts of
 * items gained. No free narrative from the body becomes her words.
 */
export const MINECRAFT_REQUEST_PATHS = Object.freeze({
  claim: '/v1/body/minecraft/claim',
  list: '/v1/body/minecraft/requests',
  progress: /^\/v1\/body\/minecraft\/requests\/([0-9a-f-]{36})\/progress$/u,
  report: /^\/v1\/body\/minecraft\/requests\/([0-9a-f-]{36})\/report$/u,
  cancel: /^\/v1\/body\/minecraft\/requests\/([0-9a-f-]{36})\/cancel$/u,
});

export const MINECRAFT_REQUEST_LIMITS = Object.freeze({
  goalCharacters: MINECRAFT_INTENT_GOAL_CHARACTERS,
  /** The body is present while its last claim (or progress) is at most this old. */
  presenceMilliseconds: 40_000,
  claimMaximumWaitSeconds: 25,
  /** A claimed request is the body's for this long; every claim that names it as held, and every progress, renews it. */
  leaseSeconds: 90,
  /** A request nobody claimed in this time is closed as expired. */
  queuedMinutes: 30,
  /** However often it is renewed, a request open longer than this is closed as expired. */
  openMinutes: 120,
  /** The same dedupe key within this time is a retry of the same request. */
  retryMinutes: 10,
  /** Open requests (queued, claimed or running) at once. */
  open: 5,
  /** Ids the body may name as held in one claim. */
  holding: 4,
  stepCharacters: 80,
  gainedItems: 6,
  itemCount: 100_000,
  /** Finished requests reach her next turns with the owner for this long. */
  contextHours: 12,
  contextRequests: 5,
  /** Rows are kept this long after they finish. */
  keepDays: 30,
  /** Requests a minute from one device on the body's routes (each long-poll claim is one). */
  requestsPerMinute: 240,
});

export const MINECRAFT_REQUEST_STATES = ['queued', 'claimed', 'running', 'done', 'failed', 'cancelled', 'expired'] as const;
export type MinecraftRequestState = typeof MINECRAFT_REQUEST_STATES[number];
export const OPEN_REQUEST_STATES: readonly MinecraftRequestState[] = Object.freeze(['queued', 'claimed', 'running']);

/** Where a request came from. `minecraft`: the owner's own game chat (the turn's intent). */
export const MINECRAFT_REQUEST_SURFACES = ['text', 'voice', 'minecraft'] as const;
export type MinecraftRequestSurface = typeof MINECRAFT_REQUEST_SURFACES[number];

/** `accepted`: the body took it into its own task list. `started`: it is working on it now. `working`: a later step. */
export const MINECRAFT_PROGRESS_PHASES = ['accepted', 'started', 'working'] as const;
export type MinecraftProgressPhase = typeof MINECRAFT_PROGRESS_PHASES[number];

export const MINECRAFT_REPORT_OUTCOMES = ['done', 'failed', 'stopped'] as const;
export type MinecraftReportOutcome = typeof MINECRAFT_REPORT_OUTCOMES[number];

/** Why a request failed or stopped, in her words. Anything else is refused. */
export const MINECRAFT_REPORT_CODES: Readonly<Record<string, string>> = Object.freeze({
  gave_up: 'うまく進められず、途中で手を止めた',
  died: '途中で体が死んだ',
  error: '体の中でエラーが起きた',
  timeout: '時間がかかりすぎた',
  queue_full: '体の頼みごとがいっぱいだった',
  run_over: '体が動ける時間が終わった',
  cancelled: '止めるように言われた',
  unsupported: '体にはできないことだった',
  unknown: '理由は分からない',
});
export type MinecraftReportCode = keyof typeof MINECRAFT_REPORT_CODES;

export interface MinecraftGainedItem { item: string; count: number }

export interface MinecraftRequestOrigin {
  surface: MinecraftRequestSurface;
  /** The Talk (or the platform thread of game chat) it was asked in. Never sent to the body. */
  threadId?: string;
  /** The game-chat turn (`mc:<requestId>`) it came from. */
  messageId?: string;
}

export interface MinecraftRequestProgress { phase: MinecraftProgressPhase; step?: string; at: string }
export interface MinecraftRequestResult { outcome: MinecraftReportOutcome; code?: MinecraftReportCode; gained: readonly MinecraftGainedItem[] }

/** A request as the owner's side and her tools see it. */
export interface MinecraftRequestView {
  id: string;
  goal: string;
  state: MinecraftRequestState;
  origin: MinecraftRequestOrigin;
  createdAt: string;
  updatedAt: string;
  claimedAt?: string;
  finishedAt?: string;
  cancelRequested: boolean;
  progress?: MinecraftRequestProgress;
  result?: MinecraftRequestResult;
}

/** What the claiming body is handed: the goal and where it came from, nothing of the conversation. */
export interface ClaimedMinecraftRequest {
  id: string;
  goal: string;
  surface: MinecraftRequestSurface;
  createdAt: string;
  leaseExpiresAt: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** `minecraft:oak_log` or `oak_log`; kept without the namespace. */
const ITEM = /^(?:minecraft:)?([a-z0-9_]{1,64})$/u;

/** One line of plain text: control characters become spaces, the rest is cut to the maximum. Empty when nothing is left. */
export function plainLine(value: string, maximum: number): string {
  const line = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
  return line.length > maximum ? line.slice(0, maximum) : line;
}

/** A goal as she wrote it (a tool call or the intent of a game-chat turn), or null. */
export function requestGoal(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const goal = plainLine(value, MINECRAFT_REQUEST_LIMITS.goalCharacters);
  return goal ? goal : null;
}

export function validClaim(body: Record<string, unknown>): { waitSeconds: number; holding: string[] } | string {
  const unknown = Object.keys(body).find(key => !['scopeKey', 'waitSeconds', 'holding'].includes(key));
  if (unknown) return `${unknown.slice(0, 40)} is not allowed`;
  const { waitSeconds, holding } = body;
  if (waitSeconds !== undefined && (typeof waitSeconds !== 'number' || !Number.isInteger(waitSeconds) || waitSeconds < 0
    || waitSeconds > MINECRAFT_REQUEST_LIMITS.claimMaximumWaitSeconds)) return 'waitSeconds is invalid';
  if (holding !== undefined && (!Array.isArray(holding) || holding.length > MINECRAFT_REQUEST_LIMITS.holding
    || holding.some(id => typeof id !== 'string' || !UUID.test(id)))) return 'holding is invalid';
  return { waitSeconds: waitSeconds ?? 0, holding: [...new Set((holding as string[] | undefined) ?? [])] };
}

export function validProgress(body: Record<string, unknown>): { phase: MinecraftProgressPhase; step?: string } | string {
  const unknown = Object.keys(body).find(key => !['scopeKey', 'phase', 'step'].includes(key));
  if (unknown) return `${unknown.slice(0, 40)} is not allowed`;
  if (!MINECRAFT_PROGRESS_PHASES.includes(body.phase as MinecraftProgressPhase)) return 'phase is invalid';
  if (body.step !== undefined && (typeof body.step !== 'string' || body.step.length > MINECRAFT_REQUEST_LIMITS.stepCharacters * 2)) return 'step is invalid';
  const step = typeof body.step === 'string' ? plainLine(body.step, MINECRAFT_REQUEST_LIMITS.stepCharacters) : '';
  return { phase: body.phase as MinecraftProgressPhase, ...(step ? { step } : {}) };
}

export function validReport(body: Record<string, unknown>): Omit<MinecraftRequestResult, 'gained'> & { gained: MinecraftGainedItem[] } | string {
  const unknown = Object.keys(body).find(key => !['scopeKey', 'outcome', 'code', 'gained'].includes(key));
  if (unknown) return `${unknown.slice(0, 40)} is not allowed`;
  if (!MINECRAFT_REPORT_OUTCOMES.includes(body.outcome as MinecraftReportOutcome)) return 'outcome is invalid';
  if (body.code !== undefined && (typeof body.code !== 'string' || !Object.hasOwn(MINECRAFT_REPORT_CODES, body.code))) return 'code is invalid';
  const gained: MinecraftGainedItem[] = [];
  if (body.gained !== undefined) {
    if (!Array.isArray(body.gained) || body.gained.length > MINECRAFT_REQUEST_LIMITS.gainedItems) return 'gained is invalid';
    for (const entry of body.gained) {
      if (!isRecord(entry) || Object.keys(entry).some(key => key !== 'item' && key !== 'count')) return 'gained is invalid';
      const item = typeof entry.item === 'string' ? ITEM.exec(entry.item)?.[1] : undefined;
      if (!item || typeof entry.count !== 'number' || !Number.isInteger(entry.count) || entry.count < 1 || entry.count > MINECRAFT_REQUEST_LIMITS.itemCount) return 'gained is invalid';
      if (!gained.some(known => known.item === item)) gained.push({ item, count: entry.count });
    }
  }
  const outcome = body.outcome as MinecraftReportOutcome;
  // A code says why it did not get done; with `done` it is dropped.
  const code = outcome === 'done' ? undefined : (body.code as MinecraftReportCode | undefined) ?? (outcome === 'stopped' ? 'cancelled' : 'unknown');
  return { outcome, ...(code ? { code } : {}), gained };
}

/** Common items in her words; any other item is named by its id (`torch`). */
const ITEM_WORDS: Readonly<Record<string, string>> = Object.freeze({
  oak_log: 'オークの原木', spruce_log: 'トウヒの原木', birch_log: 'シラカバの原木', jungle_log: 'ジャングルの原木', acacia_log: 'アカシアの原木',
  dark_oak_log: 'ダークオークの原木', mangrove_log: 'マングローブの原木', cherry_log: 'サクラの原木', pale_oak_log: 'ペールオークの原木',
  oak_planks: 'オークの板材', spruce_planks: 'トウヒの板材', birch_planks: 'シラカバの板材', stick: '棒', crafting_table: '作業台',
  cobblestone: '丸石', stone: '石', dirt: '土', sand: '砂', gravel: '砂利', coal: '石炭', charcoal: '木炭', raw_iron: '鉄の原石',
  iron_ingot: '鉄インゴット', raw_copper: '銅の原石', copper_ingot: '銅インゴット', raw_gold: '金の原石', gold_ingot: '金インゴット',
  diamond: 'ダイヤモンド', emerald: 'エメラルド', redstone: 'レッドストーン', lapis_lazuli: 'ラピスラズリ', flint: '火打石',
  wheat: '小麦', wheat_seeds: '小麦の種', bread: 'パン', apple: 'リンゴ', carrot: 'ニンジン', potato: 'ジャガイモ', baked_potato: 'ベイクドポテト',
  beef: '生の牛肉', cooked_beef: 'ステーキ', porkchop: '生の豚肉', cooked_porkchop: '焼き豚', chicken: '生の鶏肉', cooked_chicken: '焼き鳥',
  mutton: '生の羊肉', cooked_mutton: '焼き羊肉', cod: '生のタラ', salmon: '生のサケ', white_wool: '白色の羊毛', leather: '革', torch: '松明',
  furnace: 'かまど', chest: 'チェスト', glass: 'ガラス', obsidian: '黒曜石', blaze_rod: 'ブレイズロッド', ender_pearl: 'エンダーパール',
  string: '糸', bone: '骨', arrow: '矢', gunpowder: '火薬', sugar_cane: 'サトウキビ', bucket: 'バケツ', water_bucket: '水入りバケツ',
});

export function gainedWords(gained: readonly MinecraftGainedItem[]): string {
  return gained.map(entry => `${ITEM_WORDS[entry.item] ?? entry.item} ${entry.count}個`).join('、');
}
