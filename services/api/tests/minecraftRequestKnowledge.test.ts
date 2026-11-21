import { describe, expect, it } from 'vitest';
import { firstPlanSystemFor, ownFirstPlanSystem, singleRequestFirstPlanSystem } from '../src/surfaces/minecraft/minecraftStrategy.js';
import { firstPlanInput } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { MATERIAL_ACQUISITION_LINES } from '../src/surfaces/minecraft/minecraftRequestKnowledge.js';
import { lineToHand } from '../src/contracts/minecraftActShortHands.js';
import { nodesSeenDone } from '../src/surfaces/minecraft/minecraftPlanDone.js';
import { FIRST_PLAN_PEOPLE_LINES, PERSON_WORDS_LINES, PLACE_AND_HANDOVER_LINES, REQUEST_PEOPLE_LINES } from '../src/surfaces/minecraft/minecraftRequestPeople.js';
import { foreignToolNames } from '../src/contracts/minecraftLlmcToolWords.js';
import { minecraftQueueGuide } from '../src/contracts/minecraftQueuePrompt.js';
import { stageKnowledge } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';

describe('what she is told for a request that is one thing to make', () => {
  it('plans a request of one thing from the request, with the way each material is obtained, and not from the whole-game route', () => {
    const single = singleRequestFirstPlanSystem();
    expect(single).toContain('この依頼だけを計画する');
    // The whole-game route and the descent's preparation (the long text on food and nights) are not in it.
    for (const line of ['地下へ下りる前の準備を節に書く', '準備の節の doneWhen は観測の形で書く', '食料と準備', '最初の夜の前、鉄より前に 40〜60 点']) expect(single).not.toContain(line);
    for (const line of MATERIAL_ACQUISITION_LINES) expect(single).toContain(line);
    expect(single).toContain('use bucket target=#id');
    expect(single).toContain('バケツは 3 個');
  });

  it('keeps the whole-game words for the dragon and the Nether, and uses the request words for any other goal', () => {
    expect(firstPlanSystemFor('ケーキを作ってください')).toBe(singleRequestFirstPlanSystem());
    expect(firstPlanSystemFor('オークの原木を16個集める')).toBe(singleRequestFirstPlanSystem());
    expect(firstPlanSystemFor('エンドラを倒して')).toBe(ownFirstPlanSystem());
    expect(firstPlanSystemFor('ネザーに入って')).toBe(ownFirstPlanSystem());
    expect(ownFirstPlanSystem()).toContain('準備の節の doneWhen は観測の形で書く');
  });

  it('puts the cake materials and the milk way into the knowledge of every overworld decision', () => {
    const text = stageKnowledge({ body: { state: { dimension: 'overworld' } } })!;
    for (const line of MATERIAL_ACQUISITION_LINES) expect(text).toContain(line);
    expect(text).toContain('空のバケツを持って牛に use bucket target=#id');
  });

  it('leaves out of a single request the whole-game lines of the structure and the descent food count of the input', () => {
    const single = singleRequestFirstPlanSystem();
    for (const line of ['下の方針', 'エンドラ討伐の後半は', '村が見えれば近い段階で干し草']) expect(single).not.toContain(line);
    expect(ownFirstPlanSystem()).toContain('エンドラ討伐の後半は');
    const world = { dimension: 'overworld', inventory: 'oak_log x3', food: 20, health: 20 };
    expect(firstPlanInput('ケーキを作って', world, { readiness: true })).not.toContain('食料');
    expect(firstPlanInput('エンドラを倒して', world, { readiness: true })).toContain('食料');
  });

  it('tells how wheat and eggs are had when there is no farm or no chicken in sight', () => {
    const text = MATERIAL_ACQUISITION_LINES.join(' ');
    expect(text).toContain('種を植える');
    expect(text).toContain('ニワトリが見えなければ');
  });

  it('has the head break cane and grass directly, and raise wheat from seeds instead of walking to look for a village', () => {
    const text = MATERIAL_ACQUISITION_LINES.join(' ');
    // cane: the stand itself is dug (the body breaks a plant that is named), the one above the root keeps the root growing; a stand of one is the root
    expect(text).toContain('株は dig で直接壊せる');
    expect(text).toContain('根元が残ってまた伸びる');
    expect(text).toContain('高さ 1 の株は根元しか無いので、根元を壊す');
    // grass gives seeds now and then, and the answer to it is read in the result
    expect(text).toContain('壊すと時々 wheat_seeds が落ちる');
    expect(text).toContain('拾った: wheat_seeds+1');
    // no village in nearby or landmarks: none is searched for, with the reason
    expect(text).toContain('村は探しに遠出せず、草から種を集めて育てる');
    expect(text).toContain('探しに歩くより種から育てる方が早い');
    // the hoe, the seeds and the wait for the crop
    expect(text).toContain('use item=wooden_hoe');
    expect(text).toContain('use item=wheat_seeds');
    expect(text).toContain('待たずに別の材料');
    expect(text).not.toContain('根元の 1 つ上の段を dig すると、その上の段も一緒に壊れて');
  });
});

describe('bone meal on a crop', () => {
  const text = MATERIAL_ACQUISITION_LINES.join('\n');
  it('says what bone meal does to wheat and what the result shows', () => {
    expect(text).toContain('use item=bone_meal at=その作物');
    expect(text).toContain('育ち 2/7→5/7');
    expect(text).toContain('育ち切った作物には効かず、骨粉も減らない');
  });
  it('lists the ways to get it for a daytime meadow, composter first, with the reason, and a nearest move when none comes', () => {
    expect(text).toContain('昼の地上にはスケルトンが出ず');
    expect(text.indexOf('手A) コンポスター')).toBeLessThan(text.indexOf('手B) スケルトンの骨'));
    expect(text).toContain('make composter');
    expect(text).toContain('place block=composter');
    expect(text).toContain('pickup item=bone_meal');
    expect(text).toContain('頼まれた「早く育てる」に一番近い手');
  });
  it('is in the first plan of a single request and in every overworld decision', () => {
    expect(singleRequestFirstPlanSystem()).toContain('use item=bone_meal');
    expect(stageKnowledge({ body: { state: { dimension: 'overworld' } } })!).toContain('手A) コンポスター');
  });
});

