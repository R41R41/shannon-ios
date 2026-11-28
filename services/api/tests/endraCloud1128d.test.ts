import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { endViewOf } from '../src/surfaces/minecraft/minecraftEndView.js';
import { breathLine, endFightLines, inBreathCloud } from '../src/surfaces/minecraft/minecraftEndFacts.js';
import { V2_ALWAYS } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';

const frame = (world: object): BodyObservation => ({ connected: true, state: { world: { dimension: 'the_end', ...world } }, facts: {} }) as unknown as BodyObservation;
/** The 19th run's cloud #300: centre (-11.45,66,0.45), radius 4 (grown from 3), she stood at (-11.3,66,0.3). */
const cloud = { x: -11.45, y: 66, z: 0.45, radius: 4, dangerRadius: 7 };
const view = (position: object | null) => endViewOf(frame({ ...(position ? { position } : {}), dragonBreath: [cloud], dragonFireballs: 0 }));

describe('19th run: a breath cloud she stands in is said with its cost, its way out and why a ring does not help', () => {
  it('says she is in the cloud, the damage a second, that walls do not stop it and the way out', () => {
    const end = view({ x: -11.3, y: 66, z: 0.3 });
    expect(inBreathCloud(end)).toBe(true);
    const line = breathLine(end)!;
    expect(line.startsWith('竜の息の雲:')).toBe(true);
    for (const part of ['今いる所はこの雲の中', '毎秒 4 の傷', '壁を通る', '囲った中で 6 秒', '雲の外のマスへの go']) expect(line).toContain(part);
    expect(line).not.toContain('（中で立ち止まらない）');
  });

  it('keeps the old line when she is outside the cloud, off its height, or her place is unknown', () => {
    const old = '竜の息の雲: (-12,0) 避ける半径 7（雲の今の半径 4）（中で立ち止まらない）';
    expect(breathLine(view({ x: -11.3, y: 66, z: 8 }))).toBe(old);
    expect(inBreathCloud(view({ x: -11.3, y: 80, z: 0.3 }))).toBe(false);
    expect(breathLine(view(null))).toBe(old);
    expect(inBreathCloud(view(null))).toBe(false);
  });

  it('leads the fight lines while she stands in the cloud, and not otherwise', () => {
    expect(endFightLines(view({ x: -11.3, y: 66, z: 0.3 }))[0]).toContain('今いる所はこの雲の中');
    expect(endFightLines(view({ x: 30, y: 66, z: 30 })).some(line => line.startsWith('竜の息の雲:'))).toBe(true);
  });

  it('tells the head, in the instructions, that enclosing is not for a breath cloud and why', () => {
    expect(V2_ALWAYS).toContain('not against a dragon\'s breath cloud');
    expect(V2_ALWAYS).toContain('a ring round the feet blocks the body\'s walk-out');
    expect(V2_ALWAYS).toContain('not inside a breath cloud: leave it first');
  });
});
