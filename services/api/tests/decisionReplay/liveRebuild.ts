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
/** mb-llmc-cand 10（敵の見え方・near の絞り・日本語の system など）の木か（reach の語の部品がある）。 */
const reach = await dynamic('../../src/surfaces/minecraft/' + 'minecraftLlmcReachWords.js');
export const hasReachWords = !!reach;
const v2mod = await dynamic('../../src/surfaces/minecraft/' + 'minecraftLlmcV2.js');
/** 状態メッセージの progress に、完了の証明を言い切る文（binding.plain）を足す（この版だけ）。 */
export const progressPlain = (progress: unknown): unknown => typeof v2mod?.progressWithPlain === 'function' ? v2mod.progressWithPlain(progress) : progress;

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
  let derivedPlan: unknown;
  if (map) {
    const raw: Record<string, any> = {};
    for (const [key, value] of Object.entries(body)) if (!DERIVED.includes(key)) raw[key] = key === 'map' ? map : value;
    const made = rewriteLlmcLive({ ...live, body: raw }).live;
    derived = (made.body ?? {}) as Record<string, any>;
    derivedPlan = made.plan;
  }
  // mb-llmc-cand 10 の書き直し（敵の行の絞り・near の絞り・済む条件の言い換え）は、書き直し済みの行に当てても同じ形になる（試した: 実走37 の 146 判断で
  // 敵・near・今の節だけが変わる）ので、この版（reach の語の部品がある木）では、その欄も差し替える。前の版の書き直しは、書き直し済みの敵の行に当てると壊れる（差し替えない）。
  const alsoNew = hasReachWords ? ['threats', 'near', 'planNow'] : [];
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === 'around') { for (const name of MAP_FIELDS) if (derived[name] !== undefined) out[name] = derived[name]; continue; }
    if (MAP_FIELDS.includes(key)) continue;
    out[key] = alsoNew.includes(key) && derived[key] !== undefined ? derived[key] : value;
  }
  const result = { ...live, body: out } as Record<string, any>;
  if (hasReachWords && derivedPlan) result.plan = derivedPlan;
  return withStateWords(withNewLastResults(result));
}

/**
 * mb-llmc-cand 10 (D1): 結果の行は履歴にあるので、live の lastResults は履歴に無い所だけ（止まった手の周り。長い結果は 1 行目の後）。記録の lastResults は全文なので、
 * この版では act の結果は「止まった所の周り」の行だけ、それ以外の長い結果は 1 行目を外して残りを出す（`llmcStoredResult(…, v2)` と同じ分け方）。周りの行が無い act の結果は出さない。
 */
const AROUND_LINE = /^\s*(周り（上の層から|止まった所 )/u;
const ACT_RESULT = /(^|\n)(act \d|送る前に止めた|手 ?\d+（)/u;
export function withNewLastResults<T extends Record<string, any>>(live: T): T {
  const body = live.body as Record<string, any> | undefined;
  if (!hasReachWords || !Array.isArray(body?.lastResults)) return live;
  const kept = (body!.lastResults as unknown[]).flatMap(item => {
    if (typeof item !== 'string') return [item];
    if (ACT_RESULT.test(item)) {
      const lines = item.split('\n').filter(line => AROUND_LINE.test(line));
      return lines.length ? [lines.join('\n')] : [];
    }
    // 1 行目が 200 字を超える結果は、履歴には 200 字までしか残らない（llmcStoredResult の keptAndRest）ので、全文を出す。
    const firstLine = item.split('\n')[0] ?? '';
    const rest = firstLine.length > 200 ? item : item.split('\n').slice(1).join('\n');
    return rest ? [rest] : [];
  });
  const next: Record<string, any> = { ...body };
  if (kept.length) next.lastResults = kept; else delete next.lastResults;
  return { ...live, body: next };
}

/** 任務の知らせの文（本番 rel41 の物 → この木の版の物）。修正の版は V2 の文に替える。 */
export function taskNoteSwap(): { from: string; to: string } | null {
  const from = requests?.MINECRAFT_REQUEST_CONTEXT, to = requests?.MINECRAFT_REQUEST_CONTEXT_V2;
  return typeof from === 'string' && typeof to === 'string' ? { from, to } : null;
}

/**
 * mb-llmc-cand 11（v2、エンドラの課題）: live の `road`（道のり）と `meter`（目安）。本番は計画の木・体の frame・経過時間から作る。記録には判断ごとの計画の木が無いので、
 * 実走の最後の木を、その判断の今の節（planNow の id）に合わせて写す: 今の節の上の節より前の節は済み（blocked は除く）、それ以降は続き。meter は live の持ち物・着ている物・次元・
 * 経過分（state.minutes）から。この木（road の部品がある木）だけ。地図から作る欄ではないので、前の版には何も足さない。
 */
const road = await dynamic('../../src/surfaces/minecraft/' + 'minecraftLlmcRoad.js');
const mind = await dynamic('@shannon/' + 'mind');
export function withRoad<T extends Record<string, any>>(live: T, tree: unknown): T {
  const body = live.body as Record<string, any> | undefined;
  const source = tree as { nodes?: Array<Record<string, any>> } | null | undefined;
  if (!road?.roadLine || !mind?.orderedPlan || !body || !source?.nodes) return live;
  const current = /^\[([^\]]+)\]/u.exec(String(body.planNow ?? ''))?.[1];
  if (!current) return live;
  const nodes = source.nodes.map(node => ({ ...node }));
  const byId = new Map(nodes.map(node => [node.id, node]));
  const topOf = (id: string): string | undefined => { let at = byId.get(id); while (at?.parentId) at = byId.get(at.parentId); return at?.id; };
  const top = mind.orderedPlan(nodes).filter((node: Record<string, any>) => node.parentId === null).map((node: Record<string, any>) => node.id as string);
  const here = top.indexOf(topOf(current) ?? '');
  if (here < 0) return live;
  const blocked = new Set<string>((live.plan?.blocked ?? []).flatMap((text: string) => [...String(text).matchAll(/p\d+(?:\.\d+)*/gu)].map(match => match[0])));
  for (const node of nodes) {
    const index = top.indexOf(topOf(node.id) ?? '');
    node.state = blocked.has(node.id) ? 'blocked' : index < here ? 'done' : index === here ? (node.id === current ? 'active' : node.state === 'done' && byId.get(node.id) ? 'continue' : 'continue') : 'continue';
  }
  const view = { ...source, nodes, current };
  const state = (body.state ?? {}) as Record<string, any>;
  const at = /\((-?\d+),(-?\d+),(-?\d+)\)/u.exec(String(state.at ?? ''));
  const observation = { state: { world: { inventory: body.inventory ?? [], worn: state.worn, dimension: state.dimension,
    ...(at ? { position: { x: +at[1]!, y: +at[2]!, z: +at[3]! } } : {}) } }, facts: {} };
  const roadText = road.roadLine(view), meterText = typeof state.minutes === 'number' ? road.meterLine(view, observation, state.minutes) : null;
  if (!roadText && !meterText) return live;
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(body)) {
    out[key] = value;
    if (key === 'planNow') { if (roadText) out.road = roadText; if (meterText) out.meter = meterText; }
  }
  return { ...live, body: out };
}
