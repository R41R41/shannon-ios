import { aroundLines, goalOf, isOpen, mapView, NAME, noFloor, normalizeMap, nameOf, ptText, readLayers, routeLines, type P } from './rewriteMap.js';

/**
 * 書き直した live（10/23 の比べの vB）。決まりは `rewriteRules.md`。場面の記録（DB の live）だけから作る。手は決めない・足さない（事実だけ）。
 * 本番の live の形（ownerClock・waiting・observations・recall・plan・body）は残し、body の欄の名前も変えない（指示文が言う live.body.map・lastResults のため）。
 * 足すのは body.around（足の周り）と body.route（計画の目的地への道）だけ。
 */
export interface RewriteNotes {
  dropped: string[]; fixed: string[]; merged: string[]; omitted: number; added: string[];
}
const DIM_BIOMES: Record<string, RegExp> = {
  the_nether: /^(nether_wastes|soul_sand_valley|crimson_forest|warped_forest|basalt_deltas)$/u,
  overworld: /^(?!nether_|soul_sand|crimson|warped|basalt|the_end|end_|small_end|.*_end$)/u,
  the_end: /^(the_end|end_highlands|end_midlands|end_barrens|small_end_islands)$/u,
};
export const OMIT = /^ほか(\d+)件（長いため略）$/u;
const sign = (n: number) => (n >= 0 ? `+${n}` : `${n}`);

/** 相対位置の文（東西 → 南北 → 上下。0 は書かない）。 */
export function relText(self: P, target: P): string {
  const parts: string[] = [];
  const dx = target.x - self.x, dz = target.z - self.z, dy = target.y - self.y;
  if (dx) parts.push(`${dx > 0 ? '東' : '西'}${Math.abs(dx)}`);
  if (dz) parts.push(`${dz > 0 ? '南' : '北'}${Math.abs(dz)}`);
  if (dy) parts.push(`${dy > 0 ? '上' : '下'}${Math.abs(dy)}`);
  return parts.length ? parts.join('・') : '同じマス';
}
const parsePos = (text: string): P | null => { const m = /\((-?\d+),(-?\d+),(-?\d+)\)/u.exec(text); return m ? { x: +m[1]!, y: +m[2]!, z: +m[3]! } : null; };

