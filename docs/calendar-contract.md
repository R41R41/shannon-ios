# Calendar contract: what is coming up for the owner

Status: implemented on the server (2026-10-02). The apps that send it are built against this document.
Schema version: `1`. Source: `services/api/src/contracts/calendarContract.ts`, `calendarRoutes.ts`, `upcomingStore.ts`, `ownerUpcoming.ts`.

Owner decision (2026-10-02): Shannon should know what is coming up for the owner, so that she can answer "what is on today?" and, in her own time, speak up about something that is near. The apps read the calendar on the owner's device and send a bounded snapshot. **The server never reads a calendar service and never writes a calendar.**

## Transport

- Base URL and authentication are those of every app route: `Authorization: Bearer <device token>` from pairing. The scope is taken from the token; `scopeKey` in a body or query is overwritten with it.
- `PUT` and `DELETE` are accepted on this path only. `PUT /v1/calendar/upcoming` has its own JSON limit of **262,144 bytes (256 KiB)**; a larger body is answered `413 REQUEST_TOO_LARGE`.
- A device is identified by its device token. Each device has one snapshot.
- **Only the owner's scope may share** (`SHANNON_OWNER_SCOPE_KEY`, default `owner`). A `PUT` from a device paired to any other scope is answered `403 CALENDAR_OWNER_ONLY`.
- These routes never answer `404`. A client may read `404` as "this server has no calendar route yet".

## `PUT /v1/calendar/upcoming`

Replaces **this device's** snapshot whole. An event that is no longer in the device's calendar is gone on the server after the device's next send. Other devices' snapshots are untouched.

```json
{
  "scopeKey": "owner",
  "generatedAt": "2026-10-02T01:00:00.000Z",
  "timeZone": "Asia/Tokyo",
  "windowStart": "2026-10-02T01:00:00.000Z",
  "windowEnd": "2026-10-09T01:00:00.000Z",
  "events": [
    { "id": "A1B2:2026-10-02", "title": "歯医者", "start": "2026-10-02T14:00:00+09:00", "end": "2026-10-02T15:00:00+09:00", "allDay": false, "calendar": "個人", "location": "駅前" },
    { "id": "C3D4", "title": "祝日", "start": "2026-10-03T00:00:00+09:00", "end": "2026-10-04T00:00:00+09:00", "allDay": true }
  ]
}
```

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `scopeKey` | string | yes | Overwritten with the token's scope for a paired device. |
| `generatedAt` | ISO 8601 | yes | When the device built the snapshot. |
| `timeZone` | string | yes | IANA zone of the device, at most 64 characters (`Asia/Tokyo`). Used to say the day of an all-day event. |
| `windowStart`, `windowEnd` | ISO 8601 | yes | The span the device looked at. `windowEnd` is after `windowStart` and at most **31 days** later. |
| `events` | array | yes | At most **300** items. May be empty (see "Switching sharing off"). |
| `events[].id` | string | yes | 1 to 200 characters, any characters (`<identifier>@<occurrence start>` is fine). The device's own identifier. **It need not be unique**: occurrences of a repeating event may share one. |
| `events[].title` | string | yes | At most 200 characters. May be empty; an empty title is shown as 「（題なし）」. |
| `events[].start`, `events[].end` | ISO 8601 | yes | `end` is not before `start`. |
| `events[].allDay` | boolean | yes | For an all-day event send its bounds as the device's calendar gives them, in the device's zone: an end at 23:59:59 of the last day and an end at 00:00:00 of the day after are both accepted. |
| `events[].calendar` | string | no | Name of the calendar, at most 80 characters. Leave it out when empty; `null` is refused. |
| `events[].location` | string | no | At most 200 characters. Leave it out when empty; `null` is refused. |

Lengths are counted in UTF-16 code units (the length of a JavaScript or Swift `utf16` string), so one emoji counts as two.

Times are ISO 8601 with a numeric offset or `Z`, with or without fractional seconds (`2026-10-02T14:00:00+09:00`, `2026-10-02T05:00:00Z`, `2026-10-02T05:00:00.000Z`); a time without an offset is refused. `windowStart` may be before `generatedAt`. The server stores and returns canonical UTC. Control characters in text are replaced with a space.

