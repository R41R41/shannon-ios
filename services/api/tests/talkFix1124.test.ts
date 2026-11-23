import { afterEach, describe, expect, it, vi } from 'vitest';
import { peopleAudience } from '@shannon/cognition';
import { minecraftQueueGuide } from '../src/contracts/minecraftQueuePrompt.js';
import { DisclosureGate } from '../src/mind/inhibition/disclosurePorts.js';
import { cleanLiveLine, liveWriterPrompt } from '../src/surfaces/minecraft/minecraftLiveWriter.js';
import { deathCauseWords } from '../src/surfaces/minecraft/minecraftMoments.js';
import { platformVoiceInstructions, situationBlock } from '../src/surfaces/platform/platformVoicePrompt.js';
import { VoiceRooms } from '../src/surfaces/platform/voiceRoom.js';
import { memoryWorld } from './support/memoryWorld.js';

/**
 * 2026-11-24, the try of the evening before: replies that promised work that was not in the list, replies of 62-81 characters that began alike,
 * a death said as the wrong enemy, and a voice turn that stopped the whole API for 0.4-0.5 s. Each rule says why; these hold the words and the
 * deterministic parts (the model's own manner is checked by a real model, not here).
 */
const closes: Array<() => void> = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });

describe('what a reply may promise', () => {
  it('shows the order example as a blank, and says only the list is what was accepted', () => {
    const empty = minecraftQueueGuide({ queueLines: [], running: null }).join('\n');
    expect(empty).not.toContain('先にベッドを作るね');
    expect(empty).toContain('（いま頼まれた物）');
    expect(empty).toContain('引き受けた依頼は [依頼の列] にあるものだけ');
    expect(empty).toContain('理由: 言ったのに体が動いていない');
  });
  it('tells a voice turn the length, the opening and the old topics, each with its reason', () => {
    const text = platformVoiceInstructions({ title: '通話', ownerAlone: true, ownerSpeaking: true, speakerName: null, humans: 1, audioTags: false });
    expect(text).toContain('30〜40字');
    expect(text).toContain('40字までを守る');
    expect(text).not.toContain('上の「およそ60字」');
    expect(text).toContain('理由: 声は読むより遅く');
    expect(text).toContain('出だしは、毎回かえる');
    expect(text).toContain('昔の話');
  });
  it('says in the situation that work that is not running is not coming, and that the promises of the history are not taken either', () => {
    const text = situationBlock('夜の草原', 'ケーキを作る');
    expect(text).toContain('「予定」「そのあとやる」「つもり」「進めておく」とつなげず');
    expect(text).toContain('いま動いている作業は、これだけ');
    expect(text).toContain('履歴にあるボク自身の約束');
  });
  it('names the requests that stopped or ended, and says that nothing is running when nothing is', () => {
    expect(situationBlock('夜の草原', null)).toContain('動いている作業は無い');
    const text = situationBlock('夜の草原', 'ケーキを作る', ['「羊を倒す」（止めた）']);
    expect(text).toContain('いま動いていない、最近の依頼: 「羊を倒す」（止めた）');
    expect(text).toContain('止まっていると言う');
    expect(situationBlock('夜の草原', null, [])).not.toContain('最近の依頼');
  });
});

describe('a line of danger', () => {
  const moment = (kind: 'died' | 'near_death', facts: Record<string, string | number>) => ({ kind, key: `${kind}:1`, at: 0, facts });
  it('asks for a short line, names no example to echo, and never guesses a cause', () => {
    const { system } = liveWriterPrompt({ identity: 'i', persona: '', body: '', main: moment('died', { cause: '矢で撃たれた' }), also: [], recent: [], voice: true });
    expect(system).toContain('10字から20字くらい、1文だけ');
    expect(system).toContain('原因が「不明」の時は、原因を言い当てずに');
    expect(system).not.toContain('あぶない！やられそう');
    expect(system).toContain('原因: 矢で撃たれた');
  });
  it('keeps only the first sentence of a danger line past 24 characters', () => {
    const long = 'やられそう、体力がもうないよ！ちょっと下がって立て直さなきゃ、どうしよう。';
    expect(cleanLiveLine(long, { voice: true, danger: true })).toBe('やられそう、体力がもうないよ！');
    expect(cleanLiveLine('いたっ、こわい！', { voice: true, danger: true })).toBe('いたっ、こわい！');
    // The other lines are as before.
    expect(cleanLiveLine(long, { voice: true })).toBe(long);
  });
  it('says a death in her words, and leaves an unknown cause out', () => {
    expect(deathCauseWords('minecraft:arrow')).toBe('矢で撃たれた');
    expect(deathCauseWords('fall')).toBe('高い所から落ちた');
    expect(deathCauseWords('minecraft:something_new')).toBe('');
    expect(deathCauseWords('')).toBe('');
  });
});

