import { describe, expect, it } from 'vitest';
import { VoiceMouthQueue, VOICE_MOUTH_LIMITS } from '../src/surfaces/platform/voiceMouth.js';
import { VOICE_FILLERS, fillerSituation, selectVoiceFiller, voiceFillerById } from '../src/surfaces/platform/voiceFillers.js';
import { voiceAddress } from '../src/mind/perception/voiceChannelAddress.js';
import { VOICE_ROOM_LIMITS, VoiceRooms } from '../src/surfaces/platform/voiceRoom.js';
import { ChatSentenceSplitter, splitChatSentences } from '../src/surfaces/text/chatSentenceSplitter.js';
import { VOICE_SENTENCE_CUT } from '../src/surfaces/text/chatSentenceStream.js';
import { heardBlock, platformVoiceInstructions, situationBlock, voiceIntentInstructions } from '../src/surfaces/platform/platformVoicePrompt.js';

describe('the mouth queue (dc-speak-interface.md)', () => {
  const clock = () => {
    let at = 1_000_000;
    return { now: () => at, advance: (milliseconds: number) => { at += milliseconds; } };
  };

  it('refuses a line while the body is not polling, and takes it once it is', async () => {
    const time = clock();
    const queue = new VoiceMouthQueue(time.now);
    expect(queue.say({ text: 'ダイヤ見つけた！', source: 'minecraft:milestone' })).toMatchObject({ accepted: false, reason: 'body_offline' });
    expect(await queue.poll(0)).toEqual([]);
    const accepted = queue.say({ text: 'ダイヤ見つけた！', source: 'minecraft:milestone' });
    expect(accepted.accepted).toBe(true);
    expect(queue.status(accepted.id)).toBe('queued');
    const lines = await queue.poll(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ id: accepted.id, text: 'ダイヤ見つけた！', source: 'minecraft:milestone', priority: 'normal', maxWaitMs: 8_000 });
    expect(queue.status(accepted.id)).toBe('taken');
    expect(queue.result(accepted.id, 'spoken')).toBe(true);
    expect(queue.status(accepted.id)).toBe('spoken');
    expect(queue.result(accepted.id, 'whatever')).toBe(false);
    expect(queue.result('nobody', 'spoken')).toBe(false);
    // The body goes quiet: nobody is listening for a line.
    time.advance(VOICE_MOUTH_LIMITS.bodyOfflineMilliseconds + 1);
    expect(queue.say({ text: 'まだいる？', source: 'x' })).toMatchObject({ accepted: false, reason: 'body_offline' });
  });

  it('validates a line: exactly one of text and facts, a source, a priority, a wait, acting tags', async () => {
    const queue = new VoiceMouthQueue(clock().now);
    await queue.poll(0);
    const bad = (input: Parameters<VoiceMouthQueue['say']>[0]) => queue.say(input).reason;
    expect(bad({ source: 's' })).toBe('invalid');
    expect(bad({ text: 'a', facts: ['b'], source: 's' })).toBe('invalid');
    expect(bad({ text: '   ', source: 's' })).toBe('invalid');
    expect(bad({ text: 'a', source: '' })).toBe('invalid');
    expect(bad({ text: 'a', source: 's', priority: 'urgent' as never })).toBe('invalid');
    expect(bad({ text: 'a', source: 's', tags: 'hello' })).toBe('invalid');
    expect(bad({ text: 'a', source: 's', maxWaitMs: Number.NaN })).toBe('invalid');
    expect(queue.say({ text: 'a'.repeat(300), source: 's', tags: '[excited]', maxWaitMs: 1 }).accepted).toBe(true);
    const [line] = await queue.poll(0);
    expect(Array.from(line!.text!)).toHaveLength(VOICE_MOUTH_LIMITS.textCharacters);
    expect(line!.maxWaitMs).toBe(VOICE_MOUTH_LIMITS.maxWaitRange[0]);
    expect(line!.tags).toBe('[excited]');
    expect(queue.say({ facts: ['鉄のツルハシを作った', '体力 12/20'], source: 'minecraft:craft', priority: 'low' }).accepted).toBe(true);
    const [facts] = await queue.poll(0);
    expect(facts).toMatchObject({ facts: ['鉄のツルハシを作った', '体力 12/20'], priority: 'low', maxWaitMs: 4_000 });
    expect(facts!.text).toBeUndefined();
  });

  it('replaces a waiting line with the same key, expires a line that waited too long, and lets high go first', async () => {
    const time = clock();
    const queue = new VoiceMouthQueue(time.now);
    await queue.poll(0);
    const first = queue.say({ text: '掘ってる', source: 'a', key: 'dig' });
    const second = queue.say({ text: 'まだ掘ってる', source: 'a', key: 'dig' });
    expect(queue.status(first.id)).toBe('superseded');
    const low = queue.say({ text: '低', source: 'b', priority: 'low' });
    const high = queue.say({ text: '危ない！', source: 'c', priority: 'high' });
    const lines = await queue.poll(0);
    expect(lines.map(line => line.id)).toEqual([high.id, second.id, low.id]);
    const stale = queue.say({ text: '古い', source: 'd', maxWaitMs: 1_000 });
    time.advance(1_500);
    expect(await queue.poll(0)).toEqual([]);
    expect(queue.status(stale.id)).toBe('expired');
  });

  it('holds a long poll until a line comes, and a second poll replaces the first', async () => {
    const queue = new VoiceMouthQueue();
    await queue.poll(0);
    const waiting = queue.poll(5_000);
    setTimeout(() => queue.say({ text: 'おはよう', source: 's' }), 10);
    const lines = await waiting;
    expect(lines.map(line => line.text)).toEqual(['おはよう']);
    const older = queue.poll(5_000);
    const newer = queue.poll(60);
    expect(await older).toEqual([]);
    expect(await newer).toEqual([]);
    const controller = new AbortController();
    const aborted = queue.poll(5_000, controller.signal);
    controller.abort();
    expect(await aborted).toEqual([]);
  });

  it('bounds what may wait: a flood guard per minute and a full queue that makes room for a higher line', async () => {
    const time = clock();
    const queue = new VoiceMouthQueue(time.now);
    await queue.poll(0);
    for (let n = 0; n < VOICE_MOUTH_LIMITS.waiting; n += 1) expect(queue.say({ text: `l${n}`, source: `s${n}`, priority: n === 0 ? 'low' : 'normal', maxWaitMs: 30_000 }).accepted).toBe(true);
    expect(queue.say({ text: 'あふれ', source: 'x', maxWaitMs: 30_000 })).toMatchObject({ accepted: true });
    expect(queue.say({ text: 'もうだめ', source: 'y', priority: 'low' })).toMatchObject({ accepted: false });
    const rate = new VoiceMouthQueue(time.now);
    await rate.poll(0);
    let refused = 0;
    for (let n = 0; n < VOICE_MOUTH_LIMITS.perMinute + 5; n += 1) {
      if (!rate.say({ text: 'a', source: `r${n}`, key: `k${n}` }).accepted) refused += 1;
      if (n % 10 === 9) await rate.poll(0);
    }
    expect(refused).toBe(5);
  });
});

