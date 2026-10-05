import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { shannonCapabilityPrompt } from '@shannon/cognition';
import { createLocalApiKernel } from '../src/apiKernel.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonVoiceModelRequest } from '../src/chatModel.js';
import { SQLiteIncomingCallStore } from '../src/incomingCallStore.js';
import { SQLiteInitiativeStore } from '../src/initiativeStore.js';
import { SQLiteBodyStore } from '../src/bodyStore.js';
import { SQLiteOwnOutreach, ownOutreachPrompt, saysSheActedOnHerOwn, type OwnOutreachFacts, type OwnOutreachReader } from '../src/ownOutreach.js';

/**
 * Production, 2026-10-05 10:34–10:36Z: the desktop body took her iPhone voice for the owner's turns, he asked
 * 「いや、そっちからかけてきたじゃん。どうしたの？」, and she made up a call she never placed. Her last message of her own
 * was a text at 10:10Z, already read; `incoming_calls` was empty.
 */
const AT = '2026-10-05T10:36:00.000Z';
const ASKED = 'いや、そっちからかけてきたじゃん。どうしたの？';
const HEADER = '[ボクが自分からしたこと]（記録された事実';
const NO_CALL = '- 電話: 直近24時間、ボクから電話をかけた記録はない。';
const LAST_TEXT = 'ライ氏、お昼はもう食べましたか。';
const delegations = '/v1/voice/gemini/cascade/delegations';
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

class RecordingModel implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly all: Array<ShannonChatModelRequest | ShannonVoiceModelRequest> = [];
  get last() { return this.all.at(-1)!; }
  async generate(request: ShannonChatModelRequest) { this.all.push(request); return { mode: this.mode, model: this.model, reply: 'はい。' }; }
  async generateVoice(request: ShannonVoiceModelRequest) { this.all.push(request); return { mode: this.mode, model: this.model, reply: 'はい。' }; }
}

class FakeReader implements OwnOutreachReader {
  reads = 0;
  constructor(public facts: OwnOutreachFacts | null) {}
  recent() { this.reads += 1; return this.facts; }
}

const incident = () => new FakeReader({ messages: [{ createdAt: '2026-10-05T10:10:00.000Z', content: LAST_TEXT, read: true }], calls: [] });

function harness(reader: OwnOutreachReader | null = incident()) {
  const model = new RecordingModel();
  const api = createLocalApiKernel(() => AT, { chatModel: model, ...(reader ? { ownOutreach: reader } : {}) });
  const chat = (message: string, extra: Record<string, unknown> = {}) =>
    api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', message, ...extra } });
  const voice = (transcript: string, extra: { companionPresent?: boolean; participantMode?: 'guest' } = {}) => api.dispatch({ method: 'POST', path: delegations, body: {
    scopeKey: 'owner', threadId: 'desktop', transcript, ...(extra.participantMode ? { participantMode: extra.participantMode } : {}),
    deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null, ...(extra.companionPresent ? { companionPresent: true } : {}),
      userUtterance: { id: `u-${model.all.length}`, text: transcript, source: 'speech', rawText: transcript,
        ...(extra.participantMode ? { callContext: { callId: 'call-own-actions-0001', turns: [], introductionStart: true } } : {}) } },
  } });
  return { model, api, chat, voice };
}

