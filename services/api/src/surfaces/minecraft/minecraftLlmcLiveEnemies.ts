import { ptText, type P } from './minecraftLlmcWalkRules.js';

/**
 * mb-llmc v2 live (改修案 2.2; 再現台 v9b R4): one line for each hostile. The live state said the same hostile in `urgent` (no id: 「blaze 4.3m」),
 * in `unreachable` (id, 「壁の向こうで届かない」) and in `threats` (id, place), so that 「blaze 4.3m」 and 「blaze #5 4.0m・壁の向こうで届かない」
 * read as two blazes (2 scenes of 45). The three lists are joined by the hostile's id; the relative place is worked out from her feet now;
 * an urgent line without an id is joined to the hostile of its kind nearest in distance (within 0.6 m: an inference, said in the notes).
 */
interface Enemy { id: string; name: string; dist: number; pos: P | null; notes: string[]; urgent: boolean; wait: boolean }
export const OMIT = /^ほか(\d+)件（長いため略）$/u;

/** The relative place in words (east/west, then south/north, then up/down; a zero part is not written). */
export function relText(self: P, target: P): string {
  const parts: string[] = [];
  const dx = target.x - self.x, dz = target.z - self.z, dy = target.y - self.y;
  if (dx) parts.push(`${dx > 0 ? '東' : '西'}${Math.abs(dx)}`);
  if (dz) parts.push(`${dz > 0 ? '南' : '北'}${Math.abs(dz)}`);
  if (dy) parts.push(`${dy > 0 ? '上' : '下'}${Math.abs(dy)}`);
  return parts.length ? parts.join('・') : '同じマス';
}
const detail = (rest: string): string => rest.replace(/^(?:上|下) \d+・?/u, '').replace(/^・/u, '');

class Hostiles {
  readonly byId = new Map<string, Enemy>();
  readonly order: string[] = [];
  touch(id: string, name: string, dist: number): Enemy {
    let enemy = this.byId.get(id);
    if (!enemy) {
      enemy = { id, name, dist, pos: null, notes: [], urgent: false, wait: false };
      this.byId.set(id, enemy);
      this.order.push(id);
    }
    return enemy;
  }
  all(): Enemy[] { return this.order.map(id => this.byId.get(id)!); }
}

/** The enemy lines of a body live: `urgent` (nearest first, with the hostile's facts) and `threats` (the rest), each hostile once. */
export function mergeEnemies(body: Record<string, unknown>, self: P): { urgent: string[] | undefined; threats: string[] | undefined; merged: number } {
  const list = (key: string): string[] => Array.isArray(body[key]) ? (body[key] as unknown[]).filter((item): item is string => typeof item === 'string') : [];
  const hostiles = new Hostiles();
  const omitted: string[] = [];
  for (const line of list('threats')) {
    const m = /^#(\d+) (\S+) ([\d.]+)m \((-?\d+),(-?\d+),(-?\d+)\)$/u.exec(line);
    if (m) hostiles.touch(m[1]!, m[2]!, Number(m[3])).pos = { x: +m[4]!, y: +m[5]!, z: +m[6]! };
    else if (OMIT.test(line)) omitted.push(line);
  }
  for (const line of list('unreachable')) {
    const m = /^(\S+) #(\d+) ([\d.]+)m・(.*)$/u.exec(line);
    if (!m) continue;
    const enemy = hostiles.touch(m[2]!, m[1]!, Number(m[3]));
    enemy.dist = Number(m[3]);
    enemy.notes.push(detail(m[4]!));
  }
  const { kept, anonymous } = urgentInto(hostiles, list('urgent'));
  for (const item of anonymous) {
    const near = hostiles.all().filter(e => e.name === item.name && Math.abs(e.dist - item.dist) <= 0.6)
      .sort((a, b) => Math.abs(a.dist - item.dist) - Math.abs(b.dist - item.dist))[0];
    if (near) near.urgent = true;
    else kept.push(item.line);
  }
  const text = (e: Enemy) => {
    const rel = e.pos ? ` ${ptText(e.pos)} ${relText(self, e.pos)}` : '';
    const note = e.notes.filter(Boolean).join('・');
    return `#${e.id} ${e.name} ${e.dist}m${rel}${e.wait ? '（判断を待つ間に出た）' : ''}${note ? `・${note}` : ''}`;
  };
  const all = hostiles.all();
  const urgent = [...all.filter(e => e.urgent).sort((a, b) => a.dist - b.dist).map(text), ...kept];
  const threats = [...all.filter(e => !e.urgent).sort((a, b) => a.dist - b.dist).map(text),
    ...omitted.map(line => `（${line.replace(/（長いため略）/u, '')}は略）`)];
  const before = list('threats').length + list('unreachable').length + list('urgent').length;
  const merged = Math.max(0, before - urgent.length - threats.length);
  return { urgent: Array.isArray(body.urgent) ? urgent : undefined,
    threats: Array.isArray(body.threats) || Array.isArray(body.unreachable) ? threats : undefined, merged };
}

/** The urgent lines with a hostile's id go into its record; the others come back (a line with a name and a distance only, and the rest). */
function urgentInto(hostiles: Hostiles, lines: readonly string[]): { kept: string[]; anonymous: Array<{ name: string; dist: number; line: string }> } {
  const kept: string[] = [];
  const anonymous: Array<{ name: string; dist: number; line: string }> = [];
  for (const line of lines) {
    const m = /^(急ぎ: 判断を待つ間に )?(\S+) #(\d+) ([\d.]+)m・(.*)$/u.exec(line);
    if (m) {
      const e = hostiles.touch(m[3]!, m[2]!, Number(m[4]));
      e.dist = Number(m[4]);
      e.urgent = true;
      e.wait ||= !!m[1];
      const text = detail(m[5]!);
      if (!e.notes.includes(text)) e.notes.push(text);
      continue;
    }
    const anon = /^(\S+) ([\d.]+)m$/u.exec(line);
    if (anon) anonymous.push({ name: anon[1]!, dist: Number(anon[2]), line });
    else kept.push(line);
  }
  return { kept, anonymous };
}
