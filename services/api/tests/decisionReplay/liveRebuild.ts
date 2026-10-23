import { rewriteLlmcLive } from '../../src/surfaces/minecraft/minecraftLlmcLiveRewrite.js';

/**
 * 実走36・37（本番 rel41）の記録の live は、本番がもう書き直した後の形（`body.around`・`liquid`・`obsidian`・`route` と、同じ範囲にそろえた地図）。
 * 候補の書き直し（`rewriteLlmcLive`）は「地図の文から around などを作る」ので、そろえた地図をそのまま通しても around は作り直されない（層の見出しが違い、
 * 読めない）。そこで: そろえた地図を元の層の形（各層に x・z の範囲）に戻し、作られる欄を外して通し、**地図から作られる欄だけ**（around・liquid・obsidian・route）を
 * 記録の live に差し替える。残り（敵の行・持ち物・止まり・結果の行・計画）は記録のまま。基準と修正の両方に同じ地図を使うので、差は版の書き方の差だけ。
 * 戻せない所: 本番の書き直しの前の地図は層ごとに範囲が違い、そろえる時に切った外側（周りの一覧は水平 6 に対して 5 まで）は無い。
 */
const NOTE = /^（以下の層は全部 x=(-?\d+)\.\.(-?\d+) z=(-?\d+)\.\.(-?\d+) の同じ範囲/u;
/** そろえた地図 → 元の層の形（各層に x・z の範囲）。そろえた地図でなければ null。 */
export function denormalizeMap(map: string): string | null {
  const lines = map.split('\n');
  const noteIndex = lines.findIndex(line => NOTE.test(line));
  if (noteIndex < 0) return null;
  const m = NOTE.exec(lines[noteIndex]!)!;
  const range = `x=${m[1]}..${m[2]} z=${m[3]}..${m[4]}`;
  const out: string[] = [lines[0]!];
  for (const line of lines.slice(noteIndex + 1)) {
    if (line.startsWith('z' + String.fromCharCode(92) + 'x ') || /^\s+\^\s*$/u.test(line)) continue;
    const layer = /^y=(-?\d+)（足/u.exec(line);
    out.push(layer ? `y=${layer[1]} ${range}` : line);
  }
  return out.join('\n');
}
/** 本番がもう書き直した live か（body.around がある）。 */
export const isRewrittenLive = (live: Record<string, any>): boolean => Array.isArray(live.body?.around);

const MAP_FIELDS = ['around', 'liquid', 'obsidian', 'route'];
const DERIVED = [...MAP_FIELDS, 'repeat', 'pack'];

/** 版（木）ごとの、状態の言葉（minecraftLlmcStateWords.ts は修正の版にだけある）。 */
const dynamic = (path: string): Promise<Record<string, any> | null> => import(path).catch(() => null);
const words = await dynamic('../../src/surfaces/minecraft/' + 'minecraftLlmcStateWords.js');
const requests = await dynamic('../../src/wiring/' + 'fcaMinecraftRequests.js');
export const hasStateWords = !!words?.timeWords;

/** 状態の言葉（時刻・息）: 修正の版だけ（本番では体の状態から作る所で、記録の live では state の欄を書き換える）。基準の版は何もしない。 */
export function withStateWords<T extends Record<string, any>>(live: T): T {
  const body = live.body as Record<string, any> | undefined;
  if (!words || !body?.state || typeof body.state !== 'object') return live;
  const state = { ...body.state as Record<string, any> };
  if (typeof state.time === 'string') state.time = words.timeWords(state.time, state.dimension) ?? state.time;
  if (typeof state.oxygen === 'number') state.oxygen = words.breathWords(state.oxygen) ?? state.oxygen;
  return { ...live, body: { ...body, state } };
}

/** 記録の live を、この木の版の書き方で作り直した live。書き直し済みの形でなければ null（呼ぶ側が candidateLive を使う）。 */
export function rebuiltLive(live: Record<string, any>): Record<string, any> | null {
  if (!isRewrittenLive(live)) return null;
  const body = live.body as Record<string, any>;
  const map = typeof body.map === 'string' ? denormalizeMap(body.map) : null;
  let derived: Record<string, any> = {};
  if (map) {
    const raw: Record<string, any> = {};
    for (const [key, value] of Object.entries(body)) if (!DERIVED.includes(key)) raw[key] = key === 'map' ? map : value;
    derived = (rewriteLlmcLive({ ...live, body: raw }).live.body ?? {}) as Record<string, any>;
  }
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === 'around') { for (const name of MAP_FIELDS) if (derived[name] !== undefined) out[name] = derived[name]; continue; }
    if (MAP_FIELDS.includes(key)) continue;
    out[key] = value;
  }
  return withStateWords({ ...live, body: out });
}

/** 任務の知らせの文（本番 rel41 の物 → この木の版の物）。修正の版は V2 の文に替える。 */
export function taskNoteSwap(): { from: string; to: string } | null {
  const from = requests?.MINECRAFT_REQUEST_CONTEXT, to = requests?.MINECRAFT_REQUEST_CONTEXT_V2;
  return typeof from === 'string' && typeof to === 'string' ? { from, to } : null;
}
