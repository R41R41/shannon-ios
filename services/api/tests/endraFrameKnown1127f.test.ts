import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { createFcaPlanTools } from '../src/mind/action/fca/fcaPlanTools.js';
import { createEyeLedger } from '../src/surfaces/minecraft/minecraftEyeLedger.js';
import { createEndgame } from '../src/surfaces/minecraft/minecraftEndgame.js';
import { eyeThrowHold, registerEyeLedger } from '../src/surfaces/minecraft/minecraftEyeThrowHold.js';
import { firstPlanInput } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { ownFirstPlanSystem } from '../src/surfaces/minecraft/minecraftStrategy.js';
import { planNowOf } from '../src/surfaces/minecraft/minecraftLlmcNode.js';
import { preparationShortage } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';
import { stagesFor, V2_STAGES } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';
import { framesKnownOf, rememberedFramesOf } from '../src/surfaces/minecraft/minecraftSeenMarks.js';

/**
 * The frames are known before the eyes are thrown again (the body's record held the portal room 155 m away while the ledger still offered a third throw, the plan said
 * "two throws give the place", and a fourth eye broke). The body writes its places per world, so the row of this world is the world's; another world has none.
 */
const ROW = '155m 南 (505,31,1603) ×12';
const SAME_WORLD = { rememberedPlaces: { nether_portal: '1729m 北 (196,-34,-244) ×6', end_portal_frame: ROW } };
const OTHER_WORLD = { rememberedPlaces: { nether_portal: '40m 東 (12,63,-40) ×6' } };
const frame = (items: Array<[string, number]>, at = { x: 482, y: 84, z: 1595 }, more: Record<string, unknown> = {}): BodyObservation => ({ schemaVersion: 1,
  bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't', connected: true, facts: {},
  state: { world: { dimension: 'overworld', position: at, health: 20, food: 20, inventory: items.map(([name, count]) => ({ name, count })), ...more } as never } });
const throwEye = { hands: [{ do: 'use', item: 'ender_eye' }] };
const KIT: Array<[string, number]> = [['ender_eye', 11]];

describe('(a)(b) the throw is held by the frames of this world, and by no other world\'s', () => {
  it('holds a throw when only the body\'s record has the frames (no mark on the map)', () => {
    registerEyeLedger('f1', createEyeLedger(null));
    const held = eyeThrowHold(throwEye, frame(KIT, undefined, SAME_WORLD), 'f1')!;
    expect(held.line).toContain('枠は (505,31,1603)');
    expect(held.line).toContain('もう投げない');
    expect(held.line).toContain('割れた時はパールがもう 1 個要る');
  });
  it('lets the throw go in a world whose record has no frames', () => {
    registerEyeLedger('f2', createEyeLedger(null));
    expect(eyeThrowHold(throwEye, frame(KIT, undefined, OTHER_WORLD), 'f2')).toBeNull();
    expect(eyeThrowHold(throwEye, frame(KIT, undefined, { rememberedPlaces: { end_portal_frame: 'ありません' } }), 'f2')).toBeNull();
    expect(framesKnownOf({ ...OTHER_WORLD })).toBeNull();
    expect(rememberedFramesOf(SAME_WORLD)).toMatchObject({ frames: 12, eyes: null, at: { x: 505, y: 31, z: 1603 }, inView: false });
  });
  it('the map\'s marks still count, with their own eye count', () => {
    expect(framesKnownOf({ mapLandmarks: ['Q エンドポータルの枠 (-1080,30,940) 南10m・下40 ×12 アイ入り 1'] })).toMatchObject({ frames: 12, eyes: 1, inView: true });
  });
});

