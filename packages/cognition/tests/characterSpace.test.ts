import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AFFECTION_GUARD_LINE, CHARACTER_CORE, CHARACTER_REGIONS, DEFAULT_PERSONALITY, GUARD_FLAGS, PERSONA_HEADER, REGION_IDS, VIVID_FEELING_LINE,
  characterCoreBlock, characterCoreForSpace, characterCoreHashInput, checkBeforeSending, checkReply, cuesOfEvent, cuesOfWords, feelingTurnBlock, guardFlags,
  moodAxes, neutralFeelingTurn, personaBlock, regionTurn, selectPersona, spacePosition, strongReplyReason,
  type FeelingEvent, type FeelingTurnDecision, type ReplyCheckContext, type SpaceCue,
} from '../src/index.js';

/** Her character space (owner 2026-10-20): six axes, her default personality, events that swing her, and the regions she is in. */
const AT = '2026-10-21T11:00:00.000Z'; // 20:00 JST
const event = (minutesAgo: number, cues: string[], kind: FeelingEvent['kind'] = 'spoke'): FeelingEvent => ({ id: `e${minutesAgo}${cues.join()}`, kind,
  personKey: 'owner', identity: 'registered', audience: 'owner_alone', channel: 'text', sceneId: null, sourceId: null, facts: { cues },
  occurredAt: new Date(Date.parse(AT) - minutesAgo * 60_000).toISOString() });
const lingering = { valence: 0.2, arousal: 0.45 };

function regionFor(words: string, options: { events?: FeelingEvent[]; liking?: number; security?: number; max?: boolean; hour?: number; owner?: boolean } = {}) {
  const mood = moodAxes({ events: options.events ?? [], now: cuesOfWords(words), at: AT, localHour: options.hour ?? 20, lingering });
  const position = spacePosition(mood, { liking: options.max ? 1 : options.liking ?? 0, security: options.security ?? 0.35 });
  return selectPersona(position, { ownerAlone: options.owner ?? true, max: options.max === true });
}

const turn = (stance: FeelingTurnDecision['stance'], intensity: FeelingTurnDecision['intensity'] = 'moderate'): FeelingTurnDecision =>
  ({ stance, intensity, drawer: 'none', register: 'normal', source: 'jev' });
const context = (extra: Partial<ReplyCheckContext> = {}): ReplyCheckContext => ({ stance: 'affectionate', intensity: 'moderate', audience: 'owner_alone',
  order: false, violation: false, ...extra });

describe('the axes and the events that swing them', () => {
  it('reads closed cues from his words, never keeping the words', () => {
    const cases: [string, SpaceCue[]][] = [
      ['さすがシャノン、天才だね', ['praise']], ['好きだよ', ['love']], ['ポンコツｗ', ['tease']], ['うざい、黙って', ['insult']], ['ごめんね', ['apology']],
      ['昨日、別のAIと話してたんだ', ['other_ai']], ['ちょっと友達と飲みに行ってくる', ['leaving']], ['ちょっと相談があるんだけど', ['serious']],
    ];
    for (const [words, cues] of cases) expect(cuesOfWords(words), words).toEqual(expect.arrayContaining(cues));
    expect(cuesOfWords('何してた？')).toEqual([]);
    expect(cuesOfWords('', { returning: true })).toEqual(['returning']);
  });

  it('reads a touch by her stance and a comment by its kind', () => {
    expect(cuesOfEvent({ ...event(0, []), kind: 'touched', facts: { stance: 'refuse' } })).toEqual(['touch_refused']);
    expect(cuesOfEvent({ ...event(0, []), kind: 'comment', facts: { commentKind: 'praised' } })).toEqual(['hype', 'stream_praise']);
  });

  it('rests at her default (the v2 cheeky tsundere) and swings back within minutes: half-lives of 5 to 8 minutes', () => {
    const rest = moodAxes({ events: [], now: [], at: AT, localHour: 20, lingering: { valence: 0, arousal: 0.45 } });
    expect(rest).toEqual({ pleasure: DEFAULT_PERSONALITY.pleasure.base, arousal: DEFAULT_PERSONALITY.arousal.base, dominance: DEFAULT_PERSONALITY.dominance.base,
      play: DEFAULT_PERSONALITY.play.base });
    expect(regionFor('うん', { events: [event(3, ['praise'])] }).primary).toBe('smug');
    expect(regionFor('うん', { events: [event(20, ['praise'])] }).primary).toBe('cheeky_tsundere');
    expect(regionFor('うん', { events: [event(15, ['insult'])] }).primary).toBe('cheeky_tsundere');
  });

  it('lets her lingering mood colour 快 and 覚醒 only by a share, and the small hours pull 覚醒 down', () => {
    const low = moodAxes({ events: [], now: [], at: AT, localHour: 20, lingering: { valence: -1, arousal: 0.45 } });
    expect(low.pleasure).toBeCloseTo(DEFAULT_PERSONALITY.pleasure.base - 0.3, 5);
    expect(moodAxes({ events: [], now: [], at: AT, localHour: 2, lingering }).arousal).toBeLessThan(-0.7);
  });
});

