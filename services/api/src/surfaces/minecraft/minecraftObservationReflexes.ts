import type { BodyValue } from '../../contracts/bodyControlContract.js';

/**
 * Two parts of the body's world frame said in a line each, so the summary of an observation reads them without parsing JSON
 * (Minebot P8, 2026-10-17): `reflexes` (what the body's own reflexes did lately) and `jobs` (furnaces still working). A line is
 * a scalar: it is never dropped by the summary's size reduction, which only removes structured parts. A shape this does not
 * know returns null, and the part is handled as any other (kept as it is when small, else omitted by name).
 */
const LINE = 320;
const record = (value: BodyValue | undefined): value is { readonly [key: string]: BodyValue } => !!value && typeof value === 'object' && !Array.isArray(value);
/** A line cut at `LINE`, never between the halves of a surrogate pair (a lone half is refused by the provider). */
const clip = (text: string) => {
  if (text.length <= LINE) return text;
  const keep = /[\uD800-\uDBFF]/u.test(text[LINE - 2] ?? '') ? LINE - 2 : LINE - 1;
  return `${text.slice(0, keep)}…`;
};
const number = (value: BodyValue | undefined) => typeof value === 'number' && Number.isFinite(value) ? value : null;

/** `体の反射（新しい順）: 5秒前 盾を構えた／40秒前 食事（パン）｜接続以来 shield×3 eat×1`. */
export function reflexesLine(value: BodyValue | undefined): string | null {
  if (!record(value) || !Array.isArray(value.recent)) return null;
  const recent: string[] = [];
  for (const item of value.recent as readonly BodyValue[]) {
    if (!record(item) || typeof item.detail !== 'string' || number(item.ageSec) === null) return null;
    recent.push(`${number(item.ageSec)}秒前 ${item.detail}`);
  }
  if (!recent.length) return null;
  const counts = record(value.counts) ? Object.entries(value.counts).flatMap(([kind, n]) => number(n) !== null ? [`${kind}×${n}`] : []) : [];
  return clip(`体の反射（新しい順）: ${recent.join('／')}${counts.length ? `｜接続以来 ${counts.join(' ')}` : ''}`);
}

const STATUS: Readonly<Record<string, string>> = { waiting_external: '作業中', verification_due: '時間が来た（取り出して確かめる）', different_dimension: '別のディメンションにある' };

/** `炉（見込みで、完了の確認ではない）: raw_iron×8 残り約80秒 作業中 (3,64,-2)／…`. */
export function jobsLine(value: BodyValue | undefined): string | null {
  if (!Array.isArray(value) || !value.length) return null;
  const jobs: string[] = [];
  for (const item of value as readonly BodyValue[]) {
    if (!record(item) || typeof item.status !== 'string' || !record(item.position)) return null;
    const left = number(item.remainingEstimateMs), at = item.position;
    const where = [at.x, at.y, at.z].map(number);
    if (left === null || where.includes(null)) return null;
    const remaining = left > 0 ? `残り約${Math.round(left / 1000)}秒 ` : '', unfuelled = number(item.unfueledInputCount);
    jobs.push(`${String(item.input)}×${String(item.count)} ${remaining}${STATUS[item.status] ?? item.status} (${where.join(',')})`
      + (unfuelled ? ` 燃料不足${unfuelled}個` : ''));
  }
  return clip(`炉（見込みで、完了の確認ではない）: ${jobs.join('／')}`);
}
