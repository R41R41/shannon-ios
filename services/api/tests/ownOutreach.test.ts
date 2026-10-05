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
import { SQLiteOwnOutreach, ownOutreachPrompt, saysSheActedOnHerOwn, type OwnOutreachFacts, type OwnOutreachReader } from '../src/ownOutreach.js';

/**
 * Production, 2026-10-05 10:34–10:36Z: the desktop body took her iPhone voice for the owner's turns, he asked
 * 「いや、そっちからかけてきたじゃん。どうしたの？」, and she made up a call she never placed. Her last message of her own
 * was a text at 10:10Z, already read; `incoming_calls` was empty.
 */
const AT = '2026-10-05T10:36:00.000Z';
const ASKED = 'いや、そっちからかけてきたじゃん。どうしたの？';
const HEADER = '[ボクが自分からしたこと]（記録された事実';
const NO_CALL = '- 電話: 直近24時間、ボクから電話はかけていない（記録がない）。';
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
    for (const text of [ASKED, 'さっき電話くれた？', 'シャノンからメッセージ来てたよ', '着信あったけど何だった？', '書き置きを見たよ', 'きみが送ってきたやつ読んだ', '不在着信が入ってた']) {
      expect(saysSheActedOnHerOwn(text), text).toBe(true);
    }
    for (const text of ['お、シャノン、元気？', '今日は疲れた', 'この物語の続きを書いて', 'もういい、君とはもう話したくない', '明日の予定を教えて']) {
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
    expect(model.last.systemPrompt).toContain('- メッセージ: 直近24時間、ボクから送ったメッセージはない。');
  });

  it('with other people able to see or hear, keeps the times and leaves the words of her messages out', async () => {
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

  it('reads her latest messages and calls of the window, and tells a message she phoned with as the call', () => {
    const path = database();
    new SQLiteInitiativeStore(path).close();
    const calls = new SQLiteIncomingCallStore(path);
    const db = new DatabaseSync(path);
    message(db, 'old', '2026-10-04T08:00:00.000Z', '昨日の話', '2026-10-04T09:00:00.000Z');
    message(db, 'm1', '2026-10-05T09:00:00.000Z', '一つ目', '2026-10-05T09:10:00.000Z');
    message(db, 'm2', '2026-10-05T10:10:00.000Z', LAST_TEXT, null);
    message(db, 'phoned', '2026-10-05T10:20:00.000Z', '電話で言うこと', null);
    message(db, 'other-scope', '2026-10-05T10:25:00.000Z', 'よその', null, 'someone');
    calls.begin('owner', { callId: 'c1', initiativeId: 'phoned', deviceId: 'iphone', threadId: 't', expiresAt: '2026-10-05T10:21:00.000Z' }, '2026-10-05T10:20:00.000Z');
    const reader = new SQLiteOwnOutreach(path);
    expect(reader.recent('owner', '2026-10-04T10:36:00.000Z', 2)).toEqual({
      messages: [{ createdAt: '2026-10-05T10:10:00.000Z', content: LAST_TEXT, read: false }, { createdAt: '2026-10-05T09:00:00.000Z', content: '一つ目', read: true }],
      calls: [{ createdAt: '2026-10-05T10:20:00.000Z', state: 'pending' }],
    });
    reader.close(); db.close(); calls.close();
  });

  it('reads a database without the tables as holding nothing', () => {
    const path = database();
    new DatabaseSync(path).close();
    const reader = new SQLiteOwnOutreach(path);
    expect(reader.recent('owner', '2026-10-04T10:36:00.000Z', 2)).toEqual({ messages: [], calls: [] });
    reader.close();
  });
});