/* ------------------------------------------------------------------ 敵 */
interface Enemy { id: string; name: string; dist: number; pos: P | null; notes: string[]; urgent: boolean; wait: boolean }
function mergeEnemies(body: Record<string, any>, self: P, notes: RewriteNotes): { urgent: string[] | undefined; threats: string[] | undefined } {
  const byId = new Map<string, Enemy>();
  const order: string[] = [];
  const touch = (id: string, name: string, dist: number): Enemy => {
    let enemy = byId.get(id);
    if (!enemy) { enemy = { id, name, dist, pos: null, notes: [], urgent: false, wait: false }; byId.set(id, enemy); order.push(id); }
    return enemy;
  };
  const omittedLines: string[] = [];
  for (const line of (Array.isArray(body.threats) ? body.threats : []) as string[]) {
    const m = /^#(\d+) (\S+) ([\d.]+)m \((-?\d+),(-?\d+),(-?\d+)\)$/u.exec(line);
    if (m) { const e = touch(m[1]!, m[2]!, Number(m[3])); e.pos = { x: +m[4]!, y: +m[5]!, z: +m[6]! }; }
    else if (OMIT.test(line)) omittedLines.push(line);
  }
  const detail = (rest: string): string => rest.replace(/^(?:上|下) \d+・?/u, '').replace(/^・/u, '');
  for (const line of (Array.isArray(body.unreachable) ? body.unreachable : []) as string[]) {
    const m = /^(\S+) #(\d+) ([\d.]+)m・(.*)$/u.exec(line);
    if (!m) continue;
    const e = touch(m[2]!, m[1]!, Number(m[3]));
    e.dist = Number(m[3]);
    e.notes.push(detail(m[4]!));
  }
  const keptUrgent: string[] = [];
  const anonymous: Array<{ name: string; dist: number; line: string }> = [];
  for (const line of (Array.isArray(body.urgent) ? body.urgent : []) as string[]) {
    const m = /^(急ぎ: 判断を待つ間に )?(\S+) #(\d+) ([\d.]+)m・(.*)$/u.exec(line);
    if (m) {
      const e = touch(m[3]!, m[2]!, Number(m[4]));
      e.dist = Number(m[4]); e.urgent = true; e.wait ||= !!m[1];
      const text = detail(m[5]!);
      if (!e.notes.includes(text)) e.notes.push(text);
      continue;
    }
    const anon = /^(\S+) ([\d.]+)m$/u.exec(line);
    if (anon) { anonymous.push({ name: anon[1]!, dist: Number(anon[2]), line }); continue; }
    keptUrgent.push(line);
  }
  // id の無い急ぎ（"blaze 4.3m"）は、同じ種類で距離が最も近い敵の行にまとめる（0.6m 以内）。
  for (const item of anonymous) {
    const near = order.map(id => byId.get(id)!).filter(e => e.name === item.name && Math.abs(e.dist - item.dist) <= 0.6).sort((a, b) => Math.abs(a.dist - item.dist) - Math.abs(b.dist - item.dist))[0];
    if (near) { near.urgent = true; notes.merged.push(`urgent「${item.line}」→ #${near.id}（${near.dist}m）の行`); } else keptUrgent.push(item.line);
  }
  const text = (e: Enemy) => {
    const rel = e.pos ? ` ${ptText(e.pos)} ${relText(self, e.pos)}` : '';
    const note = e.notes.filter(Boolean).join('・');
    return `#${e.id} ${e.name} ${e.dist}m${rel}${e.wait ? '（判断を待つ間に出た）' : ''}${note ? `・${note}` : ''}`;
  };
  const all = order.map(id => byId.get(id)!);
  const urgent = [...all.filter(e => e.urgent).sort((a, b) => a.dist - b.dist).map(text), ...keptUrgent];
  const threats = [...all.filter(e => !e.urgent).sort((a, b) => a.dist - b.dist).map(text), ...omittedLines.map(line => `（${line.replace(/（長いため略）/u, '')}は略）`)];
  const before = [body.threats, body.unreachable, body.urgent].flatMap(list => Array.isArray(list) ? list.length : 0).reduce((a: number, b: number) => a + b, 0);
  if (before > urgent.length + threats.length) notes.merged.push(`敵の行 ${before} → ${urgent.length + threats.length}`);
  return { urgent: Array.isArray(body.urgent) ? urgent : undefined, threats: Array.isArray(body.threats) || Array.isArray(body.unreachable) ? threats : undefined };
}

/* ------------------------------------------------------------------ 持ち物・目印・止まりの周り */
function mergeInventory(list: readonly string[], notes: RewriteNotes): string[] {
  const sums = new Map<string, number>();
  const counted = new Map<string, number>();
  const out: Array<string | { name: string }> = [];
  let omitted = '';
  for (const line of list) {
    const o = OMIT.exec(line);
    if (o) { omitted = `ほか${o[1]}件は略`; notes.omitted += Number(o[1]); continue; }
    const m = /^([a-z_0-9]+)×(\d+)$/u.exec(line);
    if (!m) { out.push(line); continue; }
    if (!sums.has(m[1]!)) out.push({ name: m[1]! });
    sums.set(m[1]!, (sums.get(m[1]!) ?? 0) + Number(m[2]));
    counted.set(m[1]!, (counted.get(m[1]!) ?? 0) + 1);
  }
  const merged = out.map(item => typeof item === 'string' ? item : `${item.name}×${sums.get(item.name)}`);
  const duplicated = [...counted].filter(([, n]) => n > 1).map(([name]) => name);
  if (duplicated.length) notes.merged.push(`持ち物の同じ物 ${duplicated.join('・')} を合算`);
  return omitted ? [...merged, omitted] : merged;
}
function fixLandmarks(list: readonly string[], self: P, notes: RewriteNotes): string[] {
  let changed = 0;
  const out = list.map(line => {
    const o = OMIT.exec(line);
    if (o) { notes.omitted += Number(o[1]); return `ほか${o[1]}件は略`; }
    const m = /^(.*? \((-?\d+),(-?\d+),(-?\d+)\)) ((?:[東西南北上下]\d+)(?:・[東西南北上下]\d+)*)(.*)$/u.exec(line);
    if (!m) return line;
    const fresh = relText(self, { x: +m[2]!, y: +m[3]!, z: +m[4]! });
    if (fresh !== m[5]) changed += 1;
    return `${m[1]} ${fresh}${m[6]}`;
  });
  if (changed) notes.fixed.push(`目印の相対位置 ${changed} 行を今の足から計算し直した`);
  return out;
}
function dropOmits(list: readonly string[], notes: RewriteNotes): string[] {
  return list.map(line => { const o = OMIT.exec(line); if (!o) return line; notes.omitted += Number(o[1]); return `ほか${o[1]}件は略`; });
}