describe('what the owner says she did on her own', () => {
  it('recognises the owner saying or asking that she called, wrote or left something', () => {
    for (const text of [ASKED, 'さっき電話くれた？', 'シャノンからメッセージ来てたよ', '着信あったけど何だった？', '書き置きを見たよ', 'きみが送ってきたやつ読んだ', '不在着信が入ってた',
      // Bare questions (review of 2026-10-05).
      '何か送った？', '電話かけた？', 'シャノン電話かけた？', '呼んだ？', 'さっき鳴った？', '何か書いた？', 'メモ置いてった？', 'さっきかけたの', '話しかけた?', 'シャノンから電話あった',
      // Re-review of e1f6790: the regressions from 848b818, endings without 「？」, polite and unpunctuated forms.
      '電話したよね', '電話したでしょ', '電話したじゃん', '俺に電話した', 'さっき俺に電話したでしょ', '僕に連絡したじゃん',
      '電話したよね？', '送ったよね？', '電話かけたっけ', '何か送ったかな', '電話かけたか', '呼んだかい', '電話しました？', '呼びました？',
      '何か送った', '電話かけた', 'シャノン電話かけた', 'シャノン、さっき電話した', '通話きた？',
      // Focused review of 5b5c3c0: devices and times as the subject, and 残し.
      'デスクトップが呼んだ？', 'スマホが鳴った？', 'パソコンが話しかけてきた？', 'iPhoneに電話した？', '俺のスマホに電話した？', 'さっきから電話してた？',
      'ボクに電話した？', 'メモ残した？',
      // Accepted false alarms: nothing is excluded any more.
      '母から電話があった', '上司から連絡が来て大変だった', '友達がメッセージくれた', '母に電話した', 'さっき上司に連絡したよ', '昨日はずっとメールしてた', 'この物語の続きを書いて']) {
      expect(saysSheActedOnHerOwn(text), text).toBe(true);
    }
    for (const text of ['お、シャノン、元気？', '今日は疲れた', 'もういい、君とはもう話したくない', '明日の予定を教えて', 'アプリの通知が来た']) {
      expect(saysSheActedOnHerOwn(text), text).toBe(false);
    }
  });

  it('gives a text turn the absence of any call and her last message, when the owner says she called', async () => {
    const { chat, model } = harness();
    expect((await chat(ASKED)).status).toBe(200);
    const prompt = model.last.systemPrompt;
    expect(prompt).toContain(HEADER);
    expect(prompt).toContain(NO_CALL);
    expect(prompt).toContain(`- メッセージ: 26分前にボクから送った「${LAST_TEXT}」（既読）`);
    // The rule that goes with it is in her capability text, for every turn.
    expect(prompt).toContain('記録にも会話にもなければ話を合わせない');
    expect(shannonCapabilityPrompt('owner')).toContain('記録にも会話にもなければ話を合わせない');
  });

  it('gives an owner voice turn the same facts, on the turn that says so and no other', async () => {
    const reader = incident();
    const { voice, model } = harness(reader);
    expect((await voice('お、シャノン、元気？')).status).toBe(200);
    expect(model.last.systemPrompt).not.toContain(HEADER);
    expect(reader.reads).toBe(0);
    expect((await voice(ASKED)).status).toBe(200);
    expect(model.last.systemPrompt).toContain(NO_CALL);
    expect(model.last.systemPrompt).toContain(`「${LAST_TEXT}」（既読）`);
    expect(reader.reads).toBe(1);
  });

  it('tells a call she did place, with what became of it', async () => {
    const { chat, model } = harness(new FakeReader({ messages: [], calls: [{ createdAt: '2026-10-05T10:30:00.000Z', state: 'unanswered' }] }));
    await chat(ASKED);
    expect(model.last.systemPrompt).toContain('- 電話: 6分前にボクからライ氏のiPhoneへ電話をかけた（出てもらえなかった）。');
    expect(model.last.systemPrompt).toContain('- メッセージ: 直近24時間、ボクから送ったメッセージの記録はない。');
  });

  it('tells a voice call her PC body started, so that the mix-up of the incident can be explained, and says what is not recorded', async () => {
    const reader = new FakeReader({ messages: [{ createdAt: '2026-10-05T10:10:00.000Z', content: LAST_TEXT, read: true }], calls: [],
      bodyCalls: [{ startedAt: '2026-10-05T10:34:34.431Z', endedAt: '2026-10-05T10:36:10.000Z', surface: 'windows' }] });
    const { chat, model } = harness(reader);
    await chat(ASKED);
    const prompt = model.last.systemPrompt;
    expect(prompt).toContain('- PCのボク: 19:34（1分前）にWindowsのデスクトップのボクが音声で聞き始めた（19:36に終了）。ボクの名前が聞こえたと思うと、自分から聞き始めることがある。');
    expect(prompt).toContain('ここにないことは、この記録には残っていないということ');
    expect(prompt).toContain('聞かれた時に確かめるための参考で、聞かれていなければ持ち出さない');
    expect(prompt).toContain('体に触れられた時のひとことや体の声かけは、記録に残らず話していることがある');
    expect(prompt).not.toContain('していない）');
  });

  it('leaves out a row whose time cannot be read, never printing NaN', async () => {
    const { chat, model } = harness(new FakeReader({ messages: [{ createdAt: 'garbage', content: '壊れた行', read: false }], calls: [{ createdAt: '', state: 'answered' }],
      bodyCalls: [{ startedAt: 'x' }] }));
    await chat(ASKED);
    expect(model.last.systemPrompt).toContain(NO_CALL);
    expect(model.last.systemPrompt).not.toContain('NaN');
    expect(model.last.systemPrompt).not.toContain('壊れた行');
    expect(model.last.systemPrompt).not.toContain('PCのボク');
  });

  it('with other people able to see or hear, keeps the times and leaves the words of her messages and what became of a call out', async () => {
    const placed = harness(new FakeReader({ messages: [], calls: [{ createdAt: '2026-10-05T10:30:00.000Z', state: 'declined' }] }));
    await placed.chat(ASKED, { audience: 'others' });
    expect(placed.model.last.systemPrompt).toContain('- 電話: 6分前にボクからライ氏のiPhoneへ電話をかけた。');
    expect(placed.model.last.systemPrompt).not.toContain('断られた');
    const { chat, voice, model } = harness();
    await chat(ASKED, { audience: 'others' });
    expect(model.last.systemPrompt).toContain(NO_CALL);
    expect(model.last.systemPrompt).toContain('- メッセージ: 26分前にボクから送った（中身はこの場では話さない）');
    expect(model.last.systemPrompt).not.toContain(LAST_TEXT);
    await voice(ASKED, { companionPresent: true });
    expect(model.last.systemPrompt).toContain(NO_CALL);
    expect(model.last.systemPrompt).not.toContain(LAST_TEXT);
  });

  it('gives a friend\'s own call nothing of it', async () => {
    const reader = incident();
    const { voice, model } = harness(reader);
    await voice(`シャノン、${ASKED}`, { participantMode: 'guest' });
    expect(JSON.stringify(model.all)).not.toContain(HEADER);
    expect(reader.reads).toBe(0);
  });

  it('claims no absence from a record it could not read, and is absent without a reader', async () => {
    const unreadable = harness(new FakeReader(null));
    await unreadable.chat(ASKED);
    expect(unreadable.model.last.systemPrompt).not.toContain(HEADER);
    const none = harness(null);
    await none.chat(ASKED);
    expect(none.model.last.systemPrompt).not.toContain(HEADER);
    expect(ownOutreachPrompt(null, { scopeKey: 'owner', message: ASKED, at: AT, present: 'owner' })).toBe('');
  });
});

