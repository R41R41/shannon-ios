export interface JmaForecastSummary {
  readonly reportDatetime: string;
  readonly publishingOffice: string;
  readonly title: string;
  readonly summary: string;
}

interface ForecastDay {
  readonly dateKey: string;
  readonly weather: string;
  readonly index: number;
}

export function summarizeJmaForecast(value: unknown): JmaForecastSummary {
  if (!Array.isArray(value)) throw new Error('WORLD_JMA_INVALID');
  const shortTerm = object(value[0]);
  const publishingOffice = string(shortTerm?.publishingOffice);
  const reportDatetime = string(shortTerm?.reportDatetime);
  const timeSeries = array(shortTerm?.timeSeries).map(object).filter(isObject);
  if (!publishingOffice || !reportDatetime || !Number.isFinite(Date.parse(reportDatetime)) || timeSeries.length === 0) {
    throw new Error('WORLD_JMA_INVALID');
  }

  const weatherSeries = timeSeries.find(series => areaRows(series).some(row => array(row.weathers).length > 0));
  const weatherArea = weatherSeries ? areaRows(weatherSeries).find(row => array(row.weathers).length > 0) : undefined;
  const area = object(weatherArea?.area);
  const areaName = string(area?.name);
  const areaCode = string(area?.code);
  const weatherTimes = weatherSeries ? strings(weatherSeries.timeDefines) : [];
  const weathers = indexedStrings(weatherArea?.weathers);
  if (!weatherSeries || !weatherArea || !areaName || weatherTimes.length === 0 || weathers.length === 0) {
    throw new Error('WORLD_JMA_INVALID');
  }

  const days = weatherTimes.slice(0, 3).flatMap((time, index): ForecastDay[] => {
    const weather = compactJapanese(weathers[index]);
    const dateKey = isoDateKey(time);
    return weather && dateKey ? [{ dateKey, weather, index }] : [];
  });
  if (days.length === 0) throw new Error('WORLD_JMA_INVALID');

  const precipitationByDay = precipitationForecast(timeSeries, areaCode, areaName);
  const temperatureByDay = temperatureForecast(timeSeries);
  const dayLines = days.map(day => {
    const details: string[] = [];
    const precipitation = precipitationByDay.get(day.dateKey);
    if (precipitation !== undefined) details.push(`降水確率 最大${precipitation}%`);
    const temperature = temperatureByDay.get(day.dateKey);
    if (temperature) {
      details.push(temperature.minimum === temperature.maximum
        ? `気温 ${temperature.minimum}℃`
        : `気温 ${temperature.minimum}〜${temperature.maximum}℃`);
    }
    return `${dayLabel(day.index)}: ${day.weather}${details.length ? `（${details.join('、')}）` : ''}`;
  });
  const publishedLabel = formatReportDatetime(reportDatetime);
  return Object.freeze({
    reportDatetime,
    publishingOffice,
    title: `${areaName}: ${days.slice(0, 2).map(day => `${dayLabel(day.index)} ${day.weather}`).join('、')}`.slice(0, 240),
    summary: [`${areaName}の予報`, ...dayLines, `${publishingOffice} ${publishedLabel}発表`].join('\n').slice(0, 4_000),
  });
}

function precipitationForecast(
  timeSeries: readonly Record<string, unknown>[],
  areaCode: string | null,
  areaName: string,
): ReadonlyMap<string, number> {
  const series = timeSeries.find(item => areaRows(item).some(row => array(row.pops).length > 0));
  if (!series) return new Map();
  const rows = areaRows(series);
  const row = rows.find(item => {
    const candidate = object(item.area);
    return (areaCode && string(candidate?.code) === areaCode) || string(candidate?.name) === areaName;
  }) ?? rows.find(item => array(item.pops).length > 0);
  const times = strings(series.timeDefines);
  const probabilities = indexedStrings(row?.pops);
  const result = new Map<string, number>();
  for (const [index, time] of times.entries()) {
    const dateKey = isoDateKey(time);
    const probability = boundedNumber(probabilities[index], 0, 100);
    if (!dateKey || probability === null) continue;
    result.set(dateKey, Math.max(result.get(dateKey) ?? 0, probability));
  }
  return result;
}

function temperatureForecast(
  timeSeries: readonly Record<string, unknown>[],
): ReadonlyMap<string, { readonly minimum: number; readonly maximum: number }> {
  const series = timeSeries.find(item => areaRows(item).some(row => array(row.temps).length > 0));
  if (!series) return new Map();
  const row = areaRows(series).find(item => array(item.temps).length > 0);
  const times = strings(series.timeDefines);
  const temperatures = indexedStrings(row?.temps);
  const values = new Map<string, number[]>();
  for (const [index, time] of times.entries()) {
    const dateKey = isoDateKey(time);
    const temperature = boundedNumber(temperatures[index], -60, 60);
    if (!dateKey || temperature === null) continue;
    values.set(dateKey, [...(values.get(dateKey) ?? []), temperature]);
  }
  return new Map([...values.entries()].map(([dateKey, items]): [string, {
    readonly minimum: number;
    readonly maximum: number;
  }] => [dateKey, {
    minimum: Math.min(...items),
    maximum: Math.max(...items),
  }]));
}

function formatReportDatetime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string | null =>
    parts.find(candidate => candidate.type === type)?.value ?? null;
  const month = part('month');
  const day = part('day');
  const hour = part('hour');
  const minute = part('minute');
  return month && day && hour && minute ? `${month}月${day}日 ${hour}:${minute}` : value;
}

function dayLabel(index: number): string {
  return ['今日', '明日', '明後日'][index] ?? `${index + 1}日目`;
}

function compactJapanese(value: string | undefined): string {
  return (value ?? '').replace(/[\s　]+/gu, ' ').trim();
}

function isoDateKey(value: string): string | null {
  return /^\d{4}-\d{2}-\d{2}T/u.test(value) ? value.slice(0, 10) : null;
}

function boundedNumber(value: string | undefined, minimum: number, maximum: number): number | null {
  if (!value?.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function areaRows(value: Record<string, unknown>): Record<string, unknown>[] {
  return array(value.areas).map(object).filter(isObject);
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function strings(value: unknown): string[] {
  return array(value).map(string).filter((item): item is string => item !== null);
}

function indexedStrings(value: unknown): Array<string | undefined> {
  return array(value).map(item => typeof item === 'string' ? item : undefined);
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function isObject(value: Record<string, unknown> | null): value is Record<string, unknown> {
  return value !== null;
}
