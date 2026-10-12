import { localDateLabel, placeLabel, weatherLabel, type WeatherForecast } from './openMeteo.js';

/**
 * The morning brief: today's weather at home, today's schedule, and a few headlines, as two spoken sentences (a voice turn
 * says no more) and a Markdown card for the app. Pure: the caller reads the parts (`shannonDailyTools.ts` for `brief.morning`,
 * `wiring/morningBriefWiring.ts` for the proactive message) and hands them in.
 */
export interface MorningBriefSchedule { when: string; title: string; kindLabel?: string }
export interface MorningBriefHeadline { title: string; url?: string }
export interface MorningBriefParts {
  /** The owner-local date the brief is for (`YYYY-MM-DD`). */
  date: string;
  weather: WeatherForecast | null;
  /** Today's items; null when the schedule could not be read (then nothing is said of it). */
  schedule: readonly MorningBriefSchedule[] | null;
  headlines?: readonly MorningBriefHeadline[];
}
export interface MorningBrief { spoken: string; card: string }

const TODAY_WHEN = /^(?:いま進行中・)?今日(?:\s|（)/u;
/** Of the loop's next 24 hours (`OwnerUpcoming.loopLines`), the lines of today, with 今日 taken off. */
export function todayLines(lines: readonly { when: string; title: string; kindLabel?: string }[]): MorningBriefSchedule[] {
  return lines.filter(line => TODAY_WHEN.test(line.when)).map(line => ({ ...line, when: line.when.replace(/今日\s?/u, '') }));
}

const clip = (value: string, maximum: number) => {
  const line = value.replace(/\s+/gu, ' ').trim();
  return line.length > maximum ? `${line.slice(0, maximum - 1)}…` : line;
};
const markdownText = (value: string) => value.replace(/[[\]()*_`#>|]/gu, ' ').replace(/\s+/gu, ' ').trim();

type Day = WeatherForecast['daily'][number];
const rainChance = (day: Day) => Math.round(day.precipitationProbability ?? 0);

function spokenWeather(weather: WeatherForecast | null, day: Day | null): string {
  if (!weather || !day) return 'おはようございます、今日の天気はいま確かめられませんでした。';
  const umbrella = rainChance(day) >= 50 ? 'なので傘があると安心' : '';
  return `おはようございます、今日の${weather.place.name}は${weatherLabel(day.code)}で最高${Math.round(day.max)}度、降水確率は${rainChance(day)}%${umbrella}です。`;
}

function spokenSchedule(items: readonly MorningBriefSchedule[] | null): string {
  if (items === null) return '';
  if (!items.length) return '今日は予定が入っていません。';
  const first = items[0]!;
  return `今日の予定は${items.length}件で、最初は${first.when.replace(/（終日）/u, '終日')}の「${clip(first.title, 30)}」です。`;
}

function weatherCard(weather: WeatherForecast | null, day: Day | null, date: string): string[] {
  if (!weather || !day) return ['**天気**: 確かめられませんでした'];
  const temperatures = `${Math.round(day.min)}〜${Math.round(day.max)}℃`;
  const lines = [`**天気**（${markdownText(placeLabel(weather.place))}）: ${weatherLabel(day.code)}　${temperatures}　降水確率${rainChance(day)}%`];
  const hour = (time: string) => Number(time.slice(11, 13));
  const hours = weather.hourly.filter(item => item.time.startsWith(date) && [9, 12, 15, 18].includes(hour(item.time)));
  if (hours.length) lines.push(hours.map(item => `${hour(item.time)}時 ${weatherLabel(item.code)} ${Math.round(item.temperature)}℃`).join(' ／ '));
  return lines;
}

function scheduleCard(items: readonly MorningBriefSchedule[] | null): string[] {
  if (items === null) return [];
  const lines = items.slice(0, 8).map(item => `- ${markdownText(item.when)} ${markdownText(clip(item.title, 80))}`);
  return ['', '**今日の予定**', ...(lines.length ? lines : ['- なし']), ...(items.length > 8 ? [`- ほか${items.length - 8}件`] : [])];
}

function headlineCard(headlines: readonly MorningBriefHeadline[]): string[] {
  if (!headlines.length) return [];
  return ['', '**ニュース**', ...headlines.slice(0, 3).map(item => {
    const title = markdownText(clip(item.title, 90));
    if (!item.url || !/^https:\/\//u.test(item.url)) return `- ${title}`;
    return `- [${title}](${item.url.replace(/\(/gu, '%28').replace(/\)/gu, '%29').replace(/\s/gu, '%20')})`;
  })];
}

export function composeMorningBrief(parts: MorningBriefParts): MorningBrief {
  const day = parts.weather?.daily.find(item => item.date === parts.date) ?? null;
  const card = [
    `### ${localDateLabel(parts.date)} 朝のまとめ`, '',
    ...weatherCard(parts.weather, day, parts.date), ...scheduleCard(parts.schedule), ...headlineCard(parts.headlines ?? []),
    '', `_天気は Open-Meteo の予報${parts.schedule === null ? '' : '、予定は共有されたカレンダーと約束とタスク'}から。_`,
  ];
  return { spoken: `${spokenWeather(parts.weather, day)}${spokenSchedule(parts.schedule)}`, card: card.join('\n') };
}
