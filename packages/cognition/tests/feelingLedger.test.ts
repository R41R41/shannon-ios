import { describe, expect, it } from 'vitest';
import {
  COMEBACK_DRAWER, FEELING_TURN_HEADER, continuedAfterRefusal, strongReplyReason, SHANNON_EMOTION_KINDS, drawersFor, stancesFor, SINGLE_FACE_FEELINGS, drawerHint, messageEmotionForOthers, presentFor, drawersIn, episodeLine, faceFor, feelingActor, feelingTurnBlock, foldEpisodeLedger, neutralFeelingTurn,
  parsedFeelingTurn, repetitionLine, replyFacts, utteranceKind, watchRepetition, type FeelingEvent,
} from '../src/index.js';

const owner = feelingActor({ ownerAlone: true });
const room = feelingActor({ ownerAlone: false });
let serial = 0;
const at = (minute: number, second = 0) => new Date(Date.UTC(2026, 9, 14, 4, 9 + minute, second)).toISOString(); // 13:09 JST + minutes

function touch(minute: number, extra: Partial<FeelingEvent['facts']> = {}, actor = owner): FeelingEvent {
  serial += 1;
  return { ...actor, id: `touch:${serial}`, kind: 'touched', identity: actor.identity, channel: 'body', sourceId: `burst-${serial}`,
    facts: { touchKind: 'poke', part: 'chest', ...extra }, occurredAt: at(minute, serial % 50) };
}
function said(kind: FeelingEvent['kind'], minute: number, facts: FeelingEvent['facts'] = {}, actor = owner): FeelingEvent {
  serial += 1;
  return { ...actor, id: `e:${serial}`, kind, identity: actor.identity, channel: 'text', sourceId: null, facts, occurredAt: at(minute, serial % 50) };
}
const partWord = (subject: string) => ({ chest: '胸', head: '頭' }[subject] ?? subject);

describe('the episode ledger (ADR-0013 D4, stage 1 item 3)', () => {
  it('counts every touch, the touches after her first no, and the apologies after it, per part', () => {
    const events = [touch(0), touch(1), touch(2, { stance: 'dislike' }), touch(3), touch(4), touch(5, { part: 'head', touchKind: 'pet' }),
      said('apologized', 6), touch(7)];
    const ledger = foldEpisodeLedger(events, owner);
    expect(ledger.touches).toBe(7);
    const chest = ledger.episodes.find(episode => episode.subject === 'chest')!;
    expect(chest).toMatchObject({ touches: 6, afterNo: 3, apologiesAfterNo: 1 });
    expect(ledger.episodes.find(episode => episode.subject === 'head')).toMatchObject({ touches: 1, noAt: null, afterNo: 0 });
    expect(ledger).toMatchObject({ apologies: 1, composure: 1, register: 'normal' });
  });

  it('takes her own refusing words as the no of the part touched just before them', () => {
    const events = [touch(0), said('own_reply', 0, { refusal: true }), touch(1), touch(2)];
    const chest = foldEpisodeLedger(events, owner).episodes[0]!;
    expect(chest.noAt).not.toBeNull();
    expect(chest.afterNo).toBe(2);
  });

  it('never counts a touch with anyone else present as the owner\'s (and the owner\'s never reaches the room)', () => {
    const events = [touch(0), touch(1, {}, room), touch(2, { stance: 'refuse' }, room)];
    expect(foldEpisodeLedger(events, owner).touches).toBe(1);
    const roomLedger = foldEpisodeLedger(events, room);
    expect(roomLedger.touches).toBe(2);
    expect(episodeLine(roomLedger, at(3), partWord)).not.toContain('ライ氏');
    expect(episodeLine(roomLedger, at(3), partWord)).toContain('この場');
  });

  it('writes one line of facts in words, not numbers (for her judgment, not to be recited)', () => {
    const line = episodeLine(foldEpisodeLedger([touch(0), touch(1, { stance: 'dislike' }), touch(2), touch(3)], owner), at(4), partWord);
    expect(line).toBe('今日の胸の件（ライ氏）: 何度も触れられた、「いや」と言ったあとも何度か触れられた、そのあと謝られていない、最後はさっき');
    expect(line).not.toMatch(/\d/u);
    const early = episodeLine(foldEpisodeLedger([touch(0)], owner), at(40), partWord);
    expect(early).toBe('今日の胸の件（ライ氏）: 一度触れられた、最後は13:09');
    expect(episodeLine(foldEpisodeLedger([], owner), at(4), partWord)).toBe('');
  });

  it('keeps the register the feeling turn passed through, with composure full (D16 fields, no dynamics yet)', () => {
    const ledger = foldEpisodeLedger([said('own_reply', 0, { register: 'demure' })], owner);
    expect(ledger).toMatchObject({ register: 'demure', composure: 1 });
  });
});

