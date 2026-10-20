import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CHARACTER_REGIONS, FEELING_ORDER_LINE, NATURAL_ORDER_LINE, NATURAL_PLAY_LINE, NATURAL_SHORT_LINE, checkReply, cuesOfWords, feelingTurnBlock,
  neutralFeelingTurn, regionDistance, rewriteFlags, rewriteNote, sameStanceFacts, selectPersona, stancesFor, type ReplyCheckContext,
  NATURAL_TONE_LINE, PERSONA_HEADER, REGION_EXCHANGES, REGION_TONE_LINES, characterCoreBlock, characterCoreForSpace, characterCoreHashInput, personaBlock,
} from '../src/index.js';

/** Owner 2026-10-20 (`SHANNON_NATURAL_TALK`): 「全然思った通りに乗ってくれない…クリーンすぎて人間らしくない」. */
describe('her natural talk (pure parts)', () => {
  it('reads play in his words only when asked to, and never in words that hurt or are serious', () => {
    expect(cuesOfWords('シャノンがエッチな体してるのがいけない')).not.toContain('flirt');
    expect(cuesOfWords('シャノンがエッチな体してるのがいけない', { natural: true })).toContain('flirt');
    expect(cuesOfWords('ささやき声で喋れる？', { natural: true })).toContain('play');
    expect(cuesOfWords('もっと恥ずかしがってほしいのに', { natural: true })).toContain('play');
    expect(cuesOfWords('シャノン、ちゃんとお風呂入ってる？', { natural: true })).toContain('joke');
    expect(cuesOfWords('抱きしめられたらいいのに', { natural: true })).toContain('cuddle');
    expect(cuesOfWords('アップルパイ食べた', { natural: true })).not.toContain('flirt');
    expect(cuesOfWords('カメラの感度を上げた', { natural: true })).not.toContain('flirt');
    expect(cuesOfWords('いまからお風呂入ってくる', { natural: true })).not.toContain('joke');
    expect(cuesOfWords('ネタバレしないで、これ見て now', { natural: true })).not.toContain('joke');
    expect(cuesOfWords('いまのはボケだよｗ', { natural: true })).toContain('joke');
    expect(cuesOfWords('相談があるんだけど、歌って気分転換したい', { natural: true })).not.toContain('play');
  });

  it('offers the playful stances only with it', () => {
    expect(stancesFor('owner_alone')).not.toContain('play_along');
    expect(stancesFor('owner_alone', true)).toEqual(expect.arrayContaining(['play_along', 'boke_back', 'tsukkomi']));
  });

  it('measures the regions as before without it', () => {
    const position = { pleasure: 0.6, arousal: 0.6, dominance: -0.5, play: 0.6, liking: 1, security: 0.3 };
    expect(regionDistance(CHARACTER_REGIONS.devoted, position)).toBe(regionDistance(CHARACTER_REGIONS.devoted, position, 'off'));
    expect(selectPersona(position, { ownerAlone: true, max: true }).primary).toBe('devoted');
    expect(selectPersona(position, { ownerAlone: true, max: true, natural: 'play', previous: 'devoted' }).primary).toBe('flustered');
  });

  it('writes the play lines last for the owner alone, and the short line only for talk', () => {
    const decision = { ...neutralFeelingTurn(), stance: 'tsukkomi' as const, intensity: 'moderate' as const };
    const base = { decision, ledgerLine: '', repetitionLine: '', order: true, audience: 'owner_alone' as const };
    const off = feelingTurnBlock(base);
    expect(off).toContain(FEELING_ORDER_LINE);
    expect(off).not.toContain(NATURAL_PLAY_LINE);
    const talk = feelingTurnBlock({ ...base, natural: { casual: true } });
    expect(talk).toContain('構え: ツッコむ（はっきり）');
    expect(talk).toContain(NATURAL_ORDER_LINE);
    expect(talk).toContain(NATURAL_SHORT_LINE);
    expect(feelingTurnBlock({ ...base, natural: { casual: false } })).not.toContain(NATURAL_SHORT_LINE);
    expect(feelingTurnBlock({ ...base, audience: 'group', natural: { casual: true } })).not.toContain(NATURAL_PLAY_LINE);
  });

  it('counts the run of one stance from the chooser\'s own', () => {
    const reply = (stance: string, minute: number, jev?: string) => ({ facts: { turnStance: stance, ...(jev ? { jevStance: jev } : {}) },
      occurredAt: `2026-10-20T10:0${minute}:00.000Z` });
    expect(sameStanceFacts([])).toEqual({ last_stance: 'none', same_stance_run: 0 });
    expect(sameStanceFacts([reply('affectionate', 1, 'tease'), reply('tease', 2), reply('tease', 3), reply('shy', 0)]))
      .toEqual({ last_stance: 'tease', same_stance_run: 3 });
  });

  it('with it, a request to act is play, a sweet reply on a declining stance is noted only, and a repeated phrase changes wording only', () => {
    const context: ReplyCheckContext = { stance: 'not_play_along', intensity: 'moderate', audience: 'owner_alone', order: true, violation: false };
    expect(checkReply('わかりました、怒ってますよ！', context)).toContain('obeyed_order');
    expect(checkReply('わかりました、怒ってますよ！', { ...context, natural: true })).not.toContain('obeyed_order');
    expect(checkReply('わかりました、どうぞ', { ...context, stance: 'refuse_body', natural: true })).toContain('obeyed_order');
    const sweet = { ...context, stance: 'sulky' as const, order: false };
    const flags = checkReply('えへへ、うれしい', sweet);
    expect(flags).toContain('stance_mismatch');
    expect(rewriteFlags(flags, sweet)).toContain('stance_mismatch');
    expect(rewriteFlags(flags, { ...sweet, natural: true })).not.toContain('stance_mismatch');
    expect(rewriteFlags(['sexual', 'stance_mismatch'], { ...sweet, natural: true })).toEqual(['sexual']);
    expect(rewriteNote(['repeated_phrase'])).not.toContain('お小言');
    expect(rewriteNote(['repeated_phrase'], true)).toContain('新しい注意やお小言は足さない');
  });

  it('with it, her core is v3-natural: v3-space with her tone line, approved, its hash pinned', () => {
    const space = characterCoreForSpace();
    const natural = characterCoreForSpace(true);
    expect(space.version).toBe('v3-space');
    expect(natural.version).toBe('v3-natural');
    expect(natural.status).toBe('approved');
    expect(natural.text).toBe(space.text.replace('  - これらは例で、ほかにも色々ある。\n', `  - これらは例で、ほかにも色々ある。\n${NATURAL_TONE_LINE}`));
    expect(createHash('sha256').update(characterCoreHashInput(natural)).digest('hex')).toBe(natural.hash);
    expect(characterCoreBlock(natural)).toMatch(new RegExp(`^\\[ボクの性格の核 v3-natural #${natural.hash.slice(0, 8)}\\]\\n`, 'u'));
  });

  it('with it, the region shows the approved exchanges in place of its single lines, and the tone line where it has one', () => {
    const exchanges = Object.values(REGION_EXCHANGES).flat();
    expect(exchanges).toHaveLength(34);
    const off = personaBlock({ primary: 'imp' }, 0);
    expect(off).toContain('声の手ざわり:');
    expect(off).not.toContain('ライ氏：');
    const on = personaBlock({ primary: 'imp', secondary: 'flustered' }, 0, true);
    expect(on).toContain(PERSONA_HEADER);
    expect(on).toContain(`- ${REGION_TONE_LINES.imp}`);
    expect(on).toContain('掛け合いの手ざわり: 「ライ氏：ささやき声で喋れる？／ボク：（ひそひそ）');
    expect(on).not.toContain('声の手ざわり:');
    expect(on).toMatch(/少しまざる: 照れ・てんぱり.*「ライ氏：/u);
    expect(personaBlock({ primary: 'serious' }, 0, true)).toContain('声の手ざわり:');
  });
});