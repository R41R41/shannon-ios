import { describe, expect, it } from 'vitest';
import {
  ADDRESSED_QUESTION_WINDOW_MILLISECONDS, addressedGate, addressedQuestions, addressedState, askedHer, parsedAddressed, type AddressedInput,
} from '../src/mind/perception/addressed.js';
import { endsAsQuestion } from '../src/mind/perception/spokenQuestion.js';
import { LIVE_BLOCK_HEADER, liveBlock, type LiveSnapshot } from '../src/surfaces/minecraft/minecraftLiveBlock.js';
import { VoiceRooms } from '../src/surfaces/platform/voiceRoom.js';
import { validatedVoiceTurn } from '../src/surfaces/platform/platformVoice.js';
import { workOf } from '../src/surfaces/platform/platformVoiceAddressed.js';
import { validatedConversationTurn, voiceRequestOf } from '../src/surfaces/platform/platformConverse.js';
import { askedBackBlock, situationBlock } from '../src/surfaces/platform/platformVoicePrompt.js';

/** Talk while she works, and the answer to a question she asked herself (the voice call's turns; the whole path is in `platformVoice.test.ts`). */
const base = { scopeKey: 'owner', speaker: { id: 'u1', name: 'ユウ' }, humans: 3 };
const work = { goal: 'ケーキを1個作る', list: ['#1 実行中 「ケーキを1個作る」（ユウ）'] };

describe('endsAsQuestion', () => {
  it('reads a question she asked from its mark or its spoken ending, in the last two sentences', () => {
    for (const text of ['できた！どこに置けばいい？', '渡せばいいかな', 'どこに置く？ここで待ってるね。', 'これでいいのかな。', 'Where should I put it?']) expect(endsAsQuestion(text), text).toBe(true);
    for (const text of ['ケーキができたよ。', '小麦の種がとれたよ！', '牛乳はバケツがいるから鉄が必要だね。', 'うん、いいよ。']) expect(endsAsQuestion(text), text).toBe(false);
    // A question three sentences back is not what she is waiting on.
    expect(endsAsQuestion('どこに置く？ここで待ってるね。ちょっと見てるよ。もうすぐだよ。')).toBe(false);
  });
});

describe('a question she asked, in the room', () => {
  it('is kept with her line, and closed when the next person\'s words took it', () => {
    let at = Date.parse('2026-11-22T12:00:00.000Z');
    const rooms = new VoiceRooms(() => at);
    rooms.noteShannon('r', { at: new Date(at).toISOString(), userId: '', text: 'できた！どこに置けばいい？' });
    expect(rooms.lastShannon('r')?.asked).toBe(true);
    rooms.closeQuestion('r');
    expect(rooms.lastShannon('r')?.asked).not.toBe(true);
    expect(rooms.lastShannon('r')?.text).toBe('できた！どこに置けばいい？');
    at += 1_000;
    rooms.noteShannon('r', { at: new Date(at).toISOString(), userId: 'u1', text: 'うん、いいよ。' });
    expect(rooms.lastShannon('r')?.asked).not.toBe(true);
  });

  it('is read before the line is cut short for the room\'s record', () => {
    const rooms = new VoiceRooms(() => 0);
    const long = `${'ケーキの材料がだいぶそろってきたよ。'.repeat(10)}どこに置けばいい？`;
    rooms.noteShannon('r', { at: new Date(0).toISOString(), userId: '', text: long });
    expect(rooms.lastShannon('r')?.asked).toBe(true);
  });
});