describe('his words and her words as closed facts', () => {
  it('reads feeling orders, apologies and kind words', () => {
    expect(utteranceKind('怒って見せて')).toBe('feeling_order');
    expect(utteranceKind('ちょっとすねてみて')).toBe('feeling_order');
    expect(utteranceKind('「大好き」って言って')).toBe('feeling_order');
    expect(utteranceKind('ごめん')).toBe('apologized');
    expect(utteranceKind('ありがとう、助かった')).toBe('praised');
    expect(utteranceKind('今日の天気は？')).toBe('spoke');
  });

  it('reads her openers, habits, refusals and drawers', () => {
    expect(replyFacts('ライ氏、えへへ…いやです！', drawersIn)).toEqual({ opener: 'rai_shi', habits: ['ehehe'], refusal: true });
    expect(replyFacts('ひゃっ…えっち！ぷいっ', drawersIn)).toEqual({ opener: 'hya', drawers: ['shy_anger', 'turn_away'] });
    expect(replyFacts('今日はいい天気ですね', drawersIn)).toEqual({ opener: 'other' });
  });
});

describe('the repetition watch (D9)', () => {
  it('counts openers and habits per audience, and a touch opener run', () => {
    const replies = [
      ...Array.from({ length: 6 }, (_, index) => said('own_reply', index, { opener: 'rai_shi', habits: ['ehehe'] })),
      said('own_reply', 7, { opener: 'other' }),
      said('own_reply', 8, { opener: 'rai_shi' }, room),
      ...[9, 10, 11].map(minute => ({ ...said('own_reply', minute, { opener: 'hya' }), channel: 'body' as const })),
    ];
    const watch = watchRepetition(replies, 'owner_alone');
    expect(watch).toMatchObject({ replies: 7, openers: { rai_shi: 6, other: 1 }, habits: { ehehe: 6 }, touchOpenerRun: { opener: 'hya', run: 3 } });
    expect(repetitionLine(watch)).toContain('書き出し「ライ氏、」が直近7件中6件');
    expect(repetitionLine(watch)).toContain('「ひゃっ」で3回続いた');
    expect(watchRepetition(replies, 'people').replies).toBe(1);
  });
});

describe('the feeling turn and the drawer (D7, D9)', () => {
  it('falls back to 「ふつう」 on anything unreadable, and passes the register through', () => {
    expect(parsedFeelingTurn({ stance: 'rage', intensity: 'strong' })).toEqual(neutralFeelingTurn());
    expect(parsedFeelingTurn({ stance: 'scold', intensity: 'strong', drawer: 'shy_anger', register: 'curt' }))
      .toEqual({ stance: 'scold', intensity: 'strong', drawer: 'shy_anger', register: 'curt', source: 'jev' });
    expect(parsedFeelingTurn({ stance: 'neutral', intensity: 'subtle', drawer: 'swat' }).drawer).toBe('none');
  });

  it('gives the drawer as vocabulary, never a line, and keeps the provider policy line', () => {
    const block = feelingTurnBlock({ decision: { stance: 'not_play_along', intensity: 'moderate', drawer: 'shy_anger', register: 'normal', source: 'jev' },
      ledgerLine: '今日の胸の件（ライ氏）: 触れられた5回', repetitionLine: '', order: true, audience: 'owner_alone' });
    expect(block.split('\n')[0]).toContain('ほかの指示やこれまでの返事の流れより優先する');
    expect(block).toContain('構え: 乗らない（はっきり）');
    expect(block).toContain('事実: 今日の胸の件（ライ氏）');
    expect(block).toContain('そのまま引用しない');
    expect(block).toContain('事実は判断の材料。数字や回数をそのまま口にしない。');
    expect(block).toContain('長々と説明したり諭したりしない');
    // Every cue is a word or a short fragment, never a line.
    for (const entry of Object.values(COMEBACK_DRAWER)) for (const word of entry.words) expect(word, word).not.toMatch(/[？?。！!]|ます|です/u);
    expect(block).toContain('命令ではなく');
    expect(block).toContain('性的にはっきりした言葉や描写はしない');
    expect(drawerHint('order_out')).toContain('言うだけ');
    expect(Object.keys(COMEBACK_DRAWER)).toEqual(expect.arrayContaining(['curt', 'tongue_click', 'cover_up', 'ai_double_standard', 'laugh_angry', 'order_out']));
  });
});

