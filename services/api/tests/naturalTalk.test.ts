import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  NATURAL_ORDER_LINE, NATURAL_PLAY_LINE, NATURAL_SHORT_LINE, createInitialCompanionState, type CompanionStateSnapshot, type ReplyCheckContext,
} from '@shannon/cognition';
import { SWITCHES, switchOn } from '@shannon/switches';
import { composedFeeling, feelingDayFeatures, spaceGuarded } from '../src/wiring/feelingWiring.js';
import { feelingBody, feelingText } from '../src/mind/emotion/feelingPorts.js';
import { casualWords } from '../src/mind/emotion/naturalTalk.js';
import { checkContext } from '../src/mind/emotion/feelingTurnCheck.js';
import { FeelingReplyChatModel } from '../src/infra/models/feelingStrongChatModel.js';
import { NATURAL_TALK_STYLE_INSTRUCTIONS, SHANNON_RESPONSE_STYLE_INSTRUCTIONS, parseStructuredTurn } from '../src/infra/models/chatModelSupport.js';
import { chatTurnInstructions } from '../src/infra/models/chatModelTurn.js';
import { ChatReplyStreamDecoder } from '../src/infra/models/chatReplyStreamDecoder.js';
import { replyBreaks } from '../src/infra/models/replyBreaks.js';
import { SQLiteReplyDraftStore, WITHHELD_DRAFT } from '../src/mind/emotion/store/replyDraftStore.js';
import { VoiceSegmentTags, displayedVoiceText, elevenVoiceText, withoutStrayEnglish } from '../src/infra/models/voiceAudioTags.js';
import type { ShannonChatModel, ShannonChatModelRequest } from '../src/infra/models/chatModel.js';
import { fakeFeelingJev } from './support/feelingHarness.js';

