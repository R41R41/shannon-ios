import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createInMemoryAutonomyService } from '../src/wiring/autonomyServiceWiring.js';
import { configuredMorningBrief, dailyToolPorts } from '../src/wiring/dailyReadWiring.js';
import { toolSessionMemory } from '../src/mind/tools/shannonToolTypes.js';
import { composeMorningBrief } from '../src/integrations/weather/morningBrief.js';
import { SQLiteInitiativeStore } from '../src/surfaces/outreach/store/initiativeStore.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';

/** Weather, the route estimate and the morning brief, over a fake Open-Meteo (no network). */
const at = '2026-10-13T00:30:00.000Z'; // 09:30 in Tokyo
const HOME = { SHANNON_OWNER_HOME_LOCATION: '33.5902,130.4017,福岡市' };
const asked: string[] = [];
const hours = Array.from({ length: 48 }, (_, index) => `2026-10-${13 + Math.floor(index / 24)}T${String(index % 24).padStart(2, '0')}:00`);
const forecastBody = {
  current: { time: '2026-10-13T09:30', temperature_2m: 21.4, apparent_temperature: 20.9, relative_humidity_2m: 60, weather_code: 1, wind_speed_10m: 8 },
  hourly: { time: hours, temperature_2m: hours.map(() => 20), precipitation_probability: hours.map(() => 10), weather_code: hours.map(() => 61) },
  daily: { time: ['2026-10-13', '2026-10-14'], weather_code: [61, 0], temperature_2m_max: [24.2, 25], temperature_2m_min: [17.1, 16], precipitation_probability_max: [70, 0] },
};
const geocode: Record<string, unknown[]> = {
  福岡: [{ name: '福岡', latitude: 35.87, longitude: 139.54, feature_code: 'PPL', country_code: 'JP', admin1: '埼玉県' }],
  福岡市: [{ name: '福岡市', latitude: 33.6, longitude: 130.41667, feature_code: 'PPLA', population: 1612392, country_code: 'JP', admin1: '福岡県' }],
};
const fetcher = async (url: string) => {
  asked.push(url);
  const parsed = new URL(url);
  const body = parsed.hostname.startsWith('geocoding') ? { results: geocode[parsed.searchParams.get('name') ?? ''] ?? undefined } : forecastBody;
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};
const context = { scopeKey: 'owner', surface: 'text' as const, audience: 'owner_alone' as const, memory: toolSessionMemory() };

function runner(environment: Record<string, string> = HOME, schedule?: NonNullable<Parameters<typeof dailyToolPorts>[1]>['schedule']) {
  const autonomy = createInMemoryAutonomyService(() => at);
  autonomy.tools.useReads({ daily: dailyToolPorts(environment, { fetcher, now: () => at, ...(schedule ? { schedule } : {}) }) });
  return autonomy;
}

const directories: string[] = [];
afterEach(() => { asked.splice(0); directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })); });

