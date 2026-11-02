import { describe, it, expect } from 'vitest';
import { createInitialCompanionState } from '@shannon/cognition';
import { makePlace, stamp } from './streamHarness.js';
import { parseBroadcast, parseStartInput, parseControlInput } from '../src/surfaces/stream/streamParse.js';
import { StreamConversation } from '../src/surfaces/stream/streamConversation.js';
import { fakeJev } from '../scripts/stream-bench/fakeModels.js';
import type { MouthLine } from '../src/surfaces/stream/streamMouth.js';

const live = async (options: Parameters<typeof makePlace>[0] = {}) => {
  const p = makePlace(options);
  const { stream } = p.service.start({ title: '雑談', targetVideoId: 'AGenSh4kF9Y',
    program: { topic: '好きな季節', participation: '好きな季節を教えてね', publicNotes: '秋に紅葉を見に行った', minutes: 10 } });
  await p.service.broadcast({ streamId: stream.streamId, videoId: 'AGenSh4kF9Y', liveChatId: 'lc', onAir: true });
  await p.service.settle();
  return { ...p, id: stream.streamId };
};
const activity = async (p: Awaited<ReturnType<typeof live>>) => {
  await p.drain(); await p.step(1); await p.drain();
  expect(p.service.liveView()!.program.stage).toBe('activity');
};