describe('what she is told when people talk to her during a request of one thing', () => {
  const live = { body: { state: { dimension: 'overworld' }, planFacts: { request: true } } };
  it('reads a person\'s words as a suggestion to take into the plan, with the reason, and goes on when it cannot be followed', () => {
    const text = PERSON_WORDS_LINES.join('\n');
    expect(text).toContain('plan_update で計画に取り込む');
    expect(text).toContain('理由: 計画に書かなかった言葉は');
    expect(text).toContain('固まらず、人の返事を待たない');
    expect(text).toContain('手A のコンポスター');
  });

  it('keeps a finished thing until it is asked for, finds the place by a noun and then by the gaze, and hands it over near the person', () => {
    const text = PLACE_AND_HANDOVER_LINES.join('\n');
    expect(text).toContain('置く・渡すと言われるまで持ち物に持っておく');
    expect(text).toContain('自分から置かない・食べない・捨てない');
    expect(text).toContain('mc_view の only=[その名前]');
    expect(text).toContain('mc_probe kind=gaze player=');
    // A gaze that lands on the ground beside the noun's block is a hint toward the nearest candidate, not the place; a name that is not found is read again from the answer's list.
    expect(text).toContain('その placeAt も at も置き場にしない');
    expect(text).toContain('mc_view の center を答えの point（視線が当たった点。整数に丸める）、radius 3、only=[名詞]');
    expect(text).toContain('地面に置いてしまうとケーキは持ち物から消え');
    expect(text).toContain('答えが並べる「今いるのは …」');
    expect(text).toContain('聞き返さず進む');
    expect(text).toContain('一番近いプレイヤーに一番近い候補');
    expect(text).toContain('drop cake target=');
    expect(text).toContain('place cake 12,64,3 face=down');
    expect(text).toContain('7m を超える先へは歩かず');
    expect(text).toContain('先に go でそのマスの近く');
    expect(text).toContain('着いてから drop');
    expect(text).toContain('have:cake<1');
    // It names only the tools the mode has (a gaze is a kind of the probe).
    expect(foreignToolNames(text)).toEqual([]);
  });

  it('is in the first plan and the overworld decisions of a request of one thing, and not in the whole game\'s', () => {
    for (const line of FIRST_PLAN_PEOPLE_LINES) expect(singleRequestFirstPlanSystem()).toContain(line);
    expect(singleRequestFirstPlanSystem()).not.toContain('mc_probe kind=gaze');
    const request = stageKnowledge(live)!;
    for (const line of REQUEST_PEOPLE_LINES) expect(request).toContain(line);
    expect(stageKnowledge({ body: { state: { dimension: 'overworld' } } })!).not.toContain('作業中に人の言葉が届いた時');
    expect(ownFirstPlanSystem()).not.toContain('作業中に人の言葉が届いた時');
  });

  it('writes the hands as the short forms read them, and keeps the gaze\'s face and the hand\'s face apart', () => {
    const text = PLACE_AND_HANDOVER_LINES.join('\n');
    // `drop cake target=Yuu` reads as one kind with a target; `drop cake:1 target=Yuu` is the several-kinds form, which takes no target.
    expect(lineToHand('drop cake target=Yuu')).toMatchObject({ do: 'drop', items: [{ item: 'cake' }], target: 'Yuu' });
    expect(lineToHand('drop cake 1 target=Yuu')).toMatchObject({ items: [{ item: 'cake', count: 1 }], target: 'Yuu' });
    expect(lineToHand('drop cake:1 target=Yuu')).toHaveProperty('error');
    expect(lineToHand('place cake 12,64,3 face=down')).toMatchObject({ do: 'place', block: 'cake', at: [{ x: 12, y: 64, z: 3 }], face: 'down' });
    expect(text).toContain('手の face に up を書くと');
    expect(text).not.toContain('items=[{item: cake');
  });

  it('adds the node for putting a thing down only after she holds it, because have:cake<1 holds before it is made', () => {
    const text = PLACE_AND_HANDOVER_LINES.join('\n');
    expect(text).toContain('完成品を持ってから計画に足す');
    expect(text).toContain('作る前に済んだ事になり、置かずに完了する');
    expect(FIRST_PLAN_PEOPLE_LINES.join('\n')).toContain('置く・渡す節は持ってから足す');
    // The reason in the words is the code's own reading: with no cake in the pack the put node is seen done before the cake is made.
    const tree = { nodes: [
      { id: 'p1', parentId: null, order: 0, title: 'ケーキを作る', state: 'continue', doneWhen: 'have:cake>=1' },
      { id: 'p2', parentId: null, order: 1, title: 'ケーキを置く', state: 'continue', doneWhen: 'have:cake<1' },
    ] } as never;
    const facts = { counts: new Map(), dimension: 'overworld', feet: null, food: 20 } as never;
    expect(nodesSeenDone(tree, facts, true)).toEqual(['p2']);
  });

  it('tells the voice her request guide to keep the pointing words as they were said', () => {
    const guide = minecraftQueueGuide({ queueLines: [], running: null }).join('\n');
    expect(guide).toContain('「置いて」「ちょうだい」「渡して」');
    expect(guide).toContain('「この」「あそこ」を座標や別の言葉に直さない');
  });
});
