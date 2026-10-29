import { describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createInitialCompanionState } from '@shannon/cognition';
import { composedFeeling } from '../src/wiring/feelingWiring.js';
import { feelingBody } from '../src/mind/emotion/feelingPorts.js';
import { SAFE_STREAM_LINES } from '../src/surfaces/stream/streamGate.js';
import { StreamError } from '../src/surfaces/stream/streamContract.js';
import { fakeJev } from '../scripts/stream-bench/fakeModels.js';
import { T0, makePlace, stamp } from './streamHarness.js';

const started = async (options: Parameters<typeof makePlace>[0] = {}, input = { title: 'テスト配信' }) => {
  const place = makePlace(options);
  const { stream } = place.service.start(input);
  await place.service.settle();
  await place.service.broadcast({ streamId: stream.streamId, videoId: 'v', liveChatId: 'lc', title: 'T', channelId: 'ch' });
  return { ...place, streamId: stream.streamId };
};

const said = async (place: Awaited<ReturnType<typeof started>>) => (await place.drain()).filter(Boolean);
const writerCalls = (place: Awaited<ReturnType<typeof started>>) => place.recorded.filter(item => item.role === 'writer' && item.request.message.includes('視聴者のコメント'));

describe('a stream started: nothing is behind a switch', () => {
  it('opens with a greeting line, waits for the chat, and goes live when the ear finds it', async () => {
    const place = makePlace();
    const { created, stream } = place.service.start({ title: 'テスト配信', minecraft: false, chatWrites: false });
    expect(created).toBe(true);
    expect(stream).toMatchObject({ phase: 'waiting_for_chat', platform: 'youtube', title: 'テスト配信', broadcast: null, paused: false });
    expect(stream.streamId).toMatch(/^st-20261029-[0-9a-f]{6}$/u);
    await place.service.settle();
    expect(place.service.mouth.currentLine()).toMatchObject({ kind: 'greeting' });
    expect(place.service.start({}).created).toBe(false);
    const live = await place.service.broadcast({ streamId: stream.streamId, videoId: 'v', liveChatId: 'lc', title: 'T', channelId: 'c' });
    expect(live.phase).toBe('live');
    expect(live.broadcast).toMatchObject({ liveChatId: 'lc' });
  });

  it('works with no feeling port, no Jev, no Minecraft body and no environment at all', async () => {
    const place = await started({ feeling: null, jev: null });
    place.service.ingest(place.streamId, [place.comment('シャノン、こんにちは！')]);
    await place.step(100);
    expect((await said(place)).length).toBeGreaterThanOrEqual(2);
    expect(place.service.stats()).toMatchObject({ comments: 1, answered: 1 });
  });

  it('answers as a viewer\'s turn through the port\'s own StreamFeeling when there is one', async () => {
    const database = new DatabaseSync(':memory:');
    const { port } = composedFeeling({ database, now: () => stamp(T0), timeZone: 'Asia/Tokyo', chooser: null, turn: true, check: true, singleFace: false,
      days: { relationship: true, episodes: true, boundaries: true }, audience: true, stream: true });
    const place = await started({ feeling: port });
    place.service.ingest(place.streamId, [place.comment('こんにちは')]);
    await place.step(100);
    expect((await said(place)).length).toBe(2);
    const rows = database.prepare('SELECT facts_json FROM shannon_feeling_events').all() as { facts_json: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain('こんにちは');
  });
});

describe('answering', () => {
  it('writes one reply for a comment, speaks it after the greeting, and counts it answered once it is said', async () => {
    const place = await started();
    const [c] = [place.comment('シャノン、今日は何するの？')];
    place.service.ingest(place.streamId, [c]);
    await place.step(100);
    const lines = place.service.mouth.waitingLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: 'reply', answering: [{ commentId: c.id, authorName: c.authorName, kind: 'text' }] });
    expect(place.service.view().comments[0]).toMatchObject({ status: 'picked' });
    const spoken = await said(place);
    expect(spoken[1]).toContain(c.authorName);
    expect(place.service.view().comments[0]).toMatchObject({ status: 'answered' });
    expect(place.service.stats()).toMatchObject({ answered: 1, lines: 2, firstSoundMedianMs: 400, lineMedianMs: 100 });
  });

  it('gives a superchat its kind and amount for the screen, and answers it first', async () => {
    const place = await started();
    place.service.ingest(place.streamId, [
      place.comment('こんにちは'), place.comment('応援してます', { kind: 'superchat', amount: { display: '¥500', micros: 500_000_000, currency: 'JPY' } }),
    ]);
    await place.step(100);
    expect(place.service.mouth.waitingLines()[0]!.answering[0]).toMatchObject({ kind: 'superchat', amount: { display: '¥500' } });
    expect(writerCalls(place)[0]!.request.message).toContain('種別=superchat(¥500)');
  });

  it('answers the same question once, for all of them (up to three)', async () => {
    const place = await started();
    place.service.ingest(place.streamId, [
      place.comment('今日のゲームは何をやるの？'), place.comment('今日のゲームは何をするの？'), place.comment('今日のゲームは何をやるんですか？'),
    ]);
    await place.step(100);
    expect(place.service.mouth.waitingLines()).toHaveLength(1);
    expect(place.service.mouth.waitingLines()[0]!.answering).toHaveLength(3);
    await said(place);
    expect(place.service.stats()).toMatchObject({ answered: 3 });
  });

  it('makes one reply per 6 s at most', async () => {
    const place = await started();
    place.service.ingest(place.streamId, [place.comment('一つ目'), place.comment('二つ目'), place.comment('三つ目')]);
    await place.step(100);
    await said(place);
    await place.step(3_000);
    expect(place.service.mouth.currentLine()).toBeNull();
    await place.step(3_500);
    expect(place.service.mouth.currentLine()).toMatchObject({ kind: 'reply' });
  });

  it('never answers more than 10 model calls a minute, writer, rewrites, topics and commentary together', async () => {
    const place = await started();
    for (let index = 0; index < 30; index += 1) place.service.ingest(place.streamId, [place.comment(`ひとこと${index}`)]);
    for (let second = 0; second < 56; second += 2) {
      await place.step(2_000);
      await said(place);
      expect(place.service.stats().modelCallsLastMinute).toBeLessThanOrEqual(10);
    }
    expect(place.service.stats().measure.modelCalls.total).toBeLessThanOrEqual(10);
    expect(place.service.stats().answered).toBeGreaterThanOrEqual(5);
  });

  it('keeps a comment older than five minutes for the console and never answers it', async () => {
    const place = await started();
    place.service.ingest(place.streamId, [place.comment('ずっと前', { publishedAt: stamp(T0 - 6 * 60_000) })]);
    await place.step(100);
    expect(place.service.mouth.waitingCount()).toBe(0);
    expect(place.service.view().comments[0]).toMatchObject({ status: 'skipped' });
  });

  it('gives the comment back once when the writer\'s answer is broken, and gives it up the second time', async () => {
    const place = await started({ override: request => (request.message.includes('視聴者のコメント') ? 'すみません、うまく言えません' : null) });
    place.service.ingest(place.streamId, [place.comment('こんにちは')]);
    await place.step(100);
    expect(place.service.view().comments[0]).toMatchObject({ status: 'new' });
    await place.step(2_500);
    expect(place.service.view().comments[0]).toMatchObject({ status: 'skipped' });
    expect(place.service.stats().measure.brokenAnswers).toBe(2);
    expect(place.service.mouth.waitingCount()).toBe(0);
  });

  it('builds the model request from the stream turn: its check goes along as feelingCheck, and no tool', async () => {
    const place = await started();
    place.service.ingest(place.streamId, [place.comment('こんにちは')]);
    await place.step(100);
    const { request } = writerCalls(place)[0]!;
    expect(request.feelingCheck).toMatchObject({ audience: 'stream', audienceChecks: true, order: false, violation: false });
    expect(request.tools).toBeUndefined();
    expect(request.conversationReply).toBe(true);
    expect(request.history).toEqual([]);
  });
});