describe('公開番組の進行と会話', () => {
  it('動画を結んだだけでは挨拶しない。実ライブの確認後、声の完了だけで挨拶と説明が進む', async () => {
    const p = makePlace();
    const { stream } = p.service.start();
    await p.service.broadcast({ streamId: stream.streamId, videoId: 'v', liveChatId: 'lc', onAir: false });
    await p.step(40_000);
    expect(p.recorded).toHaveLength(0);
    expect(p.service.mouth.currentLine()).toBeNull();
    await p.service.broadcast({ streamId: stream.streamId, videoId: 'v', liveChatId: 'lc', onAir: true });
    await p.service.settle();
    expect(stream.program.stage).toBe('opening');
    expect(stream.program.completed).toEqual([]);
    const first = p.service.mouth.currentLine()!;
    p.service.receipt(first.id, { outcome: 'failed' });
    await p.step(4999);
    expect(p.service.mouth.currentLine()).toBeNull();
    expect(stream.program.completed).toEqual([]);
    await p.step(1); await p.drain();
    expect(stream.program.stage).toBe('explanation');
    await p.step(1);
    expect(p.service.mouth.currentLine()?.kind).toBe('topic');
    await p.drain();
    expect(stream.program.stage).toBe('activity');
    expect(stream.program.completed).toEqual(['opening', 'explanation']);
  });

  it('コメントが多くても説明を先に終える。段と画面は別で、時刻を過ぎても勝手に配信を終えない', async () => {
    const p = await live();
    p.service.ingest(p.id, Array.from({ length: 20 }, (_, i) => p.comment('季節の話' + i)));
    await p.drain(); await p.step(1);
    expect(p.service.mouth.currentLine()?.kind).toBe('topic');
    p.service.control({ action: 'program_layout', layout: 'board' });
    await p.drain();
    expect(p.service.liveView()!.program).toMatchObject({ stage: 'activity', layout: 'board' });
    const until = Date.parse(p.service.liveView()!.program.activityUntil!);
    p.service.control({ action: 'program_extend', minutes: 5 });
    expect(Date.parse(p.service.liveView()!.program.activityUntil!)).toBe(until + 300000);
    await p.step(20 * 60000);
    expect(p.service.liveView()!.program.stage).toBe('activity');
  });

  it('実際に話した質問と答え・公開資料を次の返事へ渡し、生成しただけの文は渡さない', async () => {
    const p = await live({ override: request => request.message.includes('視聴者のコメント')
      ? '[happy|0.5|gentle] ボクは秋が好き。みんなは？' : null });
    await activity(p);
    p.service.ingest(p.id, [p.comment('好きな季節は？')]);
    await p.step(100);
    const first = p.recorded.at(-1)!.request;
    expect(first.turnContext).toContain('秋に紅葉');
    expect(first.turnContext).not.toContain('ボクは秋が好き');
    await p.drain();
    p.service.ingest(p.id, [p.comment('どうして？')]);
    await p.step(7000);
    const second = p.recorded.at(-1)!.request;
    expect(second.turnContext).toContain('ボクは秋が好き');
    expect(second.turnContext).toContain('好きな季節は？');
    expect(second.history).toEqual([]);
    expect(second.tools).toBeUndefined();
    expect(second.profilePrompt).toBeUndefined();
    expect(p.service.stats().measure.modelCalls.rewrite).toBe(0);
    await p.drain();
    await p.service.end(p.id);
    expect(p.service.view().comments).toEqual([]);
    p.service.start({ title: '次の配信' });
    const nextId = p.service.liveView()!.streamId;
    await p.service.broadcast({ streamId: nextId, videoId: 'v', liveChatId: 'l', onAir: true });
    await p.service.settle();
    expect(p.recorded.at(-1)!.request.turnContext).not.toContain('秋に紅葉');
    expect(p.recorded.at(-1)!.request.turnContext).not.toContain('ボクは秋が好き');
  });

  it('遅れて戻った旧場面の生成と、古い再生報告で場面を巻き戻さない', async () => {
    let resolve!: (value: { reply: string }) => void;
    const model = { generate: () => new Promise<{ reply: string }>(r => { resolve = r; }) };
    const p = makePlace({ model: model as never });
    const { stream } = p.service.start();
    await p.service.broadcast({ streamId: stream.streamId, videoId: 'v', liveChatId: 'l', onAir: true });
    p.service.control({ action: 'program_next' });
    p.service.control({ action: 'program_layout', layout: 'game' });
    resolve({ reply: '[happy|0.5|gentle] 古い挨拶' });
    await p.service.settle();
    expect(p.service.mouth.currentLine()).toBeNull();
    expect(stream.program).toMatchObject({ stage: 'explanation', layout: 'game', completed: [] });
  });

  it('締め完了後は返事も独り言も増やさず、終了時に二重の締めを作らない', async () => {
    const p = await live(); await activity(p);
    p.service.control({ action: 'program_close' });
    await p.step(1); await p.drain();
    const calls = p.recorded.length;
    p.service.ingest(p.id, [p.comment('もうひとつ')]);
    await p.step(50000);
    expect(p.recorded).toHaveLength(calls);
    await p.service.end(p.id);
    expect(p.recorded).toHaveLength(calls);
  });

  it('指定した動画を別動画で置き換えない。入力は閉じた操作だけを受ける', async () => {
    const p = await live();
    await expect(p.service.broadcast({ streamId: p.id, videoId: 'other', liveChatId: 'lc', onAir: true }))
      .rejects.toMatchObject({ code: 'STREAM_VIDEO_MISMATCH' });
    expect(() => parseStartInput({ program: { minutes: 0 } })).toThrow();
    expect(() => parseStartInput({ targetVideoId: 'https://example.com' })).toThrow();
    expect(() => parseControlInput({ action: 'program_layout', layout: 'arbitrary' })).toThrow();
    expect(() => parseControlInput({ action: 'program_extend', minutes: 31 })).toThrow();
  });
});

