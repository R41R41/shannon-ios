# Device actions contract

Status: implemented on branch `skill-device-actions` (2026-10-13). Owner decisions: Syzygy ADR-0009 §10 — music on request, and Shannon may propose music but never starts it herself; reminders, timers and calendar events when the owner asks.

Shannon (the server) cannot touch the owner's devices. She asks them through a durable **device-action outbox**: a conversation tool writes an action, the owner's own paired app (iPhone or Mac) takes it, does it with the system's frameworks, and reports what became of it once.

## Actions

| kind (= tool name) | payload | device does | result |
|---|---|---|---|
| `reminder.create` | `title`, `due` (local `YYYY-MM-DDTHH:mm`) or `dueAt` (ISO, from `inMinutes`), `notes?` | EventKit reminder in the default list, with an alarm at the due time | `{ id }` |
| `timer.start` | `seconds`, `fireAt` (ISO, computed by the server), `label?` | local notification at `fireAt` (UNUserNotificationCenter); `past` if already passed | `{ fireAt }` |
| `calendar.create_event` | `title`, `start` (local date-time or `YYYY-MM-DD`), `allDay`, `end?` or `durationMinutes?`, `location?`, `notes?` | EventKit event in the default calendar | `{ id }` |
| `music.search` | `query`, `scope` (`library`/`catalog`), `type` (`song`/`album`/`playlist`) | MusicLibrarySearchRequest / MusicCatalogSearchRequest | `{ items: [{ id, type, title, artist?, source }] }` |
| `music.recent` | — | MusicRecentlyPlayedRequest, heavy rotation (`/v1/me/history/heavy-rotation`), library playlists, MusicPersonalRecommendationsRequest | `{ recent, heavyRotation, playlists, recommendations }` |
| `music.play` | `itemId?` + `itemType` + `source`, or `query`; `mode` (`now`/`next`/`later`); `reason` | ApplicationMusicPlayer; shows the now-playing card with `reason` | `{ title, artist?, itemId }` |
| `music.control` | `action` (`pause`/`resume`/`skip`/`previous`/`stop`) | ApplicationMusicPlayer | `{ action }` |
| `music.playlist_create` | `name`, `trackIds` (catalog song ids) | MusicLibrary.createPlaylist (iPhone only; the Mac reports `unsupported`) | `{ id, count }` |

Expiry from the request (server clock): reads 30 s, `music.play`/`music.playlist_create` 120 s, `music.control` 60 s, `timer.start` 10 min, `reminder.create`/`calendar.create_event` 24 h.

## Routes (owner's paired device only)

All need a paired device token of the owner's scope (`SHANNON_OWNER_SCOPE_KEY`): no token `403 PAIRED_DEVICE_REQUIRED`, another scope `403 DEVICE_ACTIONS_OWNER_ONLY`, switched off `403 DEVICE_ACTIONS_DISABLED`; 90 requests a minute per device.

- `GET /v1/device/actions?platform=ios|macos&foreground=0|1&call=0|1&kinds=<comma list>&wait=0|1` → `{ schemaVersion: 1, actions: [{ id, kind, payload, requestedAt, expiresAt }], pollSeconds }`. The device says what it can do (`kinds`) and whether it is in front or in a call. Every action handed is held by that device from then on (`claimed`); one it holds but has not reported is handed to it again (a lost answer), never to another device. With `wait=1` and nothing to hand, the answer is held up to 15 s and returns as soon as an action is written.
- `POST /v1/device/actions/{id}/result` with `{ status: done|failed|denied, code?, result? }` (`code` from `unsupported`, `not_authorized`, `not_found`, `invalid`, `past`, `unavailable`, `failed`; `result` an object of at most 8 KiB) → `{ id, status, accepted }`. The first report wins; a repeat is answered with the recorded status and `accepted: false`. `404` unknown id, `403 DEVICE_ACTION_NOT_YOURS` another device holds it.
- `POST /v1/device/music/plays` with `{ actionId?, itemId, title, artist?, outcome: started|skipped|finished|stopped }` → `{ recorded: true }`.

## Exactly once

- Server: an action moves `pending → claimed → done|failed|denied` or to `expired`, each by a guarded update. A reported action is never handed again. An action nobody took is `expired` at `expiresAt`; one taken but never reported is `expired` (outcome unknown) a minute later, and a late report from its device is still recorded.
- Device (`ShannonDeviceActionModel`): writes the id down before it runs and the report when it ends (`UserDefaults`, newest 200 ids). An id it already reported is reported again from what was written, never run again; an id that started and never ended (the app died) is reported `failed` and not run. An action past `expiresAt` on the device's clock is reported `past`.
- Targeting: music, reads and timers go to the device the owner is using (one in a call first, then one in front, then the most recent poll within 25 s); a reminder or an event is for whichever owner device takes it first (they sync).