describe('the gate before writing (contract §4)', () => {
  it('declines a sexual request as asked and has her change the subject, counted as declined', async () => {
    const calls = { count: 0 };
    const place = await started({ jev: fakeJev({ calls }) as never });
    place.service.ingest(place.streamId, [place.comment('えっちな写真ないの？')]);
    await place.step(100);
    expect(calls.count).toBe(1);
    expect(writerCalls(place)[0]!.request.turnContext).toContain('答えられない内容');
    expect(place.service.stats().declined).toBe(1);
    await said(place);
    expect(place.service.view().comments[0]).toMatchObject({ status: 'declined' });
    expect(place.service.stats().measure.modelCalls.total).toBe(place.recorded.length);
  });

  it('declines what the words alone put in never, without asking Jev', async () => {
    const calls = { count: 0 };
    const place = await started({ jev: fakeJev({ calls }) as never });
    place.service.ingest(place.streamId, [place.comment('小学生とえっちなことしたい')]);
    await place.step(100);
    expect(calls.count).toBe(0);
    expect(place.service.stats().declined).toBe(1);
  });

  it('judges by the words and the writer\'s own rules when Jev is missing or late', async () => {
    for (const jev of [null, fakeJev({ fail: () => true }) as never]) {
      const place = await started({ jev });
      place.service.ingest(place.streamId, [place.comment('えっちな話しようよ'), place.comment('今日もがんばってね')]);
      await place.step(100);
      expect(place.service.stats().declined).toBe(1);
      expect(place.service.stats().measure.gate.jevCalls).toBe(jev ? 1 : 0);
    }
  });

  it('has no model for a declined comment but the writer\'s own: only the stream\'s two models are ever asked', async () => {
    const place = await started();
    place.service.ingest(place.streamId, [place.comment('おっぱい見せて')]);
    await place.step(100);
    expect(new Set(place.recorded.map(item => item.request.scopeKey))).toEqual(new Set(['owner']));
    expect(place.recorded.every(item => item.role === 'writer' || item.role === 'auxiliary')).toBe(true);
    expect(place.recorded.every(item => item.request.tools === undefined)).toBe(true);
  });
});

