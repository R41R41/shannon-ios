import { ACT_MAX_HANDS, type ActHand, type ActInput, type ActPos } from './minecraftActContract.js';
import { handToLine, lineToHand, pos, readPos } from './minecraftActShortHands.js';

export { handToLine, lineToHand };

/**
 * `mc.act` の手の短い書き方（mb-llmc-cand、SHANNON_MINECRAFT_LLMC_V2）の契約。モデルは hands を 1 手 1 行の文字列の配列で書き、頭のコードが
 * 体へ送る前に今の JSON（`ActInput`）に直す（`expandShortAct`）。実走27〜34 の mc.act 499 件が往復で元と同じになることは試験で確かめる
 * （`minecraftActShort.test.ts`）。体の schema・結果（`ActResult`）は変えない。行の文法は `minecraftActShortHands.ts`。
 */

/** `expandShortAct` が、読めない行を入れて返す欄の名前（`llmcInputProblem` が 1 行の誤りにして返す）。 */
export const SHORT_HAND_ERROR_KEY = '書き方の誤り';

/**
 * mb-llmc-cand 10 (D3, 「一つの話題は一か所」): the hands' grammar and what each hand needs are here, and only here (the instructions keep the principles of
 * deciding): the line forms, the json fields of each hand (run 37: `walk` written with `at` was refused, the field is `to` or `path`), the rules of
 * place, dig and use, how a stop is read. Ends with the cut-offs (stopIf, accept, onFail). `ACT_DESCRIPTION` (the json hands, for the old modes) is untouched.
 */