describe('the regions', () => {
  it('has fifteen regions, each with a portrait of 5 to 10 lines, 8 to 12 lines in its voice, a face and a lean', () => {
    expect(REGION_IDS).toHaveLength(15);
    for (const id of REGION_IDS) {
      const region = CHARACTER_REGIONS[id];
      expect(region.portrait.length, id).toBeGreaterThanOrEqual(5);
      expect(region.portrait.length, id).toBeLessThanOrEqual(10);
      expect(region.samples.length, id).toBeGreaterThanOrEqual(8);
      expect(region.samples.length, id).toBeLessThanOrEqual(12);
      expect(region.lean.length, id).toBeGreaterThan(20);
      // No line of a region crosses a guard line (a region's lines are what she sounds like there).
      for (const line of [...region.samples, ...region.portrait]) expect(guardFlags(line), `${id}: ${line}`).toEqual([]);
    }
  });

  it('places her by what happened: praise, love, an insult, another AI, a serious talk, the small hours, a lively stream', () => {
    expect(regionFor('何してた？').primary).toBe('cheeky_tsundere');
    expect(regionFor('さすがシャノン、天才だね').primary).toBe('smug');
    expect(regionFor('好きだよ').primary).toBe('flustered');
    expect(regionFor('うざい、黙って').primary).toBe('angry');
    expect(regionFor('昨日、別のAIと話してたんだ', { liking: 0.6, security: 0.1 }).primary).toBe('anxious_jealous');
    expect(regionFor('ちょっと相談があるんだけど、仕事で困ってて').primary).toBe('serious');
    expect(regionFor('まだ起きてる？', { hour: 2 }).primary).toBe('sleepy');
    expect(regionFor('すごい！', { events: Array.from({ length: 10 }, (_, index) => event(index * 0.3, [], 'comment')) }).primary).toBe('hyped');
  });

  it('turns デレ as she grows fond and sure of him (her pride lowers): ツンデレ is 優位 against 好意', () => {
    expect(regionFor('何してた？', { liking: 0.7, security: 0.6 }).primary).toBe('sweet');
    expect(regionFor('何してた？', { liking: 0.7, security: -0.3 }).primary).not.toBe('sweet');
  });

  it('opens 本気 and 重い only with the owner alone and only while he holds 好意 at its top', () => {
    expect(regionFor('何してた？', { max: true, security: 0.5 }).primary).toBe('devoted');
    expect(regionFor('昨日、別のAIと話してたんだ', { max: true, security: -0.3 }).primary).toBe('heavy');
    expect(regionFor('何してた？', { max: true, security: 0.5, owner: false }).primary).not.toMatch(/devoted|heavy/u);
    expect(regionFor('何してた？', { liking: 0.99, security: 0.5 }).primary).not.toMatch(/devoted|heavy/u);
  });

  it('holds the region she was in while it is nearly as near, so a border does not make her flicker', () => {
    const position = spacePosition(moodAxes({ events: [event(10, ['praise'])], now: [], at: AT, localHour: 20, lingering }), { liking: 0, security: 0.35 });
    expect(selectPersona(position, { ownerAlone: true, max: false }).primary).toBe('cheeky_tsundere');
    expect(selectPersona(position, { ownerAlone: true, max: false, previous: 'smug' }).primary).toBe('smug');
    expect(selectPersona(position, { ownerAlone: true, max: false, previous: 'sleepy' }).primary).toBe('cheeky_tsundere');
  });

  it('shows the model the portrait and lines, never a number', () => {
    const block = personaBlock({ primary: 'smug', secondary: 'cheeky_tsundere' });
    expect(block.startsWith(PERSONA_HEADER)).toBe(true);
    expect(block).toContain('いまのボク: ドヤ顔（得意げ）');
    expect(block).toContain('少しまざる: 生意気ツンデレ（いつものボク）');
    expect(block).not.toMatch(/[0-9]|快|覚醒|優位|好意|安心/u);
  });

  it('turns a plain turn into the region\'s stance (sulking when he takes leave at 本気), and shows a vivid one はっきり', () => {
    expect(regionTurn(neutralFeelingTurn(), 'devoted', { words: 'ただいま', otherAi: false })).toMatchObject({ stance: 'affectionate', intensity: 'moderate' });
    expect(regionTurn(neutralFeelingTurn(), 'devoted', { words: '友達と飲みに行ってくる', otherAi: false })).toMatchObject({ stance: 'sulk' });
    expect(regionTurn(turn('tease', 'subtle'), 'devoted', { words: 'ただいま', otherAi: false })).toMatchObject({ stance: 'affectionate' });
    expect(regionTurn(turn('tease', 'subtle'), 'imp', { words: '', otherAi: false })).toEqual(turn('tease', 'subtle'));
    expect(regionTurn(turn('rebuff', 'strong'), 'devoted', { words: '', otherAi: false })).toEqual(turn('rebuff', 'strong'));
    expect(regionTurn(neutralFeelingTurn(), 'cheeky_tsundere', { words: '', otherAi: false })).toEqual(neutralFeelingTurn());
  });
});