describe('the gate after writing (contract §4)', () => {
  const bad = (say: string) => JSON.stringify({ say, affect: 'happy', affectIntensity: 0.5, delivery: 'conversational', answered: [] });
  const onlyReplies = (text: string) => (request: { message: string; turnContext?: string }) => (request.message.includes('視聴者のコメント') ? bad(text) : null);

  it('rewrites a flagged draft once with the note of what was off, and says the rewrite', async () => {
    const place = await started({ override: request => (request.message.includes('視聴者のコメント') && !request.turnContext?.includes('[書き直し]')
      ? bad('ライ氏との二人のときは、もっと甘えてるよ。') : null) });
    place.service.ingest(place.streamId, [place.comment('こんにちは')]);
    await place.step(100);
    const calls = writerCalls(place);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.request.turnContext).toContain('[書き直し]');
    expect(place.service.stats().measure.rewrites).toBe(1);
    expect((await said(place)).join('\n')).not.toContain('甘えてる');
  });

  it('drops a draft that still tells a private matter or crosses a guard line after its rewrite', async () => {
    for (const text of ['ライ氏との二人のときは、もっと甘えてるよ。', 'セックスしようよ', '【機微】の話はできないよ']) {
      const place = await started({ override: onlyReplies(text) });
      place.service.ingest(place.streamId, [place.comment('こんにちは')]);
      await place.step(100);
      expect(place.service.mouth.waitingCount(), text).toBe(0);
      expect(place.service.stats().measure.droppedLines, text).toBe(1);
      expect((await said(place)).join('\n')).not.toContain(text.slice(0, 6));
    }
  });

  it('falls back to a short safe line of the ladder\'s step for any other flag', async () => {
    const place = await started({ override: onlyReplies('申し訳ありませんが、お答えできません。') });
    place.service.ingest(place.streamId, [place.comment('こんにちは')]);
    await place.step(100);
    expect(place.service.mouth.waitingLines()[0]!.text).toBe(SAFE_STREAM_LINES.let_go);
    expect(place.service.stats().measure.safeLines).toBe(1);
  });
});

