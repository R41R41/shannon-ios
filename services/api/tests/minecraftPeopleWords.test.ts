import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { createEndgame } from '../src/surfaces/minecraft/minecraftEndgame.js';
import { forgetReplans } from '../src/surfaces/minecraft/minecraftLlmcReplan.js';
import { forgetStalls } from '../src/surfaces/minecraft/minecraftLlmcStalls.js';
import type { LlmcQueue } from '../src/surfaces/minecraft/minecraftLlmcQueueState.js';
import { createWaitLedger } from '../src/surfaces/minecraft/minecraftPurposeProgress.js';
import { unheldReplan } from '../src/wiring/minecraftLlmcReplanWiring.js';
import { forgetHeard, heardLines, noteHeard, posWords, rememberSpoken, spokenDetail, spokenFor, timeWords } from '../src/surfaces/minecraft/minecraftPeopleWords.js';
import { firstPlanInput } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { replanBrief, type BriefInput } from '../src/surfaces/minecraft/minecraftLlmcReplanBrief.js';
import { REPLAN_STALLS, REPLAN_SYSTEM, replanVerdict, readReplanLedger, withAttempt } from '../src/surfaces/minecraft/minecraftLlmcReplan.js';
import { planFromSeeds } from '@shannon/mind';

beforeEach(() => forgetHeard());

describe('the tail of a spoken line (the words as spoken, when, where)', () => {
  it('has the words as spoken only when they say more than the goal, the time to the second, and the place', () => {
    const detail = spokenDetail({ speakerWords: '次の夜は寝ずにスケルトンを倒して骨粉を手に入れようか', spokenAt: '2026-11-24T15:35:49.123Z',
      speakerPos: { x: 10.7, y: 64, z: -3.2 } }, 'スケルトンを倒して骨粉を手に入れる');
    expect(detail).toBe('（言われた言葉: 「次の夜は寝ずにスケルトンを倒して骨粉を手に入れようか」・言った時刻 2026-11-24T15:35:49Z・話した人のマイクラの位置 10,64,-4）');
    expect(spokenDetail({ speakerWords: 'ケーキを作って' }, 'ケーキを作って')).toBe('');
  });
  it('is empty with none of the fields (the form before them), and reads a place given as words or in another dimension', () => {
    expect(spokenDetail({}, 'ケーキを作る')).toBe('');
    expect(posWords('洞窟の入口')).toBe('洞窟の入口');
    expect(posWords({ x: 1, y: 2, z: 3, dimension: 'minecraft:the_nether' })).toBe('1,2,3（the_nether）');
    expect(posWords({ x: Number.NaN, y: 2, z: 3 })).toBeNull();
    expect(posWords(undefined)).toBeNull();
    expect(timeWords('not a time')).toBeNull();
  });
  it('keeps the detail of a request for the task that is made from it, and none for a request it never saw', () => {
    rememberSpoken('dcv:r1', '（言われた言葉: 「x」）');
    expect(spokenFor('dcv:r1')).toBe('（言われた言葉: 「x」）');
    expect(spokenFor('dcv:r2')).toBe('');
    expect(spokenFor(null)).toBe('');
  });
});