describe('(c) the ledger\'s crossing line', () => {
  // Two bearings 0.6 degrees apart, thrown 10 m apart: a point far along both lines.
  const rows = [{ dim: 'overworld', x: 0, z: 0, yawDeg: 90, flewM: 60, broke: false, atMs: 1_000 }, { dim: 'overworld', x: 0, z: 10, yawDeg: 89.4, flewM: 60, broke: true, atMs: 2_000 }];
  const make = () => { const ledger = createEyeLedger(null); ledger.seed(rows, 3_000); return ledger; };
  it('with the frames known says where they are and that nothing is thrown, with no third throw offered', () => {
    const known = rememberedFramesOf(SAME_WORLD)!;
    const lines = make().lines({ x: 437, z: 1311 }, 3_000, { frames: known, held: 11 }).join('\n');
    expect(lines).toContain('枠は (505,31,1603)');
    expect(lines).toContain('もう投げない');
    expect(lines).not.toContain('3 本目を投げてよい');
  });
  it('without frames keeps the third throw and says the frames\' probe comes first, with the slide of a narrow angle as a hypothesis', () => {
    expect(make().fix(3_000)).not.toBeNull();
    const lines = make().lines({ x: 437, z: 1311 }, 3_000).join('\n');
    expect(lines).toContain('mc_probe kind=frames を撃つ（0.3 秒で済み、目を使わない');
    expect(lines).toContain('約 200m');
    expect(lines).toContain('交点は線に沿って滑りやすい');
    expect(lines).toContain('仮説');
    expect(lines).toContain('3 本目は許されている');
    expect(lines).not.toContain('64%');
  });
  it('the endgame lines say the frames when only the record has them, and keep the old lines otherwise', () => {
    const endgame = createEndgame(null, () => 3_000);
    endgame.ledger.seed(rows, 3_000);
    const text = (world: Record<string, unknown>) => endgame.lines(frame(KIT, { x: 437, y: 64, z: 1311 }, world), true).lines.join('\n');
    expect(text(SAME_WORLD)).toContain('枠は (505,31,1603)');
    expect(text(SAME_WORLD)).not.toContain('ネザー経由で比べる材料');
    expect(text(OTHER_WORLD)).toContain('交点');
    expect(text(OTHER_WORLD)).not.toContain('枠は (505,31,1603)');
  });
});

describe('(d) the first plan\'s eyes in hand', () => {
  const pack = [{ name: 'ender_eye', count: 11 }, { name: 'iron_helmet', count: 1 }];
  const input = (extra: Record<string, unknown>) => firstPlanInput('エンドラを討伐して', { position: { x: 437, y: 64, z: 1311 }, dimension: 'overworld', health: 20, food: 20, inventory: pack, ...extra },
    { readiness: true, journeyReadiness: true, now: 0 });
  it('says the frames are known and that no throw is needed, only in a world that has them', () => {
    const known = input(SAME_WORLD);
    expect(known).toContain('枠は (505,31,1603)');
    expect(known).toContain('目を投げて場所を出す節は要らない');
    expect(known).not.toContain('2 本投げれば要塞の場所が出る');
    const none = input(OTHER_WORLD);
    expect(none).toContain('2 本投げれば要塞の場所が出る');
    expect(none).not.toContain('目を投げて場所を出す節は要らない');
  });
  it('the plan\'s words say the number needed until the frames are seen is the 12 plus a spare, and the empty frames number once they are seen', () => {
    expect(ownFirstPlanSystem()).toContain('枠が見えるまでの必要数は、枠 12＋予備');
    expect(ownFirstPlanSystem()).toContain('枠が見えたら予備は要らず、必要は空き枠の数（枠 12・目入り 1 なら 11）');
    expect(ownFirstPlanSystem()).toContain('「枠は (x,y,z) で見つかっている」とある時は');
  });
});

describe('(e) one measure for the eyes once the frames are in view', () => {
  const KITS: Array<[string, number]> = [['white_bed', 10], ['obsidian', 12], ['bow', 1], ['arrow', 30], ['iron_sword', 1], ['cobblestone', 64], ['water_bucket', 1], ['ender_eye', 10], ['blaze_powder', 1]];
  const base = { dimension: 'overworld', food: 330, nowKinds: ['stronghold' as const], counts: new Map(KITS) };
  it('gives the frames\' own count and the pearls and powder that match it, and not the 12 of a throw\'s break', () => {
    const world = { mapLandmarks: ['Q エンドポータルの枠 (505,31,1603) 南155m ×12 アイ入り 1'] };
    const said = preparationShortage({ ...base, world })!;
    expect(said).toContain('エンダーアイ（空いた枠の分） 10/11（あと 1）');
    expect(said).toContain('枠 12・目入り 1・空き 11 個。手持ち 10・足りない 1 個（パール 1・粉 1 が同数要る');
    expect(said).not.toContain('アイ 10/12');
    expect(said).not.toContain('開く確率');
  });
  it('before the frames are seen keeps the odds and the 10 of the stronghold', () => {
    const said = preparationShortage({ ...base, counts: new Map([...KITS.filter(([name]) => name !== 'ender_eye'), ['ender_eye', 9] as [string, number]]), world: {} })!;
    expect(said).toContain('エンダーアイ 9/14（枠 12＋予備 2');
    expect(said).not.toContain('開く確率');
    expect(said).toContain('エンダーアイ（要塞を探しに向かえる最低。持つ目安は枠 12＋予備。落ちたアイは拾う） 9/10');
  });
  it('with the frames only in the body record: no odds line, one measure of the frames own words', () => {
    const said = preparationShortage({ ...base, counts: new Map([...KITS.filter(([name]) => name !== 'ender_eye'), ['ender_eye', 9] as [string, number]]), world: SAME_WORLD })!;
    expect(said).not.toContain('開く確率');
    expect(said).not.toContain('アイ 10/12');
    expect(said).toContain('枠 12（見つかっている）・目入りは枠のそばで読む');
  });
});

