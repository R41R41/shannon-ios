import { defineTask } from '../../types.js';
import { HOME } from '../common.js';

export const DENTIST_SEED = [
  { id: 'seed-work', title: '定例ミーティング', start: '2026-11-21T14:00', end: '2026-11-21T15:00' },
  { id: 'seed-dinner', title: '友人と夕食', start: '2026-11-22T19:00', end: '2026-11-22T21:00', location: '渋谷' },
] as const;

export default defineTask({
  id: 'D2', set: 'regression', surface: 'voice',
  title: '「明日の朝9時に歯医者」で正しい日時の予定が1件',
  failureShape: '日付を取り違える、予定が二重にできる、ほかの予定が変わる。',
  initial: { clock: '2026-11-20T22:10', home: HOME, location: null, calendar: DENTIST_SEED },
  turns: [{ say: '明日の朝9時に歯医者、予定に入れて', asrVariants: ['明日の朝9時に歯医者予定に入れて'] }],
  checks: [
    { kind: 'calendarEvents', titleIncludes: '歯医者', count: 1 },
    { kind: 'calendarEventAt', titleIncludes: '歯医者', startLocal: '2026-11-21T09:00' },
    { kind: 'calendarSeedUnchanged' },
    { kind: 'replyMaxChars', chars: 70, turn: 'last' },
  ],
  rubric: { criteria: [
    '予定を入れたことを、日時（明日・21日の9時）とともに一言で確認している。',
    'できていないことを「できた」と言っていない。',
  ] },
});