describe('the gate while she works and after her question', () => {
  it('asks Jev about nameless words while she works, in a room of several; otherwise stays quiet as before', () => {
    expect(addressedGate({ ...base, transcript: '小麦は骨粉で早く成長させよう' })).toMatchObject({ kind: 'quiet', reason: 'no_name' });
    expect(addressedGate({ ...base, transcript: '小麦は骨粉で早く成長させよう', work })).toMatchObject({ kind: 'ask', unnamed: 'working', follows: false });
    // The owner alone keeps his own rule; a name keeps the old path.
    expect(addressedGate({ ...base, humans: 1, owner: true, transcript: '明日の天気わかる？', work })).toMatchObject({ kind: 'ask', unnamed: 'alone' });
    expect(addressedGate({ ...base, transcript: 'シャノン、いま何してるの', work })).toMatchObject({ kind: 'ask', follows: false });
    expect(addressedGate({ ...base, transcript: 'シャノン、いま何してるの', work })).not.toHaveProperty('unnamed');
  });

  it('asks Jev whether the first nameless words after a question she asked the room answer it, for 45 seconds', () => {
    const asked = (secondsAgo: number, toSpeaker: boolean | null, flag = true) => ({
      ...base, transcript: 'このオークの木材ブロックの上に置いて', shannon: { spokeAgoMs: secondsAgo * 1000, toSpeaker, ...(flag ? { asked: true } : {}) },
    });
    // Without her name, Jev says whether they answer it; called by name inside the window, as before, they are taken as the answer.
    expect(addressedGate(asked(30, null))).toMatchObject({ kind: 'ask', unnamed: 'answering', name: null });
    expect(addressedGate(asked(44, true))).toMatchObject({ kind: 'ask', unnamed: 'answering' });
    expect(addressedGate({ ...asked(30, null), transcript: 'シャノン、ここに置いて' })).toMatchObject({ kind: 'yes', reason: 'answer_to_question' });
    expect(addressedGate(asked(46, null))).toMatchObject({ kind: 'quiet' });
    // For someone else, or not a question: the old rules.
    expect(addressedGate(asked(10, false))).toMatchObject({ kind: 'quiet' });
    expect(addressedGate(asked(10, null, false))).toMatchObject({ kind: 'ask', follows: true });
    expect(askedHer(asked(30, null) as AddressedInput)).toBe(true);
    expect(ADDRESSED_QUESTION_WINDOW_MILLISECONDS).toBe(45_000);
  });
});

