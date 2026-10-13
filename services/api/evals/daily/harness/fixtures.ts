import type { WebSearchInput, WebSearchOperation, WebSearchResult } from '../../../src/infra/models/webSearch.js';
import type { WebReadInput, WebReadOperation } from '../../../src/infra/models/webResearch.js';
import type { WeatherFetch } from '../../../src/integrations/weather/openMeteo.js';
import type { VoyagerCatalog, VoyagerOpenTaskList, VoyagerTaskProjection } from '../../../src/integrations/voyager/organize.js';
import type { ForecastDayFixture, InitialState, PlaceFixture } from '../types.js';
import { localInstant, localOf } from './clock.js';
import { DEFAULT_WEATHER, PLACES } from '../tasks/common.js';

/**
 * Recorded providers for the regression set: web search and page reads, the weather/geocoding API, and Voyager's task catalog
 * answer from the task's fixtures, deterministically, and write down what they were asked. Only the model is live.
 */
export interface FixtureLog {
  webQueries: string[];
  webReads: string[];
  geocoded: string[];
  /** The resolved place name of each forecast asked for. */
  forecasts: string[];
  voyagerReads: string[];
}

export function emptyFixtureLog(): FixtureLog {
  return { webQueries: [], webReads: [], geocoded: [], forecasts: [], voyagerReads: [] };
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export function fixtureWeb(initial: InitialState, log: FixtureLog): { search: WebSearchOperation; read: WebReadOperation } {
  const fixtures = initial.web ?? [];
  const answer = async (text: string, signal?: AbortSignal): Promise<WebSearchResult> => {
    const found = fixtures.find(fixture => new RegExp(fixture.match, 'iu').test(text));
    if (!found) return { status: 'empty', text: '検索しましたが、確認できる情報は見つかりませんでした。', sources: [] };
    if (found.delayMs) await sleep(found.delayMs, signal);
    const source = found.sources[0]!;
    return { status: 'results', text: found.text, sources: found.sources.map(item => ({ ...item })),
      passages: [{ url: source.url, title: source.title, quote: found.text.slice(0, 280) }] };
  };
  return {
    search: async (input: WebSearchInput) => { log.webQueries.push(input.query); return answer(input.query, input.signal); },
    read: async (input: WebReadInput) => {
      log.webReads.push(input.url);
      const fixture = fixtures.find(item => item.sources.some(source => source.url === input.url));
      return fixture ? answer(fixture.match, input.signal) : { status: 'unavailable', text: 'このページは読めませんでした。', sources: [] };
    },
  };
}

function placeFor(name: string, places: readonly PlaceFixture[]): PlaceFixture | null {
  const trimmed = name.trim();
  return places.find(place => place.name === trimmed) ?? places.find(place => trimmed.includes(place.name) && place.name.length >= 2) ?? null;
}

function forecastDays(placeName: string, initial: InitialState): readonly ForecastDayFixture[] {
  const forecasts = (initial.weather ?? DEFAULT_WEATHER).forecasts;
  const key = Object.keys(forecasts).find(name => name !== '*' && (placeName.includes(name) || name.includes(placeName)));
  return forecasts[key ?? '*'] ?? forecasts['*'] ?? [];
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** A fake of the two Open-Meteo endpoints the weather code reads (`openMeteo.ts`), in its own JSON shape. */
export function fixtureWeather(initial: InitialState, log: FixtureLog): WeatherFetch {
  const places = initial.places ?? PLACES;
  const timeZone = initial.timeZone ?? 'Asia/Tokyo';
  return async (url: string) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'geocoding-api.open-meteo.com') {
      const name = parsed.searchParams.get('name') ?? '';
      log.geocoded.push(name);
      const found = placeFor(name, places);
      return json(found ? { results: [{ name: found.name, latitude: found.latitude, longitude: found.longitude, feature_code: 'PPLA',
        population: 100_000, country_code: 'JP', ...(found.admin ? { admin1: found.admin } : {}) }] } : {});
    }
    if (parsed.hostname === 'api.open-meteo.com') {
      const latitude = Number(parsed.searchParams.get('latitude')), longitude = Number(parsed.searchParams.get('longitude'));
      const place = places.find(item => Math.abs(item.latitude - latitude) < 0.01 && Math.abs(item.longitude - longitude) < 0.01)
        ?? (Math.abs(initial.home.latitude - latitude) < 0.01 && Math.abs(initial.home.longitude - longitude) < 0.01
          ? { name: initial.home.label } : { name: `${latitude},${longitude}` });
      log.forecasts.push(place.name);
      const days = forecastDays(place.name, initial);
      const nowLocal = localOf(Date.now(), timeZone);
      const today = localInstant(nowLocal.slice(0, 10), timeZone);
      const dayKeys = days.map(day => localOf(today + day.offset * 86_400_000, timeZone).slice(0, 10));
      const hours = Array.from({ length: 48 }, (_, index) => localOf(today + index * 3_600_000, timeZone));
      const dayOf = (hour: string) => days[dayKeys.indexOf(hour.slice(0, 10))] ?? days[0]!;
      const current = dayOf(nowLocal);
      return json({
        current: { time: nowLocal, temperature_2m: (current.max + current.min) / 2, apparent_temperature: (current.max + current.min) / 2 - 1,
          relative_humidity_2m: 60, weather_code: current.code, wind_speed_10m: 3 },
        hourly: { time: hours, temperature_2m: hours.map(hour => dayOf(hour).min + 4), precipitation_probability: hours.map(hour => dayOf(hour).precipitationProbability),
          weather_code: hours.map(hour => dayOf(hour).code) },
        daily: { time: dayKeys, weather_code: days.map(day => day.code), temperature_2m_max: days.map(day => day.max),
          temperature_2m_min: days.map(day => day.min), precipitation_probability_max: days.map(day => day.precipitationProbability) },
      });
    }
    return new Response('not found', { status: 404 });
  };
}

