import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { createEndgame } from '../src/surfaces/minecraft/minecraftEndgame.js';
import { createEyeLedger, sidewaysTries } from '../src/surfaces/minecraft/minecraftEyeLedger.js';
import { bearingBetween } from '../src/surfaces/minecraft/minecraftEyeTriangulation.js';
import { seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { V2_STAGES } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';

type Place = { x: number; z: number };
const TARGET: Place = { x: -1072, z: 928 };
const NOW = 10_000;
const frame = (dimension: string, position?: Place): BodyObservation => ({
  connected: true,
  state: { world: { dimension, ...(position ? { position: { ...position, y: 70 } } : {}) } },
  facts: {},
  bodyId: 'b',
  sequence: 1,
  stateAt: new Date(NOW).toISOString(),
}) as unknown as BodyObservation;

/** Synthetic precise reports about 24 m apart, using the lab's starting place and target. */
function report(from: Place, target = TARGET): string {
  const distance = Math.hypot(target.x - from.x, target.z - from.z);
  const unit = { x: (target.x - from.x) / distance, z: (target.z - from.z) / distance };
  return JSON.stringify({
    v: 1, done: 1, of: 1, lines: [{ i: 1, do: 'use', status: 'done' }],
    eye: { from, origin: from, to: { x: from.x + unit.x * 12, z: from.z + unit.z * 12 },
      bearingDeg: bearingBetween(from, target), unit, flew: 12, broke: false },
  });
}

function measuredLedger(target = TARGET) {
  const ledger = createEyeLedger(null);
  ledger.note('first', report({ x: 135, z: 104 }, target), 'overworld', NOW - 1000);
  ledger.note('second', report({ x: 121, z: 84 }, target), 'overworld', NOW);
  return ledger;
}

describe('the short eye baseline and travel through the Nether', () => {
  it('offers a short baseline after one precise flight and reports the intersection after two, including after restore', () => {
    const ledger = createEyeLedger(null);
    ledger.note('first', report({ x: 135, z: 104 }), 'overworld', NOW);
    expect(ledger.lines(null, NOW).join('\n')).toMatch(/次は .+（最後の線の横 \S+ 24m）で投げる/u);
    ledger.note('second', report({ x: 121, z: 84 }), 'overworld', NOW);
    const restored = createEyeLedger(ledger.checkpoint().minecraftEyes);
    expect(restored.fix(NOW)).toMatchObject({ ...TARGET, throws: 2 });
    const lines = restored.lines({ x: 121, z: 84 }, NOW).join('\n');
    expect(lines).toContain('交点 (-1072,928)');
    expect(lines).not.toContain('交点はまだ無い');
    expect(restored.fix(NOW)!.errorBlocks).toBeGreaterThan(80);
    expect(restored.fix(NOW)!.errorBlocks).toBeLessThan(100);
  });

  it('shows one converted line, with direction and distance measured from the current Nether position', () => {
    const endgame = createEndgame(measuredLedger().checkpoint(), () => NOW);
    const lines = endgame.lines(frame('minecraft:the_nether', { x: 0, z: 0 }), true).lines;
    const eyes = lines.filter(line => /交点|目玉の帳簿|次に投げる場所/u.test(line));
    expect(eyes).toEqual(['要塞の交点 (-1072,928) のネザー座標 (-134,116)・あなたから 南西 177m（ネザーの座標で）']);
    const moved = endgame.lines(frame('the_nether', { x: -134, z: 100 }), true).lines;
    expect(moved).toContain('要塞の交点 (-1072,928) のネザー座標 (-134,116)・あなたから 南 16m（ネザーの座標で）');
    expect(endgame.lines(frame('overworld', { x: 135, z: 104 }), true).lines.join('\n')).toContain('交点 (-1072,928)');
  });

  it('keeps fractional coordinates and omits the unknown current direction and distance', () => {
    const endgame = createEndgame(measuredLedger({ x: -1071, z: 929 }).checkpoint(), () => NOW);
    expect(endgame.lines(frame('the_nether'), true).lines).toContain(
      '要塞の交点 (-1071,929) のネザー座標 (-133.875,116.125)（ネザーの座標で）');
  });

  it('omits an absent or expired intersection and limits the display to a dragon task before the End', () => {
    const nether = frame('the_nether', { x: 0, z: 0 });
    const expired = createEndgame(measuredLedger().checkpoint(), () => NOW + 4 * 3_600_000 + 1);
    expect(expired.lines(nether, true).lines.join('\n')).not.toContain('交点');
    expect(createEndgame(null).lines(nether, true).lines.join('\n')).not.toContain('交点');
    const one = createEndgame(null, () => NOW);
    one.noteResult('first', report({ x: 135, z: 104 }), frame('overworld'));
    expect(one.lines(nether, true).lines.join('\n')).not.toContain('交点');
    const endgame = createEndgame(measuredLedger().checkpoint(), () => NOW);
    expect(endgame.lines(nether, false).lines).toEqual([]);
    expect(endgame.lines(frame('the_end'), true).lines.join('\n')).not.toContain('交点');
    expect(endgame.checkpoint().minecraftEyes.throws).toEqual([]);
  });
});

describe('the stronghold route knowledge and the seed plan', () => {
  it('describes the short baseline and portal recovery that preserves the twelve fighting blocks', () => {
    const knowledge = V2_STAGES.stronghold;
    expect(knowledge).toContain('精密な線の横へ 24〜32m');
    expect(knowledge).toContain('交角 0.5° 以上');
    expect(knowledge).not.toContain('50〜100m 離れた 2 か所');
    expect(knowledge).not.toContain('最後の線の横へ 200m 以上');
    expect(knowledge).toContain('交点を出す → ネザーに入り直す → 入った側のゲートの枠を回収');
    expect(knowledge).toContain('掘る前にネザー側の座標を控え');
    expect(knowledge).toContain('枠の黒曜石 10 をダイヤのツルハシで回収');
    expect(knowledge).toContain('1 個 9.4 秒、計約 94 秒');
    expect(knowledge).toContain('2 つ目のゲートの分になり、竜戦用の 12 は残る');
    expect(knowledge).toContain('回収したゲートは帰りには使わない');
  });

  it('keeps existing node IDs and the first twenty-two blocks while recording recovery beside the stronghold step', () => {
    const tree = seedPlan('エンドラを討伐して', 'the_nether')!;
    expect(tree.nodes.filter(node => node.parentId === 'p8').map(node => node.id)).toEqual(['p8.1', 'p8.2']);
    const step = tree.nodes.find(node => node.id === 'p8.1')!;
    expect(step.doneWhen).toBe('see:end_portal_frame');
    const caution = step.caution!.join('\n');
    expect(caution).toContain('交点が出た後にネザーへ入り直し、掘る前にネザー側のゲート座標を控える');
    expect(caution).toContain('枠の黒曜石 10');
    expect(caution).toContain('ダイヤのツルハシ');
    expect(caution).toContain('計約 94 秒');
    expect(caution).toContain('竜戦用の 12 を残せる');
    expect(caution).toContain('回収したゲートは帰りには使わない');
    const initial = seedPlan('エンドラを討伐して')!;
    expect(initial.nodes.find(node => node.title === '溶岩源で黒曜石22（ゲート10・竜戦12）')?.doneWhen).toBe(
      'have:obsidian>=22|dim:the_nether');
  });
});

describe('the throws along one line are one try (S5, 11/5)', () => {
  const line = (x: number, z: number, bearingDeg: number) => ({ id: `${x},${z}`, at: 0, x, z, toX: x, toZ: z, bearingDeg, flew: 30, precise: true }) as never;
  it('counts only lines thrown 12 m or more sideways of every earlier one', () => {
    // Bearing 180 (south): a line along z. Throws further south on it are the same line; 24 m east is a new one.
    expect(sidewaysTries([line(0, 0, 180), line(0, 40, 180), line(1, 80, 180), line(0, 120, 180)])).toBe(0);
    expect(sidewaysTries([line(0, 0, 180), line(24, 0, 181)])).toBe(1);
    expect(sidewaysTries([line(0, 0, 180), line(0, 40, 180), line(24, 40, 181), line(24, 80, 181)])).toBe(1);
  });
});