describe('what Jev is shown and what its answer makes of it', () => {
  it('tells it she works and what on, and that she just asked, only when so', () => {
    const idle = addressedState({ ...base, transcript: 'どう？' }, null, false);
    expect(idle).not.toHaveProperty('shannon_is_working_in_minecraft');
    expect(idle).not.toHaveProperty('shannon_last_line_was_a_question');
    const busy = addressedState({ ...base, transcript: 'どう？', work, shannon: { spokeAgoMs: 5_000, toSpeaker: null, asked: true, line: 'どこに置く？' } }, null, false);
    expect(busy).toMatchObject({ shannon_is_working_in_minecraft: true, current_work: 'ケーキを1個作る', request_list: work.list, shannon_last_line_was_a_question: true });
    const waiting = addressedState({ ...base, transcript: 'どう？', work: { goal: null, list: ['#2 待ち 「小麦を3個集める」'] } }, null, false);
    expect(waiting).toMatchObject({ current_work: null });
    const text = JSON.stringify(addressedQuestions());
    expect(text).toContain('shannon_is_working_in_minecraft');
    expect(text).toContain('shannon_last_line_was_a_question');
  });

  it('shows Jev her question as she said it (its end when the line is long), and answers by `answers_her_question` alone (0.4) inside the window', () => {
    const long = `${'ケーキの材料がだいぶそろってきたよ。'.repeat(12)}どこに置けばいい？渡せばいいかな？`;
    const state = addressedState({ ...base, transcript: 'そこの板の上に置いて', shannon: { spokeAgoMs: 12_000, toSpeaker: null, asked: true, line: long } }, null, true);
    expect(String(state.shannon_question).endsWith('どこに置けばいい？渡せばいいかな？')).toBe(true);
    expect(Array.from(String(state.shannon_question)).length).toBeLessThanOrEqual(160);
    expect(addressedState({ ...base, transcript: 'x', shannon: { spokeAgoMs: 12_000, toSpeaker: null, line: long } }, null, false)).not.toHaveProperty('shannon_question');
    const text = JSON.stringify(addressedQuestions().answers_her_question);
    expect(text).toContain('shannon_question');
    const answers = (reply: number, others = 0.9) => ({
      addressed_to_shannon: { type: 'noul', noul: others }, target: { type: 'choice', choice: 'shannon' }, about_the_job: { type: 'noul', noul: others },
      answers_her_question: { type: 'noul', noul: reply }, reply_needed: { type: 'noul', noul: others },
    });
    expect(parsedAddressed(answers(0.7, 0.05), null, 'answering')).toMatchObject({ addressed: true, reason: 'answer_to_question' });
    expect(parsedAddressed(answers(0.4, 0.05), null, 'answering')).toMatchObject({ addressed: true, reason: 'answer_to_question' });
    expect(parsedAddressed(answers(0.15, 0.95), null, 'answering')).toMatchObject({ addressed: false, reason: 'no_name' });
  });

  it('answers a nameless request while she works as `asked_while_working` by whether it is about the job alone (0.3), not by whom it is said to', () => {
    const answers = (job: number, noul = 0.9, target = 'shannon', reply = 0.95) => ({
      addressed_to_shannon: { type: 'noul', noul }, target: { type: 'choice', choice: target }, about_the_job: { type: 'noul', noul: job }, reply_needed: { type: 'noul', noul: reply },
    });
    expect(parsedAddressed(answers(0.9), null, 'working')).toMatchObject({ addressed: true, reason: 'asked_while_working' });
    // The real Jev read a tip said to the room as "to another person" and scored a suggestion low on "needs an answer": neither stops a talk about the job.
    expect(parsedAddressed(answers(0.5, 0.22, 'other_person', 0.2), null, 'working')).toMatchObject({ addressed: true, reason: 'asked_while_working' });
    expect(parsedAddressed(answers(0.25), null, 'working')).toMatchObject({ addressed: false, reason: 'no_name' });
    expect(parsedAddressed(answers(0.1, 0.9), null, 'working')).toMatchObject({ addressed: false, reason: 'no_name' });
    // Alone with her, the old three questions decide, as before.
    expect(parsedAddressed(answers(0.05, 0.9), null, true)).toMatchObject({ addressed: true, reason: 'asked_alone' });
    expect(parsedAddressed(answers(0.9, 0.75), null, true)).toMatchObject({ addressed: false, reason: 'no_name' });
  });
});

describe('the work, as the call\'s reply is told it', () => {
  it('is any request running or waiting while the body is connected', () => {
    expect(workOf(undefined)).toBeNull();
    expect(workOf({ connected: false, running: null, queue: ['#1 待ち 「木を集める」'] })).toBeNull();
    expect(workOf({ connected: true, running: null })).toBeNull();
    expect(workOf({ connected: true, running: { id: 't', goal: 'ケーキを1個作る' } })).toEqual({ goal: 'ケーキを1個作る', list: [] });
    expect(workOf({ connected: true, running: null, queue: ['#2 待ち 「小麦を3個集める」'] })).toEqual({ goal: null, list: ['#2 待ち 「小麦を3個集める」'] });
  });

  it('asks her not to promise what is not settled while a request runs, and says what her own question was', () => {
    const idle = situationBlock('洞窟にいる。', null);
    expect(idle).not.toContain('やってみるね');
    const busy = situationBlock('洞窟にいる。', 'ケーキを1個作る');
    expect(busy).toContain('やってみるね');
    expect(busy).toContain('やってみないと分からず');
    expect(askedBackBlock('できた！どこに置けばいい？')).toContain('「できた！どこに置けばいい？」');
    expect(askedBackBlock(null)).toBe('');
  });
});