/** Voyager's catalog over the task's synthetic tasks (search, open tasks, projects and the dated read). */
export function fixtureVoyager(initial: InitialState, log: FixtureLog): VoyagerCatalog {
  const timeZone = initial.timeZone ?? 'Asia/Tokyo';
  const tasks = (initial.voyagerTasks ?? []).map(task => ({
    id: task.id, title: task.title, details: `プロジェクト: ${task.project}`, status: task.status ?? 'open', projectIds: [`project-${task.project.toLowerCase()}`],
    revision: 1, updatedAt: new Date(localInstant(initial.clock, timeZone) - 86_400_000).toISOString(),
    dueAt: task.dueLocal ? new Date(localInstant(task.dueLocal, timeZone)).toISOString() : null, priority: 2,
  }));
  return {
    async listOpenTasks(limit: number): Promise<VoyagerOpenTaskList> {
      log.voyagerReads.push('open'); return { items: tasks.slice(0, limit), hasMore: tasks.length > limit };
    },
    async searchTasks(query: string, limit: number): Promise<VoyagerTaskProjection[]> {
      log.voyagerReads.push(`search:${query}`);
      const words = query.split(/[\s、。「」]+/u).filter(word => word.length >= 2);
      const hits = tasks.filter(task => !words.length || words.some(word => `${task.title}${task.details}`.toLowerCase().includes(word.toLowerCase())));
      return (hits.length ? hits : tasks).slice(0, limit);
    },
    async listProjects(limit: number) {
      return [...new Set((initial.voyagerTasks ?? []).map(task => task.project))].slice(0, limit)
        .map(project => ({ id: `project-${project.toLowerCase()}`, title: project, revision: 1, updatedAt: tasks[0]?.updatedAt ?? new Date().toISOString() }));
    },
    async upcomingTasks(from: string, until: string, limit: number) {
      log.voyagerReads.push('upcoming');
      return tasks.filter(task => task.dueAt && task.dueAt >= from && task.dueAt < until).slice(0, limit)
        .map(task => ({ id: task.id, title: task.title, dueAt: task.dueAt! }));
    },
  };
}
