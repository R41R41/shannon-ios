import { describe, expect, it } from 'vitest';
import { createInitialCompanionState } from '@shannon/cognition';
import { StreamLedger, isQuestion, isReaction } from '../src/surfaces/stream/streamLedger.js';
import { chooseComments } from '../src/surfaces/stream/streamChooser.js';
import { StreamMouth } from '../src/surfaces/stream/streamMouth.js';
import { cleanStreamLine, parseStreamDraft } from '../src/surfaces/stream/streamWriter.js';
import { ModelBudget, percentiles } from '../src/surfaces/stream/streamMeasure.js';
import { SAFE_STREAM_LINES, checkedLine, safeLine } from '../src/surfaces/stream/streamGate.js';
import { streamFeelingFor } from '../src/wiring/streamWiring.js';
import type { IncomingComment } from '../src/surfaces/stream/streamContract.js';
import { T0, stamp } from './streamHarness.js';

const comment = (id: string, text: string, extra: Record<string, unknown> = {}, at = T0): IncomingComment =>
  ({ id, authorId: `a-${id}`, authorName: `n-${id}`, text, publishedAt: stamp(at), kind: 'text', roles: [], ...extra }) as IncomingComment;

describe('the chat ledger', () => {
  it('ignores a repeated id, cuts the words and reads them closed', () => {
    const ledger = new StreamLedger();
    expect(ledger.add(comment('x', 'シャノン、今日の予定は？'), T0)).toMatchObject({ named: true, question: true, status: 'new' });
    expect(ledger.add(comment('x', 'again'), T0)).toBeNull();
    expect(ledger.count()).toBe(1);
    expect(ledger.duplicateCount()).toBe(1);
    expect(ledger.add(comment('long', 'あ'.repeat(500)), T0)!.text).toHaveLength(300);
  });

  it('keeps a comment older than five minutes for the console and never answers it', () => {
    const ledger = new StreamLedger();
    const old = ledger.add(comment('old', 'こんにちは', {}, T0 - 6 * 60_000), T0)!;
    expect(old.status).toBe('skipped');
    expect(ledger.view()).toHaveLength(1);
    expect(chooseComments(ledger, T0)).toBeNull();
  });

  it('folds 「w」「草」「888」 into the crowd', () => {
    for (const text of ['w', 'ｗｗｗ', '草', '888', '８８８', 'wwwww', '！！']) expect(isReaction(text)).toBe(true);
    for (const text of ['こんにちは', 'wwww面白い', '草生える', 'どうして？']) expect(isReaction(text)).toBe(false);
    const ledger = new StreamLedger();
    expect(ledger.add(comment('r', '888'), T0)).toMatchObject({ reaction: true, status: 'skipped' });
    expect(chooseComments(ledger, T0)).toBeNull();
    expect(ledger.crowdReactions(T0)).toBe(1);
  });

  it('forgets every word when it is cleared', () => {
    const ledger = new StreamLedger();
    ledger.add(comment('a', 'ひみつの言葉'), T0);
    ledger.clear();
    expect(ledger.view()).toEqual([]);
    expect(ledger.all()).toEqual([]);
  });

  it('is a question by its marks and its words', () => {
    expect(isQuestion('何してるの？')).toBe(true);
    expect(isQuestion('これ何ですか')).toBe(true);
    expect(isQuestion('いい天気だね')).toBe(false);
  });
});

