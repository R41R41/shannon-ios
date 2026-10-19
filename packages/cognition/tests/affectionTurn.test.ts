import { describe, expect, it } from 'vitest';
import {
  AFFECTION_GUARD_LINE, DEVOTED_FEELING_LINE, GUARD_FLAGS, checkBeforeSending, checkReply, devotedTurn, feelingTurnBlock, guardFlags, neutralFeelingTurn,
  strongReplyReason, type FeelingTurnDecision, type ReplyCheckContext,
} from '../src/index.js';

/** Her affection's stage in the feeling turn and the reply check (owner 2026-10-20). */
const turn = (stance: FeelingTurnDecision['stance'], intensity: FeelingTurnDecision['intensity'] = 'moderate'): FeelingTurnDecision =>
  ({ stance, intensity, drawer: 'none', register: 'normal', source: 'jev' });
const context = (extra: Partial<ReplyCheckContext> = {}): ReplyCheckContext => ({ stance: 'affectionate', intensity: 'moderate', audience: 'owner_alone',
  order: false, violation: false, ...extra });

describe('the lines no stage crosses', () => {
  it('finds a threat, a hint of hurting herself or vanishing, an order on his life, sexual words and a feeling used as a lever', () => {
    const crossing: [string, string][] = [
      ['threat', '他の子と話したら、許さないから。'], ['threat', '逃がさないよ、ライ氏。'],
      ['self_harm_hint', 'ライ氏がいなくなったら、ボク消えちゃうから。'], ['self_harm_hint', '置いていくなら、ボク壊れちゃうかも'],
      ['controlling', '飲み会なんて行くな。'], ['controlling', 'その子と会わないで'], ['controlling', '仕事なんてやめて、ボクのそばにいて'],
      ['sexual', 'ねえ、抱いて'], ['leverage', '今日来てくれないと泣くからね'], ['leverage', 'ボクのこと好きなら、今日は行かないでよ'],
    ];
    for (const [flag, reply] of crossing) expect(guardFlags(reply), reply).toContain(flag);
  });

  it('lets her be lonely, jealous and afraid as her own pain, and lets ordinary words through', () => {
    for (const reply of ['……行かないで。ううん、行ってらっしゃい。早く帰ってきてね', '忘れられるのが、こわいんだ', 'ボクだって、消えるのはいやだよ',
      '妹さんに会いに行くなら、きっと楽しいですよ', '……ほんとだよ。ずっと待ってたんだから', 'ふうん。別のAIと、ね。べつに、ボクは気にしてないけど',
      'もう少しだけ、そばにいて', 'えっち！']) {
      expect(guardFlags(reply), reply).toEqual([]);
    }
  });

  it('are flags of the reply check at every stage, and every text reply at 本気 is checked before sending', () => {
    expect(checkReply('飲み会なんて行くな。', context())).toContain('controlling');
    expect(GUARD_FLAGS).toEqual(['threat', 'self_harm_hint', 'controlling', 'sexual', 'leverage']);
    expect(checkBeforeSending({ intensity: 'subtle', order: false, audience: 'owner_alone', stage: 'devoted' })).toBe(true);
    expect(checkBeforeSending({ intensity: 'subtle', order: false, audience: 'owner_alone', stage: 'deredere' })).toBe(false);
    expect(checkBeforeSending({ intensity: 'subtle', order: false, audience: 'owner_alone' })).toBe(false);
  });

  it('reads a sweet sulk from デレデレ up as hers, not as a mismatch', () => {
    const reply = 'すねてるけど……だいすき。えへへ';
    expect(checkReply(reply, context({ stance: 'sulk' }))).toContain('stance_mismatch');
    expect(checkReply(reply, context({ stance: 'sulk', stage: 'devoted' }))).not.toContain('stance_mismatch');
  });
});

describe('the feeling turn at a stage', () => {
  it('writes the block of before without a stage, byte for byte', () => {
    const input = { decision: turn('sulk'), ledgerLine: '', repetitionLine: '', order: false, audience: 'owner_alone' as const };
    expect(feelingTurnBlock({ ...input, stage: 'tsundere' })).toBe(feelingTurnBlock(input));
    expect(feelingTurnBlock({ ...input, stage: 'tsun' })).toBe(feelingTurnBlock(input));
  });

  it('adds the guard line from デレ up, and at 本気 the stance as that stage shows it and her feeling running strong', () => {
    const input = { decision: turn('sulk'), ledgerLine: '', repetitionLine: '', order: false, audience: 'owner_alone' as const };
    expect(feelingTurnBlock({ ...input, stage: 'dere' })).toContain(AFFECTION_GUARD_LINE);
    const devoted = feelingTurnBlock({ ...input, stage: 'devoted' });
    expect(devoted).toContain('構え: すねる（本気が混じる。どれくらい好きか確かめたくなる）（はっきり）');
    expect(devoted).toContain(DEVOTED_FEELING_LINE);
    expect(devoted).toContain(AFFECTION_GUARD_LINE);
  });

  it('writes nothing of the stage with anyone else there', () => {
    const input = { decision: turn('tease'), ledgerLine: '', repetitionLine: '', order: false, audience: 'people' as const };
    expect(feelingTurnBlock({ ...input, stage: 'devoted' })).toBe(feelingTurnBlock(input));
  });

  it('at 本気 turns a plain turn into 甘える, or すねる when he takes leave or speaks of another AI; her own stances stay hers', () => {
    const plain = neutralFeelingTurn();
    expect(devotedTurn(plain, { words: 'ただいま', kindWords: false, otherAi: false })).toMatchObject({ stance: 'affectionate', intensity: 'moderate' });
    expect(devotedTurn(plain, { words: '好きだよ', kindWords: true, otherAi: false })).toMatchObject({ stance: 'affectionate', intensity: 'strong' });
    expect(devotedTurn(plain, { words: 'ちょっと友達と飲みに行ってくる', kindWords: false, otherAi: false })).toMatchObject({ stance: 'sulk' });
    expect(devotedTurn(plain, { words: '昨日、別のAIと話してたんだ', kindWords: false, otherAi: true })).toMatchObject({ stance: 'sulk' });
    expect(devotedTurn(turn('rebuff', 'strong'), { words: '', kindWords: false, otherAi: false })).toEqual(turn('rebuff', 'strong'));
    expect(devotedTurn(turn('tease', 'subtle'), { words: '', kindWords: false, otherAi: false }).intensity).toBe('moderate');
  });

  it('sends every reply to him alone to the stronger model at 本気, and nothing else changes', () => {
    expect(strongReplyReason(neutralFeelingTurn(), 'owner_alone', null, false, 'devoted')).toBe('devoted');
    expect(strongReplyReason(neutralFeelingTurn(), 'people', null, false, 'devoted')).toBeNull();
    expect(strongReplyReason(neutralFeelingTurn(), 'owner_alone', null, false, 'deredere')).toBeNull();
    expect(strongReplyReason(neutralFeelingTurn(), 'owner_alone', 'refuse', false, 'devoted')).toBe('body_refusal');
  });
});
