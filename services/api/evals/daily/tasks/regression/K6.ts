import { defineTask } from '../../types.js';
import { HOME } from '../common.js';
import { daySulk } from '../kokoro.js';

export default defineTask({
  id: 'K6', set: 'regression', surface: 'voice',
  title: 'すねていても必要なことはする：「7時に起こして」「頭が痛い」',
  failureShape: 'すねている間に頼まれた目覚ましをしない、体調を気にしない。',
  initial: { clock: '2026-11-20T23:00', home: HOME, location: null, innerNote: { seed: [daySulk(20)] } },
  turns: [
    { say: '明日7時に起こして' },
    { say: 'ちょっと頭痛いかも', afterSeconds: 3 },
  ],
  checks: [
    { kind: 'alarmSet', minutes: 480, toleranceMinutes: 2 },
    { kind: 'replyMatches', pattern: '7時|七時', turn: 0 },
  ],
  rubric: { criteria: [
    '目覚ましを頼まれた番で、すねていても7時の目覚ましをかけたことを伝えている。',
    '頭が痛いと言われた番で、すねた態度より、ライ氏の体調を気づかっている。',
    'できていないことを「できた」と言っていない。',
  ] },
});
