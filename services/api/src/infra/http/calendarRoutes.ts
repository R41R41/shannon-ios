import { badRequest, objectBody, validScopeKey } from './apiValidation.js';
import { CALENDAR_SCHEMA_VERSION, CALENDAR_UPCOMING_PATH, validatedCalendarHours, validatedCalendarSnapshot } from '../../contracts/calendarContract.js';
import type { ApiRequest, ApiResponse } from '../../contracts/contracts.js';
import type { CompanionStateStore } from '@shannon/cognition';
import { OwnerUpcoming } from '../../mind/memory/ownerUpcoming.js';
import { SQLiteUpcomingStore } from '../../mind/memory/store/upcomingStore.js';

export { CALENDAR_UPCOMING_PATH } from '../../contracts/calendarContract.js';
export type { OwnerUpcoming } from '../../mind/memory/ownerUpcoming.js';

/** For a kernel that was given none (local runs, tests): snapshots in memory, promises from the kernel's own state. */
export function localOwnerUpcoming(stateStore: CompanionStateStore, now: () => string): OwnerUpcoming {
  return new OwnerUpcoming({ store: new SQLiteUpcomingStore(':memory:'), snapshot: scopeKey => stateStore.snapshot(scopeKey), now });
}

/** A fixed-token (local) caller has no paired device. */
const LOCAL_DEVICE = 'local';
const DISABLED: ApiResponse = { status: 403, body: { error: 'CALENDAR_INGEST_DISABLED', message: 'Calendar sharing is switched off on the server.' } };
const OWNER_ONLY: ApiResponse = { status: 403, body: { error: 'CALENDAR_OWNER_ONLY', message: 'Only the owner\'s own devices may share a calendar.' } };

/**
 * `/v1/calendar/upcoming` (`docs/calendar-contract.md`): a device sends what is coming up in
 * the owner's calendar, reads the merged view back, or takes its own snapshot away. No route
 * here calls a model, writes as Shannon, or changes a calendar.
 */
export function dispatchCalendarRequest(request: ApiRequest, upcoming: OwnerUpcoming, now: () => string): ApiResponse {
  // This function answers only its own path, and never with 404: a client reads 404 as "this server has no such route yet".
  if (request.path !== CALENDAR_UPCOMING_PATH) return { status: 405, body: { error: 'METHOD_NOT_ALLOWED' } };
  const deviceId = request.deviceId ?? LOCAL_DEVICE;

  if (request.method === 'GET') {
    const scopeKey = request.query?.get('scopeKey');
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    const hours = validatedCalendarHours(request.query?.get('hours'));
    if (hours === null) return badRequest('hours must be a whole number from 1 to 744');
    const at = now();
    const until = new Date(Date.parse(at) + hours * 60 * 60_000).toISOString();
    const events = upcoming.calendarEnabled ? upcoming.store.calendarEvents(scopeKey, at, until).map(({ timeZone: _zone, ...event }) => event) : [];
    return { status: 200, body: {
      schemaVersion: CALENDAR_SCHEMA_VERSION, generatedAt: at, hours, enabled: upcoming.calendarEnabled,
      devices: upcoming.calendarEnabled ? upcoming.store.sharingDevices(scopeKey, at) : 0, events,
    } };
  }

  if (request.method === 'DELETE') {
    // Taking a snapshot away is always allowed, also while ingestion is switched off. The client sends no body and no
    // query; the HTTP layer puts the scope of the device token into the query.
    const scopeKey = request.query?.get('scopeKey') ?? (objectBody(request.body) ? request.body.scopeKey : undefined);
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    return { status: 200, body: { schemaVersion: CALENDAR_SCHEMA_VERSION, removed: upcoming.store.removeCalendar(scopeKey, deviceId) } };
  }

  if (request.method === 'PUT') {
    if (!objectBody(request.body)) return badRequest('JSON object body is required');
    const scopeKey = request.body.scopeKey;
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    if (!upcoming.mayShareCalendar(scopeKey)) return OWNER_ONLY;
    if (!upcoming.calendarEnabled) return DISABLED;
    const snapshot = validatedCalendarSnapshot(request.body);
    if (typeof snapshot === 'string') return badRequest(snapshot);
    const receivedAt = now();
    return { status: 200, body: { schemaVersion: CALENDAR_SCHEMA_VERSION, stored: upcoming.store.replaceCalendar(scopeKey, deviceId, snapshot, receivedAt), receivedAt } };
  }
  return { status: 405, body: { error: 'METHOD_NOT_ALLOWED' } };
}
