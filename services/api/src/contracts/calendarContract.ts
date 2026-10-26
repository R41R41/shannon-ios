import { serverEnvironment } from '../infra/config/serverEnvironment.js';
/**
 * The wire contract of the owner's upcoming calendar (`docs/calendar-contract.md`).
 *
 * The apps read the calendar on the owner's device and send a bounded snapshot of what is
 * coming up. The server never reads a calendar itself and never writes one. A snapshot is
 * owner-private material: it is treated like the rest of what she knows about the owner.
 */
export const CALENDAR_SCHEMA_VERSION = 1;
export const CALENDAR_UPCOMING_PATH = '/v1/calendar/upcoming';
/** The JSON body limit of `PUT /v1/calendar/upcoming` only. */
export const CALENDAR_REQUEST_BYTES = 256 * 1024;

export const CALENDAR_LIMITS = Object.freeze({
  events: 300,
  windowDays: 31,
  idCharacters: 200,
  titleCharacters: 200,
  calendarCharacters: 80,
  locationCharacters: 200,
  /** Names of the people invited, the owner left out. */
  attendees: 30,
  attendeeCharacters: 80,
  timeZoneCharacters: 64,
  /** `hours` of a read: the default and the largest value (31 days). */
  defaultHours: 24,
  maximumHours: 31 * 24,
  /** A device's snapshot is no longer used this long after it was received. */
  snapshotMaximumAgeMilliseconds: 7 * 24 * 60 * 60_000,
});

export interface CalendarEvent {
  /** The device's own identifier. Occurrences of a repeating event may share it. */
  id: string;
  title: string;
  /** Canonical ISO 8601 (UTC). */
  start: string;
  end: string;
  allDay: boolean;
  calendar?: string;
  location?: string;
  /** Who else is invited, by name (or address when the calendar has no name). */
  attendees?: readonly string[];
  /** An occurrence of a repeating event. */
  recurring?: boolean;
}

export interface CalendarSnapshot {
  generatedAt: string;
  timeZone: string;
  windowStart: string;
  windowEnd: string;
  events: readonly CalendarEvent[];
}

const SNAPSHOT_FIELDS = ['scopeKey', 'generatedAt', 'timeZone', 'windowStart', 'windowEnd', 'events'];
const EVENT_FIELDS = ['id', 'title', 'start', 'end', 'allDay', 'calendar', 'location', 'attendees', 'recurring'];
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/u;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** An ISO 8601 instant with an offset, as canonical UTC; null for anything else. */
function instant(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40 || !ISO_8601.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** Text from the device: control characters removed, never longer than the limit. Null when it is not a string or too long. */
function text(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string' || value.length > maximum) return null;
  return value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim();
}

function validTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > CALENDAR_LIMITS.timeZoneCharacters) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; }
}

/** The snapshot of one request, or the reason the request is refused. A refused request stores nothing. */
export function validatedCalendarSnapshot(value: Record<string, unknown>): CalendarSnapshot | string {
  const unknown = Object.keys(value).find(key => !SNAPSHOT_FIELDS.includes(key));
  if (unknown) return `${unknown.slice(0, 40)} is not allowed`;
  const generatedAt = instant(value.generatedAt);
  if (!generatedAt) return 'generatedAt must be an ISO 8601 timestamp with an offset';
  if (!validTimeZone(value.timeZone)) return 'timeZone must be an IANA time zone';
  const windowStart = instant(value.windowStart);
  const windowEnd = instant(value.windowEnd);
  if (!windowStart || !windowEnd) return 'windowStart and windowEnd must be ISO 8601 timestamps with an offset';
  const span = Date.parse(windowEnd) - Date.parse(windowStart);
  if (span <= 0 || span > CALENDAR_LIMITS.windowDays * 24 * 60 * 60_000) return `the window must be longer than zero and at most ${CALENDAR_LIMITS.windowDays} days`;
  if (!Array.isArray(value.events) || value.events.length > CALENDAR_LIMITS.events) return `events must be an array of at most ${CALENDAR_LIMITS.events} items`;
  const events: CalendarEvent[] = [];
  for (const [index, item] of value.events.entries()) {
    const event = validatedEvent(item, `events[${index}]`);
    if (typeof event === 'string') return event;
    events.push(event);
  }
  return { generatedAt, timeZone: value.timeZone, windowStart, windowEnd, events };
}

