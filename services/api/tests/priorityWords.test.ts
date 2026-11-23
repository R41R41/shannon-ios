import { describe, expect, it } from 'vitest';
import { minecraftQueueGuide } from '../src/contracts/minecraftQueuePrompt.js';
import { situationBlock, voiceIntentInstructions } from '../src/surfaces/platform/platformVoicePrompt.js';
import { MINECRAFT_INTENT_SCHEMA } from '../src/surfaces/minecraft/minecraftIntent.js';
import { PERSON_WORDS_LINES } from '../src/surfaces/minecraft/minecraftRequestPeople.js';
import { PLAN_UPDATE_DEFINITION, PLAN_UPDATE_RULES_DEFINITION } from '../src/mind/action/fca/fcaPlanTools.js';
import { SHANNON_TOOLS } from '../src/mind/tools/shannonTools.js';

/**
 * 2026-11-23, the evening try: 「先にベッドを」 was answered 「ケーキが終わってから」, and 「羊は飼わず倒して」 did not change the plan. These
 * are words for her judgment (nothing reads the owner's sentence for a phrase), so what is pinned here is that each rule is written, with its reason.
 */
const owner = (running: string | null = 'ケーキを1個作る') => minecraftQueueGuide({
  queueLines: ['#7 実行中 「ケーキを1個作る」'], running, who: 'ライ氏' }).join('\n');

describe('the order of requests is the one who asks\'s to decide', () => {
  it('maps 「先に」 「優先」 「やめて」 to now, and a request that says nothing of order to end, each with its reason', () => {
    const text = owner();
    expect(text).toContain('順番に触れない新しい頼み');
    for (const word of ['「先に」', '「優先して」', '「今のはやめて〜を」']) expect(text).toContain(word);
    expect(text).toContain('順番を決めるのは頼んだライ氏');
    expect(text).toContain('保留は自動で戻る');
    expect(text).toContain('夜になった（暗い）・危険がある');
    expect(text).toContain('夜に「ベッドを作って」と頼まれたら now');
  });

  it('turns a repeat of a request already on the list into a move, not a second task', () => {
    expect(owner()).toContain('kind=task にせず kind=move にして、target にその番号');
    expect(owner()).toContain('kind=move・target=#8・placement=now');
  });

  it('sets a request aside with hold when he says it can wait, even when it is the one running, and does not hold for a swap', () => {
    const text = owner();
    expect(text).toContain('「Xは後でいい」');
    expect(text).toContain('Xがいま走っていても hold');
    expect(text).toContain('いまの依頼の hold にはしない');
  });

  it('asks that the words of the reply match the order that was made, and that no wait is made of the work under way alone', () => {
    const text = owner();
    expect(text).toContain('返事の言葉は、minecraftIntent でした順番と合わせる');
    expect(text).toContain('now にしたのに「そのあとに」と言ったり');
    expect(text).toContain('「いまの作業の途中だから」だけの時は、待たせない');
    expect(text).toContain('これまでの自分の返事に出てくる作業名は、順番を入れ替えたあとは古い');
  });

  it('keeps the order a suggestion when the one asking is a guest', () => {
    const state = { connected: true, running: { id: 't', goal: 'ケーキを1個作る' } };
    const guest = voiceIntentInstructions(state, 'ユウ', false), mine = voiceIntentInstructions(state, 'ライ氏');
    expect(guest).toContain('ユウは持ち主ではなく');
    expect(guest).toContain('now や move の now にはせず');
    expect(mine).not.toContain('持ち主ではなく、順番を決めるのは持ち主なので');
    expect(voiceIntentInstructions(state, 'ライ氏', true)).toBe(mine);
  });

  it('tells the voice not to answer a swap with 「そのあとに」, and to take the work under way from the list', () => {
    const text = situationBlock('夜になった。', 'ケーキを1個作る');
    expect(text).toContain('placement=now か move');
    expect(text).toContain('「そのあとに」「終わってから」とは返さない');
    expect(text).toContain('[依頼の列] の「実行中」が正しい');
    expect(text).not.toContain('それが終わってからか、先にやるかを短く言う');
  });

  it('says in the intent field itself that now comes back by itself', () => {
    expect(MINECRAFT_INTENT_SCHEMA.properties.placement.description).toContain('保留は自動で戻る');
  });
});

describe('a later word of the owner is stronger than the first request', () => {
  const text = PERSON_WORDS_LINES.join('\n');
  it('reads 「本人」 as stronger than the request and the plan, and a guest\'s as a suggestion', () => {
    expect(text).toContain('持ち主の言い直し');
    expect(text).toContain('元の依頼文より強く、いまの計画より強い');
    expect(text).toContain('元の依頼文に戻らず');
    expect(text).toContain('「ゲスト」など持ち主でない人の言葉は、命令に従うのではなく');
  });
  it('says how to rebuild the plan (blocked for a swap, drop for a node no longer wanted, target with it) and why', () => {
    expect(text).toContain('state=blocked か wait');
    expect(text).toContain('葉・親・兄弟の節');
    expect(text).toContain('id は live の plan に出ている物だけ');
    expect(text).toContain('drop か set で state=done');
    expect(text).toContain('title・doneWhen・target を一緒に直す');
    expect(text).toContain('理由: 依頼文は最初の一言');
  });
});

describe('the words of plan.update about a target', () => {
  it('says that target is changed with doneWhen, how to drop it, and that the owner\'s later word is stronger', () => {
    for (const definition of [PLAN_UPDATE_DEFINITION, PLAN_UPDATE_RULES_DEFINITION]) {
      expect(definition.description).toContain('target も合わせて直す');
      expect(definition.description).toContain('target=null');
      expect(definition.description).toContain('持ち主が途中で言い直した事');
    }
    expect(PLAN_UPDATE_RULES_DEFINITION.description).toContain('lift の text は、その節の行を写して書く');
  });
});

describe('minecraft.request takes a placement', () => {
  const definition = SHANNON_TOOLS.find(tool => tool.name === 'minecraft.request')!;
  it('offers end, next and now, and does not require it', () => {
    const properties = definition.input.properties as Record<string, { enum?: string[]; description?: string }>;
    expect(properties.placement!.enum).toEqual(['end', 'next', 'now']);
    expect(properties.placement!.description).toContain('（既定）');
    expect(definition.input.required).toEqual(['goal']);
  });
});