describe('the audience gate of a voice turn', () => {
  it('reads the turns a remembered turn recalled together, and judges them as before', () => {
    const world = memoryWorld(); closes.push(world.close);
    const scope = 'owner';
    const add = (user: string, extra: Record<string, unknown> = {}) => {
      world.clock.at += 60_000;
      return world.store.appendTurn(scope, 'thread-0', user, `${user}ですね。`, world.now(), { capturedStateVersion: 0,
        messageEmotion: { valence: 0, arousal: 0.3, openness: 0.35, expression: 'calm' as const }, ...extra });
    };
    const plain = add('散歩のコースを考えて');
    const withUnknown = add('献立を考えて', { recalledMemoryIds: Array.from({ length: 10 }, (_, index) => `gone-${index}`) });
    for (let turn = 1; turn < 10; turn += 1) add(`話${turn}`, { recalledMemoryIds: Array.from({ length: 10 }, (_, index) => `gone-${turn}-${index}`) });
    const withPlain = add('写真の整理をしたい', { recalledMemoryIds: [plain.id] });
    const candidates = world.store.experienceCandidates(scope);
    const reads = vi.spyOn(world.store, 'experiencesById');
    const gate = new DisclosureGate(peopleAudience(['person-x']), world.store.snapshot(scope), world.store as never, scope, candidates);
    gate.prime(candidates);
    // A hundred ids not among the candidates: one read, not a hundred one by one.
    expect(reads.mock.calls.length).toBe(1);
    const verdicts = candidates.map(turn => [turn.id === withUnknown.id ? 'unknown' : turn.id === withPlain.id ? 'plain' : 'none', gate.allowsTurn(turn)]);
    expect(reads.mock.calls.length).toBe(1);
    // The same answers as a gate that read them one by one: a turn that recalled turns it cannot find is judged on what is known (unlabelled: guarded, not withheld).
    const fresh = new DisclosureGate(peopleAudience(['person-x']), world.store.snapshot(scope), world.store as never, scope, candidates);
    expect(candidates.map(turn => fresh.allowsTurn(turn))).toEqual(verdicts.map(([, allowed]) => allowed));
  });
  it('does nothing for the owner alone', () => {
    const world = memoryWorld(); closes.push(world.close);
    const reads = vi.spyOn(world.store, 'experiencesById');
    new DisclosureGate(peopleAudience([]), world.store.snapshot('owner'), world.store as never, 'owner', []).prime([{ recalledMemoryIds: ['x'] }]);
    expect(reads).not.toHaveBeenCalled();
  });
});

describe('her replies that were only words', () => {
  it('keeps the ones no request went with, with how long ago, and drops the old and the handed', () => {
    let now = Date.parse('2026-11-24T10:00:00Z');
    const rooms = new VoiceRooms(() => now);
    const say = (text: string, handed: boolean) => rooms.noteShannon('r', { at: new Date(now).toISOString(), userId: 'u', text }, handed);
    say('羊は倒すね', false);
    now += 16 * 60_000;
    say('ケーキを作るね', true);
    now += 2 * 60_000;
    say('作業台を用意してるよ', false);
    expect(rooms.unhanded('r')).toEqual(['「羊は倒すね」（18分前）', '「作業台を用意してるよ」（いま）']);
    now += 45 * 60_000;
    expect(rooms.unhanded('r')).toEqual([]);
  });
  it('is said in the situation as not taken by the body, in the present form', () => {
    const block = situationBlock('夜の草原。', 'ケーキを作る', [], ['「羊は倒すね」（18分前）']);
    expect(block).toContain('体には渡していない返事');
    expect(block).toContain('「羊は倒すね」（18分前）');
    expect(block).toContain('理由');
    expect(situationBlock('夜の草原。', null, [], [])).not.toContain('体には渡していない返事');
  });
});
