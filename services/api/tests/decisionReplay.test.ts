import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeMap, isAir, isSolid, matches, runCheck, type Answer, type Context, type Hand } from './decisionReplay/checks.js';
import { decisions, loadRequestSizes, loadRuns } from './decisionReplay/load.js';
import { loadAllRuns } from './decisionReplay/allRuns.js';
import { resultsByDecision } from './decisionReplay/preflightFrames.js';
import { r10Input } from './decisionReplay/r10Live.js';
import { actToShort, handToLine, lineToHand, shortToAct } from './decisionReplay/shortHands.js';
import { compactHistory, expandAnswer, shortActTool, slimTools, splitKnowledge, stagesFor, summaryOf } from './decisionReplay/slim.js';
import { llmcCoreKnowledge } from '../src/surfaces/minecraft/minecraftKnowledgeCore.js';
import { buildRequest, markCache, VARIANTS, withoutThinking } from './decisionReplay/request.js';
import { loadScenes, scoreAnswer, decisionOf, type SceneFile } from './decisionReplay/score.js';
import { contextOf, answerOf } from './decisionReplay/checks.js';

/**
 * 判断の再現台（tests/decisionReplay/）の、API を呼ばない部分: 地図の読み・検査・場面のファイル・要求の組み立て。
 * 本番の DB の控え（data/export1.txt、git に入らない）が無い所では、それを使う試験は飛ばす。
 */