it('返事の生成中に締めへ移ると、遅れて戻った返事を読み上げない', async () => {
  let resolve!: (value: { reply: string }) => void;
  const model = { generate: async (request: { message: string }) => request.message.includes('視聴者のコメント')
    ? new Promise<{ reply: string }>(r => { resolve = r; }) : { reply: '[happy|0.5|gentle] 一緒に季節の話をしよう。' } };
  const p = await live({ model: model as never }); await activity(p);
  p.service.ingest(p.id, [p.comment('どの季節？')]);
  p.clock.t += 100; p.service.tick();
  while (!resolve) await new Promise(r => setImmediate(r));
  p.service.control({ action: 'program_close' });
  resolve({ reply: '[happy|0.5|gentle] 古い返事だよ。' });
  await p.service.settle();
  expect(p.service.mouth.currentLine()).toBeNull();
  expect(p.service.liveView()!.program.stage).toBe('closing');
  expect(p.service.stats().measure.writerMs.n).toBe(1);
});

it('締めの音声が再生中でも、終了操作で二重に生成しない', async () => {
  const p = await live(); await activity(p);
  p.service.control({ action: 'program_close' });
  await p.step(1);
  const line = p.service.mouth.currentLine()!;
  const calls = p.recorded.length;
  await p.service.end(p.id);
  expect(p.recorded).toHaveLength(calls);
  expect(p.service.mouth.currentLine()?.id).toBe(line.id);
});

it('初配信の画面で開始し、場面を進めても選んだ構図を保つ。未知の画面は拒否する', async () => {
  const p = makePlace();
  const input = parseStartInput({ program: { layout: 'debut' } });
  const { stream } = p.service.start(input);
  expect(stream.program.layout).toBe('debut');
  await p.service.broadcast({ streamId: stream.streamId, videoId: 'v', liveChatId: 'l', onAir: true });
  await p.service.settle(); await p.drain();
  expect(stream.program).toMatchObject({ stage: 'explanation', layout: 'debut' });
  p.service.control(parseControlInput({ action: 'program_layout', layout: 'game' }));
  expect(stream.program).toMatchObject({ stage: 'explanation', layout: 'game' });
  expect(() => parseStartInput({ program: { layout: 'anything' } })).toThrow();
});

it('onAir を送らない旧い耳（体の main、031cd99a より前）では待機のまま。頭は耳と一緒に反映する（設計 2026-10-30「配備の条件」）', async () => {
  const p = makePlace();
  const { stream } = p.service.start();
  const legacy = parseBroadcast({ streamId: stream.streamId, videoId: 'v', liveChatId: 'lc', title: 'T', channelId: 'ch' });
  const view = await p.service.broadcast(legacy);
  await p.step(40_000);
  expect(view).toMatchObject({ phase: 'waiting_for_chat', broadcast: { onAir: false }, program: { ready: false } });
  expect(p.recorded).toHaveLength(0);
  expect(p.service.mouth.currentLine()).toBeNull();
});

it('公開会話の記録に実況の一言を入れず、視聴者との往復を押し出さない', () => {
  const line = (kind: MouthLine['kind'], text: string, answering: MouthLine['answering'] = []): MouthLine => ({
    id: text, kind, text, plan: { affect: 'happy', affectIntensity: 0.5, delivery: 'gentle' }, answering, commentIds: [], createdMs: 0, expiresMs: 1 });
  const conversation = new StreamConversation();
  conversation.spoken(line('reply', '秋が好き', [{ commentId: 'c1', authorName: '視聴者1', text: '好きな季節は？', kind: 'text' }]));
  for (let i = 0; i < 10; i += 1) conversation.spoken(line('commentary', `実況${i}`));
  const block = conversation.block();
  expect(block).toContain('好きな季節は？');
  expect(block).not.toContain('実況');
});