## Tools and Shannon's side

- Registry: `deviceActionToolDefinitions.ts`; executors `shannonDeviceActionTools.ts`; gate domain `device_action`; audience the owner alone; surfaces text and voice (never her own time). A voice turn is offered tools when the words ask for music, a reminder, a timer (also 「1時間後に起こして」, an alarm) or an event (`asksForDeviceAction`), or say yes to a song she proposed; while the common FCA runs, a spoken turn of the owner alone without such words is offered them too, beside her task, memory and everyday-read tools (`COMMON_FCA_VOICE_DOMAINS`, 2026-10-13 daily evals). The tools his words name (`askedToolNames`: a timer and a reminder, an event, music) are loaded with the turn in text and voice, never only behind `tool_open`.
- A call writes one action (deduplicated by the turn) and waits up to 8 s (bounded by the turn's deadline) for the report. Reads (`music.search`, `music.recent`) are refused at once when no device is connected and fail with `timeout` when no answer comes. Music writes are refused when no device is connected. A reminder, event or timer with no device connected is queued for the next time an app opens, and the tool says so; she must not say it is done before the report.
- A report that arrives after the turn reaches her next owner-alone text turn as `[端末に頼んだこと]` (last 3 hours, not repeated once told).
- Capability block `SHANNON_DEVICE_ACTIONS_CAPABILITY` (`packages/cognition/src/capabilities.ts`) is appended only to a turn that offers the tools, after her identity (`anthropicCachePlan.ts` takes it out to the turn's lines like the other appended blocks). The same `withDeviceActionsCapability` takes what the device does out of 今はできないこと: the timer line goes, and the calendar line keeps only changing or deleting an event (2026-10-13 daily evals D1–D3: with both lines in one prompt she refused timers and events). All of it follows the tools this turn actually offers (`withToolCapabilityLines`): the line and the limitation rewrite need a device write tool, and the reminder boundary (`reminderCapabilityBoundary`, honest by default: no timer, use the Clock app) becomes 「call `timer_start` or `reminder_create` now」 only when `timer.start` or `reminder.create` is offered. A turn whose words could not be trusted (writes withheld), with anyone else there, or a web/place turn without tools keeps the honest lines.
- Music choice: from his recent, heavy-rotation and library music and the catalog, by the conversation's mood and her feeling, with one line of why (`reason`), shown on the now-playing card. The call is a conversation tool call, so the existing choice ledger records it; play outcomes are stored in `device_music_plays` for a later reward and are not scored yet.

## Apps

`apps/ios/Sources/ShannonAppCore/Features/DeviceActions/` (shared by iPhone and Mac): `ShannonDeviceActionModel` (poll loop, ledger, dispatch), `ShannonDeviceEventKitWriter`, `ShannonDeviceTimers`, `ShannonDeviceMusic`, `ShannonNowPlayingCard` (+ `.shannonDeviceActions(_:)`), and `API/ShannonAPIClient+DeviceActions.swift`. Both app roots attach `.shannonDeviceActions(model)`; the card is in the iPhone conversation (list and face display) and the Mac Talk.

Permissions are asked on first use: Apple Music (`MusicAuthorization.request()`), reminders full access, events write-only access (full access if calendar sharing already has it), notifications. Usage strings: `NSAppleMusicUsageDescription`, `NSRemindersFullAccessUsageDescription`, `NSCalendarsWriteOnlyAccessUsageDescription` (and the existing `NSCalendarsFullAccessUsageDescription`) in both Info.plists. The Mac sandbox's existing `com.apple.security.personal-information.calendars` entitlement covers reminders and events.

**MusicKit needs the App ID's MusicKit service** in the Apple Developer portal (Certificates, Identifiers & Profiles › Identifiers › each App ID of the iPhone and Mac apps › App Services › MusicKit). Without it MusicKit calls fail and the device reports `unavailable`. Playing catalog songs needs an Apple Music subscription on the device.

Not done: ducking music while she speaks in a voice call (the call's audio session decides; no explicit duck), and scoring play outcomes as reward.

## Switch

`SHANNON_DEVICE_ACTIONS` (default on). Off at start: no table, no tool, routes `403 DEVICE_ACTIONS_DISABLED`; off later: the tools say the feature is unavailable and the routes refuse.