/** Owner 2026-10-20: 「全然思った通りに乗ってくれない…クリーンすぎて人間らしくない」 (`SHANNON_NATURAL_TALK`). */
const TODAY = '2026-10-25T11:00:00.000Z'; // 20:00 JST
const later = (minutes: number) => new Date(Date.parse(TODAY) + minutes * 60_000).toISOString();
const snapshot = (): CompanionStateSnapshot => ({ ...createInitialCompanionState('owner', '2026-10-20T03:00:00.000Z'),
  sharedDays: ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24'] });

function composed(natural: boolean, options: { stance?: string; max?: boolean } = {}) {
  const jev = fakeFeelingJev(() => ({ stance: options.stance ?? 'tease', intensity: 'moderate', drawer: 'none' }));
  const database = new DatabaseSync(':memory:');
  const space = { max: options.max ?? true, ...(natural ? { natural: true } : {}) };
  const configured = composedFeeling({ database, now: () => TODAY, timeZone: 'Asia/Tokyo', chooser: jev.chooser, turn: true, singleFace: true, check: true,
    strong: { cap: 100, model: {} as never }, days: { relationship: false, episodes: false, boundaries: false, space } });
  return { port: configured.port, wrap: configured.wrap, jev, database };
}
type Port = ReturnType<typeof composed>['port'];
const start = (port: Port, message: string, at = TODAY, alone = true) =>
  feelingText.start(port, { scopeKey: 'owner', alone, surface: false, message, begun: { occurredAt: at, captured: snapshot() } });

async function say(port: Port, message: string, at = TODAY, reply = 'うん。') {
  const handle = start(port, message, at);
  const block = await feelingText.block(handle);
  const route = feelingText.route(handle);
  feelingText.ended(handle, { at, message, reply, experienceId: `x${at}${message}` });
  return { handle, block, route };
}

const touch = (port: Port, id: string, at: string, stance?: string) => feelingBody.touched(port, 'owner',
  { id, type: 'poke', part: 'chest', audience: 'owner', occurredAt: at, burstId: `b${id}` }, stance ? { stance } : {});

describe('her talk with the owner alone (SHANNON_NATURAL_TALK)', () => {
  it('is off by default and needs her character space', () => {
    expect(switchOn({}, 'SHANNON_NATURAL_TALK')).toBe(false);
    expect(SWITCHES.find(entry => entry.name === 'SHANNON_NATURAL_TALK')?.requires).toEqual(['SHANNON_CHARACTER_SPACE']);
    expect(feelingDayFeatures({ SHANNON_CHARACTER_SPACE: 'on' }).space).toEqual({ max: false });
    const on = feelingDayFeatures({ SHANNON_CHARACTER_SPACE: 'on', SHANNON_NATURAL_TALK: 'on' });
    expect(on.space).toEqual({ max: false, natural: true });
    expect(feelingDayFeatures({ SHANNON_NATURAL_TALK: 'on' }).space).toBeUndefined();
    expect(spaceGuarded(on, true, false).space).toBeUndefined();
  });

  it('off: the menu, the questions, the block and the request are as before', async () => {
    const { port, jev } = composed(false);
    const { handle, block, route } = await say(port, 'エッチな体してるのがいけない');
    expect(handle?.lines?.space?.natural).toBeUndefined();
    expect(handle?.lines?.space?.cues).not.toContain('flirt');
    expect(JSON.stringify(jev.questions[0])).not.toContain('"play_along"');
    expect(JSON.stringify(jev.questions[0])).toContain('slightly tsundere');
    expect(block).not.toContain(NATURAL_PLAY_LINE);
    expect(route.naturalTalk).toBeUndefined();
    expect(Object.keys(handle?.lines?.facts ?? {})).not.toContain('same_stance_run');
  });

  it('on: reads play in his words, asks Jev v4 with the playful stances, and tells the reply model it is talk', async () => {
    const { port, jev } = composed(true);
    const { handle, block, route } = await say(port, 'エッチな体してるのがいけない');
    expect(handle?.lines?.space?.natural).toBe(true);
    expect(handle?.lines?.space?.cues).toContain('flirt');
    const questions = JSON.stringify(jev.questions[0]);
    expect(questions).toContain('play_along');
    expect(questions).toContain('tsukkomi');
    expect(questions).not.toContain('slightly tsundere');
    expect(jev.states[0]).toMatchObject({ shannon_feeling: { cues: expect.arrayContaining(['flirt']) } });
    expect(block).toContain(NATURAL_PLAY_LINE);
    expect(block).toContain(NATURAL_SHORT_LINE);
    expect(route.naturalTalk).toBe(true);
    expect(checkContext(handle!)).toMatchObject({ natural: true });
    // Every natural turn is checked before sending (review: its turns of play leave the regions that are).
    expect(route.feelingCheck).toMatchObject({ natural: true, region: 'flustered' });
  });

  it('on: a request to act is play (the natural order line), and a request is not answered short', async () => {
    const { port } = composed(true);
    const order = await say(port, 'もっと恥ずかしがって見せて');
    expect(order.block).toContain(NATURAL_ORDER_LINE);
    const request = await say(port, '小説とか作ってほしい', later(1));
    expect(request.block).not.toContain(NATURAL_SHORT_LINE);
    expect(casualWords('お風呂入ってる？')).toBe(true);
    expect(casualWords('マイクラの改善点を調べて')).toBe(false);
    expect(casualWords('PythonでリストをsortするにはHow？')).toBe(false);
  });

  it('on: keeps Jev\'s own stance on her reply and tells Jev how long one stance has run', async () => {
    const { port, jev } = composed(true);
    for (let minute = 0; minute < 4; minute += 1) await say(port, `なにしてた？${minute}`, later(minute));
    const replies = port.events.today('owner', later(4), snapshot()).filter(event => event.kind === 'own_reply');
    expect(replies.every(event => event.facts.jevStance === 'tease')).toBe(true);
    await say(port, 'ねえ', later(5));
    expect(jev.states.at(-1)).toMatchObject({ shannon_feeling: { ledger: { last_stance: 'tease', same_stance_run: 4 } } });
  });

  it('on: the day\'s touch facts only within ten minutes of a touch (once), or when he speaks of her body', async () => {
    const { port } = composed(true);
    touch(port, 't1', later(-30), 'dislike');
    const unrelated = await say(port, 'マイクラの機能を改善していくぞ〜');
    expect(unrelated.block).not.toContain('事実: 今日の');
    const body = await say(port, '胸つついてごめんね', later(1));
    expect(body.block).toContain('事実: 今日の');
    touch(port, 't2', later(2));
    const fresh = await say(port, 'へへ', later(3));
    expect(fresh.block).toContain('事実: 今日の');
    const again = await say(port, 'それでさ', later(4));
    expect(again.block).not.toContain('事実: 今日の');
    const words = await say(port, '満足した、具体的にはあの体調の話', later(30));
    expect(words.block).not.toContain('事実: 今日の');
  });

  it('off: the touch facts are in every turn, as before', async () => {
    const { port } = composed(false);
    touch(port, 't1', later(-30), 'dislike');
    const unrelated = await say(port, 'マイクラの機能を改善していくぞ〜');
    expect(unrelated.block).toContain('事実: 今日の');
  });

  it('on: with 好意 held at the top she still goes to 照れ on a lewd tease', async () => {
    const off = await say(composed(false).port, 'シャノンがエッチな体してるのがいけない');
    const on = await say(composed(true).port, 'シャノンがエッチな体してるのがいけない');
    expect(off.handle?.lines?.space?.selection.primary).toMatch(/devoted|heavy/u);
    expect(on.handle?.lines?.space?.selection.primary).toBe('flustered');
  });

  it('on: never for anyone else in the turn', async () => {
    const { port } = composed(true);
    const others = start(port, 'エッチな体だね', TODAY, false);
    await feelingText.block(others);
    expect(others?.lines?.space?.natural).toBeUndefined();
    expect(feelingText.route(others).naturalTalk).toBeUndefined();
  });
});

describe('the reply model in a natural turn', () => {
  const request = (extra: Partial<ShannonChatModelRequest> = {}): ShannonChatModelRequest => ({ scopeKey: 'owner', systemPrompt: 'あなたはシャノン', history: [],
    message: 'やあ', ...extra });

  it('takes the conversation\'s style in place of the report\'s', () => {
    expect(chatTurnInstructions(request(), undefined)).toContain(SHANNON_RESPONSE_STYLE_INSTRUCTIONS);
    const natural = chatTurnInstructions(request({ naturalTalk: true }), undefined);
    expect(natural).toContain(NATURAL_TALK_STYLE_INSTRUCTIONS);
    expect(natural).not.toContain(SHANNON_RESPONSE_STYLE_INSTRUCTIONS);
  });

  function model(replies: string[]) {
    const asked: ShannonChatModelRequest[] = [];
    const inner: ShannonChatModel = { mode: 'local-stub', model: 'stub', generate: async (sent) => {
      asked.push(sent);
      return { mode: 'local-stub', model: 'stub', reply: replies.shift() ?? 'ふつう。' };
    } };
    return { inner, asked };
  }
  const context = (extra: Partial<ReplyCheckContext>): ReplyCheckContext => ({ stance: 'sulk', intensity: 'moderate', audience: 'owner_alone', order: false,
    violation: false, turn: 't1', ...extra });

  it('notes a sweet reply on a declining stance without rewriting it, and keeps a rewritten draft', async () => {
    const { inner, asked } = model(['えへへ、うれしい。だいすき。']);
    const noted: string[][] = [];
    const reply = new FeelingReplyChatModel(inner, { checked: (_scope, flags) => noted.push([...flags]), ranTool: () => false });
    const result = await reply.generate({ ...request(), feelingCheck: context({ stance: 'sulky', natural: true }) });
    expect(result.reply).toBe('えへへ、うれしい。だいすき。');
    expect(asked).toHaveLength(1);
    expect(noted[0]).toContain('stance_mismatch');

    const drafts = new SQLiteReplyDraftStore(new DatabaseSync(':memory:'), () => TODAY);
    const second = model(['ボクは平気です、気にしてません。', 'むう。']);
    const kept = new FeelingReplyChatModel(second.inner, { ranTool: () => false, drafted: (scope, draft) => drafts.keep(scope, draft) });
    await kept.generate({ ...request(), feelingCheck: context({ stance: 'sulky', violation: true, natural: true }) });
    expect(drafts.recent('owner')).toMatchObject([{ turn: 't1', first: 'ボクは平気です、気にしてません。', second: 'むう。' }]);
    drafts.keep('owner', { turn: 't2', flags: ['sexual'], first: 'ないしょ', second: 'むう。' });
    expect(drafts.recent('owner')[0]).toMatchObject({ turn: 't2', first: WITHHELD_DRAFT, second: WITHHELD_DRAFT });
  });

  it('starts no rewrite when nothing is left of the turn', async () => {
    const { inner, asked } = model(['ボクは平気です、気にしてません。', 'むう。']);
    const tools = { deadline: { left: () => 1_000 } } as unknown as ShannonChatModelRequest['tools'];
    const reply = new FeelingReplyChatModel(inner, { ranTool: () => false });
    const result = await reply.generate({ ...request(), tools, feelingCheck: context({ stance: 'sulky', violation: true }) });
    expect(result.reply).toBe('ボクは平気です、気にしてません。');
    expect(asked).toHaveLength(1);
  });

  it('cuts the rewrite\'s wait to what is left of the turn', async () => {
    const slow: ShannonChatModel = { mode: 'local-stub', model: 'stub', generate: async (sent) => {
      if (!sent.turnContext?.includes('[書き直し]')) return { mode: 'local-stub', model: 'stub', reply: 'ボクは平気です、気にしてません。' };
      await new Promise(resolve => setTimeout(resolve, 400));
      return { mode: 'local-stub', model: 'stub', reply: 'むう。' };
    } };
    const tools = { deadline: { left: () => 1_600 } } as unknown as ShannonChatModelRequest['tools'];
    const reply = new FeelingReplyChatModel(slow, { ranTool: () => false });
    const result = await reply.generate({ ...request(), tools, feelingCheck: context({ stance: 'sulky', violation: true }) });
    expect(result.reply).toBe('ボクは平気です、気にしてません。');
  });
});

describe('a line break written as 「\\」「n」', () => {
  it('is a line break outside code, in the whole reply and while it streams', () => {
    const reply = 'えっ\\nほんとに？\\n\\n`printf("\\n")` はそのまま。C:\\new も';
    expect(replyBreaks(reply)).toBe('えっ\nほんとに？\n\n`printf("\\n")` はそのまま。C:\\new も');
    const json = JSON.stringify({ reply, threadSummary: null, taskDecision: { disposition: 'none', reason: 'x' }, taskProposal: null, intentPlan: null,
      artifacts: null });
    expect(parseStructuredTurn(json).reply).toBe(replyBreaks(reply));
    for (const size of [1, 2, 3, 7]) {
      const decoder = new ChatReplyStreamDecoder();
      let out = '';
      for (let index = 0; index < json.length; index += size) out += decoder.push(json.slice(index, index + size));
      expect(out).toBe(replyBreaks(reply).trim());
    }
  });
});

describe('an English sentence in a Japanese spoken reply', () => {
  const english = 'Doesn\'t matter if it\'s a joke; I\'m not going to make a big deal of it right now.';
  it('is dropped where Japanese is around it; a reply all in English, a name and a tag stay', () => {
    const said = 'もう、いきなりそういうこと言うの、やめてください。びっくりするじゃないですか。';
    expect(withoutStrayEnglish(`ふーん。${english} ${said}`)).toBe(`ふーん。 ${said}`);
    expect(displayedVoiceText(`${said}${english}`)).toBe(said);
    expect(elevenVoiceText(`[whispers] ${said}${english}`)).toBe(`[whispers] ${said}`);
    expect(withoutStrayEnglish(english)).toBe(english);
    expect(withoutStrayEnglish('Shannon Live Voice Stream の話です')).toBe('Shannon Live Voice Stream の話です');
    expect(withoutStrayEnglish('英語だと、I really love you so much. だよ')).toBe('英語だと、I really love you so much. だよ');
    expect(withoutStrayEnglish('この曲、『Hello, is it me you are looking for』って知ってる？')).toBe('この曲、『Hello, is it me you are looking for』って知ってる？');
    expect(withoutStrayEnglish('Sakura (桜) is the flower that I like the most.')).toBe('Sakura (桜) is the flower that I like the most.');
    const tags = new VoiceSegmentTags();
    expect(tags.take(said)).toEqual({ text: said });
    expect(tags.take(english)).toBeNull();
  });
});
