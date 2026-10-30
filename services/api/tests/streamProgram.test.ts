import { describe, it, expect } from 'vitest';
import { makePlace, stamp } from './streamHarness.js';
import { parseStartInput, parseControlInput } from '../src/surfaces/stream/streamParse.js';

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