describe('SQLiteOwnOutreach', () => {
  const database = () => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-own-outreach-'));
    directories.push(directory);
    return join(directory, 'shannon.sqlite');
  };
  const message = (db: DatabaseSync, id: string, createdAt: string, content: string, readAt: string | null, scope = 'owner') => db.prepare(`
    INSERT INTO initiative_messages (initiative_id, scope_key, thread_id, source_item_id, source_title, source_url, content, expression, day_key, created_at, read_at)
    VALUES (?, ?, 't', ?, 'シャノンから', '', ?, 'curious', ?, ?, ?)
  `).run(id, scope, `reach-out:wonder:${id}`, content, `day-${id}`, createdAt, readAt);

  it('reads her latest messages and calls of the window, tells a message she phoned with as the call, and leaves look answers out', () => {
    const path = database();
    new SQLiteInitiativeStore(path).close();
    const calls = new SQLiteIncomingCallStore(path);
    const db = new DatabaseSync(path);
    message(db, 'old', '2026-10-04T08:00:00.000Z', '昨日の話', '2026-10-04T09:00:00.000Z');
    message(db, 'm1', '2026-10-05T09:00:00.000Z', '一つ目', '2026-10-05T09:10:00.000Z');
    message(db, 'm2', '2026-10-05T10:10:00.000Z', LAST_TEXT, null);
    message(db, 'phoned', '2026-10-05T10:20:00.000Z', '電話で言うこと', null);
    message(db, 'other-scope', '2026-10-05T10:25:00.000Z', 'よその', null, 'someone');
    // An answer to a look he asked for in a conversation is not her own initiative.
    db.prepare(`INSERT INTO initiative_messages (initiative_id, scope_key, thread_id, source_item_id, source_title, source_url, content, expression, day_key, created_at, read_at)
      VALUES ('look', 'owner', 't', 'body-look:l1', '部屋を見た', '', '机が見えました', 'curious', 'body-look:l1', '2026-10-05T10:30:00.000Z', NULL)`).run();
    calls.begin('owner', { callId: 'c1', initiativeId: 'phoned', deviceId: 'iphone', threadId: 't', expiresAt: '2026-10-05T10:21:00.000Z' }, '2026-10-05T10:20:00.000Z');
    const reader = new SQLiteOwnOutreach(path);
    expect(reader.recent('owner', '2026-10-04T10:36:00.000Z', 2)).toEqual({
      messages: [{ createdAt: '2026-10-05T10:10:00.000Z', content: LAST_TEXT, read: false }, { createdAt: '2026-10-05T09:00:00.000Z', content: '一つ目', read: true }],
      calls: [{ createdAt: '2026-10-05T10:20:00.000Z', state: 'pending' }], bodyCalls: [],
    });
    // A call that could not ring gave its message back: the message is told again.
    calls.end('c1', ['pending'], 'failed', 'server', '2026-10-05T10:20:05.000Z');
    expect(reader.recent('owner', '2026-10-04T10:36:00.000Z', 2)?.messages.map(item => item.content)).toEqual(['電話で言うこと', LAST_TEXT]);
    reader.close(); db.close(); calls.close();
  });

  it('reads a database without the tables as holding nothing', () => {
    const path = database();
    new DatabaseSync(path).close();
    const reader = new SQLiteOwnOutreach(path);
    expect(reader.recent('owner', '2026-10-04T10:36:00.000Z', 2)).toEqual({ messages: [], calls: [], bodyCalls: [] });
    reader.close();
  });

  it('reads the latest call a full body started, with its end, and never a touch-only phone\'s', () => {
    const path = database();
    const body = new SQLiteBodyStore(path);
    body.saveCapabilities('owner', 'pc', { expressions: [], gestures: [], flags: {}, surface: 'windows' }, AT);
    body.saveCapabilities('owner', 'phone', { expressions: [], gestures: [], flags: { touchOnly: true }, surface: 'iphone' }, AT);
    const event = (id: string, device: string, type: string, occurredAt: string) =>
      body.record('owner', device, { id, type: type as 'callStarted', audience: 'owner', occurredAt }, AT, '2026-10-05');
    event('p1', 'pc', 'callStarted', '2026-10-05T10:34:34.431Z');
    event('p2', 'pc', 'callEnded', '2026-10-05T10:36:10.000Z');
    event('f1', 'phone', 'callStarted', '2026-10-05T10:35:00.000Z');
    const reader = new SQLiteOwnOutreach(path);
    expect(reader.recent('owner', '2026-10-04T10:36:00.000Z', 2)?.bodyCalls)
      .toEqual([{ startedAt: '2026-10-05T10:34:34.431Z', endedAt: '2026-10-05T10:36:10.000Z', surface: 'windows' }]);
    reader.close(); body.close();
  });
});