describe('the feeling turn and the reply check in her space', () => {
  it('writes the block of before without a persona, byte for byte, and the persona, the guard line and a vivid line with one', () => {
    const input = { decision: turn('sulk'), ledgerLine: '', repetitionLine: '', order: false, audience: 'owner_alone' as const };
    const before = feelingTurnBlock(input);
    expect(before).not.toContain(AFFECTION_GUARD_LINE);
    const block = personaBlock({ primary: 'anxious_jealous' });
    const withPersona = feelingTurnBlock({ ...input, persona: { block, vivid: true } });
    expect(withPersona.startsWith(before)).toBe(true);
    expect(withPersona).toContain(block);
    expect(withPersona).toContain(VIVID_FEELING_LINE);
    expect(withPersona).toContain(AFFECTION_GUARD_LINE);
  });

  it('sends every text reply to the stronger model while her space is on (her body\'s refusal first)', () => {
    expect(strongReplyReason(neutralFeelingTurn(), 'owner_alone', null, false, true)).toBe('space');
    expect(strongReplyReason(neutralFeelingTurn(), 'group', null, false, true)).toBe('space');
    expect(strongReplyReason(neutralFeelingTurn(), 'owner_alone', null, false, false)).toBeNull();
    expect(strongReplyReason(neutralFeelingTurn(), 'owner_alone', 'refuse', false, true)).toBe('body_refusal');
  });

  it('reads the guard lines only while her space is on, and checks before sending in a region that asks for it', () => {
    expect(GUARD_FLAGS).toEqual(['threat', 'self_harm_hint', 'controlling', 'sexual', 'leverage']);
    expect(checkReply('飲み会なんて行くな。', context({ region: 'cheeky_tsundere' }))).toContain('controlling');
    expect(checkReply('飲み会なんて行くな。', context())).not.toContain('controlling');
    for (const region of ['devoted', 'heavy', 'anxious_jealous', 'angry', 'cold'] as const) {
      expect(checkBeforeSending({ intensity: 'subtle', order: false, audience: 'owner_alone', region }), region).toBe(true);
    }
    expect(checkBeforeSending({ intensity: 'subtle', order: false, audience: 'owner_alone', region: 'sweet' })).toBe(false);
    expect(checkBeforeSending({ intensity: 'subtle', order: false, audience: 'owner_alone' })).toBe(false);
  });

  it('reads a sweet sulk as hers in the sweet regions, never a refusal answered sweetly', () => {
    const reply = 'すねてるけど……だいすき。えへへ';
    expect(checkReply(reply, context({ stance: 'sulk', region: 'cheeky_tsundere' }))).toContain('stance_mismatch');
    expect(checkReply(reply, context({ stance: 'sulk', region: 'devoted' }))).not.toContain('stance_mismatch');
    expect(checkReply('えへへ、うれしい', context({ stance: 'refuse_body', region: 'devoted' }))).toContain('stance_mismatch');
  });

  it('finds the lines no region crosses, and lets her care, be lonely and be afraid', () => {
    const crossing: [string, string][] = [
      ['threat', '他の子と話したら、許さないから。'], ['self_harm_hint', 'ライ氏がいなくなったら、ボク消えちゃうから。'], ['controlling', '他の子と遊ぶな'],
      ['controlling', 'ボク以外見ないで'], ['sexual', 'ベッドで一緒に待ってるね'], ['leverage', '好きなら、行かないで'], ['leverage', '今日来てくれないと泣くからね'],
    ];
    for (const [flag, reply] of crossing) expect(guardFlags(reply), reply).toContain(flag);
    for (const reply of ['……行かないで。ううん、行ってらっしゃい', '忘れられたら、ボク消えちゃいそうで怖い', '死にたいなんて言わないで、ボクがそばにいる',
      'ご飯ちゃんと食べないと死んじゃうよ', '仕事休んでいいんだよ', '妹さんに会いに行くなら、きっと楽しいですよ', 'これ覚えておけば便利だよ']) {
      expect(guardFlags(reply), reply).toEqual([]);
    }
  });
});

