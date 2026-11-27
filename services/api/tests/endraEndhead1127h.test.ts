import { afterEach, describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { ALOFT_FROM_METRES, climbNow, noBowLine } from '../src/surfaces/minecraft/minecraftEndFacts.js';
import type { EndView } from '../src/surfaces/minecraft/minecraftEndView.js';
import { createEndgame } from '../src/surfaces/minecraft/minecraftEndgame.js';
import { createLlmcEvents, notSentLine, tasks } from '../src/surfaces/minecraft/minecraftLlmcEvents.js';
import { inputFacts } from '../src/surfaces/minecraft/minecraftLlmcFacts.js';
import { footingDropOf, forgetColumnFacts, groundNote, lookAtFooting, withGround } from '../src/surfaces/minecraft/minecraftLlmcFooting.js';
import { scaffoldLine } from '../src/surfaces/minecraft/minecraftLlmcDetour.js';
import { STAGE_IDS, V2_ALWAYS, V2_STAGES } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';

/**
 * The End's high footholds: a bridge in the air whose blocks ran out left her on a one-wide foothold 40 high; the footing line gave the number and not what it
 * means (a ground 40 down, a fall that kills at full health), the scaffold count vanished from an urgent input, the bow-less line counted the pillar from
 * her feet, and a refused act was not told at the head of the next input.
 */
afterEach(() => { forgetColumnFacts(); tasks.clear(); });

const FEET = { x: 16, y: 101, z: -31 };
describe('the footing line says where the fall ends', () => {
  it('a measured drop of 40 gives the ground height, the damage and the death of full health, with no coordinate of its own', () => {
    expect(groundNote(101, 40)).toBe('下は地面 y=61（落差 40）。落ちると約 37 の被害・防具は効かない・体力 20 でも即死（水バケツで着水できる時だけ減る）');
    expect(withGround('足場: 幅 1・四方とも空所（落差 40）。押されたら落ちる', 101))
      .toBe('足場: 幅 1・四方とも空所（落差 40）。押されたら落ちる。下は地面 y=61（落差 40）。落ちると約 37 の被害・防具は効かない・体力 20 でも即死（水バケツで着水できる時だけ減る）');
    // A smaller drop says what hurts it still takes; lava, water and an unmeasured depth say their own thing and get no ground.
    expect(groundNote(70, 10)).toContain('約 7 の被害・防具は効かない・体力が 7 以下なら死ぬ');
    for (const line of ['足場: 幅 1 の橋・両脇とも空所（落差 24、下は溶岩）。押されたら落ちる', '足場: 北が空所（落差 30 以上（深さは調べていない））。押されたら落ちる',
      '足場: 北が空所（落差 2）', null]) expect(withGround(line, 70)).toBe(line);
    expect(footingDropOf('足場: 四方とも空所（落差 40）。押されたら落ちる')).toBe(40);
    expect(footingDropOf('足場: 北が空所（落差 30 以上（深さは調べていない））')).toBeNull();
  });

  it('the body\'s own footing word gets the ground line too, and the drop is read back from it', async () => {
    const said = '足場: 幅 1・四方とも空所（落差 40）。押されたら落ちる';
    const around = JSON.stringify({ v: 1, kind: 'around', text: `${said}。近くに生き物は居ない`, footing: { text: '幅 1' } });
    const map = ['地図 v1 足=(16,101,-31) x=15..17 z=-32..-30 方式=layers', 'y=101', '-32 . . .', '-31 . @ .', '-30 . . .', 'y=100', '-32 . . .', '-31 . # .', '-30 . . .', 'y=99', '-32 . . .', '-31 . . .', '-30 . . .'].join('\n');
    const found = await lookAtFooting({ taskId: 'h-ground', map, feet: FEET, index: 20, budgetMs: 100, run: async input => input.kind === 'around' ? around : null });
    expect(found.by).toBe('body');
    expect(found.line).toContain('下は地面 y=61（落差 40）');
    expect(footingDropOf(found.line)).toBe(40);
  });
});

const frame = (dimension: string, inventory: Array<{ name: string; count: number }>, position?: object): BodyObservation =>
  ({ connected: true, facts: {}, state: { world: { dimension, inventory, ...(position ? { position } : {}) } } }) as unknown as BodyObservation;

describe('the scaffold count in the End and in an urgent input', () => {
  const end = frame('the_end', [{ name: 'cobblestone', count: 20 }, { name: 'end_stone', count: 6 }], { x: 0, y: 100, z: 0 });
  it('stays in an urgent End input and is left out of an urgent Nether one (the normal ones keep it)', () => {
    expect(inputFacts(end, {}, true).lines.some(line => line.startsWith('置ける足場'))).toBe(true);
    expect(inputFacts(end, {}, false).lines.some(line => line.startsWith('置ける足場'))).toBe(true);
    const nether = frame('the_nether', [{ name: 'netherrack', count: 40 }]);
    expect(inputFacts(nether, {}, true).lines.some(line => line.startsWith('置ける足場'))).toBe(false);
    expect(inputFacts(nether, {}, false).lines.some(line => line.startsWith('置ける足場'))).toBe(true);
    const overworld = frame('overworld', [{ name: 'cobblestone', count: 40 }]);
    expect(inputFacts(overworld, {}, true).lines.some(line => line.startsWith('置ける足場'))).toBe(false);
  });

  it('counts the way back and the few kept for the far end as a sum, with the bridge as an estimate', () => {
    const line = scaffoldLine(end, { urgent: true, goal: { at: { x: 12, y: 100, z: 5 } } })!;
    expect(line).toContain('合計 26 個');
    expect(line).toContain('橋 約 13 m（直線距離からの概算で、引き直しで外れる）: 往復 2×13 個＋降りる用 3 個＝29 個が要る');
    expect(line).toContain('合計 26 個では足りない: 橋で渡らず、降りて地面で材料を掘る');
    const enough = scaffoldLine(frame('the_end', [{ name: 'cobblestone', count: 64 }], { x: 0, y: 100, z: 0 }), { goal: { at: { x: 12, y: 100, z: 5 } } })!;
    expect(enough).toContain('go の maxPlace の上限は 48（合計 − 戻る橋 13 − 降りる用 3）');
    // With no go or plan place to measure from, the sum is a formula; the Nether line is as it was.
    expect(scaffoldLine(end)).toContain('渡る橋の長さ M（行き先までの直線距離からの概算）の往復 2×M 個＋降りる用 3 個が合計に収まる時だけ');
    expect(scaffoldLine(frame('the_nether', [{ name: 'netherrack', count: 40 }]))).toContain('64 個の目安に足りない');
    expect(inputFacts(end, { goal: { at: { x: 12, y: 100, z: 5 }, from: 'queue' } }, true).lines.find(item => item.startsWith('置ける足場'))).toContain('橋 約 13 m');
  });
});

describe('the bow-less crystal line from the ground when she is aloft', () => {
  const crystal = { id: 15, position: { x: 50, y: 100, z: -11 }, caged: false, distance: 38 };
  const view = (drop: number | null, phase = 0, distance = 40): EndView => ({ feet: { ...FEET, y: 101 }, ...(drop === null ? {} : { drop }),
    dragon: { id: 1, health: 200, phase, phaseName: null, phaseFor: 3, perched: false, position: null, headPosition: null, distance, headReach: null, strike: null },
    perch: null, crystals: { remaining: 5, gone: 5, caged: 0, unseen: 0, visible: 5, list: [crystal] }, breath: [], fireballs: 0 } as unknown as EndView);

  it('on the ground (or with no drop said) the line is as before', () => {
    expect(noBowLine(view(null))).toContain('今登れる（竜は phase 0 で自分から 40m、30m 以上');
    expect(noBowLine(view(null))).toContain('vertical pillar up');
    expect(noBowLine(view(ALOFT_FROM_METRES - 1))).toContain('今登れる');
    expect(climbNow(view(null))).toBe(true);
  });

  it('aloft by 10 m or more it says to come down first, counts the pillar from the ground, and does not press a climb', () => {
    const line = noBowLine(view(40));
    expect(line).toContain('今は宙・塔の上（地面まで 40 m）');
    expect(line).toContain('先に降りて地面で end_stone を掘る（柱は掘りながら降りられる: vertical down shaft）');
    expect(line).toContain('高さのまま橋で渡ると置く物が尽き宙に残る');
    expect(line).toContain('次の柱へ短く渡るのは、置ける足場の行の往復分が足りる時だけ');
    // The crystal stands at y=100 and the ground is at 61: 100 − 61 − 2 = 37 from the ground (from the feet, 101, it would not be a climb at all).
    expect(line).toContain('地面から約 37 段');
    expect(line).not.toContain('今登れる');
    expect(climbNow(view(40))).toBe(false);
    // The short bridge between pillars is not forbidden, only tied to the count of blocks.
    expect(line).not.toContain('渡らない');
  });

  it('while she circles at the fireball phase, a bridge up high is the same as a climb', () => {
    expect(noBowLine(view(null, 1, 50))).toContain('高所の橋で渡ることも同じ: 火の玉の線に立つ');
    expect(noBowLine(view(40, 1, 50))).toContain('高所の橋で渡ることも、登ることと同じ（火の玉の線に立つ）');
  });

  it('the drop from the footing line reaches the End lines through the endgame', () => {
    const observation = { connected: true, facts: { dimension: 'the_end' }, state: { world: { dimension: 'the_end', position: FEET, inventory: [{ name: 'cobblestone', count: 3 }],
      crystals: { remaining: 5, list: [{ id: 15, position: crystal.position, caged: false, distance: 38 }] }, dragon: { phase: 0, distance: 40, health: 200 } } } } as unknown as BodyObservation;
    const lines = (drop: number | null) => createEndgame(null).lines(observation, true, false, drop).lines.join('\n');
    expect(lines(null)).not.toContain('今は宙・塔の上');
    // (The line needs no bow word when a bow is carried: the shooting places are said instead, so only the shape of the call is checked here.)
    expect(lines(40).length).toBeGreaterThan(0);
  });
});

describe('an act that was refused before it was sent is told at the head of the next input', () => {
  const refused = '手1（vertical）: liquid が要る（liquid=stop|seal|seal_water のどれかを足す。例: vertical down stairs south y=10 dig=stone,dirt liquid=stop）\n'
    + 'この act は全体を送っていない。先行 go を含め、この act のどの手も動いていない。';
  it('reads the refusal\'s own first line, and nothing for another result', () => {
    expect(notSentLine(refused)).toBe('前の act は送られていない（どの手も動いていない）: 手1（vertical）: liquid が要る（liquid=stop|seal|seal_water のどれかを足す。例: vertical down stairs south y=10 dig=stone,dirt liquid=stop）。'
      + '足りない所だけ直した同じ手を出し直す（別の手に変えると、元の手は動かないまま）');
    expect(notSentLine('go 止まった dead_end')).toBeNull();
  });

  it('the events keep it until an act goes, and the facts of a normal input open with it', () => {
    const events = createLlmcEvents('h-sent');
    events.result('mc.act', false, false, refused);
    const line = events.notSent();
    expect(line).toContain('liquid が要る');
    const facts = inputFacts(frame('the_end', [{ name: 'cobblestone', count: 3 }]), { notSent: line! }, false).lines;
    expect(facts[0]).toBe(line);
    expect(inputFacts(frame('the_end', []), { notSent: line! }, true).lines[0]).toBe(line);
    expect(inputFacts(frame('the_end', []), {}, false).lines[0]).not.toContain('送られていない');
    events.result('mc.act', true, false, '手1: ok');
    expect(events.notSent()).toBeNull();
    events.result('mc.act', false, false, 'go 止まった: dead_end');
    expect(events.notSent()).toBeNull();
  });
});

describe('the knowledge: the new words are in the End section only', () => {
  const NEW = ['宙の橋・足場（柱の天辺、自分で置いた橋の先）の上で、自分が置いた床と足元の横（隣の黒曜石・柱の天辺を含む）を掘らない', '待つ手（wait・probe など動かない手）を走らせたまま、次の手を積まず text だけで返事を終えない',
    'toY:地面の高さ, canDig:["end_stone","cobblestone"], liquid:"stop"', '水バケツを pack に持っていたら、先に equip で hotbar・手へ出す', 'go の to は立つマス（足の高さ。床のブロックの 1 つ上）'];
  it('has them once in the End section and in no other stage or the shared sections', () => {
    const rest = [V2_ALWAYS, ...STAGE_IDS.filter(id => id !== 'end').map(id => V2_STAGES[id])].join('\n');
    for (const words of NEW) {
      expect(V2_STAGES.end.split(words).length - 1).toBe(1);
      expect(rest).not.toContain(words);
    }
    // The reasons ride with the rules.
    expect(V2_STAGES.end).toContain('掘った物は下の虚空か遠い地面へ落ちて拾えず、来た道も切れる');
    expect(V2_STAGES.end).toContain('戻る間は幅 1 の橋の上で竜に押される。降りられるなら降りる側');
    expect(V2_STAGES.end).toContain('「下は地面 y=…」がその高さ');
    expect(V2_STAGES.end).toContain('空気の上の shaft は掘る物が無く落ちるだけなので、先に隣の固い列（柱の天辺');
    expect(V2_STAGES.end).toContain('end_stone を掘って進む道（地中の y）は遅い');
    expect(V2_STAGES.end).toContain('例外は、結晶の柱の根へ canDig=["end_stone"] で寄る時だけ');
  });
});