describe('her everyday reads', () => {
  it('exist only with their port, for the owner alone in text and voice, never with others or in her own time', () => {
    expect(createInMemoryAutonomyService(() => at).tools.offered('text', 'owner_alone', 'owner').some(tool => tool.domain === 'daily_read')).toBe(false);
    const tools = runner().tools;
    expect(tools.offered('text', 'owner_alone', 'owner').filter(tool => tool.domain === 'daily_read').map(tool => tool.name)).toEqual(['weather.forecast', 'route.estimate', 'brief.morning']);
    expect(tools.offered('voice', 'owner_alone', 'owner').filter(tool => tool.domain === 'daily_read')).toHaveLength(3);
    expect(tools.offered('text', 'others', 'owner').some(tool => tool.domain === 'daily_read')).toBe(false);
    expect(tools.offered('autonomy', 'owner_alone', 'owner').some(tool => tool.domain === 'daily_read')).toBe(false);
  });

  it('reads the forecast at home in the owner\'s zone, labels it in Japanese, and records the call without the place', async () => {
    const autonomy = runner();
    const home = await autonomy.tools.call('weather.forecast', JSON.stringify({ hours: 6, days: 2 }), context);
    expect(home.ok).toBe(true);
    expect(home.text).toContain('福岡市');
    expect(home.text).toContain('いま（10月13日(火) 09:30）: 晴れ 21℃');
    expect(home.text).toContain('- 今日 10月13日(火): 弱い雨 17〜24℃ 降水確率70%');
    expect(asked[0]).toContain('timezone=Asia%2FTokyo');
    // A bare 福岡 is a village in Saitama to the geocoder; the city wins.
    const named = await autonomy.tools.call('weather.forecast', JSON.stringify({ place: '福岡' }), context);
    expect(named.text).toContain('福岡市（福岡県）');
    const entries = autonomy.activityDays('owner', 30).flatMap(day => day.entries);
    expect(entries.map(entry => entry.tool)).toContain('weather.forecast');
    expect(JSON.stringify(entries)).not.toContain('福岡');
  });

  it('asks for a place when no home is configured, and refuses a secret place', async () => {
    const result = await runner({}).tools.call('weather.forecast', '{}', context);
    expect(result).toMatchObject({ ok: false, failure: 'invalid_input' });
    const secret = await runner().tools.call('weather.forecast', JSON.stringify({ place: '秘密の別荘' }), { ...context, secrets: { carries: (text: string) => text.includes('秘密') } as never });
    expect(secret).toMatchObject({ ok: false, failure: 'refused' });
    expect(asked).toEqual([]);
  });

  it('estimates a route honestly, as 目安 with an Apple Maps link', async () => {
    const result = await runner().tools.call('route.estimate', JSON.stringify({ to: '33.5897,130.4207', mode: 'walking' }), context);
    expect(result.ok).toBe(true);
    expect(result.text).toMatch(/直線距離: 1\.\dkm/u);
    expect(result.text).toMatch(/徒歩: 約\d+分/u);
    expect(result.text).toContain('https://maps.apple.com/?saddr=33.59020%2C130.40170&daddr=33.58970%2C130.42070&dirflg=w');
    expect(result.text).toContain('目安');
  });

  it('composes the morning brief: two spoken sentences, a card, and today\'s schedule only', async () => {
    const schedule = () => [
      { kindLabel: '予定', when: '今日 10:00〜11:00', title: '歯医者', subject: 'calendar:e1@2026-10-13T01:00:00.000Z' },
      { kindLabel: '予定', when: '明日 9:00', title: '出張' },
    ];
    const result = await runner(HOME, schedule).tools.call('brief.morning', '{}', context);
    expect(result.ok).toBe(true);
    expect(result.text).toContain('声で言う2文（声ではこれだけを自然に言う）: おはようございます、今日の福岡市は弱い雨で最高24度、降水確率は70%なので傘があると安心です。今日の予定は1件で、最初は10:00〜11:00の「歯医者」です。');
    expect(result.text).toContain('### 10月13日(火) 朝のまとめ');
    expect(result.text).not.toContain('出張');
    const spoken = composeMorningBrief({ date: '2026-10-13', weather: null, schedule: [] }).spoken;
    expect(spoken.split('。').filter(Boolean).length).toBeLessThanOrEqual(2);
  });
});

describe('the proactive morning brief (SHANNON_MORNING_BRIEF)', () => {
  it('is off by default and without a home, and once on is the day\'s one initiative in the morning', async () => {
    const path = databasePath();
    expect(configuredMorningBrief({}, { databasePath: path, now: () => at })).toBeNull();
    expect(configuredMorningBrief({ SHANNON_MORNING_BRIEF: 'on' }, { databasePath: path, now: () => at })).toBeNull();
    const state = new SQLiteShannonStore({ path, now: () => at });
    state.snapshot('owner');
    state.createThread('owner', 'いつものトーク');
    const brief = configuredMorningBrief({ ...HOME, SHANNON_MORNING_BRIEF: 'on' }, { databasePath: path, now: () => at, fetcher, headlines: () => [{ title: '見出し', url: 'https://example.com/a' }] })!;
    expect((await brief.candidates('2026-10-12T14:00:00.000Z')).size).toBe(0); // 23:00 in Tokyo
    const candidates = await brief.candidates(at);
    const initiatives = new SQLiteInitiativeStore(path, () => at);
    expect(initiatives.runOnce(at, 'Asia/Tokyo', new Map(), candidates)).toMatchObject({ sent: 1 });
    const [message] = initiatives.unreadMessages('owner');
    expect(message).toMatchObject({ sourceTitle: '朝のまとめ', content: expect.stringContaining('おはようございます、今日の福岡市は') });
    expect(message!.content).toContain('[見出し](https://example.com/a)');
    expect(initiatives.runOnce(at, 'Asia/Tokyo', new Map(), candidates)).toMatchObject({ sent: 0, stopped: 'today-is-enough' });
    initiatives.close(); brief.close(); state.close();
  });
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-daily-'));
  directories.push(directory);
  return join(directory, 'shannon.sqlite');
}
