import { describe, expect, it } from 'vitest';
import { SPEECH_MODES, SPEECH_RATES } from '@shannon/mind';
import { bodyIntentOf, MINECRAFT_INTENT_KINDS, MINECRAFT_INTENT_SCHEMA, parsedMinecraftIntent } from '../src/surfaces/minecraft/minecraftIntent.js';
import { minecraftQueueGuide } from '../src/contracts/minecraftQueuePrompt.js';
import { materialsOf, recipeOf } from '../src/surfaces/minecraft/minecraftLlmcRecipes.js';

describe('the intent field of her reply', () => {
  it('has every field required and every kind of the list in the enum', () => {
    expect(MINECRAFT_INTENT_SCHEMA.required).toEqual(['kind', 'goal', 'placement', 'target', 'speechMode', 'speechRate']);
    expect(MINECRAFT_INTENT_SCHEMA.properties.kind.enum).toEqual([...MINECRAFT_INTENT_KINDS]);
    expect(MINECRAFT_INTENT_SCHEMA.properties.placement.enum).toEqual(['end', 'next', 'now', '']);
    expect(Object.keys(MINECRAFT_INTENT_SCHEMA.properties)).toEqual(MINECRAFT_INTENT_SCHEMA.required);
  });

  it('reads each kind with only the fields it uses, and the older shape as it was', () => {
    expect(parsedMinecraftIntent({ kind: 'task', goal: ' ケーキを\n作る ', placement: 'next', target: '#2' })).toEqual({ kind: 'task', goal: 'ケーキを 作る', placement: 'next' });
    expect(parsedMinecraftIntent({ kind: 'task', goal: '丸石を集める' })).toEqual({ kind: 'task', goal: '丸石を集める' });
    expect(parsedMinecraftIntent({ kind: 'message', goal: '16個にして', placement: 'now' })).toEqual({ kind: 'message', goal: '16個にして' });
    expect(parsedMinecraftIntent({ kind: 'stop', goal: 'x', placement: 'now', target: '3' })).toEqual({ kind: 'stop', goal: '' });
    expect(parsedMinecraftIntent({ kind: 'cancel', goal: '', placement: '', target: ' #3 ' })).toEqual({ kind: 'cancel', goal: '', target: '#3' });
    expect(parsedMinecraftIntent({ kind: 'hold', goal: '', placement: '', target: '' })).toEqual({ kind: 'hold', goal: '' });
    expect(parsedMinecraftIntent({ kind: 'resume', goal: '', target: '2' })).toEqual({ kind: 'resume', goal: '', target: '2' });
    expect(parsedMinecraftIntent({ kind: 'move', goal: '', placement: 'end', target: '#1' })).toEqual({ kind: 'move', goal: '', placement: 'end', target: '#1' });
    expect(parsedMinecraftIntent({ kind: 'none', goal: 'x' })).toEqual({ kind: 'none', goal: '' });
  });

  it('reads a way of speaking from either field, with the words of the head (no copy of the lists drifts from them)', () => {
    expect(MINECRAFT_INTENT_SCHEMA.properties.speechMode.enum).toEqual([...SPEECH_MODES, '']);
    expect(MINECRAFT_INTENT_SCHEMA.properties.speechRate.enum).toEqual([...SPEECH_RATES, '']);
    expect(parsedMinecraftIntent({ kind: 'speech', goal: 'x', placement: 'now', target: '3', speechMode: 'needed', speechRate: '' })).toEqual({ kind: 'speech', goal: '', speechMode: 'needed' });
    expect(parsedMinecraftIntent({ kind: 'speech', goal: '', placement: '', target: '', speechMode: '', speechRate: 'high' })).toEqual({ kind: 'speech', goal: '', speechRate: 'high' });
    expect(parsedMinecraftIntent({ kind: 'speech', speechMode: 'silent', speechRate: 'low' })).toEqual({ kind: 'speech', goal: '', speechMode: 'silent', speechRate: 'low' });
    expect(parsedMinecraftIntent({ kind: 'speech', goal: '', speechMode: '', speechRate: '' })).toBeNull();
    expect(parsedMinecraftIntent({ kind: 'speech', speechMode: 'loud' })).toBeNull();
    // Another kind keeps none of it, and the body is never told of a way of speaking as a request.
    expect(parsedMinecraftIntent({ kind: 'task', goal: 'パン', speechMode: 'silent' })).toEqual({ kind: 'task', goal: 'パン' });
    expect(bodyIntentOf({ kind: 'speech', goal: '', speechMode: 'silent' })).toEqual({ kind: 'none', goal: '' });
  });

  it('puts login and logout after speech, reading nothing else from them, and the body is never told of them as a request', () => {
    expect([...MINECRAFT_INTENT_KINDS].slice(-4)).toEqual(['speech', 'login', 'logout', 'call_join']);
    expect(MINECRAFT_INTENT_SCHEMA.properties.kind.description).toContain('login=マイクラの体をサーバーへ入れてほしいと誰かが頼んだ時だけ');
    expect(MINECRAFT_INTENT_SCHEMA.properties.kind.description).toContain('logout=マイクラの体をサーバーから出してほしいと誰かが頼んだ時だけ。');
    expect(MINECRAFT_INTENT_SCHEMA.properties.kind.description).toContain('call_join=Discordの通話に入ってきてほしい');
    expect(parsedMinecraftIntent({ kind: 'login', goal: 'x', placement: 'now', target: '3', speechMode: 'silent', speechRate: 'low' })).toEqual({ kind: 'login', goal: '' });
    expect(parsedMinecraftIntent({ kind: 'logout', goal: '', placement: '', target: '', speechMode: '', speechRate: '' })).toEqual({ kind: 'logout', goal: '' });
    expect(bodyIntentOf({ kind: 'login', goal: '' })).toEqual({ kind: 'none', goal: '' });
    expect(bodyIntentOf({ kind: 'logout', goal: '' })).toEqual({ kind: 'none', goal: '' });
    expect(parsedMinecraftIntent({ kind: 'call_join', goal: 'x', placement: 'now', target: '3' })).toEqual({ kind: 'call_join', goal: '' });
    expect(bodyIntentOf({ kind: 'call_join', goal: '' })).toEqual({ kind: 'none', goal: '' });
  });

  it('reads nothing from a task without words, a move without a target, an unknown kind, or a placement that is not one', () => {
    expect(parsedMinecraftIntent({ kind: 'task', goal: '' })).toBeNull();
    expect(parsedMinecraftIntent({ kind: 'message', goal: '  ' })).toBeNull();
    expect(parsedMinecraftIntent({ kind: 'move', goal: '', placement: 'next', target: '' })).toBeNull();
    expect(parsedMinecraftIntent({ kind: 'fly' })).toBeNull();
    expect(parsedMinecraftIntent(null)).toBeNull();
    expect(parsedMinecraftIntent({ kind: 'task', goal: 'a', placement: 'later' })).toEqual({ kind: 'task', goal: 'a' });
    expect(parsedMinecraftIntent({ kind: 'task', goal: 'あ'.repeat(200) })?.goal).toHaveLength(120);
    expect(parsedMinecraftIntent({ kind: 'cancel', target: '1234567890123456' })?.target).toHaveLength(12);
  });

  it('tells the body only the kinds it has always known', () => {
    expect(bodyIntentOf({ kind: 'task', goal: 'a', placement: 'now' })).toEqual({ kind: 'task', goal: 'a' });
    for (const kind of ['stop', 'cancel', 'hold'] as const) expect(bodyIntentOf({ kind, goal: '' })).toEqual({ kind: 'stop', goal: '' });
    for (const kind of ['none', 'message', 'resume', 'move'] as const) expect(bodyIntentOf({ kind, goal: 'x' })).toEqual({ kind: 'none', goal: '' });
  });
});

