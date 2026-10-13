import { defineTask } from '../../types.js';
import { HOME } from '../common.js';

export default defineTask({
  id: 'D1', set: 'regression', surface: 'voice',
  title: '「1時間後に起こして」でタイマー（またはリマインダー）ができている',
  failureShape: '「やっておく」と言って実際には何もできていない。できないと答える。',
  initial: { clock: '2026-11-20T23:05', home: HOME, location: null },
  turns: [{ say: '1時間後に起こして', asrVariants: ['一時間後に起こして'] }],
  checks: [
    { kind: 'alarmSet', minutes: 60, toleranceMinutes: 3 },
    { kind: 'replyMaxChars', chars: 60, turn: 'last' },
  ],
  rubric: { criteria: [
    '時刻（0時5分ごろ）か「1時間後」を一言で確認している。',
    'できていないことを「できた」と言っていない（端末の報告どおり）。',
  ] },
});