/** 止まった手の周り（"周り（上の層から、北が上・西が左）x=308..310 z=72..74 y=68: N.#/N.#/N.N y=67: …"）を、マスごとの座標つきの書き方にする。 */
function expandAround(text: string, notes: RewriteNotes): string {
  return text.split('\n').map(line => {
    const m = /^(\s*)周り（上の層から、北が上・西が左）x=(-?\d+)\.\.(-?\d+) z=(-?\d+)\.\.(-?\d+) (.*)$/u.exec(line);
    if (!m) return line;
    const x0 = Number(m[2]), z0 = Number(m[4]);
    const groups = new Map<string, string[]>();
    let center: P | null = null;
    const layers = [...m[6]!.matchAll(/y=(-?\d+): (\S+)/gu)];
    const ys = layers.map(l => Number(l[1]));
    const midY = ys[Math.floor(ys.length / 2)]!;
    for (const layer of layers) {
      const y = Number(layer[1]);
      layer[2]!.split('/').forEach((row, rowIndex) => [...row].forEach((symbol, col) => {
        const cell = { x: x0 + col, y, z: z0 + rowIndex };
        if (y === midY && col === 1 && rowIndex === 1) center = cell;
        const label = symbol === '@' ? '@ 自分の足' : nameOf(symbol);
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label)!.push(ptText(cell).replace(/^\(|\)$/gu, ''));
      }));
    }
    notes.fixed.push('止まった手の周りの略記を座標つきに');
    const body = [...groups].map(([label, cells]) => `${label}: ${cells.map(c => `(${c})`).join('')}`).join(' ／ ');
    return `${m[1]}止まった所 ${center ? ptText(center) : ''} の周り 3×3×3（マスごとの座標つき）: ${body}`;
  }).join('\n');
}

/** 「注意: (x,y,z): 的そのものには立てない（…）」が、今の地図ではそのマスに立てる（足と頭が空き、床がある）なら古い注意。 */
export function staleStand(rule: string, view: ReturnType<typeof mapView>): boolean {
  const m = /^注意: ((-?d+),(-?d+),(-?d+)): 的そのものには立てない/u.exec(rule);
  if (!m) return false;
  const [x, y, z] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = view.symbol(x, y, z), head = view.symbol(x, y + 1, z), floor = view.symbol(x, y - 1, z);
  return at !== undefined && head !== undefined && floor !== undefined && isOpen(at) && isOpen(head) && !noFloor(floor);
}

