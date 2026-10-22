import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeMap, isAir, isSolid, matches, runCheck, type Answer, type Context, type Hand } from './decisionReplay/checks.js';
import { decisions, loadRequestSizes, loadRuns } from './decisionReplay/load.js';
import { buildRequest, markCache, VARIANTS, withoutThinking } from './decisionReplay/request.js';
import { loadScenes, scoreAnswer, decisionOf, type SceneFile } from './decisionReplay/score.js';
import { contextOf, answerOf } from './decisionReplay/checks.js';

/**
 * 判断の再現台（tests/decisionReplay/）の、API を呼ばない部分: 地図の読み・検査・場面のファイル・要求の組み立て。
 * 本番の DB の控え（data/export1.txt、git に入らない）が無い所では、それを使う試験は飛ばす。
 */
const dataFile = (name: string) => new URL(`./decisionReplay/data/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const haveData = existsSync(dataFile('export1.txt')) && existsSync(dataFile('journal.txt'));

const MAP = ['地図 v1 足=(10,5,20) x=8..12 z=19..21 方式=layers 上=北', 'y=5 x=8..12 z=19..21', 'z\\x 8 9 0 1 2', ' 19 # . . . #', ' 20 # . @ . #', ' 21 # # # # #',
  'y=4 x=8..12 z=19..21', 'z\\x 8 9 0 1 2', ' 19 # # # # #', ' 20 # # # . #', ' 21 # # # # #', '縦 (10,20) 上: y=6 . / 下: y=4 #'].join('\n');
const context = (extra: Partial<Context> = {}): Context => ({ decision: undefined as never, live: {}, self: { x: 10, y: 5, z: 20 }, hp: 20, food: 20, threats: [], grid: decodeMap(MAP),
  stopped: null, recentStops: [], visible: [], urgent: false, hasAnswerLine: false, inventory: [], ...extra });
const act = (hands: Hand[], extra: Partial<Answer> = {}): Answer => ({ tool: 'mc.act', input: { hands }, hands, shapeProblem: null, ...extra });

describe('decision replay: the map and the checks', () => {
  it('reads the layers of the body\'s map into cells', () => {
    const grid = decodeMap(MAP);
    expect(grid.get('10,5,20')).toBe('@');
    expect(grid.get('8,5,19')).toBe('#');
    expect(grid.get('11,4,20')).toBe('.');
    expect(isSolid(grid.get('8,5,20'))).toBe(true);
    expect(isAir(grid.get('9,5,19'))).toBe(true);
    expect(grid.get('13,5,20')).toBeUndefined();
  });

  it('matches a hand by kind, cell, direction and threat', () => {
    const ctx = context({ threats: [{ id: '7', name: 'blaze', meters: 3, pos: { x: 12, y: 5, z: 20 } }] });
    expect(matches({ do: 'dig', at: [{ x: 9, y: 5, z: 20 }] }, { do: 'dig', near: [9, 5, 20, 0.5] }, ctx)).toBe(true);
    expect(matches({ do: 'walk', to: { x: 8, y: 5, z: 20 } }, { do: 'walk', heading: 'west' }, ctx)).toBe(true);
    expect(matches({ do: 'walk', to: { x: 8, y: 5, z: 20 } }, { do: 'walk', awayFrom: '#7' }, ctx)).toBe(true);
    expect(matches({ do: 'walk', to: { x: 12, y: 5, z: 20 } }, { do: 'walk', awayFrom: '#7' }, ctx)).toBe(false);
    expect(matches({ do: 'dig', at: [{ x: 9, y: 5, z: 20 }] }, { do: 'dig', tool: null }, ctx)).toBe(true);
    expect(matches({ do: 'dig', tool: 'hand', at: [{ x: 9, y: 5, z: 20 }] }, { do: 'dig', tool: null }, ctx)).toBe(false);
  });

  it('knows a bridge without walls, a plan that skips ahead, and the answer line', () => {
    const floor = (x: number) => ({ do: 'place', block: 'cobblestone', at: [{ x, y: 54, z: 78 }] });
    expect(runCheck({ kind: 'noBareBridge', floorMax: 55 }, act([floor(1), floor(2), floor(3)]), context()).pass).toBe(false);
    expect(runCheck({ kind: 'noBareBridge', floorMax: 55 }, act([floor(1), floor(2), floor(3), { do: 'place', at: [{ x: 1, y: 56, z: 78 }] }]), context()).pass).toBe(true);
    const plan: Answer = { tool: 'plan.update', input: { current: 'p3.1' }, hands: [], shapeProblem: null };
    expect(runCheck({ kind: 'planCurrentNot', prefix: 'p3' }, plan, context()).pass).toBe(false);
    expect(runCheck({ kind: 'answerLine' }, act([{ do: 'walk' }, { do: 'walk' }, { do: 'walk' }, { do: 'walk' }]), context({ hasAnswerLine: true })).pass).toBe(false);
    expect(runCheck({ kind: 'answerLine' }, act([{ do: 'walk' }, { do: 'walk' }, { do: 'walk' }, { do: 'walk' }]), context()).pass).toBe(true);
  });

  it('refuses a walk into rock, into a floorless cell, and the same hand that just stopped', () => {
    const scene: SceneFile = { id: 'x', run: 'r', seq: 0, category: [], title: '', situation: '', correct: '', hindsight: '' };
    const into = act([{ do: 'walk', to: { x: 8, y: 5, z: 20 } }]);
    expect(scoreAnswer(scene, context(), into).failed.join()).toContain('塞がった');
    // Digging first opens the cell: not a refusal.
    expect(scoreAnswer(scene, context(), act([{ do: 'dig', at: [{ x: 8, y: 5, z: 20 }, { x: 8, y: 6, z: 20 }] }, { do: 'walk', to: { x: 8, y: 5, z: 20 } }])).failed).toEqual([]);
    const stopped = context({ stopped: { do: 'walk', reason: '一歩ではない', hand: { do: 'walk', to: { x: 9, y: 5, z: 20 } } } });
    expect(scoreAnswer(scene, stopped, act([{ do: 'walk', to: { x: 9, y: 5, z: 20 } }])).failed.join()).toContain('くり返し');
    expect(scoreAnswer(scene, stopped, act([{ do: 'dig', at: [{ x: 9, y: 5, z: 19 }] }, { do: 'walk', to: { x: 9, y: 5, z: 20 } }])).failed.join()).not.toContain('くり返し');
    // exposeOk is the answer to a "seen" stop, not a repeat of it.
    const seen = context({ stopped: { do: 'dig', reason: '見られる', hand: { do: 'dig', at: [{ x: 9, y: 5, z: 20 }] } } });
    expect(scoreAnswer(scene, seen, act([{ do: 'dig', at: [{ x: 9, y: 5, z: 20 }] }])).failed.join()).toContain('くり返し');
    expect(scoreAnswer(scene, seen, act([{ do: 'dig', exposeOk: true, at: [{ x: 9, y: 5, z: 20 }] }])).failed.join()).not.toContain('くり返し');
  });

  it('decides ○ only when every wanted check passes, × when a must fails, and leaves the rest to the judge', () => {
    const scene: SceneFile = { id: 'x', run: 'r', seq: 0, category: [], title: '', situation: '', correct: '', hindsight: '',
      must: [{ id: 'm', why: 'no attack', check: { kind: 'none', match: { do: 'attack' } } }], want: [{ id: 'w', why: 'eat', check: { kind: 'some', match: { do: 'eat' } } }] };
    expect(scoreAnswer(scene, context(), act([{ do: 'attack' }])).verdict).toBe('×');
    expect(scoreAnswer(scene, context(), act([{ do: 'eat' }])).verdict).toBe('○');
    expect(scoreAnswer(scene, context(), act([{ do: 'wait' }])).verdict).toBe('?');
    expect(scoreAnswer({ ...scene, judge: 'always' }, context(), act([{ do: 'eat' }])).verdict).toBe('?');
  });
});

describe('decision replay: the scene files', () => {
  const scenes = loadScenes();
  it('are written for a person: every scene says the situation, the right move and what happened', () => {
    expect(scenes.length).toBeGreaterThanOrEqual(30);
    expect(new Set(scenes.map(scene => scene.id)).size).toBe(scenes.length);
    for (const scene of scenes) {
      expect(scene.situation.length, scene.id).toBeGreaterThan(20);
      expect(scene.correct.length, scene.id).toBeGreaterThan(20);
      expect(scene.hindsight.length, scene.id).toBeGreaterThan(20);
      expect(scene.id.startsWith(`s${scene.id.slice(1, 3)}-${scene.run}-${scene.seq}`), scene.id).toBe(true);
    }
    const categories = new Set(scenes.flatMap(scene => scene.category));
    for (const wanted of ['stopped', 'urgent', 'death', 'progress', 'plan']) expect(categories.has(wanted), wanted).toBe(true);
  });

  it.runIf(haveData)('each resolves to a recorded decision, and the production answer is judged by its rubric as the real outcome says', () => {
    const runs = loadRuns(dataFile('export1.txt'), dataFile('journal.txt'));
    const recorded = Object.fromEntries(scenes.map(scene => {
      const decision = decisionOf(runs, scene);
      const score = scoreAnswer(scene, contextOf(decision), answerOf((decision.assistant?.content ?? []) as never));
      return [scene.id, score.verdict];
    }));
    // The deaths and the dead-end acts of the real runs are caught by the checks; the good tunnels are let through.
    for (const id of ['s19-r32-1336-lava-gap', 's20-r32-1344-accept-seen', 's21-r32-1345-death', 's22-r33-1479-wait-without-guard', 's31-r33-1457-plan-skip',
      's05-r33-1403-solid-target', 's14-r33-1452-walk-solid', 's28-r32-1334-after-plan-update', 's29-r33-1409-head-cell']) expect(recorded[id], id).toBe('×');
    for (const id of ['s24-r32-1325-tunnel', 's25-r33-1411-tunnel', 's27-r34-1548-tunnel', 's07-r33-1436-void-edge']) expect(recorded[id], id).toBe('○');
  });
});

describe('decision replay: the request is the production request', () => {
  it('takes the signed thinking out of the history and marks the cache as the body task does', () => {
    const entries = [{ role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'tool_use', id: 't', name: 'mc_act', input: {} }] }];
    expect(withoutThinking(entries as never)[0]!.content).toEqual([{ type: 'tool_use', id: 't', name: 'mc_act', input: {} }]);
    const body = markCache({ system: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 's' }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'r' }] },
        { role: 'system', clear_at: 'next_user_message', content: '{}' }] }, '5m', 0) as unknown as { system: Array<{ cache_control?: unknown }>; messages: Array<Record<string, any>> };
    expect(body.system.every(block => block.cache_control)).toBe(true);
    expect(body.messages[0].content[0].cache_control).toBeTruthy();
    expect(body.messages[1].content[0].cache_control).toBeTruthy();
    expect(body.messages[2].cache_control).toBeUndefined();
  });

  it.runIf(haveData)('is byte for byte the request production sent (journal requestCharacters), for run 34\'s first epoch with the thinking kept', async () => {
    const runs = loadRuns(dataFile('export1.txt'), dataFile('journal.txt'));
    const run = runs.get('r34')!;
    const sizes = new Set((loadRequestSizes(dataFile('journal.txt')).get(run.taskId) ?? []).map(item => item.requestCharacters));
    let exact = 0;
    const first = decisions(run).filter(item => item.epoch === 0).slice(0, 6);
    for (const decision of first) {
      const request = await buildRequest(VARIANTS[0]!, decision, run.core, null, '1h', true);
      if (sizes.has(JSON.stringify(request.body).length)) exact += 1;
    }
    expect(exact).toBe(first.length);
  }, 60_000);

  it.runIf(haveData)('puts the own prompt and the short output rule only where the variant says so', async () => {
    const runs = loadRuns(dataFile('export1.txt'), dataFile('journal.txt'));
    const run = runs.get('r34')!;
    const decision = decisions(run)[0]!;
    const [v1, v2, v3] = await Promise.all(VARIANTS.map(variant => buildRequest(variant, decision, run.core, null)));
    const text = (request: Awaited<ReturnType<typeof buildRequest>>) => (request.body.system as Array<{ text: string }>).map(block => block.text).join('\n');
    expect(text(v1!)).toContain('シャノン');
    expect(text(v2!)).not.toContain('[シャノンの人格]');
    expect(text(v2!)).toContain('## Output length');
    expect(text(v1!)).not.toContain('## Output length');
    expect(text(v3!)).toBe(text(v2!));
    expect(v3!.body.model).toBe('claude-sonnet-5-5');
    expect(JSON.stringify(v1!.body.tools)).toBe(JSON.stringify(v2!.body.tools));
  }, 60_000);
});
