import { ACT_CONTRACT_VERSION, type ActPos } from './minecraftActContract.js';

/**
 * mb-llmc r4 (shared note `r4-contract.md` 1, and the body's form of 2026-10-22 04:10): the body's read `probe` (head `mc.probe`), a fixed
 * computation with no model, read only, and the body's own scan of the land it holds (`world.scan`). The head owns this contract with
 * `minecraftActContract.ts`; the body follows it. One flat object: `kind` and that kind's fields only. The head puts the model's input into
 * this form before it is sent (`minecraftLlmcProbeInput.ts`): a creature named is sent as its `#id`, a column always with its x, z and y bounds.
 */
export const MC_PROBE_SKILL = 'probe' as const;
export const MC_PROBE_TOOL = `mc.${MC_PROBE_SKILL}` as const;
export const PROBE_KINDS = ['path', 'sight', 'column', 'around', 'history', 'scan'] as const;
export type ProbeKind = typeof PROBE_KINDS[number];
export interface ProbeInput {
  kind: ProbeKind;
  /** path: where to go. */
  to?: ActPos;
  /** path, sight: from where (default her feet). */
  from?: ActPos;
  /** sight: a block, or a creature (`#12`). */
  target?: ActPos | string;
  /** column: the column (default her feet's) and its y bounds, top to bottom. */
  x?: number; z?: number; yFrom?: number; yTo?: number;
  /** history: the place (default her feet). */
  at?: ActPos;
  /** around: blocks (1–16, default 8); history: blocks (1–32, default 4); scan: chunks (1–16, default the view distance). */
  radius?: number;
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
    if (value && typeof value === 'object' && typeof value.text === 'string') return value as ProbeResult;
  } catch { /* not JSON: the text as it is */ }
  return { text };
}
/** The definition text of `mc.probe` (fixed: part of the cached prefix). */
export const PROBE_DESCRIPTION = [
  '体の周りを調べる（読むだけ・速い・体は動かない）。詰まった時・驚いた時に、手を変える前に事実を確かめる。答えは危ない事実が先。',
  'kind と引数: path(to, from: 掘らず置かずに歩いて行けるか。行けない時は、行けない所とその理由（落差 n・壁・水深 n・溶岩・すき間）と、'
    + 'walk の path に使える点・的の近くに立てる場所) / sight(target: 座標か "#id"、from: 見えるか・4.5m で届くか・間のブロック) / '
    + 'column(x, z, yFrom, yTo: 縦の列の連なり。落差・水・溶岩・砂利) / '
    + 'around(radius: 生き物（敵か・狙っているか・見えるか・高さの差）と危ないブロック) / history(at, radius: その場所の最近の手と止まり) / '
    + 'scan(radius: 読み込み済みの範囲の目印。木・村・水・溶岩・構造物・ネザーの幹・要塞・スポナー・ポータル)。',
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
    from: pos('path・sight の始まり（既定は足）'),
    target: { type: 'string', maxLength: 64, description: 'sight の的: "#id"・生き物の名前・"x,y,z"' },
    at: pos('sight の的のブロック、history の場所'),
    x: intField(-30_000_000, 30_000_000), z: intField(-30_000_000, 30_000_000),
    yFrom: intField(-64, 320), yTo: intField(-64, 320),
    radius: intField(1, 32),
  },
});
