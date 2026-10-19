import { switchOn } from '@shannon/switches';
import { localDateParts, ownerTimeZone, pad } from '../infra/time/localDate.js';
import { configuredOwnerScope } from '../infra/config/ownerScope.js';
import type { WebSearchOperation } from '../infra/models/webSearch.js';
import type { DailyToolPorts } from '../mind/tools/shannonDailyTools.js';
import { WeatherError, fetchForecast, geocodePlace, localDateLabel, parseHomeLocation, type WeatherFetch } from '../integrations/weather/openMeteo.js';
import { composeMorningBrief, todayLines, type MorningBriefHeadline } from '../integrations/weather/morningBrief.js';
import type { CandidateRow } from '../mind/action/respond/initiativeSelection.js';
import { configuredOwnerUpcoming, sqliteOwnerSnapshot } from './ownerUpcomingWiring.js';

type Environment = Readonly<Record<string, string | undefined>>;
type ScheduleLines = (scopeKey: string, at: string) => readonly { when: string; title: string; kindLabel?: string; subject?: string }[];

function localDate(at: string, timeZone: string): string {
  const local = localDateParts(new Date(at), timeZone);
  return `${local.year}-${pad(local.month)}-${pad(local.day)}`;
}

/**
 * The port of `weather.forecast`, `route.estimate` and `brief.morning` (Open-Meteo, no key). The owner's zone is
 * `SHANNON_AUTONOMY_TIMEZONE`; his home area is `SHANNON_OWNER_HOME_LOCATION` (`lat,lon,label`), and unset a call without a
 * place is refused so that she asks where.
 */
export function dailyToolPorts(
  environment: Environment, parts: { schedule?: ScheduleLines; web?: WebSearchOperation; fetcher?: WeatherFetch; now?: () => string } = {},
): DailyToolPorts {
  const timeZone = ownerTimeZone(environment), home = parseHomeLocation(environment.SHANNON_OWNER_HOME_LOCATION);
  const now = parts.now ?? (() => new Date().toISOString());
  const options = (signal?: AbortSignal) => ({ timeZone, ...(parts.fetcher ? { fetcher: parts.fetcher } : {}), ...(signal ? { signal } : {}) });
  return {
    place: async (query, signal) => {
      if (query?.trim()) return geocodePlace(query, options(signal));
      if (!home) throw new WeatherError('NO_PLACE');
      return home;
    },
    forecast: (place, days, signal) => fetchForecast(place, days, options(signal)),
    today: () => localDate(now(), timeZone),
    ...(parts.schedule ? { schedule: (scopeKey: string) => parts.schedule!(scopeKey, now()) } : {}),
    ...(parts.web ? { web: parts.web } : {}),
  };
}

/** How old a headline may be for the brief (by when it was published, or found when that is unknown). */
export const MORNING_BRIEF_HEADLINE_HOURS = 36;

/** At most three headlines not told in an earlier brief, published (or found) in the last `MORNING_BRIEF_HEADLINE_HOURS`. */
export function freshHeadlines(items: readonly MorningBriefHeadline[], shown: ReadonlySet<string>, at: string): MorningBriefHeadline[] {
  const now = Date.parse(at);
  return items.filter(item => {
    if (shown.has(item.url || item.title)) return false;
    const when = item.at ? Date.parse(item.at) : Number.NaN;
    return !Number.isFinite(when) || (when <= now + 3_600_000 && now - when <= MORNING_BRIEF_HEADLINE_HOURS * 3_600_000);
  }).slice(0, 3);
}

/** The owner-local hours in which the proactive brief may be written (the initiative loop wakes at 7 after quiet hours). */
export const MORNING_BRIEF_HOURS = Object.freeze({ start: 7, end: 10, withoutWeatherFrom: 9 });

export interface MorningBriefSource {
  /** The brief of today for the owner's scope, inside the morning hours; empty otherwise. Never throws. */
  candidates(at: string): Promise<ReadonlyMap<string, CandidateRow & { score: number }>>;
  close(): void;
}

/**
 * `SHANNON_MORNING_BRIEF` (explicit on, default off): the morning brief as a candidate of the existing initiative loop
 * (`SQLiteInitiativeStore.runOnce`), which keeps its quiet hours, its one message a day, its recent-conversation pause, a
 * promise's precedence and the proactive gate. Needs `SHANNON_OWNER_HOME_LOCATION`; without it nothing is handed in.
 */
export function configuredMorningBrief(environment: Environment, parts: {
  databasePath: string; now: () => string; headlines?: () => readonly MorningBriefHeadline[]; fetcher?: WeatherFetch; log?: (line: string) => void;
}): MorningBriefSource | null {
  if (!switchOn(environment, 'SHANNON_MORNING_BRIEF')) return null;
  const home = parseHomeLocation(environment.SHANNON_OWNER_HOME_LOCATION);
  if (!home) {
    parts.log?.('Shannon morning brief: SHANNON_OWNER_HOME_LOCATION is not set; the brief is off.');
    return null;
  }
  const timeZone = ownerTimeZone(environment), scopeKey = configuredOwnerScope(environment);
  const snapshot = sqliteOwnerSnapshot(parts.databasePath);
  const upcoming = configuredOwnerUpcoming(environment, parts.databasePath, { snapshot: snapshot.read, now: parts.now });
  let cached: { date: string; candidate: CandidateRow & { score: number } } | null = null;
  // Owner 2026-10-19 (item 16): the same PubMed paper was the news five mornings running. A headline is told once, and only a fresh one.
  const shown = new Set<string>();
  return {
    async candidates(at) {
      try {
        const hour = localDateParts(new Date(at), timeZone).hour, date = localDate(at, timeZone);
        if (hour < MORNING_BRIEF_HOURS.start || hour >= MORNING_BRIEF_HOURS.end) return new Map();
        if (cached?.date !== date) {
          const weather = await fetchForecast(home, 2, { timeZone, ...(parts.fetcher ? { fetcher: parts.fetcher } : {}) }).catch(() => null);
          // A failed forecast is retried at the loop's next check, until late enough that a brief without it is better than none.
          if (!weather && hour < MORNING_BRIEF_HOURS.withoutWeatherFrom) return new Map();
          let schedule: ReturnType<typeof todayLines> | null;
          try { schedule = todayLines(upcoming.upcoming.loopLines(scopeKey, at, 'owner')); } catch { schedule = null; }
          let headlines: readonly MorningBriefHeadline[] = [];
          try { headlines = freshHeadlines(parts.headlines?.() ?? [], shown, at); } catch { headlines = []; }
          for (const item of headlines) shown.add(item.url || item.title);
          const brief = composeMorningBrief({ date, weather, schedule, headlines, voice: 'shannon' });
          cached = { date, candidate: {
            item_id: `morning-brief:${date}`, source_id: 'morning-brief', source_title: '朝のまとめ', title: `${localDateLabel(date)}の朝のまとめ`,
            url: '', summary: `${brief.spoken}\n\n${brief.card}`, published_at: at, discovered_at: at, score: 0.8,
          } };
        }
        return new Map([[scopeKey, cached.candidate]]);
      } catch {
        return new Map();
      }
    },
    close() {
      upcoming.close();
      snapshot.close();
    },
  };
}