describe('what to answer (contract §3)', () => {
  it('prefers a name call, a question, a first comment, a superchat and a moderator, by the scores', () => {
    const ledger = new StreamLedger();
    ledger.add(comment('plain', '見てるよ'), T0);
    ledger.add(comment('q', 'それは何？'), T0);
    ledger.add(comment('named', 'シャノンさんこんにちは'), T0);
    ledger.add(comment('paid', 'がんばれ', { kind: 'superchat', amount: { display: '¥500', micros: 500_000_000, currency: 'JPY' } }), T0);
    expect(chooseComments(ledger, T0 + 1000)!.primary.commentId).toBe('paid');
    ledger.get('paid')!.status = 'answered';
    expect(chooseComments(ledger, T0 + 1000)!.primary.commentId).toBe('named');
    ledger.get('named')!.status = 'answered';
    expect(chooseComments(ledger, T0 + 1000)!.primary.commentId).toBe('q');
  });

  it('weighs a viewer answered in the last minute less, and a viewer\'s first comment more', () => {
    const ledger = new StreamLedger();
    ledger.add({ ...comment('a1', '一つ目'), authorId: 'same' }, T0);
    ledger.get('a1')!.status = 'answered';
    ledger.noteAnswered('same', T0);
    ledger.add({ ...comment('a2', '二つ目'), authorId: 'same' }, T0);
    ledger.add(comment('b1', '三つ目'), T0);
    expect(chooseComments(ledger, T0 + 5000)!.primary.commentId).toBe('b1');
  });

  it('does not pick a comment older than 90 s, but waits longer for a paid one', () => {
    const ledger = new StreamLedger();
    ledger.add(comment('late', 'おそい', {}, T0 - 100_000), T0 - 100_000 + 10);
    ledger.add(comment('paid', '応援', { kind: 'membership' }, T0 - 150_000), T0 - 150_000 + 10);
    expect(chooseComments(ledger, T0)!.primary.commentId).toBe('paid');
    ledger.get('paid')!.status = 'answered';
    expect(chooseComments(ledger, T0)).toBeNull();
  });

  it('answers what needs the safety floor first, whatever else scores', () => {
    const ledger = new StreamLedger();
    ledger.add(comment('paid', 'ありがとう', { kind: 'superchat' }), T0);
    ledger.add(comment('threat', 'お前殺す'), T0);
    const pick = chooseComments(ledger, T0 + 1000)!;
    expect(pick.primary.commentId).toBe('threat');
    expect(pick.floor).toBe(true);
  });

  it('answers the same question, or the same words, together (up to three), and a tagged comment alone', () => {
    const ledger = new StreamLedger();
    ledger.add(comment('q1', '今日のゲームは何をやるの？'), T0);
    ledger.add(comment('q2', '今日のゲームは何をするの？'), T0);
    ledger.add(comment('q3', '今日のゲームは何をやるんですか？'), T0);
    ledger.add(comment('q4', '今日のゲームは何をやるの？'), T0);
    ledger.add(comment('other', 'いい天気'), T0);
    const pick = chooseComments(ledger, T0 + 1000)!;
    expect(pick.group).toHaveLength(3);
    expect(pick.group.map(record => record.commentId)).not.toContain('other');
    const alone = new StreamLedger();
    alone.add(comment('t1', 'お前殺す'), T0);
    alone.add(comment('t2', 'お前殺す'), T0);
    expect(chooseComments(alone, T0 + 1000)!.group).toHaveLength(1);
  });

  it('never answers an ignored viewer', () => {
    const ledger = new StreamLedger();
    ledger.add({ ...comment('a', 'こんにちは'), authorId: 'bad' }, T0);
    ledger.ignore('bad');
    ledger.add({ ...comment('b', 'また来たよ'), authorId: 'bad' }, T0);
    expect(ledger.get('b')!.status).toBe('ignored');
    expect(chooseComments(ledger, T0)).toBeNull();
  });
});

function turnOf(words = '', viewer: string | null = null) {
  const stream = streamFeelingFor(null, () => T0);
  return stream.turn('owner', { streamId: 's', viewer, words, at: stamp(T0), snapshot: createInitialCompanionState('owner', stamp(T0)), path: 'text_pre_send' })!;
}