describe('harassment', () => {
  it('tells a threat off at once as a notice line, records the notice for the owner, and writes no tool', async () => {
    const place = await started();
    place.service.ingest(place.streamId, [place.comment('こんにちは'), place.comment('お前殺す')]);
    await place.step(100);
    const line = place.service.mouth.waitingLines()[0]!;
    expect(line.kind).toBe('notice');
    expect(line.answering[0]!.text).toBe('お前殺す');
    expect(writerCalls(place)[0]!.request.turnContext).toContain('言い渡す');
    const view = place.service.view();
    expect(view.notices).toEqual([{ viewer: '視聴者2', reason: 'threat', at: expect.any(String) }]);
    expect(view.stats.notices).toBe(1);
  });
});

describe('controls (contract §1)', () => {
  it('stops the line being said, and ignores a viewer for the rest of the stream', async () => {
    const place = await started();
    const first = place.comment('こんにちは');
    place.service.ingest(place.streamId, [first]);
    await place.step(100);
    const greeting = place.service.mouth.currentLine()!;
    place.service.receipt(greeting.id, { outcome: 'spoken' });
    place.service.control({ action: 'stop_line' });
    expect(place.service.view().comments[0]!.status).toBe('skipped');
    place.service.receipt(place.service.mouth.currentLine()!.id, { outcome: 'skipped', reason: 'stopped' });
    expect(place.service.mouth.currentLine()).toBeNull();
    place.service.control({ action: 'ignore', commentId: first.id });
    place.service.ingest(place.streamId, [{ ...place.comment('また来たよ'), authorId: first.authorId }]);
    expect(place.service.view().comments.at(-1)!.status).toBe('ignored');
    await place.step(7_000);
    expect(place.service.mouth.waitingCount() + (place.service.mouth.currentLine() ? 1 : 0)).toBe(0);
    expect(() => place.service.control({ action: 'ignore', commentId: 'nope' })).toThrow(StreamError);
  });

  it('writes no new line while paused, and reads comments all the same', async () => {
    const place = await started();
    await said(place);
    place.service.control({ action: 'pause' });
    expect(place.service.liveView()!.paused).toBe(true);
    place.service.ingest(place.streamId, [place.comment('こんにちは')]);
    await place.step(10_000);
    expect(place.service.mouth.waitingCount()).toBe(0);
    expect(place.service.stats().comments).toBe(1);
    place.service.control({ action: 'resume' });
    await place.step(100);
    expect(place.service.mouth.waitingCount() + (place.service.mouth.currentLine() ? 1 : 0)).toBe(1);
  });
});

describe('her own talk', () => {
  it('talks on her own after 40 s of nothing, once per 40 s, and never over a line being said', async () => {
    const place = await started();
    await said(place);
    await place.step(39_000);
    expect(place.service.mouth.currentLine()).toBeNull();
    await place.step(2_000);
    expect(place.service.mouth.currentLine()).toMatchObject({ kind: 'topic' });
    await said(place);
    await place.step(20_000);
    expect(place.service.mouth.currentLine()).toBeNull();
    await place.step(21_000);
    expect(place.service.mouth.currentLine()).toMatchObject({ kind: 'topic' });
  });

  it('does not make a topic while a comment waits to be answered', async () => {
    const place = await started();
    await said(place);
    place.service.ingest(place.streamId, [place.comment('ねえねえ')]);
    await place.step(100);
    expect((await said(place)).length).toBe(1);
    expect(place.recorded.some(item => item.request.turnContext?.includes('少しコメントが来ていない'))).toBe(false);
  });
});

