import { ACT_DESCRIPTION, ACT_MAX_HANDS, type ActHand, type ActInput, type ActPos } from './minecraftActContract.js';
import { handToLine, lineToHand, pos, readPos } from './minecraftActShortHands.js';

export { handToLine, lineToHand };

/**
 * `mc.act` の手の短い書き方（mb-llmc-cand、SHANNON_MINECRAFT_LLMC_V2）の契約。モデルは hands を 1 手 1 行の文字列の配列で書き、頭のコードが
 * 体へ送る前に今の JSON（`ActInput`）に直す（`expandShortAct`）。実走27〜34 の mc.act 499 件が往復で元と同じになることは試験で確かめる
 * （`minecraftActShort.test.ts`）。体の schema・結果（`ActResult`）は変えない。行の文法は `minecraftActShortHands.ts`。
 */

/** `expandShortAct` が、読めない行を入れて返す欄の名前（`llmcInputProblem` が 1 行の誤りにして返す）。 */
export const SHORT_HAND_ERROR_KEY = '書き方の誤り';

const SHORT_GRAMMAR = [
  'hands は手の文字列の配列（1 手 1 行。座標は x,y,z の整数、複数の座標・点は空白で続ける。行末に note="40字までの説明" を付けられる）:',
  'walk X,Y,Z（点を空白で続けると path）[sprint] [range=N]: 掘らない・置かない・段差1と泳ぎだけ。地図の外の遠い点は64mごとに区切って歩き、掘る所で止まる',
  'dig X,Y,Z ...（順に掘る。16マスまで）[tool=名] [exposeOk: 敵に見られても掘る] [takeOk: 村の物も掘る]'
    + ' [collect=false: 掘るだけで拾いに歩かない。階段・トンネルで石や土を掘り進む dig に付ける（付けないと拾い続けて満杯になる）。原木・鉱石など拾う物の dig には付けない。持ち物の空きは live の body.pack]',
  'place ブロック名 X,Y,Z ... [face=down] / pillarUp N [ブロック名]（真下に置きながら N 段登る）',
  'use 物 [X,Y,Z] [face=..] [target=#id]: バケツで汲む・注ぐ、火打ち金、ベッドで寝る、扉、エンダーアイを投げる（X,Y,Z 無し: 飛んだ方位と距離が返る）・枠にはめる（X,Y,Z と face）',
  'look X,Y,Z か look yaw=A pitch=B / jump N / sneak on|off / equip 物 [slot] / craft 物 [個数: 作業台が5m内に要る] / eat [物] / wait 秒（0.5〜30）',
  'attack 相手(#id か名前) [hold: その場で待って届いたら打つ・追わない] [seconds=N] [untilDead=false] / pickup [range=N] [target=..]',
  'どの手にも rel（その手を始める時の足のブロックからの差。x 東+・z 南+・y 上+）と onFail=continue|stop を付けられる。',
  '上に無い形は json {手の JSON} の 1 行。at・items は 1 つでも配列:',
  'json {"do":"furnace","at":[{"x":1,"y":2,"z":3}],"op":"put","item":"iron_ore","count":8,"fuel":"coal","fuelCount":2}（op=take で出来上がりを取る）',
  'json {"do":"chest","at":[{"x":1,"y":2,"z":3}],"op":"look|take|put|takeAll","items":[{"item":"coal","count":4}]}（chest は箱・樽だけ）',
  'json {"do":"drop","items":[{"item":"gold_ingot","count":1}],"target":"#12"}（その方へ投げる）',
  'json {"do":"shoot","target":"#12","item":"bow","charge":1,"n":3}（target の代わりに at も可）',
  'stopIf は文字列 "hostileWithin=8 hpBelow=10"（hungerBelow=N、blockChanged=X,Y,Z/X,Y,Z で見張るマス最大4 も可）、accept は戦うと決めた敵の種類の配列、'
    + 'why は act に 1 つ。',
].join('\n');

/** 先頭の 2 行（概要・体は自分で決めない）、短い書き方の文法、そのあとに ACT_DESCRIPTION の残り。 */
const KEPT = ACT_DESCRIPTION.split('\n').filter(line => !line.startsWith('手（do）と引数') && !line.startsWith('座標はブロックの整数')
  && !line.startsWith('形: why は act に 1 つ'));
export const SHORT_ACT_DESCRIPTION: string = [KEPT[0], KEPT[1], SHORT_GRAMMAR, ...KEPT.slice(2)].join('\n');

