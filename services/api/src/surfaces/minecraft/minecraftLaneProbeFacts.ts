import type { ActPos } from '../../contracts/minecraftActContract.js';
import type {
  LaneCandidateReading, LaneDirection, LanePair, LaneProbeReading, LaneRequired,
} from '../../contracts/minecraftLaneProbeContract.js';

const DIRECTIONS: Readonly<Record<LaneDirection, string>> = { east: '東', west: '西', south: '南', north: '北' };
const direction = (value: LaneDirection | null) => value ? DIRECTIONS[value] : '向き不明';
const number = (value: number | null) => value === null ? '不明' : String(value);
const pos = (at: ActPos | null) => at ? `(${at.x},${at.y},${at.z})` : '不明';
const pair = (value: LanePair) => `${pos(value[0])}/${pos(value[1])}`;

/** The body's text is a fallback, once. Its construction-order sentences are deliberately not model input. */
function fallback(text: string, absent: string): string {
  const sentences = text.slice(0, 600).split(/[。\n]/u).map(line => line.trim()).filter(Boolean);
  const fact = sentences.find(line => !/せよ|しろ|建てる|建築順|先にする|調べる|してください|\b(?:go|place)\b|→/u.test(line));
  return fact ? fact.slice(0, 200) : absent;
}
function site(r: LaneProbeReading): string {
  const b = r.blaze;
  const limit = b.atLimit === true ? '（湧きが止まる数に達している）' : '';
  const unknown = r.spawn.unknown ? `・不明${r.spawn.unknown}` : '';
  return `lane: スポナー ${pos(r.spawner)} ／ 数え箱の生き残り ${number(b.count)}/${number(b.limit)}${limit}`
    + ` ／ 湧ける空間 ${number(r.spawn.spaces)}か所${unknown}（床・明るさを含まない）`;
}
function needed(r: LaneRequired): string {
  const unknown = r.unknown === null || r.unknown > 0 || r.complete !== true ? '・不明あり' : '';
  return `必要 ${number(r.total)}個（囲み${number(r.enclosure)}・屋根${number(r.roof)}・栓${number(r.plug)}・蓋${number(r.lid)}）${unknown}`;
}
function marks(c: LaneCandidateReading): string {
  const m = c.marks;
  const unknown = m?.unknown ? `（印不明${m.unknown}）` : '';
  return `待ち場から手が届かない ${number(m?.outOfReach ?? null)}・見えない ${number(m?.invisible ?? null)}`
    + `・支え無し ${number(m?.noSupport ?? null)}${unknown} ／ 片付け ${number(c.clear)}・危険 ${number(c.hazards)}`;
}
function outside(c: LaneCandidateReading): string[] {
  if (c.remainingOutsideLane === null && c.unknownOutsideLane === null) return [];
  return [`指定の形で通路外の湧ける空間 ${number(c.remainingOutsideLane)}か所・不明 ${number(c.unknownOutsideLane)}か所`];
}

/** At most eight fact lines, for both the tool reply and a live investigation. No raw tables or placement sequence. */
export function laneProbeFacts(r: LaneProbeReading): string {
  if (r.found === false) return `lane: ${fallback(r.text, '湧き場は見つかっていない')}`;
  const c = r.best;
  if (!c) return [site(r), `候補なし: ${fallback(r.text, '向きの観測なし')}`].join('\n');
  const stands = c.stands?.length ? c.stands.map(at => pos(at)).join(' ') : '不明';
  const others = r.others.map(c => `${direction(c.direction)}: ${number(c.total)}個`).join(' ／ ');
  return [site(r), `最少 ${direction(c.direction)}: ${needed(c.required)}`,
    `栓 ${pos(c.plug)} ／ 待ち場（足/頭）${pair(c.waiting)}`,
    `通路（足/頭、観測${c.lane.length}マス）${c.lane.map(pair).join(' ') || '不明'}`,
    `立つ所（先頭3か所まで）${stands}`, marks(c), ...outside(c),
    ...(others ? [`他の向き: ${others}`] : [])].join('\n');
}