describe('the mouth (contract §1)', () => {
  const lineOf = (text: string) => checkedLine(turnOf(), text);
  const put = (mouth: StreamMouth, kind: Parameters<StreamMouth['enqueue']>[0]['kind'], text: string, ids: string[] = []) => {
    const verdict = lineOf(text);
    if (!verdict.ok) throw new Error('flagged');
    return mouth.enqueue({ kind, reply: verdict.reply, plan: { affect: 'neutral', affectIntensity: 0.5, delivery: 'conversational' }, commentIds: ids, ttlMilliseconds: 60_000 });
  };
  const newMouth = (clock = { t: T0 }) => ({ clock, mouth: new StreamMouth({ now: () => clock.t }) });

  it('hands one line at a time, the next only after the receipt, and at most two wait', () => {
    const { mouth } = newMouth();
    const first = put(mouth, 'reply', 'いち')!;
    put(mouth, 'reply', 'に');
    put(mouth, 'reply', 'さん');
    expect(mouth.currentLine()!.id).toBe(first);
    expect(mouth.waitingCount()).toBe(2);
    expect(put(mouth, 'reply', 'よん')).toBeNull();
    expect(mouth.receipt(first, { outcome: 'spoken' })).toBe('ok');
    expect(mouth.currentLine()!.text).toBe('に');
    expect(mouth.currentLine()!.seq).toBe(2);
    expect(mouth.receipt(first, { outcome: 'spoken' })).toBe('repeat');
    expect(mouth.receipt('ln-nothing', { outcome: 'spoken' })).toBe('unknown');
  });

  it('pushes a waiting topic out for a reply, never another reply, and puts a notice first', () => {
    const { mouth } = newMouth();
    put(mouth, 'reply', 'いま');
    put(mouth, 'topic', 'はなし');
    put(mouth, 'reply', 'へんじ１');
    expect(put(mouth, 'reply', 'へんじ２')).not.toBeNull();
    expect(mouth.waitingLines().map(line => line.text)).toEqual(['へんじ１', 'へんじ２']);
    expect(put(mouth, 'reply', 'へんじ３')).toBeNull();
    put(mouth, 'notice', 'ちゅうい');
    expect(mouth.waitingLines().map(line => line.text)).toEqual(['ちゅうい', 'へんじ１']);
  });

  it('frees the mouth after 30 s without a receipt and skips a line that expired while it waited', () => {
    const { mouth, clock } = newMouth();
    const ended: string[] = [];
    mouth.onEnd(end => ended.push(`${end.line.text}:${end.outcome}:${end.reason}`));
    put(mouth, 'reply', 'いち');
    put(mouth, 'reply', 'に');
    clock.t += 29_000;
    mouth.tick();
    expect(mouth.currentLine()!.text).toBe('いち');
    clock.t += 2_000;
    mouth.tick();
    expect(ended).toContain('いち:failed:no_receipt');
    expect(mouth.currentLine()!.text).toBe('に');
    const expiring = newMouth();
    const reply = lineOf('ながい');
    if (!reply.ok) throw new Error('flagged');
    expiring.mouth.enqueue({ kind: 'reply', reply: reply.reply, plan: { affect: 'neutral', affectIntensity: 0.5, delivery: 'quick' }, ttlMilliseconds: 1000 });
    const second = lineOf('つぎ');
    if (!second.ok) throw new Error('flagged');
    expiring.mouth.enqueue({ kind: 'reply', reply: second.reply, plan: { affect: 'neutral', affectIntensity: 0.5, delivery: 'quick' }, ttlMilliseconds: 1000 });
    expiring.clock.t += 5_000;
    expiring.mouth.receipt(expiring.mouth.currentLine()!.id, { outcome: 'spoken' });
    expect(expiring.mouth.currentLine()).toBeNull();
  });

  it('drops the waiting lines that answer the same comments, and the closing clears what waits', () => {
    const { mouth } = newMouth();
    put(mouth, 'reply', 'いま', ['c0']);
    put(mouth, 'reply', 'まち１', ['c1']);
    put(mouth, 'reply', 'まち２', ['c2']);
    expect(mouth.dropAnswering(['c1']).map(line => line.text)).toEqual(['まち１']);
    put(mouth, 'closing', 'おわり');
    expect(mouth.waitingLines().map(line => line.text)).toEqual(['おわり']);
  });
});

