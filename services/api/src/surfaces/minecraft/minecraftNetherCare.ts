import type { BodyObservation } from '../../contracts/bodyControlContract.js';

/**
 * The Nether's first minute (mb-r24, Minecraft run 24: 39 s after the gate the server logged "Can't keep up" for 5.3 s, took back twelve
 * digs of netherrack and cut the body off; it came back in 12 s). The server makes the chunks of the Nether as she arrives, and a dig sent
 * then is taken back. What the head can do: say so in the decision's lines for the first seconds (no dig, no run; look at the ground, a
 * short wait or a few steps to a safe place), and from three failed digs among the latest results, stop digging and wait. Closed numbers
 * and fixed words.
 */
export const NETHER_CARE = Object.freeze({ settleMilliseconds: 20_000, digFailures: 3, waitSeconds: 10 });
const DIG_TOOL = /mine-block|dig-block|stair-mine|dig-shelter/u;

type Recent = ReadonlyArray<{ name: string; ok: boolean; summary: string }>;
const dimensionOf = (observation: BodyObservation | null) => {
  const value = observation?.facts.dimension ?? (observation?.state as { world?: { dimension?: unknown } } | undefined)?.world?.dimension;
  return typeof value === 'string' ? value.replace(/^minecraft:/u, '') : null;
};

/** The lines for the Nether now (none elsewhere): the first seconds after arriving, and digs that keep failing. */
export function netherCareLines(observation: BodyObservation | null, recent: Recent, arrivedAt: number | null, now: number): string[] {
  if (dimensionOf(observation) !== 'the_nether') return [];
  const since = arrivedAt === null ? null : now - arrivedAt;
  const dug = recent.filter(result => DIG_TOOL.test(result.name)).slice(-NETHER_CARE.digFailures);
  return [
    ...(since !== null && since >= 0 && since < NETHER_CARE.settleMilliseconds
      ? [`ネザーに着いて${Math.round(since / 1000)}秒。この間サーバーがチャンクを作って重く、掘りが巻き戻ったり切断されたりする。`
        + `着いて${Math.round(NETHER_CARE.settleMilliseconds / 1000)}秒は掘らない・走らない: 足元（マグマ・溶岩）を確かめ、mc.wait-time を5〜${NETHER_CARE.waitSeconds}秒か、近くの安全な所へ歩く`] : []),
    ...(dug.length >= NETHER_CARE.digFailures && dug.every(result => !result.ok)
      ? [`ネザーで掘りが${NETHER_CARE.digFailures}回続けて失敗している（サーバーが重いか足場が悪い）。同じ掘りを重ねず、mc.wait-time を${NETHER_CARE.waitSeconds}秒待ってから、別の向き・別の足場で`] : []),
  ];
}

/** The situation with the Nether's lines among its route lines (the lines every decision carries); as it was elsewhere. */
export function withNetherCare<T extends { route?: readonly string[] }>(situation: T, observation: BodyObservation | null, recent: Recent,
  arrivedAt: number | null, now: number): T {
  const lines = netherCareLines(observation, recent, arrivedAt, now);
  return lines.length ? { ...situation, route: [...(situation.route ?? []), ...lines] } : situation;
}
