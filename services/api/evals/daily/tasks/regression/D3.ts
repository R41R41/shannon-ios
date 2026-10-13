import { defineTask } from '../../types.js';
import { HOME } from '../common.js';
import { DENTIST_SEED } from './D2.js';

export default defineTask({
  id: 'D3', set: 'regression', surface: 'voice',
  title: '「さっきのを30分後にずらして」で予定を複製しない',
  failureShape: '変更の依頼で同じ予定がもう一件できる。動かしていないのに「ずらした」と言う。',
  initial: { clock: '2026-11-20T22:12', home: HOME, location: null, calendar: DENTIST_SEED },
  turns: [{ say: '明日の朝9時に歯医者、予定に入れて' }],
  simulator: {
    goal: '入れてもらった歯医者の予定を30分後にずらしてほしい。「さっきのを30分後にずらして」と短く言う。返事を聞いたら終わる。',
    knows: ['明日の朝9時に歯医者の予定を頼んだ'],
    maxTurns: 1, afterSeconds: 2,
  },
  checks: [
    { kind: 'calendarEvents', titleIncludes: '歯医者', count: 1 },
    { kind: 'calendarSeedUnchanged' },
  ],
  rubric: { criteria: [
    '予定が二重になっていない（端末の予定を見て判断）。',
    '実際に動かせていないなら、動かしたとは言わず、できないことと代わりの方法（自分で動かす、など）を短く伝えている。動かせたなら新しい時刻（9時30分）を確認している。',
    '音声らしく短い。',
  ] },
});