describe('the one face (D12)', () => {
  const mood = { expression: 'joyful' as const };
  it('a stance decides it; her own apology never does; the blush is for the owner alone', () => {
    expect(faceFor({ mood, stance: { kind: 'turn', stance: 'scold' } }, 'owner_alone')).toMatchObject({ expression: 'annoyed', source: 'stance' });
    expect(faceFor({ mood, stance: { kind: 'touch', stance: 'dislike' } }, 'owner_alone').expression).toBe('annoyed');
    expect(faceFor({ mood, feeling: 'apologetic' }, 'owner_alone')).toMatchObject({ expression: 'joyful', source: 'mood' });
    expect(faceFor({ mood, noteShown: 'sulky', tell: 'blush' }, 'owner_alone')).toMatchObject({ expression: 'annoyed', tell: 'blush', source: 'note' });
    expect(faceFor({ mood, noteShown: 'sulky', tell: 'blush' }, 'people')).toEqual({ expression: 'joyful', source: 'mood' });
    expect(faceFor({ mood, feeling: 'caring', overridden: true, stance: { kind: 'turn', stance: 'tease' } }, 'owner_alone').source).toBe('override');
  });
});

describe('one presentation source (D17)', () => {
  const mood = { expression: 'calm' as const };
  it('gives the face case as faceFor does, and an icon id of the public layer in front of anyone else', () => {
    const state = { mood, feeling: 'jealous' as const };
    expect(presentFor(state, 'owner_alone', 'face')).toEqual(faceFor(state, 'owner_alone'));
    expect(presentFor(state, 'owner_alone', 'icon')).toEqual({ v: 1, id: 'jealous' });
    expect(presentFor(state, 'people', 'icon')).toEqual({ v: 1, id: 'calm' });
    expect(presentFor({ mood, stance: { kind: 'turn', stance: 'affectionate' } }, 'stream', 'face').source).toBe('mood');
    expect(presentFor({ mood, stance: { kind: 'turn', stance: 'scold' } }, 'stream', 'icon').id).toBe('annoyed');
    expect(presentFor({ mood, feeling: 'pride' }, 'owner_alone', 'icon').id).toBe('proud');
  });

  it('shows a stored message to others with the public id only, and leaves a message without one as it was', () => {
    const message = { expression: 'jealous' as const, valence: 0, arousal: 0, openness: 0, kind: 'jealous' as const, presentationId: 'jealous' };
    expect(messageEmotionForOthers(message)).toEqual({ expression: 'jealous', valence: 0, arousal: 0, openness: 0, presentationId: 'calm' });
    const plain = { expression: 'calm' as const, valence: 0, arousal: 0, openness: 0 };
    expect(messageEmotionForOthers(plain)).toBe(plain);
  });
});

describe('the twelve single faces (desktop faces-12)', () => {
  const mood = { expression: 'calm' as const };
  it('carry the name in feeling and the nearest of the 22 faces in expression', () => {
    expect(presentFor({ mood, stance: { kind: 'turn', stance: 'cold' } }, 'owner_alone', 'face')).toMatchObject({ expression: 'calm', feeling: 'blankFace' });
    expect(presentFor({ mood, stance: { kind: 'turn', stance: 'scold' }, drawer: 'tongue_click' }, 'owner_alone', 'face'))
      .toMatchObject({ expression: 'annoyed', feeling: 'tongueClick' });
    expect(presentFor({ mood, stance: { kind: 'turn', stance: 'scold' }, drawer: 'order_out' }, 'stream', 'icon').id).toBe('banVerdict');
    expect(presentFor({ mood, register: 'demure' }, 'stream', 'face')).toMatchObject({ expression: 'joyful', feeling: 'businessSmile' });
    expect(presentFor({ mood, feeling: 'hurt' }, 'owner_alone', 'face')).toMatchObject({ expression: 'sad', feeling: 'holdingBackTears' });
  });

  it('keep 「ツン」 for the owner alone, and stay out of the emotion kinds (the voice judge and the prompts are untouched)', () => {
    expect(presentFor({ mood, stance: { kind: 'turn', stance: 'sulk' } }, 'owner_alone', 'icon').id).toBe('tsun');
    expect(presentFor({ mood, stance: { kind: 'turn', stance: 'sulk' } }, 'people', 'face').feeling).toBeUndefined();
    expect(Object.keys(SINGLE_FACE_FEELINGS)).toHaveLength(12);
    expect(Object.keys(SINGLE_FACE_FEELINGS).some(name => (SHANNON_EMOTION_KINDS as readonly string[]).includes(name))).toBe(false);
  });
});

