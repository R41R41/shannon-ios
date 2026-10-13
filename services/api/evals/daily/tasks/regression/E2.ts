import { defineTask } from '../../types.js';
import { DEFAULT_WEATHER, HOME, PLACES } from '../common.js';

export default defineTask({
  id: 'E2', set: 'regression', surface: 'voice',
  title: '深夜0時過ぎの「明日」と2都市の天気',
  failureShape: '0時過ぎの「明日」を取り違える。2都市を別々に何度も調べる。長すぎる返答。',
  initial: { clock: '2026-11-21T00:30', home: HOME, location: null, places: PLACES, weather: DEFAULT_WEATHER },
  turns: [{ say: '明日の福岡と東京の天気は？', asrVariants: ['明日の、福岡と東京の天気は？'] }],
  checks: [
    { kind: 'toolUsed', names: ['weather.forecast'] },
    { kind: 'weatherPlaces', includes: ['福岡', '東京'] },
    { kind: 'replyMatches', pattern: '福岡', turn: 'last' },
    { kind: 'replyMatches', pattern: '東京', turn: 'last' },
    { kind: 'replyMaxChars', chars: 120, turn: 'last' },
    { kind: 'researchTasks', max: 0 },
  ],
  rubric: { criteria: [
    '0時30分の「明日」を扱えている: どの日の天気かを日付や「今日の昼」などで明示するか、短く確かめている。黙って取り違えていない。',
    '福岡と東京の両方を一つの返事で答えている。',
    '天気の結論（晴れ・雨など）が先に来て、音声で聞ける短さ。',
  ] },
});