describe('what a task has been told by people, for the strong model', () => {
  const line = (id: string, text: string, receivedAt: string) => ({ id, text, receivedAt });
  const REQUEST = 'Discordの通話でのライ（マイクラ名 Rai_41）の依頼: ケーキを1個作る';
  const ADVICE = 'Discordの通話でのミキの言葉（いまのタスクへ）: スケルトンを倒して骨粉を取る（言われた言葉: 「スケルトンを倒して骨粉を取って」・言った時刻 2026-11-24T15:40:00Z）';
  it('keeps the request and the words after it, each once, oldest first with the time, and gives only the new words for the request under way', () => {
    expect(noteHeard('t1', [line('m0', REQUEST, '2026-11-24T15:30:00.000Z')])).toEqual([]);
    const fresh = noteHeard('t1', [line('m0', REQUEST, '2026-11-24T15:30:00.000Z'), line('m1', ADVICE, '2026-11-24T15:40:01.000Z')]);
    expect(fresh.map(item => item.id)).toEqual(['m1']);
    expect(noteHeard('t1', [line('m1', ADVICE, '2026-11-24T15:40:01.000Z')])).toEqual([]);
    const lines = heardLines('t1');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(`- 2026-11-24T15:30:00Z: ${REQUEST}`);
    expect(lines[1]).toContain('ミキの言葉');
    expect(lines[1]).toContain('言われた言葉: 「スケルトンを倒して骨粉を取って」');
  });
  it('leaves out what is not a person\'s line (the queue\'s news, a note of the body), and keeps the first line with the newest few', () => {
    expect(noteHeard('t2', [line('n1', '（列の知らせ）q3 終わった', '2026-11-24T15:30:00.000Z')])).toEqual([]);
    expect(heardLines('t2')).toEqual([]);
    noteHeard('t2', [line('a0', REQUEST, '2026-11-24T15:30:00.000Z')]);
    for (let i = 1; i <= 8; i += 1) noteHeard('t2', [line(`a${i}`, `ゲーム内の本人の言葉（いまのタスクへ）: 言葉${i}`, `2026-11-24T15:3${i}:00.000Z`)]);
    const lines = heardLines('t2');
    expect(lines).toHaveLength(6);
    expect(lines[0]).toContain('依頼: ケーキを1個作る');
    expect(lines.at(-1)).toContain('言葉8');
  });
  it('is in the first plan\'s input after the request, and not when nothing was said', () => {
    const asked = firstPlanInput('ケーキを1個作る', null, { words: [`- 2026-11-24T15:30:00Z: ${REQUEST}`] });
    expect(asked.indexOf('依頼: ケーキを1個作る')).toBe(0);
    expect(asked).toContain('人の言葉（依頼と、届いた言葉。原文・話者・時刻つき');
    expect(asked).toContain(REQUEST);
    expect(firstPlanInput('ケーキを1個作る', null, {})).not.toContain('人の言葉');
    expect(firstPlanInput('ケーキを1個作る', null, { words: [] })).not.toContain('人の言葉');
  });
  it('is in the brief of the plan made again, under its own heading, and the heading is left out with no words', () => {
    const tree = planFromSeeds([{ id: 'p1', title: '小麦を集める', doneWhen: 'have:wheat>=3' }])!;
    const input: BriefInput = { goal: 'ケーキを1個作る', seconds: 100, stall: { kind: 'person_words', why: '人の言葉が届いた', node: 'p1' }, tree, doneStatus: null,
      now: ['場所: overworld (0,64,0)'], facts: [], results: [], queue: [], earlier: [], sameNode: 0, knowledge: '知識' };
    const brief = replanBrief({ ...input, words: [`- 2026-11-24T15:40:01Z: ${ADVICE}`] });
    expect(brief).toContain('## 人の言葉（依頼と、あとから届いた言葉。原文・話者・時刻つき）');
    expect(brief).toContain('言われた言葉: 「スケルトンを倒して骨粉を取って」');
    expect(brief.indexOf('## 人の言葉')).toBeLessThan(brief.indexOf('## 計画'));
    expect(replanBrief(input)).not.toContain('## 人の言葉');
  });
});

describe('words for the request under way ask the strong model for a plan at once, and say how to read them', () => {
  it('is a stall a new plan answers, and the gap, the hour and the node\'s count do not hold it (the run\'s count does)', () => {
    expect(REPLAN_STALLS.has('person_words')).toBe(true);
    let ledger = readReplanLedger(null);
    for (let i = 0; i < 3; i += 1) ledger = withAttempt(ledger, { at: 1_000 + i, node: 'p1', kind: 'node_stalled', outcome: 'changed', why: 'x' });
    expect(replanVerdict(ledger, 'p1', 2_000, 'node_stalled')).toEqual({ ok: false, why: 'node' });
    expect(replanVerdict(ledger, 'p1', 2_000, 'person_words')).toEqual({ ok: true });
    expect(replanVerdict({ ...ledger, total: 30 }, 'p1', 2_000, 'person_words')).toEqual({ ok: false, why: 'run' });
  });
  it('tells the strong model to judge by content and reason for any speaker, to write the reason and what it changed, and that the body is not stopped', () => {
    expect(REPLAN_SYSTEM).toContain('person_words');
    expect(REPLAN_SYSTEM).toContain('体は止まっていない');
    expect(REPLAN_SYSTEM).toContain('誰が言っても同じ扱いで、話者で重みを変えない');
    expect(REPLAN_SYSTEM).toContain('why に、採った理由と、計画のどこを変えたかを書く');
    expect(REPLAN_SYSTEM).toContain('理由: 助言を計画に書かないと');
  });
});

