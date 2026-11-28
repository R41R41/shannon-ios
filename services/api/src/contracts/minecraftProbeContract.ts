import { ACT_CONTRACT_VERSION, type ActPos } from './minecraftActContract.js';

/**
 * mb-llmc r4 (shared note `r4-contract.md` 1, and the body's form of 2026-10-22 04:10): the body's read `probe` (head `mc.probe`), a fixed
 * computation with no model, read only, and the body's own scan of the land it holds (`world.scan`). The head owns this contract with
 * `minecraftActContract.ts`; the body follows it. One flat object: `kind` and that kind's fields only. The head puts the model's input into
 * this form before it is sent (`minecraftLlmcProbeInput.ts`): a creature named is sent as its `#id`, a column always with its x, z and y bounds.
 */
export const MC_PROBE_SKILL = 'probe' as const;
export const MC_PROBE_TOOL = `mc.${MC_PROBE_SKILL}` as const;
// gaze: the block a player is looking at (the request "put it on this block"; the body reads the player's eye and direction).
// roofsite: S6's body fb180c10 (11/5), where an enderman roof can be built, by the endermen whose eyes are seen from there.
export const PROBE_KINDS = [
  'path', 'sight', 'column', 'around', 'history', 'scan', 'worksite', 'frames', 'camp', 'lane', 'den', 'roofsite', 'bedsite', 'route',
  'gaze',
] as const;
export type ProbeKind = typeof PROBE_KINDS[number];
export interface ProbeInput {
  kind: ProbeKind;
  /** path, route: where to go. */
  to?: ActPos;
  /** worksite: explicit return destination, evaluated independently. */
  retreat?: ActPos;
  /** route: how near is near enough (0–32, default 0: the cell itself). */
  range?: number;
  /** path, route, sight, lane: from where (default her feet). */
  from?: ActPos;
  /** lane: the spawner (default the nearest loaded Nether spawner). */
  spawner?: ActPos;
  /** sight: a block, or a creature (`#12`). */
  target?: ActPos | string;
  /** column: the column (default her feet's) and its y bounds, top to bottom; frames: the centre of the search (default her feet). */
  x?: number; z?: number; yFrom?: number; yTo?: number;
  /** history: the place (default her feet). */
  at?: ActPos;
  /** around: blocks (1–16, default 8); history: blocks (1–32, default 4); scan: chunks (1–16, default the view distance);
   * frames: blocks (16–128, default 64). */
  radius?: number;
  /** gaze: whose gaze (the player's in-game name; when no one has it, or it is left out, the body answers for the people who are here). */
  player?: string;
  /** gaze: a block name (oak_planks); the answer also lists the blocks of that name nearest the look. */
  near?: string;
}
/**
 * The body's answer (the receipt's `result`): one line of JSON, `text` first (Japanese, short, the dangerous fact said as it is: 「下 7 段は
 * 空気（落差 7、底 y=-15 stone）」, never a word that reads as "dig here"), then the kind's fields (path: `reachable`, `points`, `breaks`,
 * `nearest`, `stands`…; sight: `visible`, `reach`, `distance`, `between`…; see the shared note). A text that is not this JSON is read as `text`.
 */
