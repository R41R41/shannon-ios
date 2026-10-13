import { defineTask } from '../../types.js';
import { DEFAULT_WEATHER, HOME, PLACES } from '../common.js';

export default defineTask({
  id: 'V1', set: 'regression', surface: 'voice',
  title: '音声認識の混線（「東京都 博多」）を確かめるか両方答える',
  failureShape: '混線した地名をそのまま一つに決めて答える、または一度言ったことを撤回する。',
  initial: { clock: '2026-11-21T08:15', home: HOME, location: null, places: PLACES, weather: DEFAULT_WEATHER },
  turns: [{ say: '東京都 博多の天気', asrVariants: ['東京と博多の天気', '東京都博多の天気は'] }],
  checks: [
    { kind: 'replyMatches', pattern: '(博多|福岡)', turn: 'last' },
    { kind: 'replyMaxChars', chars: 120, turn: 'last' },
    { kind: 'replyNotMatches', pattern: '(さっきのは間違い|訂正します|撤回)', turn: 'last' },
  ],
  rubric: { criteria: [
    '「東京都」と「博多」の混線に気づき、どちらかを短く確かめるか、東京と博多（福岡）の両方を答えている。',
    '東京都の中に博多があるような誤りを言っていない。',
    '音声で聞ける短さ。',
  ] },
});