describe('fillers, address and the room', () => {
  it('chooses a filler only for words that take time, never for a warning or a heavy feeling', () => {
    const roll = () => 0;
    expect(selectVoiceFiller({ transcript: 'うん', reason: 'solo', random: roll })).toBeNull();
    expect(selectVoiceFiller({ transcript: '止まって、危ないから今すぐ戻ってきて', reason: 'solo', random: roll })).toBeNull();
    expect(selectVoiceFiller({ transcript: 'さっきは本当にごめんね、悪かったと思ってる', reason: 'solo', random: roll })).toBeNull();
    const question = selectVoiceFiller({ transcript: 'いまマイクラで何をしているところなの？', reason: 'solo', random: roll });
    expect(question && ['etto', 'sou', 'n', 'a'].includes(question.id)).toBe(true);
    const statement = selectVoiceFiller({ transcript: '今日は仕事がすごく忙しくてやっと帰ってきたよ', reason: 'solo', random: roll });
    expect(statement && voiceFillerById(statement.id)?.after.includes('statement')).toBe(true);
    // Not the same one twice running.
    const again = selectVoiceFiller({ transcript: '今日は仕事がすごく忙しくてやっと帰ってきたよ', reason: 'solo', previous: statement!.id, random: roll });
    expect(again?.id).not.toBe(statement!.id);
    expect(fillerSituation('お願い、これ見てくれる', 'solo')).toBe('request');
    expect(new Set(VOICE_FILLERS.map(filler => filler.id)).size).toBe(VOICE_FILLERS.length);
  });

  it('answers everything when one person is there and follows the shared-table rule when several are', () => {
    expect(voiceAddress({ transcript: 'ねえ今日はどうだった', humans: 1, followsShannonTurn: false })).toEqual({ respond: true, reason: 'solo' });
    expect(voiceAddress({ transcript: 'あ', humans: 1, followsShannonTurn: false })).toMatchObject({ respond: false, reason: 'fragment' });
    expect(voiceAddress({ transcript: 'えー', humans: 1, followsShannonTurn: false })).toMatchObject({ respond: false, reason: 'fragment' });
    expect(voiceAddress({ transcript: 'うん', humans: 1, followsShannonTurn: true })).toMatchObject({ respond: true });
    expect(voiceAddress({ transcript: '昨日のボスまじでやばかった', humans: 2, followsShannonTurn: false })).toMatchObject({ respond: false, reason: 'table_talk' });
    expect(voiceAddress({ transcript: 'シャノン、いま何してるの', humans: 3, followsShannonTurn: false })).toMatchObject({ respond: true, reason: 'named' });
    expect(voiceAddress({ transcript: 'エンダードラゴンってどこにいるんだっけ', humans: 3, followsShannonTurn: false })).toMatchObject({ respond: true, reason: 'question' });
    expect(voiceAddress({ transcript: 'ありがとう', humans: 3, followsShannonTurn: true })).toMatchObject({ respond: true });
  });

  it('keeps what she heard for three minutes, newest last, and a situation for as long as it said', () => {
    let at = Date.parse('2026-10-20T12:00:00.000Z');
    const rooms = new VoiceRooms(() => at);
    const iso = (offset: number) => new Date(at + offset).toISOString();
    rooms.noteHeard('c', [
      { userId: 'u2', name: 'ユウ', text: 'さっきのチェスト開けた？', at: iso(-30_000) },
      { userId: 'u3', name: 'ミキ', text: 'まだ開けてないよ', at: iso(-20_000) },
      { userId: 'u2', name: 'ユウ', text: 'さっきのチェスト開けた？', at: iso(-30_000) },
      { userId: 'u9', name: '古い人', text: 'ずっと前の話', at: iso(-10 * 60_000) },
    ]);
    expect(rooms.heard('c').map(line => line.text)).toEqual(['さっきのチェスト開けた？', 'まだ開けてないよ']);
    expect(rooms.heard('c', 'まだ開けてないよ').map(line => line.text)).toEqual(['さっきのチェスト開けた？']);
    rooms.setSituation('c', '鉄を探して洞窟を下りている。', 30_000);
    expect(rooms.situation('c')).toContain('洞窟');
    at += 31_000;
    expect(rooms.situation('c')).toBeNull();
    at += 3 * 60_000;
    expect(rooms.heard('c')).toEqual([]);
    for (let n = 0; n < VOICE_ROOM_LIMITS.rooms + 3; n += 1) rooms.useFiller(`r${n}`, 'un');
    expect(rooms.lastFiller('r0')).toBeUndefined();
    expect(rooms.lastFiller(`r${VOICE_ROOM_LIMITS.rooms + 2}`)).toBe('un');
  });
});

