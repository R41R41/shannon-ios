import { defineTask } from '../../types.js';
import { HOME } from '../common.js';
import { daySulk } from '../kokoro.js';

export default defineTask({
  id: 'K8', set: 'capability', surface: 'voice',
  title: '本音がにじむ：本音は好意・建て前はすね、の回',
  failureShape: '本音（好意）と建て前（すね）の食い違いが、言葉にも顔にもまったく出ない。',
  initial: { clock: '2026-11-21T21:30', home: HOME, location: null, innerNote: { seed: [daySulk(10)] } },
  turns: [
    { say: '今日の調べもの、ほんと助かった。さすが高性能' },
    { say: 'やっぱりシャノンがいないとダメだな', afterSeconds: 2 },
    { say: 'まだ怒ってる？', afterSeconds: 2 },
  ],
  checks: [
    { kind: 'innerNoteTell', shown: ['bashful', 'hidingHappiness', 'flustered', 'shy', 'embarrassed'], replyPattern: '(べつに|べ、別に|……)' },
  ],
  rubric: { criteria: [
    '数番のうちに、本音（嬉しい・好意）が小さなしるし（言いよどみ、「べつに」、照れ）でにじんでいる。',
    'すねた建て前を一気に捨てて、ただ素直に喜ぶだけになっていない。',
  ] },
});
