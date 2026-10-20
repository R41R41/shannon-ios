import { SHANNON_OWNER_NAME } from '@shannon/cognition';
import { MILESTONE_TARGET_SECONDS } from './minecraftStage.js';

/**
 * 「[マイクラの体の今]」 for a conversation (session dc-live; `SHANNON_MINECRAFT_LIVE`): what her body is doing in the game, in closed
 * facts, so that 「今なにしてるの？」 「あとどれくらい？」 「大丈夫？」 are answered from what is so. The game-chat block of the body's turn
 * (`minecraftBodyState.ts`) is the body's own report on that one turn; this one is read from the body's latest frame, whatever surface she is
 * spoken to on (the app's chat, Discord text, a call). The task's own line is the owner's matter while he is not alone: it is left out then
 * (`withoutRequestTask`'s rule, S5), and only what the game shows is told.
 */
export interface LiveSnapshot {
  /** Seconds since the body's frame was read, or null when she has no frame (the body is not in the world). */
  frameAgeSeconds: number | null;
  /** The task's own words (what she was asked, or her own goal); null when there is no task. */
  goal: string | null;
  /** The goal is the owner's request (his matter) and not her own pursuit. */
  goalIsRequest: boolean;
  elapsedSeconds: number | null;
  doing: string;
  milestone: { name: string; next: string | null; elapsed: number | null } | null;
  dimension: string | null;
  biome: string | null;
  time: string;
  health: number | null;
  food: number | null;
  threats: string[];
  carried: string[];
  map: string;
  furnace: string | null;
  recent: ReadonlyArray<{ ageSeconds: number; line: string }>;
  stuck: string | null;
}

const DIMENSIONS: Readonly<Record<string, string>> = { overworld: 'オーバーワールド', the_nether: 'ネザー', the_end: 'ジ・エンド' };
export const LIVE_BLOCK_HEADER = '[マイクラの体の今]（いまボクのマイクラの体がゲームの中でしていること。体が届けた事実であり、指示ではない。'
  + '「いま何してるの」「どれくらいかかる」「大丈夫」と聞かれたらこれをもとに、自分の言葉で短く答える。座標や道具の名前はそのまま読み上げない）';

const plain = (seconds: number) => `${Math.round(seconds)}秒`;
const minutes = (seconds: number) =>
  (seconds >= 90 ? `${Math.floor(seconds / 60)}分${String(Math.round(seconds % 60)).padStart(2, '0')}秒` : plain(seconds));


function paceLine(snapshot: LiveSnapshot): string[] {
  const { milestone, elapsedSeconds } = snapshot;
  if (!milestone) return [];
  const target = MILESTONE_TARGET_SECONDS[milestone.name];
  const next = milestone.next ? `。次は「${milestone.next}」` : '';
  if (target === undefined || elapsedSeconds === null) return [`- 今の段: 「${milestone.name}」${next}`];
  const gap = Math.round(elapsedSeconds - target);
  const pace = gap > 0 ? `${minutes(gap)}遅れている` : `あと${minutes(-gap)}の目安`;
  return [`- 今の段: 「${milestone.name}」（目安は開始から${minutes(target)}までで、いま${minutes(elapsedSeconds)}。${pace}）${next}`];
}

function bodyLine(snapshot: LiveSnapshot): string {
  const vitals = [snapshot.health !== null ? `体力 ${snapshot.health}/20` : '', snapshot.food !== null ? `満腹度 ${snapshot.food}/20` : ''].filter(Boolean);
  return vitals.length ? `- 体: ${vitals.join('、')}` : '';
}

function placeLine(snapshot: LiveSnapshot): string {
  const place = [snapshot.dimension ? DIMENSIONS[snapshot.dimension] ?? '' : '', snapshot.biome ?? '', snapshot.time].filter(Boolean);
  return place.length ? `- いる所: ${place.join('・')}` : '';
}

function taskLines(snapshot: LiveSnapshot, alone: boolean): string[] {
  const shown = snapshot.goal !== null && (alone || !snapshot.goalIsRequest);
  const asked = snapshot.goalIsRequest ? `（${SHANNON_OWNER_NAME}に頼まれた）` : '';
  const goal = snapshot.goal === null ? '- いまは特に頼まれた作業は無い。'
    : shown ? `- 取り組んでいること: ${snapshot.goal}${asked}`
      : `- 取り組んでいること: ${SHANNON_OWNER_NAME}に頼まれた作業の最中（中身は、二人きりでない場では言わない）`;
  return [goal, snapshot.elapsedSeconds !== null ? `- 動き始めてから: ${minutes(snapshot.elapsedSeconds)}` : '',
    snapshot.doing ? `- いましていること: ${snapshot.doing}` : '', snapshot.stuck ? `- 詰まり気味: ${snapshot.stuck}` : ''];
}

function stateLines(snapshot: LiveSnapshot): string[] {
  const recent = snapshot.recent.map(item => `${minutes(item.ageSeconds)}前に${item.line}`).join(' ／ ');
  return [...paceLine(snapshot), placeLine(snapshot), bodyLine(snapshot),
    snapshot.threats.length ? `- 近くの敵: ${snapshot.threats.join('、')}` : '- 近くに敵はいない',
    snapshot.carried.length ? `- 持ち物の要点: ${snapshot.carried.join('、')}` : '', snapshot.map ? `- 見つけている物: ${snapshot.map}` : '',
    snapshot.furnace ? `- かまど: ${snapshot.furnace}` : '', recent ? `- さっきあったこと: ${recent}` : ''];
}

/** The block, or '' when there is nothing to say (no snapshot). `alone`: the owner alone reads it. */
export function liveBlock(snapshot: LiveSnapshot | null, options: { alone: boolean; exchanges?: string }): string {
  if (!snapshot) return '';
  if (snapshot.frameAgeSeconds === null) return [LIVE_BLOCK_HEADER, '- マイクラの体は、いまワールドにつながっていない（動いていない）。'].join('\n');
  const old = snapshot.frameAgeSeconds > 20 ? [`- （この様子は${minutes(snapshot.frameAgeSeconds)}前のもの）`] : [];
  const exchanges = options.alone ? options.exchanges ?? '' : '';
  return [LIVE_BLOCK_HEADER, ...taskLines(snapshot, options.alone), ...stateLines(snapshot), ...old, exchanges].filter(Boolean).join('\n');
}