/** `mc.act` の短い書き方の入力 schema（API の道具の schema に使える範囲）。体の schema（ACT_INPUT_SCHEMA）に直した後で通る。 */
export const SHORT_ACT_INPUT_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['hands'],
  properties: {
    hands: { type: 'array', minItems: 1, maxItems: ACT_MAX_HANDS, items: { type: 'string', maxLength: 600 },
      description: '順に動かす手（1〜12、1 手 1 行）。見えている手はまとめて出す。' },
    why: { type: 'string', maxLength: 120, description: 'この手の組のねらい（短く）' },
    stopIf: { type: 'string', maxLength: 120, description: '例 "hostileWithin=8 hpBelow=10"' },
    accept: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 40 }, description: 'この act で戦うと決めた敵の種類（体はそれから逃げない）' },
  },
});

export interface ShortAct { why?: string; hands: string[]; stopIf?: string; accept?: string[] }

const STOP_KEYS = ['hostileWithin', 'hpBelow', 'hungerBelow'] as const;
function stopIfText(stopIf: NonNullable<ActInput['stopIf']>): string {
  const fields = stopIf as Record<string, unknown>;
  return Object.entries(fields).map(([key, value]) => key === 'blockChanged' && Array.isArray(value)
    ? `blockChanged=${(value as ActPos[]).map(pos).join('/')}` : `${key}=${String(value)}`).join(' ');
}
/** act 全体 → 短い書き方。 */
export function actToShort(input: ActInput): ShortAct {
  return { ...(input.why !== undefined ? { why: input.why } : {}), hands: input.hands.map(handToLine),
    ...(input.stopIf ? { stopIf: stopIfText(input.stopIf) } : {}), ...(input.accept?.length ? { accept: [...input.accept] } : {}) };
}

function stopIfOf(text: string, errors: string[]): Record<string, unknown> {
  const stopIf: Record<string, unknown> = {};
  for (const token of text.trim().split(/\s+/u).filter(Boolean)) {
    const [key = '', raw = ''] = token.split(/=(.*)/su);
    if (key === 'blockChanged') {
      const cells = raw.split('/').map(readPos);
      if (cells.length && cells.every(Boolean)) stopIf[key] = cells; else errors.push(`stopIf が読めない: ${token}`);
    } else if ((STOP_KEYS as readonly string[]).includes(key) && raw !== '' && Number.isFinite(Number(raw))) stopIf[key] = Number(raw);
    else errors.push(`stopIf が読めない: ${token}`);
  }
  return stopIf;
}
function handsOf(value: unknown, errors: string[]): ActHand[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split('\n') : [];
  if (!items.length) errors.push('hands が無い');
  const hands: ActHand[] = [];
  for (const item of items) {
    if (item && typeof item === 'object' && !Array.isArray(item)) hands.push(item as ActHand);
    else if (typeof item === 'string' && item.trim()) {
      const hand = lineToHand(item);
      if ('error' in hand) errors.push(hand.error); else hands.push(hand);
    }
  }
  return hands;
}
/** 短い書き方 → act。読めない行は errors に（act は読めた手だけ）。手が JSON のまま混じっていればそのまま通す。 */
export function shortToAct(input: unknown): { act: ActInput; errors: string[] } {
  const value = (input ?? {}) as { why?: unknown; hands?: unknown; stopIf?: unknown; accept?: unknown };
  const errors: string[] = [];
  const act: Record<string, unknown> = { hands: handsOf(value.hands, errors) };
  if (typeof value.why === 'string') act.why = value.why;
  if (typeof value.stopIf === 'string') act.stopIf = stopIfOf(value.stopIf, errors);
  else if (value.stopIf && typeof value.stopIf === 'object') act.stopIf = value.stopIf;
  if (Array.isArray(value.accept)) act.accept = value.accept.filter(item => typeof item === 'string');
  return { act: act as unknown as ActInput, errors };
}

/**
 * モデルの入力を今の JSON の act にする。`hands` が文字列を 1 つでも含む配列（か 1 つの文字列）なら短い書き方として直す（読めない行は
 * `SHORT_HAND_ERROR_KEY` の欄に入れて返す）。既に JSON の手だけなら入力をそのまま返す。
 */
export function expandShortAct(input: unknown): { input: unknown; errors: string[] } {
  const hands = (input as { hands?: unknown } | null)?.hands;
  const short = typeof hands === 'string' || (Array.isArray(hands) && hands.some(item => typeof item === 'string'));
  if (!short) return { input, errors: [] };
  const { act, errors } = shortToAct(input);
  return { input: errors.length ? { ...act, [SHORT_HAND_ERROR_KEY]: errors.join(' / ').slice(0, 200) } : act, errors };
}

/** `expandShortAct` が読めなかった行の 1 行の誤り、または null。 */
export function shortHandProblem(input: unknown): string | null {
  const text = input && typeof input === 'object' ? (input as Record<string, unknown>)[SHORT_HAND_ERROR_KEY] : undefined;
  return typeof text === 'string' ? `手の書き方が読めない: ${text}` : null;
}