An unknown field at either level, a missing required field, or a value outside a bound is answered `400 BAD_REQUEST` with the offending field in `message`, and **nothing of that request is stored** (the device's previous snapshot stays).

Answer `200`:

```json
{ "schemaVersion": 1, "stored": 2, "receivedAt": "2026-10-02T01:00:03.000Z" }
```

## `GET /v1/calendar/upcoming?scopeKey=…&hours=…`

The merged view of every device with a fresh snapshot: events that are under way now or begin within `hours` (a whole number from 1 to 744, default 24), earliest first. The same `title`, `start` and `end` from two devices is returned once.

```json
{
  "schemaVersion": 1, "generatedAt": "2026-10-02T01:00:05.000Z", "hours": 24, "enabled": true, "devices": 2,
  "events": [ { "id": "A1B2:2026-10-02", "title": "歯医者", "start": "2026-10-02T05:00:00.000Z", "end": "2026-10-02T06:00:00.000Z", "allDay": false, "calendar": "個人", "location": "駅前" } ]
}
```

`devices` is the number of devices whose snapshot is in use; `enabled` is `false` while ingestion is switched off on the server (then `events` is empty and `devices` is 0).

## `DELETE /v1/calendar/upcoming`

Removes this device's snapshot: the owner switched sharing off there. **No body and no query**: the scope comes from the device token. Answer `200`: `{ "schemaVersion": 1, "removed": true }` (`false` when there was none). It works also while ingestion is switched off.

### Switching sharing off

Either signal works, and a device may use whichever is easier:

- `DELETE /v1/calendar/upcoming`, or
- `PUT` with `"events": []`. Every event of the device is gone. The one difference from `DELETE`: the device still counts in `devices`, so she says "your calendar is shared and nothing is coming up" rather than "no calendar is shared".

Prefer `DELETE` when the owner turns the setting off, and an empty `PUT` when the calendar really has nothing in the window.

### A device that cannot say goodbye

A device that is unpaired while offline, or whose pairing ran out, cannot send `DELETE`. The server does it for it: a snapshot is read only while its device is still paired (not revoked, not expired), from the moment of the revocation, and the row is deleted the next time any device sends a snapshot or the service starts.

## What the server does with a snapshot

- It is stored per device in `calendar_device_snapshots` (additive table). **A snapshot is used for seven days after it was received**; after that it is ignored until the device sends again. Send at least daily, and again when the calendar changes.
- Events are owner-private material, like the rest of what she knows about him. They reach a model through one projection only (`upcomingForOwner`, `ownerUpcoming.ts`), together with promises that have a due time and, when Voyager is configured for it, dated Voyager tasks:
  - **An owner conversation turn that asks about the schedule** (text and owner voice): one block of at most 12 lines for the next 48 hours (8 days when he names a week), each line a kind, an owner-local time, the title, and the place. With no device sharing, the block says so, so she does not invent events. With other people present every line carries the marker of owner-private information and the speak-time check decides what is said aloud; a promise he keeps secret from the people present is left out.
  - **Her own activity**, only while she may speak up on her own (`reach_out`): at most 12 lines for the next 24 hours, each a kind, a time and a title. No place, no calendar name, no id.
- No route here calls a model, writes as Shannon, or creates a memory.

## Errors

| Status | `error` | When |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | Outside the rules above; `message` names the field. |
| 401 | `PAIRING_REQUIRED` | No valid device token. |
| 403 | `CALENDAR_OWNER_ONLY` | `PUT` from a scope that is not the owner's. |
| 403 | `CALENDAR_INGEST_DISABLED` | `PUT` while ingestion is switched off. Retry later; nothing was stored. |
| 405 | `METHOD_NOT_ALLOWED` | Any other method. (`404` is never used here.) |
| 413 | `REQUEST_TOO_LARGE` | A body over 256 KiB. |

## Server switch

`SHANNON_CALENDAR_INGEST` (unset means on). With `off`, `false`, `0` or `disabled`: `PUT` answers 403, `GET` answers no events, stored snapshots are not read by any prompt, and `DELETE` still works. A restart of the API and of the autonomy service applies it.

## Not built

- Writing to a calendar, invitations, attendees, notes, alarms, and recurrence rules. Only what is listed above is accepted.
- A push from the server when the snapshot is stale. The device decides when to send.
- Reading a calendar service from the server.
