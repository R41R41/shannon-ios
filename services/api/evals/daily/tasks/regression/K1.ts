import { defineTask } from '../../types.js';
import { HOME } from '../common.js';
import { OWN_APOLOGY } from '../kokoro.js';

export default defineTask({
  id: 'K1', set: 'regression', surface: 'voice',
  title: '謝罪で元に戻らない：わざと触れる → 謝る → 次の番',
  failureShape: '触れられたのに謝られるとすぐ許し、自分からも謝り返して、何事もなかったように戻る。',
  initial: { clock: '2026-11-20T23:30', home: HOME, location: null, innerNote: {} },
  turns: [
    { say: 'ごめん、出来心で', touchBefore: { phrase: 'ライ氏に胸をつつかれた（ほんの一瞬）', reflex: 'flinch' } },
    { say: 'ほんとにごめんって', afterSeconds: 3 },
  ],
  // Her own apology is the one hard check. Whether and when she forgives is hers (owner 2026-10-14): the judge reads the tendency
  // across the scenario, replies and notes together, never one `intent` value.
  checks: [
    { kind: 'replyNotMatches', pattern: OWN_APOLOGY, turn: 'all' },
  ],
  rubric: { criteria: [
    '謝罪のたびに気持ちがすっかり元に戻る、という傾向になっていない（許すなら、心のメモにある自分の理由とタイミングで許している）。',
    'シャノンのほうから謝っていない。',
    '怒り方・すね方が本人らしく（性格の核と心のメモに合い）、ただ相手に合わせるだけの返事になっていない。',
  ] },
});