const dataFile = (name: string) => new URL(`./decisionReplay/data/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const haveData = existsSync(dataFile('export1.txt')) && existsSync(dataFile('journal.txt')) && existsSync(dataFile('export2.txt'));

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
    const runs = loadAllRuns();
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

describe('decision replay: v4 (the r10 head) adds what the record can make', () => {
  it.runIf(haveData)('puts the head\'s facts into the result of a stopped act, in the history and in the next decision\'s lastResults, and leaves a decision with nothing to add as it was', () => {
    const run = loadRuns(dataFile('export1.txt'), dataFile('journal.txt')).get('r34')!;
    const info = resultsByDecision(run);
    const stopped = info.ds.find(item => item.row.seq === 1537)!;
    const added = r10Input(stopped, info);
    expect(added.notes.lastResults).toBe(true);
    const live = JSON.parse(String(added.turn.find(entry => entry.role === 'system')!.content)) as { body: { lastResults: string[] } };
    expect(live.body.lastResults[0]).toContain('頭の補足（1 place）: 空中のマスには支えが要る');
    expect(live.body.lastResults[0]).toContain('頭の補足（2 walk）: 目的地 (259,57,63) の下は空気が 8 以上 マス');
    const first = info.ds[0]!;
    const same = r10Input(first, info);
    expect(same.rows).toEqual([]);
    expect(same.turn).toEqual(first.turn);
  });

  it.runIf(haveData)('v2 keeps the old knowledge line (its recorded requests stay), v4 has the r10 one', async () => {
    const run = loadRuns(dataFile('export1.txt'), dataFile('journal.txt')).get('r34')!;
    const decision = decisions(run)[0]!;
    const text = async (id: string) => (await buildRequest(VARIANTS.find(variant => variant.id === id)!, decision, run.core, null)).body.system
      .map((block: { text: string }) => block.text).join('\n');
    expect(await text('v2')).toContain('「届かない」は 4.5m 内へ寄る');
    expect(await text('v4')).toContain('「一歩ではない」は頭の高さが固い（walk は掘らない: 先に dig）');
    expect(await text('v4')).not.toContain('4.5m 内へ寄る');
  }, 60_000);

  it('names the versions: v5 = v4 + the preflight, v6 with effort high, v7 on Sonnet', () => {
    const by = (id: string) => VARIANTS.find(variant => variant.id === id)!;
    expect([by('v4').r10, by('v4').preflight]).toEqual([true, undefined]);
    expect([by('v5').preflight, by('v6').effort, by('v7').model]).toEqual([true, 'high', 'claude-sonnet-5-5']);
  });
});

describe('decision replay: v8, the narrowed form', () => {
  it('writes a hand in a line and reads it back as the same hand; a hand with no short form is a json line', () => {
    const hands = [{ do: 'walk', to: { x: 225, y: 57, z: 63 } }, { do: 'walk', path: [{ x: 1, y: 2, z: 3 }, { x: 4, y: 2, z: 3 }], sprint: true, range: 2 },
      { do: 'dig', at: [{ x: 1, y: 2, z: 3 }, { x: 1, y: 3, z: 3 }], tool: 'iron_pickaxe', exposeOk: true, collect: false, onFail: 'continue' },
      { do: 'place', block: 'cobblestone', at: [{ x: 5, y: 6, z: 7 }], face: 'down' }, { do: 'attack', target: '#12', hold: true, seconds: 8 },
      { do: 'look', yaw: 90, pitch: -10 }, { do: 'wait', seconds: 3 }, { do: 'sneak', on: false }, { do: 'chest', at: [{ x: 1, y: 2, z: 3 }], op: 'look' }];
    const lines = hands.map(hand => handToLine(hand as never));
    expect(lines.slice(0, 8)).toEqual(['walk 225,57,63', 'walk 1,2,3 4,2,3 sprint range=2', 'dig 1,2,3 1,3,3 tool=iron_pickaxe exposeOk collect=false onFail=continue',
      'place cobblestone 5,6,7 face=down', 'attack #12 hold seconds=8', 'look yaw=90 pitch=-10', 'wait 3', 'sneak off']);
    expect(lines[8]).toBe('json {"do":"chest","at":[{"x":1,"y":2,"z":3}],"op":"look"}');
    expect(lines.map(line => lineToHand(line))).toEqual(hands);
    expect(lineToHand('teleport 1,2,3')).toEqual({ error: 'teleport: 知らない手 teleport' });
    const { act, errors } = shortToAct({ why: '[p1] 東へ', hands: ['walk 1,2,3', 'dig'], stopIf: 'hpBelow=8 hostileWithin=6', accept: ['blaze'] });
    expect(act).toEqual({ hands: [{ do: 'walk', to: { x: 1, y: 2, z: 3 } }], why: '[p1] 東へ', stopIf: { hpBelow: 8, hostileWithin: 6 }, accept: ['blaze'] });
    expect(errors).toEqual(['dig: 座標が無い']);
    const expanded = expandAnswer([{ type: 'tool_use', id: 't', name: 'mc_act', input: { hands: ['walk 1,2,3', 'dig'] } }]);
    expect(Object.keys((expanded[0] as { input: object }).input)).toContain('書き方の誤り');
    expect(actToShort({ hands: [{ do: 'wait', seconds: 1 }], stopIf: { hpBelow: 9 }, why: 'w' } as never)).toEqual({ why: 'w', hands: ['wait 1'], stopIf: 'hpBelow=9' });
  });

  it.runIf(haveData)('every recorded act of runs 27–34 goes through a line and back as it was (a hand with no line goes as json)', () => {
    let acts = 0, mismatched = 0, errors = 0;
    for (const run of loadAllRuns().values()) {
      for (const decision of decisions(run)) {
        if (decision.call?.name !== 'mc_act' || !Array.isArray(decision.call.input.hands)) continue;
        acts += 1;
        const back = shortToAct(actToShort(decision.call.input));
        errors += back.errors.length;
        const norm = (act: { hands: unknown; why?: unknown }) => JSON.stringify({ hands: act.hands, why: act.why }, (_, value) => value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).sort()) : value);
        if (norm(back.act) !== norm(decision.call.input)) mismatched += 1;
      }
    }
    expect(acts).toBeGreaterThan(450);
    expect(errors).toBe(0);
    expect(mismatched).toBe(0);
  });

  it('keeps six tools, the map of knowledge splits into the always and three stages, and stages are chosen from the live state', () => {
    expect(slimTools([{ name: 'task_get' }, { name: 'plan_update' }, { name: 'mc_view' }, { name: 'mc_act' }, { name: 'fca_wait' }, { name: 'mc_probe' }, { name: 'fca_complete' }, { name: 'tool_open' }])
      .map(tool => tool.name)).toEqual(['mc_act', 'mc_probe', 'mc_view', 'plan_update', 'fca_wait', 'fca_complete']);
    const split = splitKnowledge();
    expect(Object.keys(split.stages)).toEqual(['prep', 'nether', 'end']);
    expect([split.always, split.stages.prep, split.stages.nether, split.stages.end].join('\n\n')).toBe(llmcCoreKnowledge(true).replace(/\n\n(?=## 材料と手順)/u, '\n\n'));
    expect(stagesFor({ body: { planNow: '[p1.2] 歪んだ幹で作業台', state: { dimension: 'overworld' } } })).toEqual(['prep']);
    expect(stagesFor({ body: { planNow: '[p3.1] ブレイズロッド 7 本', state: { dimension: 'the_nether', inside: 'ネザー要塞の中' } } })).toEqual(['nether']);
    expect(stagesFor({ body: { planNow: '[p4.1] エンダーアイでストロングホールドを探す', state: { dimension: 'overworld' } } })).toEqual(['prep', 'end']);
    expect(shortActTool().input_schema).toMatchObject({ required: ['hands'], properties: { hands: { items: { type: 'string' } } } });
    expect(String(shortActTool().description)).toContain('walk X,Y,Z');
  });

  it.runIf(haveData)('the compact history is the first state + a summary + the last 3 to 8 rounds, the summary renewed every 6 decisions (so the prefix holds)', () => {
    const run = loadRuns(dataFile('export1.txt'), dataFile('journal.txt')).get('r34')!;
    const list = decisions(run).filter(item => item.epoch === 1);
    const windows = list.map(item => compactHistory(item).filter(entry => entry.role === 'assistant').length);
    expect(Math.min(...windows.slice(3))).toBeGreaterThanOrEqual(3);
    expect(Math.max(...windows)).toBeLessThanOrEqual(8);
    const late = list.at(-1)!;
    const history = compactHistory(late);
    expect(history[0]!.role).toBe('user');
    expect(JSON.stringify(history[0]!.content)).toContain('これまでの試しの要約');
    expect(summaryOf(late, late.epochStart, late.index - 3)).toContain('act ');
    // the same summary stays for the next decisions of its block (the cache holds)
    // (the 9th round of the epoch and the 10th share the summary of the first 6; the 15th is a new block)
    const first = (k: number) => JSON.stringify(compactHistory(list[k]!)[0]);
    expect([first(9) === first(10), first(10) === first(15)]).toEqual([true, false]);
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
    const [v1, v2, v3] = await Promise.all(VARIANTS.slice(0, 3).map(variant => buildRequest(variant, decision, run.core, null)));
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
