import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { endViewOf } from '../src/surfaces/minecraft/minecraftEndView.js';
import { breathLine, endFightLines, inBreathCloud } from '../src/surfaces/minecraft/minecraftEndFacts.js';
import { V2_ALWAYS, V2_STAGES } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';

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
    for (const part of ['今いる所はこの雲の中', '1 秒ごとに 4〜6', '壁を通る', '囲った中で雲を受け続けて', '雲の外のマスへの go']) expect(line).toContain(part);
    expect(line).not.toContain('（中で立ち止まらない）');
    // The rate is not one fixed number (19th run 4, the lab 6), and the input carries no wound value, so none is quoted as a fixed fact.
    expect(line).not.toContain('毎秒 4');
    expect(line).not.toContain('約 5 秒で 20');
    expect(line).toContain('装備で変わると見ている');
    expect(line).toContain('縁まで歩いて約');
  });

  it('says "in the cloud" for certain within 3 m of the centre even when the body gave no radius (a fireball cloud starts at radius 3)', () => {
    const noRadius = { ...cloud, radius: null };
    const end = endViewOf(frame({ position: { x: -11.3, y: 66, z: 0.3 }, dragonBreath: [noRadius], dragonFireballs: 0 }));
    expect(inBreathCloud(end)).toBe(true);
    const line = breathLine(end)!;
    expect(line).toContain('今いる所はこの雲の中（中心から 0m');
    expect(line).toContain('3m 以内は必ず中');
    expect(line).toContain('縁まで歩いて最大で約');
    expect(line).not.toContain('かもしれない');
    expect(line).toContain('雲の外のマスへの go');
    expect(endFightLines(end)[0]).toContain('今いる所はこの雲の中');
  });

  it('keeps the hedged "may be outside" words when the radius is unread and she is 3 to 7 m from the centre', () => {
    const noRadius = { ...cloud, radius: null };
    const end = endViewOf(frame({ position: { x: -11.45 + 5, y: 66, z: 0.45 }, dragonBreath: [noRadius], dragonFireballs: 0 }));
    expect(inBreathCloud(end)).toBe(true);
    const line = breathLine(end)!;
    expect(line).toContain('避ける半径 7 の内');
    expect(line).toContain('実際の雲は 3 から 30 秒で 7 まで広がる');
    expect(line).toContain('まだ雲の外かもしれない');
    expect(line).not.toContain('この雲の中（');
    expect(line).not.toContain('縁まで');
    // Past 7 m, or at 3.1 m with no avoid radius either, it is not under her.
    expect(inBreathCloud(endViewOf(frame({ position: { x: -11.45 + 8, y: 66, z: 0.45 }, dragonBreath: [noRadius], dragonFireballs: 0 })))).toBe(false);
    const noDanger = { ...cloud, radius: null, dangerRadius: null };
    expect(inBreathCloud(endViewOf(frame({ position: { x: -11.45 + 2.5, y: 66, z: 0.45 }, dragonBreath: [noDanger], dragonFireballs: 0 })))).toBe(true);
    expect(inBreathCloud(endViewOf(frame({ position: { x: -11.45 + 3.5, y: 66, z: 0.45 }, dragonBreath: [noDanger], dragonFireballs: 0 })))).toBe(false);
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
    expect(V2_ALWAYS).toContain('a ring did not stop it');
    expect(V2_ALWAYS).not.toContain('walk-out');
    expect(V2_ALWAYS).toContain('not inside a breath cloud: leave it first');
  });

  it('says, in the End stage text, the 19th run as recorded: about 22 s in one place, 10 to 13 s inside the ring, one fireball cloud', () => {
    const end = V2_STAGES.end;
    expect(end).toContain('約 22 秒立ち止まり');
    expect(end).toContain('約 10〜13 秒を囲いの中で過ごして死亡し、火の玉の雲は 1 回だった（19 回目の記録）');
    expect(end).not.toContain('塞いだと見ている');
    expect(end).not.toContain('1 面を空けておくと');
  });
});