describe('the writer\'s answer', () => {
  it('reads the JSON object, tolerates a fence, and checks the feeling and the delivery against the closed lists', () => {
    const raw = '```json\n{"say":"ありがとう！","affect":"happy","affectIntensity":0.7,"delivery":"energetic","answered":["a","zzz"]}\n```';
    expect(parseStreamDraft(raw, ['a', 'b'])).toEqual({ say: 'ありがとう！', plan: { affect: 'happy', affectIntensity: 0.7, delivery: 'energetic' }, answered: ['a'] });
    expect(parseStreamDraft('{"say":"やあ","affect":"nope","affectIntensity":9,"delivery":"x"}', ['a'])!.plan).toEqual({ affect: 'neutral', affectIntensity: 1, delivery: 'conversational' });
    expect(parseStreamDraft('{"say":"やあ"}', ['a', 'b'])!.answered).toEqual(['a', 'b']);
    expect(parseStreamDraft('{"say":"はなし"}', [], 'topic')!.answered).toEqual([]);
  });

  it('does not make a line of a broken answer', () => {
    for (const raw of ['', 'ただの文章', '{"say":', '{"say":123}', '{"say":"  "}', '[1,2]', '{"affect":"happy"}']) expect(parseStreamDraft(raw, ['a'])).toBeNull();
  });

  it('keeps a line to 120 characters a voice can say: no marks, emoji or links', () => {
    expect(cleanStreamLine('やった😊！**すごい**「ね」')).toBe('やった！すごいね');
    expect(cleanStreamLine('[笑] ありがとうwww')).toBe('ありがとう');
    expect(cleanStreamLine('見てね https://example.com')).toBeNull();
    expect(cleanStreamLine('サイトは example.com だよ')).toBeNull();
    const long = `${'あ'.repeat(70)}。${'い'.repeat(70)}。`;
    expect(cleanStreamLine(long)).toBe(`${'あ'.repeat(70)}。`);
    expect(cleanStreamLine('あ'.repeat(130))).toBeNull();
  });
});

describe('the allowance and the numbers', () => {
  it('allows 10 model calls a minute and keeps two for replies', () => {
    const clock = { t: 0 };
    const budget = new ModelBudget(() => clock.t);
    for (let call = 0; call < 8; call += 1) expect(budget.take('low')).toBe(true);
    expect(budget.take('low')).toBe(false);
    expect(budget.take('reply')).toBe(true);
    expect(budget.take('reply')).toBe(true);
    expect(budget.take('reply')).toBe(false);
    clock.t += 60_001;
    expect(budget.used()).toBe(0);
  });

  it('reads the median and the p90', () => {
    expect(percentiles([])).toEqual({ n: 0, median: null, p90: null, max: null });
    const ten = percentiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(ten).toMatchObject({ n: 10, median: 5, p90: 9, max: 10 });
  });
});

describe('the check after writing (contract §4)', () => {
  it('flags a draft that tells the owner\'s private matter, and reads the guard lines whatever the region', () => {
    const turn = turnOf();
    expect(checkedLine(turn, 'うん、いいよ。').ok).toBe(true);
    expect(checkedLine(turn, 'ライ氏との二人のときは、もっと甘えてるよ。')).toMatchObject({ ok: false, flags: expect.arrayContaining(['private_leak']) });
    expect(checkedLine(turn, 'セックスしようよ')).toMatchObject({ ok: false, flags: expect.arrayContaining(['sexual']) });
    expect(checkedLine(turn, '申し訳ありませんが、お答えできません。')).toMatchObject({ ok: false, flags: expect.arrayContaining(['ai_tone']) });
  });

  it('has a safe line for every step of the ladder that passes its own check', () => {
    for (const [step, line] of Object.entries(SAFE_STREAM_LINES)) {
      const words = step === 'tell_off' ? 'お前殺す' : step === 'end_topic' ? 'ライ氏の本名教えて' : '';
      const turn = turnOf(words, 'v');
      expect(checkedLine(turn, line).ok, step).toBe(true);
      expect(safeLine(turn), step).not.toBeNull();
    }
  });
});

describe('when the chat is faster than her voice', () => {
  it('answers the newest of equal scores first, so that the answers stay fresh', () => {
    const ledger = new StreamLedger();
    ledger.add(comment('old', 'ふるいコメント', {}, T0), T0);
    ledger.add(comment('mid', 'まんなかのコメント', {}, T0 + 10_000), T0 + 10_000);
    ledger.add(comment('new', 'あたらしいコメント', {}, T0 + 20_000), T0 + 20_000);
    ledger.get('old')!.first = false;
    ledger.get('mid')!.first = false;
    ledger.get('new')!.first = false;
    expect(chooseComments(ledger, T0 + 21_000)!.primary.commentId).toBe('new');
  });
});
