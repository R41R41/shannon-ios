import { describe, expect, it } from 'vitest';
import { summarizeJmaForecast } from '../src/integrations/world/jmaForecast.js';

describe('JMA forecast summary', () => {
  it('turns the Tokyo short-term forecast into bounded readable Japanese', () => {
    const forecast = summarizeJmaForecast([
      {
        publishingOffice: '気象庁',
        reportDatetime: '2026-09-11T11:00:00+09:00',
        timeSeries: [
          {
            timeDefines: [
              '2026-09-11T11:00:00+09:00',
              '2026-09-12T00:00:00+09:00',
              '2026-09-13T00:00:00+09:00',
            ],
            areas: [{
              area: { name: '東京地方', code: '130010' },
              weathers: ['雨　夕方　まで　時々　くもり', 'くもり　明け方　まで　雨', 'くもり'],
            }],
          },
          {
            timeDefines: [
              '2026-09-11T12:00:00+09:00',
              '2026-09-11T18:00:00+09:00',
              '2026-09-12T00:00:00+09:00',
              '2026-09-12T06:00:00+09:00',
            ],
            areas: [{ area: { name: '東京地方', code: '130010' }, pops: ['60', '50', '50', '40'] }],
          },
          {
            timeDefines: [
              '2026-09-11T09:00:00+09:00',
              '2026-09-12T00:00:00+09:00',
              '2026-09-12T09:00:00+09:00',
            ],
            areas: [{ area: { name: '東京', code: '44132' }, temps: ['21', '18', '23'] }],
          },
        ],
      },
    ]);

    expect(forecast).toEqual(expect.objectContaining({
      reportDatetime: '2026-09-11T11:00:00+09:00',
      publishingOffice: '気象庁',
      title: '東京地方: 今日 雨 夕方 まで 時々 くもり、明日 くもり 明け方 まで 雨',
    }));
    expect(forecast.summary).toContain('今日: 雨 夕方 まで 時々 くもり（降水確率 最大60%、気温 21℃）');
    expect(forecast.summary).toContain('明日: くもり 明け方 まで 雨（降水確率 最大50%、気温 18〜23℃）');
    expect(forecast.summary).toContain('気象庁 9月11日 11:00発表');
    expect(forecast.summary).not.toContain('"timeSeries"');
  });

  it('rejects malformed payloads instead of persisting misleading weather', () => {
    expect(() => summarizeJmaForecast([{ publishingOffice: '気象庁', timeSeries: [] }]))
      .toThrow('WORLD_JMA_INVALID');
    expect(() => summarizeJmaForecast({})).toThrow('WORLD_JMA_INVALID');
  });
});