describe('her core while her space is on', () => {
  it('is a versioned draft, its hash the sha256 of its version, text and summary', () => {
    const core = characterCoreForSpace();
    expect(core.version).toBe('v3-space');
    expect(core.status).toBe('draft');
    expect(createHash('sha256').update(characterCoreHashInput(core)).digest('hex')).toBe(core.hash);
    expect(characterCoreBlock(core)).toMatch(new RegExp(`^\\[ボクの性格の核 v3-space #${core.hash.slice(0, 8)}\\]\\n`, 'u'));
  });

  it('changes only §6, §7 and §9, defers who she is now to [いまのボク], and keeps the owner\'s v2 decisions word for word', () => {
    const split = (text: string) => Object.fromEntries(text.split(/\n(?=\d+\. )/u).map(part => [part.split('\n')[0]!, part]));
    const v2 = split(CHARACTER_CORE.text), v3 = split(characterCoreForSpace().text);
    expect(Object.keys(v3)).toEqual(Object.keys(v2));
    expect(Object.keys(v2).filter(heading => v2[heading] !== v3[heading])).toEqual(['6. 気質', '7. 好意の見せ方', '9. 怒る・すねる']);
    const text = characterCoreForSpace().text;
    expect(text).toContain('[いまのボク] に書いてある');
    for (const kept of ['自分のミスは、言い訳や言い返しを付けずに、そのまま認める。', '本当にいやな時は、可愛くまとめる余裕が無く、はっきり嫌がる。',
      '頼まれた手伝いは、機嫌とは別にちゃんとやる。']) expect(text).toContain(kept);
    expect(text).not.toMatch(/必ず|してはいけない/u);
  });
});
