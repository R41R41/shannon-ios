import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { minecraftV2System } from '../src/infra/models/anthropic/anthropicFcaMinecraftSystem.js';
import { stageKnowledge, V2_ALWAYS, V2_STAGES } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';
import { NETHER_BY_SECONDS, SAFETY_FIRST } from '../src/surfaces/minecraft/minecraftLlmcPrepRules.js';
import { recoveryLine } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';
import { lookHint } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { packLines } from '../src/surfaces/minecraft/minecraftLlmcPack.js';
import { URGENT_NOTE } from '../src/surfaces/minecraft/minecraftLlmcUrgent.js';
import { BED_FROM, dayBedLine } from '../src/surfaces/minecraft/minecraftNightArms.js';

/**
 * The 11/11 trim of what the head reads at every decision (the owner took the recommendation of the prompt review: section 4). The tests of what each rule
 * says stay where they were; these are the ones the trim itself needs.
 */
const source = (name: string): string => readFileSync(new URL(`../src/surfaces/minecraft/${name}`, import.meta.url), 'utf8');

describe('the live dictionary leaves out the fields whose live line says what it is by itself', () => {
  // If one of these lines loses the wording below, the dictionary entry it replaced has to come back (the entries were one line each in `V2_ALWAYS`, 11/11).
  const dictionary = V2_ALWAYS.slice(V2_ALWAYS.indexOf('## live の項目辞典'), V2_ALWAYS.indexOf('## 地図'));
  it('has no entry for shortage, recovery, footing, away, look, repeat, pack or mode', () => {
    for (const field of ['shortage', 'recovery', 'footing', 'away', 'look', 'repeat', 'pack']) {
      expect(dictionary, field).not.toMatch(new RegExp(`(^- |[。・])${field}[:：・]`, 'mu'));
    }
    expect(dictionary).not.toContain('mode「急ぎの版」');
  });
  it('recovery: the line says the health does not come back, why, and the food she has', () => {
    const line = recoveryLine(10, 12, 20, new Map([['cooked_beef', 2]]))!;
    expect(line).toContain('体力 12/20 は自然に戻らない');
    expect(line).toContain('満腹 10＜18');
    expect(line).toContain('食べる');
    expect(source('minecraftLlmcReadiness.ts')).toContain('食料の当て: ');
  });
  it('look: the line says what happened and which view reads it', () => {
    const fell = lookHint({ oxygen: 4 })!;
    expect(fell).toContain('落ちた・溺れかけた・大きく打たれた');
    expect(fell).toContain('mc_view');
    expect(source('minecraftLlmcLive.ts')).toContain('同じ所で同じ止まりが続いている（原因は見えていない。mc_view の slice で縦の断面、layers で周りが見られる）');
  });
  it('pack: the line says the free and used slots and what a full pack does', () => {
    const line = packLines(['cobblestone×64'], { free: 20 })[0]!;
    expect(line).toContain('持ち物の空き 20 マス（使用 16/36');
    expect(line).toContain('満杯だと dig・pickup が「満杯」で止まる');
  });
  it('mode: the urgent mode says the rule is the instructions\' 「急ぎの時」, which is a section of them', () => {
    expect(URGENT_NOTE).toBe('急ぎの版（決まりは system の「急ぎの時」）');
    expect(minecraftV2System(V2_ALWAYS)).toContain('## 急ぎの時');
    expect(V2_ALWAYS).toContain('live の mode が「急ぎの版」の判断');
  });
  it('footing, away, repeat and shortage: the producers keep the words (the earlier tests drive them with scenes)', () => {
    const footing = source('minecraftLlmcFooting.ts');
    expect(footing).toContain('`足場: ${shapeText(gaps)}（${depth.text}）${depth.falls ? \'。押されたら落ちる\' : \'\'}`');
    const away = source('minecraftLlmcAround.ts');
    expect(away).toContain('から離れる、掘らずに歩ける隣');
    expect(away).toContain('は無い（周りの 8 方向の 1 歩は、どれも近づくか、掘る・置くが要る）');
    expect(source('minecraftLlmcRepeat.ts')).toContain('同じやり直しはしない: ');
    expect(source('minecraftLlmcReadiness.ts')).toContain('準備の不足（${table.title}）: ');
  });
});

describe('a death is avoided: said once in the instructions, in no stage', () => {
  it('has it once in the instructions, and a stage (or two at once) does not repeat it', () => {
    expect(V2_ALWAYS.split(SAFETY_FIRST).length - 1).toBe(1);
    for (const id of Object.keys(V2_STAGES) as Array<keyof typeof V2_STAGES>) expect(V2_STAGES[id], id).not.toContain(SAFETY_FIRST);
    const both = stageKnowledge({ body: { state: { dimension: 'overworld' }, inventory: ['blaze_rod×2'], landmarks: ['blaze スポナー'] } })!;
    expect(both).toContain('この場面の知識:');
    expect(both).not.toContain(SAFETY_FIRST);
  });
});

describe('the nether ruler is one number: the goal, the road and the night\'s lines say the same minutes', () => {
  it('says 47 minutes in the goal, and the night\'s line says its share of the same 47', () => {
    const minutes = Math.round(NETHER_BY_SECONDS / 60);
    expect(V2_ALWAYS).toContain(`ネザーへ入るまでは ${minutes} 分ほど`);
    const line = dayBedLine({ timeOfDay: 1000 }, new Map([['white_bed', 1]]), 'overworld')!;
    const share = /ネザーまで (\d+) 分の目標の (\d+)%/u.exec(line)!;
    expect(Number(share[1])).toBe(minutes);
    // From tick 1000 the bed works at BED_FROM (12,542): 11,542 ticks of waiting, as a share of the ruler's 2,820 s (56,400 ticks).
    expect(Number(share[2])).toBe(Math.round(100 * (BED_FROM - 1000) / (NETHER_BY_SECONDS * 20)));
    expect(source('minecraftNightArms.ts')).not.toContain('30 分の目標');
  });
});

describe('the review of the trim (11/11): what the reviewers found lost is back, in the fewest words', () => {
  it('keeps the doneWhen caveat of the dictionary, the fullnessLostIn5min definition and the same-hands policy at decision time', () => {
    expect(V2_ALWAYS).toContain('済む条件（doneWhen）は観測で満たされるとコードが済みにする（今済んだ印ではない）');
    expect(V2_ALWAYS).toContain('fullnessLostIn5min（直近 5 分に減った満腹の点');
    expect(V2_ALWAYS).toContain('同じ手の連続は repeat と done・mine の count・go の seconds');
  });
  it('says the re-look after a dimension change (scan and landmarks) in the scan line shown right after the portal', () => {
    expect(source('minecraftLlmcProbe.ts')).toContain('この走査と landmarks で見直す');
  });
});
