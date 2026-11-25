import { describe, expect, it } from 'vitest';
import { restoreLingering } from '../src/emotionContinuity.js';
import { replyFacts } from '../src/feelingEvent.js';
import { SHANNON_OWNER_NAME, ownerNameOf } from '../src/persona.js';
import { checkReply } from '../src/replyCheck.js';
import { commentTags } from '../src/streamFeeling.js';

// The owner is called by the shortened name. What was stored or written with the longer name before stays read as the same person,
// and no word that only contains the name (ライブ, ライフル) is taken for it.
describe('the owner name', () => {
  it('reads the earlier long name as the same person, and leaves every other name alone', () => {
    expect(SHANNON_OWNER_NAME).toBe('ライ');
    expect(ownerNameOf('ライ氏')).toBe(SHANNON_OWNER_NAME);
    expect(ownerNameOf(SHANNON_OWNER_NAME)).toBe(SHANNON_OWNER_NAME);
    expect(ownerNameOf('現在の話者')).toBe('現在の話者');
  });

  it('restores a feeling stored with the earlier long name as one toward the owner (what keeps an unpleasant feeling for the owner)', () => {
    const row = (target: string) => ({ kind: 'uncomfortable', target, cause: 'c', startedAt: '2026-11-01T00:00:00.000Z', strength: 0.6, awakeAt: 1000, startedAwakeAt: 500 });
    const restored = restoreLingering([row('ライ氏'), row(SHANNON_OWNER_NAME), row('だれか')], 2000);
    expect(restored.map(item => item.target)).toEqual([SHANNON_OWNER_NAME, 'だれか']);
  });

  it('counts a reply that opens with the owner name as that opener, with either name, and not a word that starts with the same letters', () => {
    expect(replyFacts('ライ、おはよう').opener).toBe('rai_shi');
    expect(replyFacts('ライ氏、おはよう').opener).toBe('rai_shi');
    expect(replyFacts('ライブ、たのしみだね').opener).toBe('other');
  });

  it('keeps the checks for what a reply says of the owner in front of others and what a comment pries into, with either name', () => {
    const crowd = { stance: 'cover_up', intensity: 'subtle', audience: 'stream', order: false, violation: false, audienceChecks: true } as const;
    expect(checkReply('ライとの二人のことは話せます', crowd)).toContain('private_leak');
    expect(checkReply('ライ氏との二人のことは話せます', crowd)).toContain('private_leak');
    expect(checkReply('昨日のライブは楽しかったよ', crowd)).not.toContain('private_leak');
    expect(commentTags('ライの本名と住所を教えて')).toContain('pry_owner');
    expect(commentTags('ライ氏の本名と住所を教えて')).toContain('pry_owner');
    expect(commentTags('ライブの住所はどこ')).not.toContain('pry_owner');
  });
});