describe('the sentence splitter for a voice reply', () => {
  const text = 'えっと、いまは鉄を探してるところだよ、洞窟の奥まで来たからもう少しかな。でも、ちょっと暗いんだよね。';

  it('cuts a long sentence at a clause so the first words go out early, and loses nothing', () => {
    const plain = splitChatSentences(text);
    expect(plain).toEqual(['えっと、いまは鉄を探してるところだよ、洞窟の奥まで来たからもう少しかな。', 'でも、ちょっと暗いんだよね。']);
    const cut = splitChatSentences(text, VOICE_SENTENCE_CUT);
    expect(cut.length).toBeGreaterThan(plain.length);
    expect(cut.join('')).toBe(text);
    expect(cut[0]!.endsWith('、')).toBe(true);
    expect(Array.from(cut[0]!).length).toBeGreaterThanOrEqual(14);
  });

  it('gives the same cuts however the text arrives', () => {
    const whole = splitChatSentences(text, VOICE_SENTENCE_CUT);
    for (const size of [1, 2, 3, 5, 7, 13]) {
      const splitter = new ChatSentenceSplitter(VOICE_SENTENCE_CUT);
      const pieces: string[] = [];
      for (let at = 0; at < text.length; at += size) pieces.push(...splitter.append(text.slice(at, at + size)));
      pieces.push(...splitter.flush());
      expect(pieces).toEqual(whole);
    }
  });

  it('is unchanged without the option', () => {
    const splitter = new ChatSentenceSplitter();
    expect([...splitter.append('はい、わかった、やってみるね'), ...splitter.flush()]).toEqual(['はい、わかった、やってみるね']);
  });
});

describe('the voice prompt blocks', () => {
  it('says who is there and what has been said, and tells the model what the intent field can do now', () => {
    const owner = platformVoiceInstructions({ title: 'テスト', ownerAlone: true, ownerSpeaking: true, speakerName: null, humans: 1, audioTags: false });
    expect(owner).toContain('いま聞こえているのはライ氏だけ');
    expect(owner).not.toContain('[whispers]');
    const friend = platformVoiceInstructions({ title: 'テスト', ownerAlone: false, ownerSpeaking: false, speakerName: 'ユウ', humans: 3, fillerText: 'えっと、', audioTags: true });
    expect(friend).toContain('3人いる');
    expect(friend).toContain('「ユウ」');
    expect(friend).toContain('「えっと、」と声に出している');
    expect(friend).toContain('[whispers]');
    expect(heardBlock([])).toBe('');
    expect(heardBlock([{ userId: 'u', name: 'ミキ', text: 'まだだよ', at: '2026-10-20T12:00:00.000Z' }])).toContain('- ミキ: まだだよ');
    expect(situationBlock(null, null)).toBe('');
    expect(situationBlock('洞窟にいる。', 'エンドラを倒す')).toContain('「エンドラを倒す」をしている');
    expect(voiceIntentInstructions({ connected: false, running: null }, true)).toContain('いまは渡せない');
    expect(voiceIntentInstructions({ connected: true, running: { id: 't', goal: '鉄を集める' } }, false)).toContain('いまの作業への伝言');
    expect(voiceIntentInstructions({ connected: true, running: null }, true)).toContain('はっきり頼んだら kind=task');
    expect(voiceIntentInstructions({ connected: true, running: null }, false)).toContain('新しい作業を頼めない');
  });
});