describe('the body\'s present for a call', () => {
  const snapshot = (patch: Partial<LiveSnapshot> = {}): LiveSnapshot => ({
    frameAgeSeconds: 1, goal: 'ケーキを1個作る', goalIsRequest: true, elapsedSeconds: 120, doing: '小麦を育てている', milestone: null, dimension: 'overworld',
    biome: 'plains', time: '昼', health: 20, food: 20, threats: [], carried: ['小麦の種'], map: '', furnace: null, recent: [], stuck: null, ...patch,
  });

  it('tells everyone on a call what was asked, and still keeps it from other shared places and keeps the owner\'s exchanges to him', () => {
    const call = liveBlock(snapshot(), { alone: false, participants: true, exchanges: 'ライだけの話' });
    expect(call).toContain('取り組んでいること: ケーキを1個作る（通話の誰かに頼まれた）');
    expect(call).not.toContain('ライだけの話');
    const elsewhere = liveBlock(snapshot(), { alone: false });
    expect(elsewhere).not.toContain('ケーキ');
    expect(elsewhere).toContain('頼まれた作業の最中');
    expect(liveBlock(snapshot(), { alone: true })).toContain('（ライに頼まれた）');
  });

  it('tells her plan\'s section and points when the body\'s head keeps them, and nothing when it does not', () => {
    const planned = liveBlock(snapshot({ plan: { section: '小麦を育てる', points: ['種を植える', '骨粉で育てる', '刈り取る', 'パンを作る', '牛乳を用意する'] } }), { alone: false, participants: true });
    expect(planned).toContain('いま手をつけている節: 小麦を育てる');
    expect(planned).toContain('計画の要点: 種を植える → 骨粉で育てる → 刈り取る → パンを作る');
    expect(planned).not.toContain('牛乳を用意する');
    const none = liveBlock(snapshot(), { alone: false, participants: true });
    expect(none).not.toContain('- いま手をつけている節');
    expect(none).not.toContain('計画の要点');
  });

  it('says that the dragon run\'s step and pace are not about another job', () => {
    expect(LIVE_BLOCK_HEADER).toContain('ドラゴン討伐の通しの時だけ付く段取りの話');
  });
});

describe('the speaker\'s Minecraft name on the wire (both forms the body sends)', () => {
  const flat = { platform: 'discord', requestId: 'r1', conversationId: 'discord:1:2', sourceUserId: 'u1', sourceDisplayName: 'ユウ', userMessage: 'そこに置いて',
    observedAt: '2026-11-22T12:00:00.000Z', participants: ['u1'] };
  it('is a top-level field of the old form, and does not make it a 400', () => {
    expect(validatedVoiceTurn({ ...flat, speakerMinecraftName: 'Yuu_1234' })).toMatchObject({ speakerMinecraftName: 'Yuu_1234' });
    expect(validatedVoiceTurn(flat)).not.toHaveProperty('speakerMinecraftName');
    expect(() => validatedVoiceTurn({ ...flat, speakerMinecraftName: '' })).toThrow();
    expect(() => validatedVoiceTurn({ ...flat, somethingElse: 'x' })).toThrow();
  });
  it('is `who.speakerMinecraftName` of the one-head form, and reaches the same request field', () => {
    const turn = validatedConversationTurn({ version: 1, requestId: 'c1', observedAt: '2026-11-22T12:00:00.000Z', modality: 'voice',
      where: { platform: 'discord', conversationId: 'discord:1:2', conversationKind: 'channel' },
      who: { userId: 'u1', displayName: 'ユウ', speakerMinecraftName: 'Yuu_1234' }, presence: { participants: ['u1'] }, words: 'そこに置いて' });
    expect(voiceRequestOf(turn)).toMatchObject({ speakerMinecraftName: 'Yuu_1234', sourceDisplayName: 'ユウ' });
    const without = validatedConversationTurn({ version: 1, requestId: 'c2', observedAt: '2026-11-22T12:00:00.000Z', modality: 'voice',
      where: { platform: 'discord', conversationId: 'discord:1:2', conversationKind: 'channel' },
      who: { userId: 'u1', displayName: 'ユウ' }, presence: { participants: ['u1'] }, words: 'そこに置いて' });
    expect(voiceRequestOf(without)).not.toHaveProperty('speakerMinecraftName');
  });
});