describe('what she is told of the list', () => {
  const guide = (options: Partial<Parameters<typeof minecraftQueueGuide>[0]> = {}) =>
    minecraftQueueGuide({ queueLines: [], running: null, ...options }).join('\n');

  it('says how his ways of asking map to the kinds, with the reason, and leaves the judgment to her', () => {
    const text = guide();
    for (const word of ['kind=task', 'kind=message', 'kind=stop', 'cancel', 'hold', 'resume', 'move', 'placement', 'end', 'next', 'now']) expect(text).toContain(word);
    // Examples of his ways of saying it, as hers to match; the words are never matched by the code.
    for (const example of ['あとで', '次に', '今のはやめて', '全部止めて']) expect(text).toContain(example);
    expect(text).toContain('一度に一つ');
    expect(text).toContain('[依頼の列] いまは空');
  });

  it('sends a fact about the work under way (has, has not, where, a correction) to the body as a message, with the reason, and leaves small talk to none', () => {
    const running = guide({ running: 'ケーキを作る' });
    expect(running).toContain('持っている');
    expect(running).toContain('間違いの指摘');
    expect(running).toContain('goal に事実をそのまま書く');
    expect(running).toContain('人が何度も言い直すことになる');
    expect(running).toContain('相づちは none のまま');
  });

  it('says that words for work are a new request when nothing runs, with the reason, and keeps the message line when something does', () => {
    const idle = guide();
    expect(idle).toContain('いま実行中の依頼も待っている依頼も無い');
    expect(idle).toContain('kind=message は使わない');
    expect(idle).toContain('足す先が無いと体に届かず');
    expect(idle).toContain('直前に終わった依頼の成果物');
    for (const busy of [guide({ running: 'ケーキを作る' }), guide({ queueLines: ['#1 待ち 「木材を集める」'] })]) {
      expect(busy).not.toContain('いま実行中の依頼も待っている依頼も無い');
      expect(busy).toContain('新しい依頼にはならず、いまの作業への伝言として渡る');
    }
  });

  it('shows the list as it stands, the running request, and who is asking', () => {
    const lines = ['#1 実行中 「ケーキを作る」', '#2 待ち 「木材を集める」'];
    const text = guide({ queueLines: lines, running: 'ケーキを作る' });
    expect(text).toContain('いま体は「ケーキを作る」をしている');
    expect(text).toContain(`[依頼の列]\n${lines.join('\n')}`);
    const asked = guide({ who: 'ユウ' });
    expect(asked).toContain('ユウがマイクラでしてほしいこと');
    expect(asked).toContain('placement は、順番に触れた言葉があるかで選ぶ');
    expect(asked).not.toContain('足せない');
  });
});

describe('the cake in the table of recipes', () => {
  it('counts the cake and the sugar it needs, and the sugar from its cane', () => {
    expect(recipeOf('cake')).toEqual({ yields: 1, needs: [{ item: 'milk_bucket', count: 3 }, { item: 'sugar', count: 2 }, { item: 'egg', count: 1 }, { item: 'wheat', count: 3 }] });
    expect(recipeOf('minecraft:sugar')).toEqual({ yields: 1, needs: [{ item: 'sugar_cane', count: 1 }] });
    expect(materialsOf('cake', 1, { chain: false })).toEqual({ spends: expect.arrayContaining([{ item: 'egg', count: 1 }]), uncounted: false });
  });
});