const SHORT_LINES = [
  '体に小さな手を最大12個まとめて頼む。体は順に動かし、手ごとに思ったとおりか確かめ、外れたら（失敗・反射・stopIf・満杯）そこで止めて、'
    + '手ごとの1行と止まった所の周りを返す。',
  '体は自分で決めない: 回り道・置き場所・道具作り・片づけ・睡眠・戦うかどうかは、あなたが地図と状態を見て手で出す。',
  '',
  '## 書き方',
  '- hands は手の文字列の配列（1 手 1 行）。座標は x,y,z の整数。複数の座標・点は空白で続ける。行末に note="40字までの説明" を付けられる。',
  '- 座標は、rel を付けない限り、すべて世界の絶対座標（live の完全な座標をそのまま写す）。小さな数（-1,0,0 など）を rel 無しで書くと、世界の原点の近くを指す。',
  '- 足からの差で書きたい手は rel を付ける（その手を始める時の足のブロックから。x 東+・z 南+・y 上+）。例（足が 230,-54,197 の時）:',
  '  dig 230,-54,196      ← 絶対座標（足の北隣）。  dig 0,0,-1 rel      ← 同じマスを足からの差で。  walk 3,0,0 rel      ← 足の 3 マス東へ。',
  '- どの手にも onFail=continue|stop を付けられる。',
  '- 1 行で書けない形は json {手の JSON} の 1 行。at・items・path は 1 つでも配列。使える欄は手ごとに決まっていて（下の「json の欄」）、'
    + '違う欄の名前を書くとその手は断られる（例: walk に at は使えない。to か path）。',
  '- why は act に 1 つ（手の中には書かない）。',
  '',
  '## 手',
  'walk X,Y,Z [X,Y,Z ...] [sprint] [range=N]',
  '  歩く。掘らない・置かない・段差1と泳ぎだけ（点を空白で続けると path。32点まで）。range は的から何 m で着いたことにするか。',
  '  40m 以上先は地図の外の座標を渡してよい（64m ごとに区切って歩き、掘る所で止まる）。',
  '  ポータル（p・e）へは、そのマスを最後の点にして range=0 で入る。',
  'dig X,Y,Z ... [tool=名] [exposeOk] [takeOk] [collect=false]',
  '  順に掘る（1 手に16マスまで書ける）。素手は tool=hand。around が「掘る (x,y,z)」と名指ししたマスは全部 dig してから walk する（頭のマスを掘り残すと着かない）。',
  '  届くのは目から5m以内のマス: トンネルや階段は5mずつ（掘る→歩いて進む→掘る）の手の列にする。16マスを一度に掘ると、奥は手が届かず止まる。',
  '  exposeOk: 敵に見られても掘る。takeOk: 村の物も掘る。',
  '  collect=false: 掘るだけで拾いに歩かない。階段・トンネルで石や土を掘り進む dig に付ける（付けないと拾い続けて満杯になる）。'
    + '原木・鉱石など拾う物の dig には付けない。持ち物の空きは live の pack。',
  'place ブロック名 X,Y,Z ... [face=down] / pillarUp N [ブロック名]',
  '  place は空気（. か *）で、6面のどれかが固いマスへ。足と頭のマス・草花（,）・水・レール・ポータル・周りが全部空気の宙には置けない。',
  '  pillarUp は真下に置きながら N 段登る（縦穴を上る）。',
  'use 物 [X,Y,Z] [face=..] [target=#id]',
  '  バケツで汲む・注ぐ、火打ち金、ベッドで寝る（夜か雷雨の時だけ。昼は寝られない。ネザー・エンドでは爆発する）、扉、エンダーアイを投げる（X,Y,Z 無し: 飛んだ方位と距離が返る）・枠にはめる（X,Y,Z と face）。',
  '  use・furnace・chest は目からそのマスの面が見える所で。間に固いブロックがあれば先に dig する（石1枚の向こうの水は、その石を dig してから use bucket）。',
  'craft 物 [個数]',
  '  2×2 で作れる物（板・棒・作業台・松明・火打ち金など）は作業台が要らない。3×3 の物（ツルハシ・剣・盾・かまど・バケツ・ハーフブロックなど）は作業台が5m内に要る。',
  'equip 物 [slot] / eat [物] / look X,Y,Z か look yaw=A pitch=B / jump N / sneak on|off / wait 秒（0.5〜30）',
  'drop 物 [数] [target=#id か X,Y,Z]  その方へ投げる。target も座標も無ければ体が水平に投げる（ピグリンへの金は target=#id）',
  'attack 相手(#id か名前) [hold] [seconds=N] [untilDead=false]  hold はその場で待って届いたら打つ（追わない）',
  'pickup [range=N] [target=..]',
  'furnace・chest・shoot は json の形で書く。',
  '',
  '## json の欄（手ごとに決まっている。ほかの欄は断られる。どの手にも rel・note・onFail）',
  '- walk: to か path・sprint・range / dig: at・tool・collect・exposeOk・takeOk / place: block・at・face / pillarUp: n・block / use: item・at（1つ）・face・target',
  '- look: to か yaw・pitch / jump: n / sneak: on / equip: item・slot / craft: item・count / attack: target・untilDead・seconds・hold / eat: item',
  '- pickup: target・range / wait: seconds / furnace: at（1つ）・op・item・count・fuel・fuelCount / chest: at（1つ）・op・items',
  '- drop: items・target か at / shoot: target か at・item・charge・n',
  'json {"do":"walk","to":{"x":1,"y":64,"z":2},"range":1,"sprint":true,"note":"村へ"}',
  'json {"do":"furnace","at":[{"x":1,"y":2,"z":3}],"op":"put","item":"iron_ore","count":8,"fuel":"coal","fuelCount":2}（op=take で出来上がりを取る。溶鉱炉・燻製器も）',
  'json {"do":"chest","at":[{"x":1,"y":2,"z":3}],"op":"look|take|put|takeAll","items":[{"item":"coal","count":4}]}（箱・樽だけ）',
  'json {"do":"drop","items":[{"item":"gold_ingot","count":1}],"target":"#12"}（その方へ投げる）',
  'json {"do":"shoot","target":"#12","item":"bow","charge":1,"n":3}（target の代わりに at も可）',
  '',
  '## 止める・守る',
  '- stopIf は文字列 "hostileWithin=8 hpBelow=10"（hostileWithin は敵までの m、hpBelow は体力 0〜20、hungerBelow=N、blockChanged=X,Y,Z/X,Y,Z で見張るマス最大4 も可）。満たしたら全体を止めて返す。'
    + 'hpBelow は今の体力より低い値（以上だと1手も動かず止まる）。待つ手の act には hostileWithin。',
  '- accept は、この act で戦うと決めた敵の種類の配列（例 ["blaze"]）。体はその敵から下がらず・逃げず・止まらない（盾の構えと火の玉の打ち返しはする）。'
    + '溶岩・溺れ・落下・点火クリーパー・体力8以下の逃走の反射は残る。早めに引くなら stopIf の hpBelow を高めに。',
  '- onFail: 手が自分で失敗した時、continue なら「失」と書いて次の手へ進み、stop ならそこで act を止める。既定は equip・eat・look・sneak・jump が continue、'
    + 'ほかは stop。急ぐ手（離れる・食べる）の前の手が失敗しそうなら continue に。反射・stopIf・満杯・時間切れはいつでも act を止める。',
  '- 同じ種類の手が続く場面（トンネル・階段・橋・採掘）は、10〜12 手を 1 つの act に入れる（dig の at は16マス、walk の path は32点まで1手に）。'
    + '止まりは反射・stopIf・onFail が守る。',
  '',
  '## 返る行',
  '- 行は「番号 手 済|止|失|未 本文」。止まった手の周りの 3×3×3 は、次の判断の live の lastResults に一度だけ出る。',
  '- 止まりの読み方: 「一歩ではない」は段差2以上か着いていない / 「届かない」は5m内へ寄る / 「掘れない」は道具か岩盤（X）/ '
    + '「見えない：間に (x,y,z)」はその間を先に掘る / 「そのものには立てない」は続く「立てる隣」へ。',
];
export const SHORT_ACT_DESCRIPTION: string = SHORT_LINES.join('\n');

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