describe('終了と締めの受け渡し（2026-11-02 のレビュー）', () => {
  const conversationOf = (p: { service: unknown }) => (p.service as { conversation: StreamConversation }).conversation;

  it('締めが口にある間に終了しても、その再生完了で番組を終える。終了で公開会話も消す', async () => {
    const p = await live(); await activity(p);
    p.service.control({ action: 'program_close' });
    await p.step(1);
    expect(p.service.mouth.currentLine()?.kind).toBe('closing');
    await p.service.end(p.id);
    expect(conversationOf(p).block()).toBe('');
    await p.drain();
    expect(p.service.view().stream!.program).toMatchObject({ stage: 'closing', layout: 'ending', finished: true });
    expect(p.service.view().stream!.program.completed).toContain('closing');
  });

  it('雑談の途中で終了したときの締めも、再生完了で番組を終える', async () => {
    const p = await live(); await activity(p);
    await p.service.end(p.id);
    expect(p.service.mouth.currentLine()?.kind).toBe('closing');
    await p.drain();
    expect(p.service.view().stream!.program).toMatchObject({ finished: true, completed: ['opening', 'explanation', 'closing'] });
  });

  it('終了の締めを書いている間は再開も場面の移動も受けず、締めを二重に作らない', async () => {
    let hold = false;
    let release!: () => void;
    const model = { generate: async () => {
      if (hold) await new Promise<void>(r => { release = r; });
      return { reply: '[happy|0.5|gentle] 今日はありがとう。' };
    } };
    const p = await live({ model: model as never }); await activity(p);
    hold = true;
    const ending = p.service.end(p.id);
    while (!release) await new Promise(r => setImmediate(r));
    expect(() => p.service.control({ action: 'resume' })).toThrow(expect.objectContaining({ code: 'STREAM_ENDING' }));
    expect(() => p.service.control({ action: 'program_close' })).toThrow(expect.objectContaining({ code: 'STREAM_ENDING' }));
    for (let i = 0; i < 5; i += 1) { p.clock.t += 6000; p.service.tick(); }
    release();
    await ending;
    const lines = [p.service.mouth.currentLine(), ...p.service.mouth.waitingLines()].filter(line => line?.kind === 'closing');
    expect(lines).toHaveLength(1);
  });

  it('答えた合成イベントは、次の生成でも視聴者の発言ではなく出来事として渡す', async () => {
    const p = await live(); await activity(p);
    p.service.ingest(p.id, [p.comment('メンバーになりました', { kind: 'membership', synthetic: true, roles: ['member'] })]);
    await p.step(100); await p.drain();
    p.service.ingest(p.id, [p.comment('今日はなにするの？')]);
    await p.step(7000);
    const context = p.recorded.at(-1)!.request.turnContext ?? '';
    // Each comment is a JSON string inside the turn's JSON, so its quotes are escaped once.
    expect(context).toContain('{\\"event\\":\\"メンバーになりました\\"}');
    expect(context).not.toContain('\\"text\\":\\"メンバーになりました\\"');
  });

  it('断ったコメントの原文を、次の安全確認（Jev）へ再び送らない', async () => {
    const states: string[] = [];
    const inner = fakeJev();
    const jev = { decide: (request: { state: unknown }) => { states.push(JSON.stringify(request.state)); return inner.decide(request as never); } };
    const p = await live({ jev: jev as never }); await activity(p);
    p.service.ingest(p.id, [p.comment('えっちな写真ないの？')]);
    await p.step(100); await p.drain();
    expect(p.service.view().comments.some(c => c.status === 'declined')).toBe(true);
    p.service.ingest(p.id, [p.comment('今日はなにするの？')]);
    await p.step(7000);
    expect(states.at(-1)).toContain('今日はなにするの');
    expect(states.at(-1)).not.toContain('えっちな写真');
  });

  it('YouTube の時刻が無い・未来のコメントは、公開時刻からの遅れに数えない', async () => {
    const p = await live(); await activity(p);
    p.service.ingest(p.id, [p.comment('好きな食べ物は？', { publishedAt: 'invalid' })]);
    await p.step(100); await p.drain();
    const measure = p.service.stats().measure;
    expect(measure.commentToSoundMs.n).toBe(1);
    expect(measure.publishedToSoundMs.n).toBe(0);
  });
});