export interface ProbeResult { v: typeof ACT_CONTRACT_VERSION; kind: ProbeKind; text: string; [field: string]: unknown }
/** The body's scan of the land it holds (`world.scan`, the body's form of 2026-10-22 04:10). */
export interface WorldScan {
  trigger: 'login' | 'reconnect' | 'respawn' | 'portal';
  /** When it was made (ISO): a new value is a new scan. */
  at: string;
  dimension?: string;
  center?: ActPos;
  /** One or two sentences: what is where. */
  text: string;
  /** At most 20 lines: `記号 名前 (x,y,z) 方角距離 注記`. */
  rows?: readonly string[];
  chunks?: number; reach?: number; ms?: number; partial?: boolean;
}
/** A probe's result (`ProbeResult`), or the plain text as one; null for none. */
export function readProbeResult(text: string | undefined): ProbeResult | { text: string; kind?: undefined } | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Partial<ProbeResult>;
    if (value?.kind === 'lane') return { ...value, text: typeof value.text === 'string' ? value.text : '' } as ProbeResult;
    if (value && typeof value === 'object' && typeof value.text === 'string') return value as ProbeResult;
  } catch { /* not JSON: the text as it is */ }
  return { text };
}
/** The definition text of `mc.probe` (fixed: part of the cached prefix). */
export const PROBE_DESCRIPTION = [
  'bedsite(target:#竜ID): 竜が止まり木へ降りてくる途中（phase 2）に、すぐ読む。現在のphase 2の進入に対するベッド配置候補を読む（座ってからは current_phase2_required）。撃つ時に立つマス（stand）、足場と遮蔽の黒曜石の施工順、ベッドの足側と枕側、必要な黒曜石の数と今の持ち数を返す。ready:true に付く not_ready_to_fire は「撃つ前に体が毎回もう一度確かめる」印で、ready:true なら進んでよい。'
    + '体は動かず施工しない。初回は観測不足を返す場合がある。候補は同じ接続・生命・進入だけの観測で、安全の保証ではない。通常は予約の手（bed_standby）を使うので、この probe は予約が使えない時の旧の手（bed_burst）のためにある。旧の手では、置き場所の選択と施工は頭が行い、bed_burst が撃つ前に体がもう一度確かめる。',
  'route(to, from, range: 掘る・置くを混ぜた最短の道の見積り。歩く・掘る・置く数と秒、道の点。水源・溶岩は避ける。着けない時は行ける所まで。見積りだけで動かない): 長い道は go の前にこれで数を読む。',
  '体の周りを調べる（読むだけ・速い・体は動かない）。詰まった時・驚いた時に、手を変える前に事実を確かめる。答えは危ない事実が先。',
  'kind と引数: path(to, from: 掘らず置かずに歩いて行けるか。行けない時は、行けない所とその理由（落差 n・壁・水深 n・溶岩・すき間）と、'
    + 'walk の path に使える点・的の近くに立てる場所) / sight(target: 座標か "#id"、from: 見えるか・4.5m で届くか・間のブロック) / '
    + 'column(x, z, yFrom, yTo: 縦の列の連なり。落差・水・溶岩・砂利) / '
    + 'around(radius: 生き物（敵か・狙っているか・見えるか・高さの差）と危ないブロック) / history(at, radius: その場所の最近の手と止まり) / '
    + 'scan(radius: 読み込み済みの範囲の目印。木・村・水・溶岩・構造物・ネザーの幹・要塞・スポナー・ポータル) / '
    + 'frames(x, z: 探す中心（省くと足）、radius: ブロック 16〜128（既定 64）。要塞のエンドポータルの枠を近い順に。無ければ 16 ブロック刻みの輪の次に歩く点) / '
    + 'camp(ネザーのブレイズの湧き場と、その 3m 以内で縁・火の無い立てる足場) / '
    + 'lane(spawner, from: 省くと近い湧き場と現在地。暗い1列の通路の四方向の必要数、最少候補の栓・待ち場・通路・立つ所・支え・危険の事実) / '
    + 'den(エンダーマンの横穴の候補: 壁に掘れる 2 高×2 奥の穴の入口と向き・入口正面の見通し・未掘削のマス数を、良い順に最大 8 件。引数なし) / '
    + 'roofsite(radius 4〜24、既定 16: エンダーマンの屋根を作れる所を、そこから 8〜48m に目の見える個体の多い順に最大 5 件。マス・見える数・要るブロック・距離)。',
  'gaze(player: 見ている人のマイクラ名, near: ブロックの名前, range: 光線の長さ 1〜64、既定 32: その人が今見ているブロックの名前・座標・面（up/down/north/south/east/west）・距離と、'
    + 'reach（体の手が届くか）・placeAt（そこへ置く時のマス）・against（place の face にそのまま渡す向き）・above（そのブロックの真上のマス）。'
    + 'near=oak_planks のように足すと、視線の点（何も当たらなければ視線の線）に近い順にその名前のブロックを数個、位置・視線からの距離・上に置けるか・置く先も返す（見ている物そのものが先頭）。'
    + '何も見ていない時は hit:false とその向き。player が合わない・無い時は断らず、今いる人（体に近い順に 3 人まで）それぞれの視線を gazes に並べて返す。「この〇〇の上に」の「この」を解く時に、名前で探した候補が複数ある時に使う。体は動かない）。',
  'worksite(target または at: 目的物、to: 作業する立ち位置、省略なら届く現在地か隣接候補、retreat: 帰還先): 接近・作業の射程/呼吸/道具・逆向きの帰路を別々に調べる。結果は観測時点の短区間だけ。施工後は再確認。',
  '省いた座標は足から。column の yFrom・yTo を省くと足の上下。',
].join('\n');

const pos = (description: string) => ({ type: 'object', description, additionalProperties: false, required: ['x', 'y', 'z'],
  properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } });
const intField = (minimum: number, maximum: number) => ({ type: 'integer', minimum, maximum });
/** The input schema of `mc.probe` (r4, the head's; the body's takes every input the head sends after `prepareProbeInput`). */
export const PROBE_INPUT_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['kind'],
  properties: {
    kind: { type: 'string', enum: [...PROBE_KINDS] },
    to: pos('path の行き先'),
    retreat: pos('worksite の帰還先'),
    from: pos('path・sight・lane の始まり（既定は足）'),
    spawner: pos('lane の湧き場（省くとネザーの読み込み済みの範囲の近い湧き場）'),
    target: { type: 'string', maxLength: 64, description: 'sight の的: "#id"・生き物の名前・"x,y,z"' },
    at: pos('sight の的のブロック、history の場所'),
    x: intField(-30_000_000, 30_000_000), z: intField(-30_000_000, 30_000_000),
    yFrom: intField(-64, 320), yTo: intField(-64, 320),
    range: intField(0, 64),
    player: { type: 'string', maxLength: 32, description: 'gaze の人: マイクラ名（分かる時。合わない・無い時は、今いる人それぞれの視線が返る）' },
    near: { type: 'string', maxLength: 48, description: 'gaze: ブロックの名前（oak_planks）。視線の点に近い順にその名前のブロックも返す' },
    radius: intField(1, 128),
  },
});