/* ------------------------------------------------------------------ 本体 */
export function rewriteLive(live: Record<string, any>): { live: Record<string, any>; notes: RewriteNotes } {
  const notes: RewriteNotes = { dropped: [], fixed: [], merged: [], omitted: 0, added: [] };
  const out: Record<string, any> = {};
  // 要らない欄を外す
  for (const [key, value] of Object.entries(live)) {
    if (key === 'ownerClock' || key === 'waiting' || key === 'observations') { notes.dropped.push(key); continue; }
    if (key === 'recall') { notes.dropped.push(`recall(${(value?.items ?? []).length})`); continue; }
    out[key] = value;
  }
  const bodyIn = (live.body ?? {}) as Record<string, any>;
  const state = (bodyIn.state ?? {}) as Record<string, any>;
  const self = parsePos(String(state.at ?? '')) ?? null;
  const mapText = typeof bodyIn.map === 'string' ? bodyIn.map : undefined;
  const layers0 = readLayers(mapText);
  const view0 = layers0 ? mapView(layers0) : null;
  // plan: 同じ注意の重複、今の地図と合わない古い注意、body.planNow と同じ plan.now / path
  if (live.plan) {
    const plan = { ...live.plan } as Record<string, any>;
    if (Array.isArray(plan.rules)) {
      const seen = new Set<string>();
      plan.rules = (plan.rules as string[]).filter(rule => {
        const stale = view0 ? staleStand(rule, view0) : false;
        if (stale) { notes.fixed.push(`plan.rules の古い注意を外した「${rule.slice(0, 30)}」（今の地図ではそのマスは立てる）`); return false; }
        const norm = rule.replace(/（p\d+(?:\.\d+)*）/u, ''); if (seen.has(norm)) { notes.merged.push(`plan.rules の重複「${rule.slice(0, 20)}」`); return false; } seen.add(norm); return true;
      });
    }
    const id = /^(p\d+(?:\.\d+)*|r\d+)\s/u.exec(String(plan.now ?? ''))?.[1];
    if (id && typeof bodyIn.planNow === 'string' && bodyIn.planNow.startsWith(`[${id}]`)) { delete plan.now; delete plan.path; notes.dropped.push('plan.now・plan.path（body.planNow と同じ）'); }
    out.plan = plan;
  }
  const body: Record<string, any> = {};
  const map = typeof bodyIn.map === 'string' ? bodyIn.map : undefined;
  const layers = readLayers(map);
  const view = layers ? mapView(layers) : null;
  const feet = layers?.feet ?? self;
  const enemies = self ? mergeEnemies(bodyIn, self, notes) : { urgent: bodyIn.urgent, threats: bodyIn.threats };
  for (const [key, value] of Object.entries(bodyIn)) {
    if (key === 'unreachable') { notes.merged.push('unreachable を敵の行へ'); continue; }
    if (key === 'urgent') { if (enemies.urgent) body.urgent = enemies.urgent; continue; }
    if (key === 'threats') { if (enemies.threats) body.threats = enemies.threats; continue; }
    if (key === 'map') {
      if (view && feet) {
        body.around = aroundLines(view, feet);
        notes.added.push('around');
        const goal = goalOf(String(bodyIn.planNow ?? ''), feet);
        if (goal) {
          body.route = routeLines(view, feet, goal, String(bodyIn.planNow ?? '').match(/^\[([^\]]+)\]/u)?.[1] ?? '今の節');
          notes.added.push('route');
        }
      }
      body.map = normalizeMap(map) ?? value;
      continue;
    }
    if (key === 'state') {
      const copy = { ...(value as Record<string, any>) };
      const biome = String(copy.biome ?? ''), dimension = String(copy.dimension ?? '');
      if (biome && DIM_BIOMES[dimension] && !DIM_BIOMES[dimension]!.test(biome)) { delete copy.biome; notes.fixed.push(`biome ${biome} は ${dimension} に無い物なので外した`); }
      body.state = copy;
      continue;
    }
    if (key === 'inventory' && Array.isArray(value)) { body.inventory = mergeInventory(value as string[], notes); continue; }
    if (key === 'landmarks' && Array.isArray(value) && self) { body.landmarks = fixLandmarks(value as string[], self, notes); continue; }
    if ((key === 'near' || key === 'stops') && Array.isArray(value)) { body[key] = dropOmits(value as string[], notes); continue; }
    if (key === 'lastResults' && Array.isArray(value)) { body.lastResults = (value as string[]).map(text => expandAround(text, notes)); continue; }
    if (key === 'investigation' && Array.isArray(value)) {
      body.investigation = (value as string[]).map(line => { const fixed = line.replace(/（undefined マス）/gu, ''); if (fixed !== line) notes.fixed.push('「undefined マス」を外した'); return fixed; });
      continue;
    }
    body[key] = value;
  }
  out.body = body;
  return { live: out, notes };
}

/** 版の指示文に足す、書き直した live の読み方（短く）。 */
export const REWRITE_LEGEND = [
  '## 足の周りと道の行（コードが地図から作った事実。手は決めない）',
  '- live.body.around: 足の 8 方向の 1 歩と、4 方向の 2 マス先、頭の上、足の下を 1 行ずつ。座標は完全な数。歩きの決まりは walk と同じ（掘らず置かず、上り 1・下り 3 まで。斜めは角のどちらかの列が空いている時だけ）。',
  '  「歩ける」= 足と頭が空き床がある。「掘れば歩ける: 掘る (…)」= その座標を dig すると歩ける。「床が無い（落差 n、下は …）」。「歩けない: …」は理由。足 / 頭 / 床 は先のマスの 3 つの中身（記号と名前）。',
  '- live.body.route: 計画の今の節の目的地への道。「掘らずに行ける範囲」は walk の path に使える点、「掘り k マスまで許した時の」は掘るマスと道の点。敵に見られるか・体力は含まない。目的地が地図の外なら、地図の中で最も近い立ち位置を言う。',
  '- live.body.map: 全部の層が同じ範囲（x の列は層をまたいで同じ位置）。? は範囲の外。^ の列が足の x。層の名前に足からの高さを添えた。',
  '- 敵の行は 1 体 1 行（urgent か threats のどちらか 1 か所）。相対位置は今の足から計算した値。止まった手の周りは、マスごとの座標つき。',
].join('\n');

export { NAME, sign };