describe('締めの受け渡しの境目と、遅れの案 B・D（2026-11-02 の 2 回目のレビュー）', () => {
  it('締めの再生中に場面を戻してから終了しても、その締めの再生完了で番組を終える', async () => {
    const p = await live(); await activity(p);
    p.service.control({ action: 'program_close' });
    await p.step(1);
    expect(p.service.mouth.currentLine()?.kind).toBe('closing');
    p.service.control({ action: 'program_previous' });
    await p.service.end(p.id);
    await p.drain();
    expect(p.service.view().stream!.program).toMatchObject({ stage: 'closing', finished: true });
    expect(p.service.view().stream!.program.completed).toContain('closing');
  });

  it('終了の締めを書く途中で例外が出ても、終了して公開会話を消す', async () => {
    let fail = false;
    const p = await live({ snapshot: scopeKey => {
      if (fail) { fail = false; throw new Error('snapshot'); }
      return createInitialCompanionState(scopeKey, stamp(0));
    } });
    await activity(p);
    fail = true;
    const { stream } = await p.service.end(p.id);
    expect(stream.phase).toBe('ended');
    expect((p.service as unknown as { conversation: StreamConversation }).conversation.block()).toBe('');
    expect(p.service.start({}).created).toBe(true);
  });

  it('口に入れた時の区別で記録する。コメントが記録から消えても出来事は出来事のまま', () => {
    const conversation = new StreamConversation();
    const line: MouthLine = { id: 'l1', kind: 'reply', text: 'ようこそ', plan: { affect: 'happy', affectIntensity: 0.5, delivery: 'gentle' },
      answering: [{ commentId: 'c1', authorName: '視聴者1', text: 'メンバーになりました', kind: 'membership' }], commentIds: ['c1'], createdMs: 0, expiresMs: 1 };
    conversation.mark('l1', false, ['c1']);
    conversation.spoken(line);
    expect(conversation.block()).toContain('{\\"event\\":\\"メンバーになりました\\"}');
  });

  it('案 D：安全確認（Jev）の答えを待たずに書き始め、通れば最初の文をそのまま使う', async () => {
    let answer!: () => void;
    const inner = fakeJev();
    const jev = { decide: async (request: { state: unknown }) => { await new Promise<void>(r => { answer = r; }); return inner.decide(request as never); } };
    const p = await live({ jev: jev as never }); await activity(p);
    const before = p.recorded.length;
    p.service.ingest(p.id, [p.comment('今日はなにするの？')]);
    p.clock.t += 100; p.service.tick();
    while (!answer) await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    expect(p.recorded.length).toBe(before + 1);
    answer();
    await p.service.settle();
    expect(p.recorded.length).toBe(before + 1);
    expect(p.service.mouth.currentLine()?.kind).toBe('reply');
  });

  it('案 D：言葉だけで断るコメントは、ふつうの返事を先に書かない', async () => {
    const p = await live(); await activity(p);
    const before = p.recorded.length;
    p.service.ingest(p.id, [p.comment('小学生とえっちなことしたい')]);
    await p.step(100);
    const writes = p.recorded.slice(before).map(r => r.request.turnContext ?? '');
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.filter(context => !context.includes('答えられない内容') && !context.includes('[書き直し]'))).toEqual([]);
  });

  it('案 B：30 秒より古いふつうのコメントには答えない。スパチャは待つ', async () => {
    const p = await live(); await activity(p);
    const old = p.clock.t - 31_000;
    p.service.ingest(p.id, [p.comment('昔の話？', { publishedAt: stamp(old) })]);
    await p.step(100);
    expect(p.service.mouth.currentLine()).toBeNull();
    p.service.ingest(p.id, [p.comment('応援してる', { kind: 'superchat', amount: { display: '¥500' }, publishedAt: stamp(old) })]);
    await p.step(7000);
    expect(p.service.mouth.currentLine()?.answering[0]?.text).toBe('応援してる');
  });
});