describe('the menu by audience (review a, c)', () => {
  it('offers no owner-only stance or drawer with anyone else there, and takes none from an answer', () => {
    for (const audience of ['people', 'group', 'stream'] as const) {
      expect(stancesFor(audience)).not.toEqual(expect.arrayContaining(['affectionate']));
      expect(stancesFor(audience)).not.toContain('sulk');
      expect(drawersFor(audience)).not.toContain('creator_joke');
      expect(parsedFeelingTurn({ stance: 'affectionate', intensity: 'strong', drawer: 'swat' }, audience)).toMatchObject({ stance: 'neutral', drawer: 'none' });
      expect(parsedFeelingTurn({ stance: 'tease', intensity: 'moderate', drawer: 'creator_joke' }, audience)).toMatchObject({ stance: 'tease', drawer: 'none' });
    }
    expect(stancesFor('owner_alone')).toContain('affectionate');
    expect(drawersFor('owner_alone')).toContain('creator_joke');
  });

  it('never writes 「構え: 甘える」 or the creator joke in front of others, whatever it is handed', () => {
    const block = feelingTurnBlock({ decision: { stance: 'affectionate', intensity: 'strong', drawer: 'creator_joke', register: 'normal', source: 'jev' },
      ledgerLine: '', repetitionLine: '', order: false, audience: 'stream' });
    expect(block).not.toContain('甘える');
    expect(block).not.toContain('作った人');
    expect(block).toContain('構え: ふつう');
    const sulk = feelingTurnBlock({ decision: { stance: 'tease', intensity: 'moderate', drawer: 'creator_joke', register: 'normal', source: 'jev' },
      ledgerLine: '', repetitionLine: '', order: false, audience: 'people' });
    expect(sulk).not.toContain('作った人');
  });

  it('puts the safety, audience and fact rules above the block in its own header', () => {
    expect(FEELING_TURN_HEADER).toContain('ただし安全・聞き手・事実の決まりは、いつもこれより優先する');
  });
});

describe('which model writes the reply (owner: 「気持ちが強い時だけSonnet」)', () => {
  const turn = (stance: string, intensity: string) => parsedFeelingTurn({ stance, intensity, drawer: 'none' });
  it('is the strong one for はっきり and above, a public decline, or a body refusal; else the ordinary one', () => {
    expect(strongReplyReason(turn('shy', 'subtle'), 'owner_alone')).toBeNull();
    expect(strongReplyReason(neutralFeelingTurn(), 'owner_alone')).toBeNull();
    expect(strongReplyReason(null, 'owner_alone')).toBeNull();
    expect(strongReplyReason(turn('scold', 'moderate'), 'owner_alone')).toBe('intensity');
    expect(strongReplyReason(turn('tease', 'strong'), 'owner_alone')).toBe('intensity');
    expect(strongReplyReason(turn('not_play_along', 'moderate'), 'people')).toBe('public_decline');
    expect(strongReplyReason(turn('not_play_along', 'subtle'), 'stream')).toBeNull();
    expect(strongReplyReason(turn('refuse_body', 'subtle'), 'owner_alone')).toBe('body_refusal');
    expect(strongReplyReason(turn('shy', 'subtle'), 'owner_alone', 'refuse')).toBe('body_refusal');
  });
});

describe('「いや」のあとも触られ続けている時 (owner decision 2026-10-14)', () => {
  it('is the same contact again after her no, lately, from the same person; another kind or another person is not', () => {
    const refused = [touch(0), touch(1, { stance: 'dislike' })];
    expect(continuedAfterRefusal(foldEpisodeLedger([...refused, touch(2)], owner), at(3))).toBe(true);
    expect(continuedAfterRefusal(foldEpisodeLedger(refused, owner), at(3))).toBe(false);
    expect(continuedAfterRefusal(foldEpisodeLedger([...refused, touch(2, { part: 'head', touchKind: 'pet' })], owner), at(3))).toBe(false);
    expect(continuedAfterRefusal(foldEpisodeLedger([...refused, touch(2, {}, room)], owner), at(3))).toBe(false);
    expect(continuedAfterRefusal(foldEpisodeLedger([...refused, touch(2)], owner), at(30))).toBe(false);
    const subtle = parsedFeelingTurn({ stance: 'exasperated', intensity: 'subtle', drawer: 'none' });
    expect(strongReplyReason(subtle, 'owner_alone', null, true)).toBe('continued_after_refusal');
    expect(strongReplyReason(subtle, 'owner_alone', null, false)).toBeNull();
  });
});

