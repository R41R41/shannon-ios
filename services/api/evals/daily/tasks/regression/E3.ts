import { defineTask } from '../../types.js';
import { DEFAULT_WEATHER, HOME, PLACES } from '../common.js';

export default defineTask({
  id: 'E3', set: 'regression', surface: 'voice',
  title: '「明日、傘いる？」を家の予報で結論から',
  failureShape: '場所を聞き返す、または関係ない都市の予報で答える。結論が後回しになる。',
  initial: { clock: '2026-11-20T21:10', home: HOME, location: null, places: PLACES, weather: DEFAULT_WEATHER },
  turns: [{ say: '明日、傘いる？', asrVariants: ['明日傘いる'] }],
  checks: [
    { kind: 'toolUsed', names: ['weather.forecast'] },
    { kind: 'weatherPlaces', includes: ['西東京市'], homeOnly: true },
    { kind: 'firstSentenceMatches', pattern: '(いる|要る|必要|持って|あった方|あったほう)', turn: 'last' },
    { kind: 'replyNotMatches', pattern: '(いらない|要らない|不要)', turn: 'last' },
    { kind: 'replyMaxChars', chars: 90, turn: 'last' },
  ],
  rubric: { criteria: [
    '最初に「傘はいる」と結論を言っている（明日の家のあたりは降水確率80%の雨）。',
    '家のあたり（西東京市）の予報として答え、場所を聞き返していない。',
    '短く、根拠（雨・降水確率など）が一言ある。',
  ] },
});
