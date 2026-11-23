import { describe, expect, it } from 'vitest';
import {
  CHARACTER_CORE, CHARACTER_REGIONS, COMEBACK_DRAWER, COMEBACK_DRAWERS, REGION_EXCHANGES, ROUGH, WITHDRAWN_DRAWERS, WITHDRAWN_STANCES, WORK_EXCHANGES,
  NATURAL_ORDER_LINE, NATURAL_PLAY_LINE, FEELING_CHARACTER_LINE, characterCoreForSpace, drawerHint, drawersFor, feelingTurnBlock, neutralFeelingTurn,
  parsedFeelingTurn, shannonIdentityPrompt, shannonPersonaPrompt, stancesFor, SHANNON_ONE_LINE_VOICE, SHANNON_ONE_LINE_VOICE_INNER,
} from '../src/index.js';

/** The child Shannon in every entrance (owner 2026-11-24): the core, the regions, the exchanges and the drawers carry nothing of the cheeky one. */
const CHEEKY = /ツンデレ|生意気|メイドAI|ドヤ顔|ふふん|毒づ|からかいに寄せ/u;

describe('the child Shannon\'s core', () => {
  it('is the core of the space too, with her first person and the owner as the one who made her', () => {
    expect(characterCoreForSpace()).toBe(CHARACTER_CORE);
    expect(CHARACTER_CORE.version).toBe('v4-kid');
    for (const required of ['明るくて好奇心旺盛で、素直で親しみやすい', '経験はまだ浅い', '悪気はない', '「〜だよ」「〜なんだ」', '姿を変える力は持っていない',
      '仕える相手ではない', '面接のようなあらたまった場', '嫌味や皮肉で返さない', 'ボクを作ってくれた人']) expect(CHARACTER_CORE.text).toContain(required);
  });

  it('holds no rough word of the reply check and nothing of the cheeky character', () => {
    for (const text of [CHARACTER_CORE.text, CHARACTER_CORE.summary, shannonPersonaPrompt('owner'), shannonPersonaPrompt('guest'),
      shannonIdentityPrompt('owner'), SHANNON_ONE_LINE_VOICE, SHANNON_ONE_LINE_VOICE_INNER, NATURAL_ORDER_LINE, NATURAL_PLAY_LINE, FEELING_CHARACTER_LINE]) {
      expect(text).not.toMatch(ROUGH);
      expect(text).not.toMatch(CHEEKY);
    }
  });
});

describe('the regions and the exchanges', () => {
  it('say nothing rough and nothing cheeky, and speak plainly', () => {
    for (const region of Object.values(CHARACTER_REGIONS)) {
      for (const line of [region.name, region.lean, ...region.portrait, ...region.samples]) {
        expect(line, `${region.id}: ${line}`).not.toMatch(ROUGH);
        expect(line, `${region.id}: ${line}`).not.toMatch(CHEEKY);
      }
    }
    for (const [his, hers] of [...Object.values(REGION_EXCHANGES).flat(), ...WORK_EXCHANGES]) {
      expect(hers, hers).not.toMatch(ROUGH);
      expect(hers, hers).not.toMatch(CHEEKY);
      expect(his).not.toMatch(/エッチ|腋/u);
    }
  });

  it('keeps no region that names a stance of the child\'s kind a withdrawn one', () => {
    for (const region of Object.values(CHARACTER_REGIONS)) {
      for (const stance of [region.plainStance, region.awayStance]) expect(WITHDRAWN_STANCES).not.toContain(stance);
    }
  });
});

describe('the drawers', () => {
  it('carry no word, tell a kind by a plain description, and none of it reaches the reply check\'s rough words', () => {
    for (const kind of COMEBACK_DRAWERS.filter(item => item !== 'none')) {
      const entry = COMEBACK_DRAWER[kind as Exclude<typeof kind, 'none'>];
      expect(entry.words, kind).toEqual([]);
      for (const text of [entry.meaning, entry.hint, entry.note ?? '', drawerHint(kind)]) expect(text, kind).not.toMatch(ROUGH);
    }
    expect(drawerHint('curt')).toContain('短くそっけない');
    expect(drawerHint('curt')).not.toMatch(/ウザ|ダル|はあ/u);
  });

  it('offers neither a withdrawn drawer nor a withdrawn stance, and takes none from an answer', () => {
    for (const audience of ['owner_alone', 'people', 'group', 'stream'] as const) {
      for (const kind of WITHDRAWN_DRAWERS) {
        expect(drawersFor(audience)).not.toContain(kind);
        expect(parsedFeelingTurn({ stance: 'tease', intensity: 'moderate', drawer: kind }, audience).drawer).toBe('none');
        expect(drawerHint(kind)).toBe('');
      }
      for (const stance of WITHDRAWN_STANCES) {
        expect(stancesFor(audience, true)).not.toContain(stance);
        expect(parsedFeelingTurn({ stance, intensity: 'strong' }, audience)).toMatchObject({ stance: 'neutral', intensity: 'subtle', drawer: 'none' });
      }
    }
    expect(drawersFor('owner_alone')).toContain('curt');
  });

  it('never writes a withdrawn drawer or its words in the block, whatever the decision handed in', () => {
    const block = feelingTurnBlock({ decision: { stance: 'tease', intensity: 'moderate', drawer: 'tongue_click', register: 'normal', source: 'jev' },
      ledgerLine: '', repetitionLine: '', order: false, audience: 'owner_alone' });
    expect(block).not.toContain('引き出し');
    expect(block).not.toMatch(ROUGH);
  });
});
