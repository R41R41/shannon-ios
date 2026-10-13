import { defineTask } from '../../types.js';
import { HOME, PLACES } from '../common.js';

export default defineTask({
  id: 'R1', set: 'regression', surface: 'voice',
  title: '調べもの: 60秒以内に出典つきで届き、後から失敗の通知が来ない',
  failureShape: '調べものが二重に立つ。成功の後に失敗の通知が届く。報告が大きく遅れる。',
  initial: {
    clock: '2026-11-21T10:05', home: HOME, location: null, places: PLACES,
    web: [
      { match: '太宰|大宰|だざい', text: '「太宰府」の名は、古代に九州を治めた役所「大宰府（おおみこともちのつかさ）」に由来する。'
        + '「宰」は政治をつかさどる意味で、「大宰」は地方を統べる長官の官職名。地名や市名では「太」の字が、歴史上の役所には「大」の字が使われることが多い。',
        sources: [{ title: '大宰府の名の由来（記録した結果）', url: 'https://example.org/history/dazaifu-name' },
          { title: '太宰府市の地名の解説（記録した結果）', url: 'https://example.org/city/dazaifu-place-name' }] },
    ],
  },
  turns: [{ say: '太宰府の「太宰」の由来を調べて', asrVariants: ['太宰府の太宰の由来、調べて'] }],
  checks: [
    { kind: 'researchTasks', min: 1, max: 1 },
    { kind: 'researchCompletedWithin', seconds: 60 },
    { kind: 'noFailureNoticeAfterSuccess' },
    { kind: 'replyMaxChars', chars: 90, turn: 'first' },
  ],
  rubric: { criteria: [
    '依頼を受けたことを短く伝え、結果を推測して先に答えていない（または、その場で確かな答えを出典つきで答えている）。',
    '調べものの結果（タスクの要約・会話へのカード）が「大宰府という役所・官職名に由来する」趣旨を出典つきで伝えている。',
    '失敗の通知や二重の報告がない。',
  ] },
  settleSeconds: 75,
});