/** One event of a snapshot, or the reason it is refused. */
function validatedEvent(item: unknown, at: string): CalendarEvent | string {
  if (!isRecord(item)) return `${at} must be an object`;
  const extra = Object.keys(item).find(key => !EVENT_FIELDS.includes(key));
  if (extra) return `${at}.${extra.slice(0, 40)} is not allowed`;
  if (typeof item.id !== 'string' || !item.id || item.id.length > CALENDAR_LIMITS.idCharacters) {
    return `${at}.id must be 1..${CALENDAR_LIMITS.idCharacters} characters`;
  }
  const title = text(item.title, CALENDAR_LIMITS.titleCharacters);
  if (title === null) return `${at}.title must be a string of at most ${CALENDAR_LIMITS.titleCharacters} characters`;
  const start = instant(item.start);
  const end = instant(item.end);
  if (!start || !end) return `${at}.start and ${at}.end must be ISO 8601 timestamps with an offset`;
  if (Date.parse(end) < Date.parse(start)) return `${at}.end is before its start`;
  if (typeof item.allDay !== 'boolean') return `${at}.allDay must be a boolean`;
  const optional = optionalEventFields(item, at);
  return typeof optional === 'string' ? optional : { id: item.id, title, start, end, allDay: item.allDay, ...optional };
}

/** The optional fields of one event, each left out when empty; a string is the problem. */
type OptionalEventFields = Pick<CalendarEvent, 'calendar' | 'location' | 'attendees' | 'recurring'>;
function optionalEventFields(item: Record<string, unknown>, at: string): OptionalEventFields | string {
  const calendar = item.calendar === undefined ? undefined : text(item.calendar, CALENDAR_LIMITS.calendarCharacters);
  if (calendar === null) return `${at}.calendar must be a string of at most ${CALENDAR_LIMITS.calendarCharacters} characters`;
  const location = item.location === undefined ? undefined : text(item.location, CALENDAR_LIMITS.locationCharacters);
  if (location === null) return `${at}.location must be a string of at most ${CALENDAR_LIMITS.locationCharacters} characters`;
  const attendees = item.attendees === undefined ? [] : validAttendees(item.attendees);
  const attendeeBound = `${CALENDAR_LIMITS.attendees} strings of at most ${CALENDAR_LIMITS.attendeeCharacters} characters`;
  if (attendees === null) return `${at}.attendees must be at most ${attendeeBound}`;
  if (item.recurring !== undefined && typeof item.recurring !== 'boolean') return `${at}.recurring must be a boolean`;
  return { ...(calendar ? { calendar } : {}), ...(location ? { location } : {}), ...(attendees.length ? { attendees } : {}),
    ...(item.recurring ? { recurring: true } : {}) };
}

/** The names of an event's attendees, empty ones dropped; null when the field breaks a bound. */
function validAttendees(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > CALENDAR_LIMITS.attendees) return null;
  const names = value.map(name => text(name, CALENDAR_LIMITS.attendeeCharacters));
  return names.includes(null) ? null : names.filter((name): name is string => Boolean(name));
}

/** `hours` of a read, or null when it is not a whole number in range. Absent is the default. */
export function validatedCalendarHours(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === '') return CALENDAR_LIMITS.defaultHours;
  const hours = Number(raw);
  return Number.isInteger(hours) && hours >= 1 && hours <= CALENDAR_LIMITS.maximumHours ? hours : null;
}

/** Stopping calendar ingestion needs only this variable and a restart, not a deployment. Unset means on. */
export function calendarIngestEnabled(environment: Readonly<Record<string, string | undefined>> = serverEnvironment()): boolean {
  return !['off', 'false', '0', 'disabled'].includes(environment.SHANNON_CALENDAR_INGEST?.trim().toLowerCase() ?? '');
}

/** The JSON body limit of the calendar route; null for every other path. */
export function calendarRequestBytes(path: string): number | null {
  return path === CALENDAR_UPCOMING_PATH ? CALENDAR_REQUEST_BYTES : null;
}