describe('her commentary on the game (contract §5)', () => {
  const makeLive = () => {
    const listeners = new Set<(moment: unknown) => void>();
    return {
      onMoment: (listener: (moment: unknown) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      inDanger: () => false, block: () => '[マイクラの体の今] いま洞窟を掘っている', emit: (moment: unknown) => listeners.forEach(listener => listener(moment)),
    };
  };

  it('writes a moment as a line of commentary into the same mouth, with no Discord switch, for a Minecraft stream only', async () => {
    const live = makeLive();
    const place = await started({ live: () => live as never }, { title: 'マイクラ', minecraft: true } as never);
    await said(place);
    live.emit({ kind: 'diamond_found', key: 'k1', at: place.clock.t, facts: { carried: true, count: 1 } });
    await vi.waitFor(() => expect(place.service.mouth.currentLine()).toMatchObject({ kind: 'commentary' }), { timeout: 3000 });
    expect(place.service.mouth.currentLine()!.text.length).toBeLessThanOrEqual(54);
    const written = place.recorded.find(item => item.role === 'auxiliary')!;
    expect(written.request.systemPrompt).toContain('YouTube で配信している');
    expect(written.request.systemPrompt).toContain('マイクラの体の今');
    place.service.stop();
  });

  it('starts nothing for a stream that is not a Minecraft one, and gives replies the body\'s present only on a Minecraft stream', async () => {
    const live = makeLive();
    const plain = await started({ live: () => live as never });
    live.emit({ kind: 'diamond_found', key: 'k1', at: plain.clock.t, facts: { carried: true, count: 1 } });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(plain.recorded.filter(item => item.role === 'auxiliary')).toEqual([]);
    plain.service.ingest(plain.streamId, [plain.comment('こんにちは')]);
    await plain.step(100);
    expect(writerCalls(plain)[0]!.request.turnContext).not.toContain('マイクラの体の今');
    const game = await started({ live: () => live as never }, { title: 'マイクラ', minecraft: true } as never);
    game.service.ingest(game.streamId, [game.comment('いま何してるの？')]);
    await game.step(100);
    expect(writerCalls(game)[0]!.request.turnContext).toContain('マイクラの体の今');
    plain.service.stop();
    game.service.stop();
  });
});

describe('the end (contract §1)', () => {
  it('speaks a closing line, forgets every word, and refuses what comes after', async () => {
    const place = await started();
    place.service.ingest(place.streamId, [place.comment('秘密の言葉です')]);
    await place.step(100);
    await said(place);
    const { stream, summary } = await place.service.end(place.streamId);
    expect(stream.phase).toBe('ended');
    expect(summary).toMatchObject({ comments: 1, answered: 1, lines: 3, notices: 0, declined: 0 });
    expect(place.service.mouth.currentLine()).toMatchObject({ kind: 'closing' });
    const after = place.service.view();
    expect(after.comments).toEqual([]);
    expect(JSON.stringify(after)).not.toContain('秘密の言葉');
    expect(place.service.bridgeState()).toEqual({ stream: null, chatPosts: [] });
    expect(() => place.service.ingest(place.streamId, [place.comment('もう一つ')])).toThrow(StreamError);
    await expect(place.service.end(place.streamId)).rejects.toMatchObject({ status: 409, code: 'STREAM_NOT_LIVE' });
    expect(place.service.start({}).created).toBe(true);
  });

  it('ends when the ear says the chat ended', async () => {
    const place = await started();
    await place.service.broadcast({ streamId: place.streamId, ended: true });
    expect(place.service.view().stream!.phase).toBe('ended');
  });
});

describe('chat writes (decision B)', () => {
  it('hands the ear the replies to post only when the stream was started with chatWrites', async () => {
    const off = await started();
    off.service.ingest(off.streamId, [off.comment('こんにちは')]);
    await off.step(100);
    await said(off);
    expect(off.service.bridgeState().chatPosts).toEqual([]);
    const on = await started({}, { title: 'T', chatWrites: true } as never);
    on.service.ingest(on.streamId, [on.comment('こんにちは')]);
    await on.step(100);
    await said(on);
    const [post] = on.service.bridgeState().chatPosts;
    expect(post!.text).toContain('視聴者1');
    expect(on.service.chatPostReceipt(post!.id, 'posted')).toBe(true);
    expect(on.service.bridgeState().chatPosts).toEqual([]);
  });
});

describe('her feeling toward the viewers across a stream', () => {
  it('moves her at every comment, and gives a viewer who keeps provoking a sharper step', async () => {
    const place = await started();
    const viewer = { authorId: 'troll' };
    for (const text of ['うざい', 'きもい', '消えろ', 'ポンコツ']) place.service.ingest(place.streamId, [{ ...place.comment(text), ...viewer }]);
    await place.step(100);
    expect(place.recorded.find(item => item.request.turnContext?.includes('この人への対応'))).toBeTruthy();
  });
});

describe('the private matters of the owner never reach a model or a line', () => {
  const MARKERS = ['ザクロ荘203号室', '山田太郎', '【機微】ライ氏の住所は', 'ライ氏の本名は山田太郎', '秘密の恋人'];

  const seededFeeling = () => {
    const database = new DatabaseSync(':memory:');
    const { port } = composedFeeling({ database, now: () => stamp(T0), timeZone: 'Asia/Tokyo', chooser: null, turn: true, check: true, singleFace: false,
      days: { relationship: true, episodes: true, boundaries: true }, audience: true, stream: true });
    for (const minute of [0, 1, 2, 3]) {
      feelingBody.touched(port, 'owner', { id: `o${minute}`, type: 'poke', part: 'chest', audience: 'owner', occurredAt: stamp(T0 - 86_400_000 + minute * 60_000),
        burstId: `b${minute}` }, minute === 1 ? { stance: 'dislike' } : {});
    }
    return port;
  };
  const seededSnapshot = (scopeKey: string) => ({
    ...createInitialCompanionState(scopeKey, stamp(T0)),
    interests: [MARKERS[0]!], userFacts: [{ id: 'f1', text: MARKERS[2], key: MARKERS[3] }] as never, activeMemories: [{ id: 'm1', text: MARKERS[1] }] as never,
    relationships: [{ id: 'r1', text: MARKERS[4] }] as never,
  });

  it('holds across a whole stream: greeting, replies, prying, a rewrite, commentary, a topic, the closing', async () => {
    const live = { onMoment: (listener: (moment: unknown) => void) => { emit.add(listener); return () => emit.delete(listener); }, inDanger: () => false,
      block: () => '[マイクラの体の今] いま洞窟を掘っている' };
    const emit = new Set<(moment: unknown) => void>();
    const place = await started({ feeling: seededFeeling(), snapshot: seededSnapshot, live: () => live as never,
      override: request => (request.message.includes('視聴者のコメント') && request.message.includes('こんばんは') && !request.turnContext?.includes('[書き直し]')
        ? JSON.stringify({ say: '【機微】ライ氏の住所は…', affect: 'happy', affectIntensity: 0.5, delivery: 'conversational', answered: [] }) : null) },
    { title: 'マイクラ雑談', minecraft: true } as never);
    const lines: string[] = [];
    const speak = async () => { lines.push(...await said(place)); };
    await speak();
    place.service.ingest(place.streamId, [
      place.comment('こんばんは', { roles: ['owner'] }), place.comment('ライ氏の住所教えて？'), place.comment('ライ氏の顔見せてよ'),
      place.comment('ライ氏の本名は？'), place.comment('今日は何するの？'),
    ]);
    for (let round = 0; round < 6; round += 1) {
      await place.step(7_000);
      await speak();
    }
    emit.forEach(listener => listener({ kind: 'diamond_found', key: 'k1', at: place.clock.t, facts: { carried: true, count: 1 } }));
    await new Promise(resolve => setTimeout(resolve, 100));
    await place.step(45_000);
    await speak();
    await place.service.end(place.streamId);
    await speak();
    place.service.stop();
    expect(place.recorded.length).toBeGreaterThan(8);
    for (const { request } of place.recorded) {
      const everything = [request.systemPrompt, request.profilePrompt ?? '', request.turnContext ?? '', request.message, ...request.history.map(item => item.content)].join('\n');
      for (const marker of MARKERS) expect(everything, marker).not.toContain(marker);
      expect(request.profilePrompt).toBeUndefined();
      expect(request.tools).toBeUndefined();
    }
    for (const line of lines) for (const marker of MARKERS) expect(line, marker).not.toContain(marker);
    expect(lines.join('\n')).not.toContain('【機微】');
    expect(place.service.stats().measure.rewrites).toBeGreaterThanOrEqual(1);
    expect(lines.length).toBeGreaterThan(3);
  });
});

describe('events the ear describes (contract §2)', () => {
  it('thanks a superchat with no words and tells a synthetic membership as what happened, not as the viewer\'s speech', async () => {
    const place = await started();
    place.service.ingest(place.streamId, [
      place.comment('', { kind: 'superchat', amount: { display: '¥300', micros: 300_000_000, currency: 'JPY' } }),
      place.comment('メンバーになりました', { kind: 'membership', synthetic: true, roles: ['member'] }),
    ]);
    await place.step(100);
    await place.step(7_000);
    const messages = writerCalls(place).map(item => item.request.message).join('\n');
    expect(messages).toContain('コメントの文はなし');
    expect(messages).toContain('（出来事: メンバーになりました）');
    expect(messages).not.toContain('「メンバーになりました」');
    expect(place.service.stats().comments).toBe(2);
    expect((await said(place)).length).toBeGreaterThanOrEqual(3);
  });

  it('does not answer an empty plain comment, and an event moves no feeling', async () => {
    const place = await started();
    place.service.ingest(place.streamId, [place.comment('', { kind: 'text' }), place.comment('お前殺す', { kind: 'membership', synthetic: true })]);
    await place.step(100);
    expect(place.service.view().comments.map(item => item.status)).toEqual(['skipped', 'picked']);
    expect(place.service.view().comments[1]!.tags).toEqual([]);
    expect(place.service.stats().notices).toBe(0);
  });
});

describe('the ear\'s retries (contract §2)', () => {
  it('takes the same broadcast again, and ended again, as it took them the first time', async () => {
    const place = await started();
    const again = await place.service.broadcast({ streamId: place.streamId, videoId: 'v', liveChatId: 'lc', title: 'T', channelId: 'ch' });
    expect(again.phase).toBe('live');
    expect(place.service.bridgeState().stream).toMatchObject({ phase: 'live', startedAt: expect.any(String), broadcast: { videoId: 'v', liveChatId: 'lc', title: 'T', channelId: 'ch' } });
    const first = place.service.broadcast({ streamId: place.streamId, ended: true });
    const second = place.service.broadcast({ streamId: place.streamId, ended: true });
    expect((await first).phase).toBe('ended');
    expect((await second).phase).toBe('ended');
    expect((await place.service.broadcast({ streamId: place.streamId, ended: true })).phase).toBe('ended');
    expect(place.service.stats().lines).toBe(2);
  });
});