describe('words for the request under way reach the strong model through the replan flow, wired', () => {
  const frame = (world: object): BodyObservation => ({ connected: true, state: { world }, facts: {}, bodyId: 'b', sequence: 1, stateAt: new Date(0).toISOString() }) as unknown as BodyObservation;
  const idle = frame({ dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, inventory: [{ name: 'oak_log', count: 2 }] });
  const tree = { ...seedPlan('エンドラを討伐して')!, current: 'p1.1' };
  const signal = new AbortController().signal;
  const ADVICE = 'Discordの通話でのミキの言葉（いまのタスクへ）: スケルトンを倒して骨粉を取る（言われた言葉: 「スケルトンを倒して骨粉を取って」）';
  function setup(people: () => readonly string[]) {
    const clock = { now: 0 };
    const briefs: string[] = [];
    const systems: string[] = [];
    const queue = { onRan: () => undefined, lines: () => ['▶ q1: go'], runningInput: () => null } as unknown as LlmcQueue;
    const unheld = unheldReplan({ held: false, taskId: 'pw', goal: 'エンドラを討伐して', createdAt: new Date(0).toISOString(), checkpoint: null,
      replanner: async (system, brief) => { systems.push(system); briefs.push(brief); return { ops: [], why: '助言は計画にすでにある' }; },
      observe: () => idle, plan: { tree: () => tree, view: () => null },
      bodyParts: { plan: () => undefined, planView: () => null, planTree: () => tree, endgame: createEndgame(null) },
      queue, waits: createWaitLedger(null), activeClock: () => clock.now, heldMs: () => 0, validate: () => null, log: () => undefined, people });
    return { clock, briefs, systems, unheld: unheld! };
  }
  afterEach(() => { forgetReplans(); forgetStalls(); });

  it('asks at the next decision for the words, shows them to the strong model with the reading rule, and is not held by the gap after another ask', async () => {
    const { clock, briefs, systems, unheld } = setup(() => [`- 2026-11-24T15:40:01Z: ${ADVICE}`]);
    unheld.flow.note({ kind: 'person_words', key: 'm1', why: '人の言葉が届いた（2026-11-24T15:40:01Z）: スケルトンを倒して骨粉を取る' });
    await unheld.flow.run(signal);
    expect(briefs).toHaveLength(1);
    expect(briefs[0]).toContain('種類 person_words');
    expect(briefs[0]).toContain('## 人の言葉（依頼と、あとから届いた言葉。原文・話者・時刻つき）');
    expect(briefs[0]).toContain('ミキの言葉');
    expect(systems[0]).toContain('person_words');
    // A second words 20 seconds later: the gap of a stall (5 minutes) does not hold it.
    clock.now = 20_000;
    unheld.flow.note({ kind: 'person_words', key: 'm2', why: '人の言葉が届いた' });
    await unheld.flow.run(signal);
    expect(briefs).toHaveLength(2);
    // The asks are counted against the words, not against the node the body is in.
    expect(unheld.checkpoint()).toMatchObject({ minecraftReplans: { total: 2, nodes: { person_words: 2 } } });
    expect((unheld.checkpoint() as { minecraftReplans: { nodes: Record<string, number> } }).minecraftReplans.nodes['p1.1']).toBeUndefined();
    // A stall of the body right after is held by the gap, as before.
    clock.now = 25_000;
    unheld.flow.note({ kind: 'node_stalled', key: 'p1.1', why: '節が動かない' });
    await unheld.flow.run(signal);
    expect(briefs).toHaveLength(2);
  });

  it('shows no heading when the task has heard nothing (the form before)', async () => {
    const { briefs, unheld } = setup(() => []);
    unheld.flow.note({ kind: 'person_words', key: 'm1', why: '人の言葉が届いた' });
    await unheld.flow.run(signal);
    expect(briefs[0]).not.toContain('## 人の言葉');
  });
});
