import { reachOf } from './minecraftLlmcReachWords.js';

type Rec = Record<string, unknown>;
interface Blaze { key: unknown; distance: number; visible: boolean }
const rec = (value: unknown): Rec | null => value && typeof value === 'object' ? value as Rec : null;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function frameBlazes(world: Rec): Blaze[] {
  const list = Array.isArray(world.nearbyThreats) ? world.nearbyThreats : [];
  return list.flatMap(raw => {
    const entity = rec(raw);
    if (entity?.name !== 'blaze') return [];
    return [{ key: finite(entity.id) ? `#${entity.id}` : raw,
      distance: finite(entity.distance) ? entity.distance : Infinity, visible: reachOf(entity) === 'seen' }];
  });
}

/** Raw body threats and older live lines use the same visibility words; repeated ids count once. */
export function blazeThreats(world: Rec): Blaze[] {
  const lists = [world.threats, world.urgent].flatMap(list => Array.isArray(list) ? list : []);
  const lines = lists.flatMap(line => {
    const match = typeof line === 'string' ? /^#(\d+) blaze ([\d.]+)m/u.exec(line) : null;
    return match ? [{ key: `#${match[1]}`, distance: Number(match[2]), visible: line.includes('見える（射線の中）') }] : [];
  });
  const unique = new Map<unknown, Blaze>();
  for (const item of [...frameBlazes(world), ...lines]) {
    const old = unique.get(item.key);
    unique.set(item.key, { ...item, visible: item.visible || old?.visible === true });
  }
  return [...unique.values()];
}

/** A named blaze, or a #id resolved from the actual frame, on any of the three combat hands. */
export function onBlaze(hand: Rec, world: Rec): boolean {
  if (!['fight', 'attack', 'shoot'].includes(String(hand.do))) return false;
  const target = typeof hand.target === 'string' ? hand.target.replace(/^minecraft:/u, '') : '';
  return target === 'blaze' || blazeThreats(world).some(blaze => blaze.key === target);
}

export const blazesWithin = (world: Rec, meters: number): number =>
  blazeThreats(world).filter(blaze => blaze.distance <= meters).length;