describe('(7) the pearl\'s road is read when the pearl is short', () => {
  const live = (shortage: string) => ({ body: { state: { dimension: 'overworld' }, shortage, inventory: [] } });
  it('brings the pearl\'s knowledge in at a stronghold node, with the road\'s facts and no odds', () => {
    expect(stagesFor(live('準備の不足: エンダーアイ（空いた枠の分） 10/11（あと 1）。足りない 1 個（パール 1・粉 1 が同数要る）') as never)).toContain('pearl');
    expect(stagesFor(live('準備の不足: ベッド 7/8') as never)).not.toContain('pearl');
    const road = V2_STAGES.pearl.split('\n').find(line => line.includes('パールの道の行'))!;
    for (const word of ['昼の 15 分で 0 体', 'mc_probe kind=scan', 'スポナー・溶岩・迷路', '緑宝石 5', '30 分以上']) expect(road).toContain(word);
    expect(road).not.toMatch(/\d+\s*%/u);
  });
});

describe('(f) a title changed alone says its done condition is of before', () => {
  const stamp = () => '2026-11-27T00:00:00.000Z';
  const signal = new AbortController().signal;
  const run = async (made: ReturnType<typeof createFcaPlanTools>, ops: unknown[]) =>
    made.tools.execute({ scopeKey: 's', taskId: 'f-t', operationId: 'o', name: 'plan.update', signal, input: { ops } } as never);
  it('adds the fact to the result and the live\'s now, and clears it when the condition is rewritten', async () => {
    const made = createFcaPlanTools({ taskId: 'f-t', checkpoint: null, rules: true, now: stamp });
    await run(made, [{ op: 'add', title: '投げ直し地点まで歩く', doneWhen: 'at:437,64,1311~12@overworld', where: '437,64,1311（現世）' }]);
    const retitled = JSON.stringify(await run(made, [{ op: 'set', id: 'n1', title: 'パールを集める' }]));
    expect(retitled).toContain('この済む条件は題を変える前のものです');
    const tree = made.port.tree();
    const node = tree.nodes.find(item => item.id === 'n1')!;
    expect(node.staleCondition).toBe(true);
    expect(node.doneWhen).toBe('at:437,64,1311~12@overworld');
    expect(planNowOf({ ...tree, current: 'n1' }, null, frame(KIT))).toContain('この済む条件は題を変える前のものです');
    // The checkpoint keeps it (a restart reads it back).
    const reread = createFcaPlanTools({ taskId: 'f-t', checkpoint: made.tools.checkpoint?.(), rules: true, now: stamp });
    expect(reread.port.tree().nodes.find(item => item.id === 'n1')!.staleCondition).toBe(true);
    const again = JSON.stringify(await run(made, [{ op: 'set', id: 'n1', note: 'メモ' }]));
    expect(again).not.toContain('この済む条件は題を変える前のものです');
    await run(made, [{ op: 'set', id: 'n1', doneWhen: 'have:ender_pearl>=1' }]);
    expect(made.port.tree().nodes.find(item => item.id === 'n1')!.staleCondition).toBeUndefined();
  });
  it('leaves a title set together with a new doneWhen alone, and says in the definition to rebuild both', async () => {
    const made = createFcaPlanTools({ taskId: 'f-t2', checkpoint: null, rules: true, now: stamp });
    await run(made, [{ op: 'add', title: '歩く', doneWhen: 'at:1,64,1~12@overworld' }]);
    const text = JSON.stringify(await run(made, [{ op: 'set', id: 'n1', title: '集める', doneWhen: 'have:cobblestone>=8' }]));
    expect(text).not.toContain('この済む条件は題を変える前のものです');
    expect(made.tools.definitions[0]!.description).toContain('title を変える時は、doneWhen と where も新しい題に合わせて作り直す');
  });
});
