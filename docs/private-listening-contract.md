# Private listening contract (v1)

Owner decision 2026-10-02: 「イヤホンをつないでいるとき（ボクにしか聞こえないとき）は、いつでも話しかけていい」.

"Privately listening" means that the sound of one of the owner's own apps comes out of something only he can hear. The app decides it; the server is told. The vocabulary and bounds are in `services/api/src/privateListeningContract.ts`, the routes in `privateListeningRoutes.ts`, the store in `privateListeningStore.ts`, and the contract test is `services/api/tests/privateListening.test.ts`.

Everything here is additive: one route and one table are added, and nothing existing changes.

## What "only he can hear" is

Decided on the device, by `ShannonPrivateListeningJudge` (`apps/ios/Sources/ShannonAppCore/Features/PrivateListening/`):

- **Wired headphones count without registration.** iOS: an output port of type `headphones`. macOS: the built-in device `BuiltInHeadphoneOutputDevice` (Apple silicon), or a built-in device whose output data source is `hdpn` (Intel).
- **Bluetooth and USB devices count only when the owner registered that device.** The system cannot tell Bluetooth earphones from a Bluetooth speaker, so the owner registers his earphones in Settings while they are connected. The registry is matched by the device's identity, never by its name; iOS port UIDs are stored without their profile suffix (`-tacl`, `-tsco`), so the same earphones are recognised while a voice conversation uses the hands-free profile.
- **Everything else is not private:** the built-in speaker, the receiver, AirPlay, a car, a display, an aggregate or virtual device, and an empty route. With several outputs at once, every one must be private.
- **Other people present is never private.** While a voice conversation is in 「友人も一緒」, or the owner mentioned a companion, the app does not report private listening whatever the output is.
- **An app that cannot run does not report.** The iPhone app is suspended in the background, so it withdraws its report when it leaves the foreground. The Mac app reports for as long as it runs, in front or not.

The registry is stored on the device (`UserDefaults`, `shannon.privateListening.earphones`: identity, name, date). It is not secret, and it never leaves the device: the server receives no device name and no identifier of the earphones.

## `POST /v1/private-listening`

`Authorization: Bearer <device token>`. Only a **paired device in the owner's scope** may call it. The device is taken from its token.

```json
{ "scopeKey": "owner", "kind": "mac", "listening": true, "ownerActiveAt": "2026-10-02T03:00:00Z" }
```

| Field | Values |
| --- | --- |
| `kind` | `mac` \| `iphone` |
| `listening` | `true`: only he can hear this app now. `false`: no longer. |
| `ownerActiveAt` | optional ISO 8601: when the owner last used that device, as the app saw it (macOS: the last keyboard or pointer input in any app; iPhone: now, while the app is in front). The server never takes it from the future and never moves it backwards within one run. |

No other field is accepted (`400`): there is no text field and no device name.

Answer to `listening: true`:

```json
{ "schemaVersion": 1, "listening": true, "kind": "mac", "since": "2026-10-02T03:00:00.000Z", "expiresAt": "2026-10-02T03:00:45.000Z", "pollAfterSeconds": 15 }
```

- **It is a heartbeat.** The app repeats the report every `pollAfterSeconds` (15). A report counts for 45 seconds (`expiresAt`); a device that stops reporting — the app was closed or force-quit, the network dropped, the Mac went to sleep — stops counting by itself. Nothing has to be cleaned up after a restart of the server: the table holds timestamps, and freshness is read from the clock.
- `since` is the first report of the current unbroken run. A gap longer than 45 seconds, or another `kind`, starts a new run.
- The app sends `listening: false` at once when the route changes to something that is not private, a friend joins, the iPhone app leaves the foreground, or the app is closing. The answer is `{ "schemaVersion": 1, "listening": false, "pollAfterSeconds": 15 }`. Saying it twice is harmless.
- While it is not privately listening the app sends nothing at all.

| Status | `error` | Meaning |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | A field is missing, not allowed, or out of its closed set. |
| 401 | `PAIRING_REQUIRED` | Missing or revoked device token. |
| 403 | `PAIRED_DEVICE_REQUIRED` | The caller has no paired device (a fixed-token caller). |
| 403 | `PRIVATE_LISTENING_OWNER_ONLY` | The device is paired into another scope than the owner's (`SHANNON_OWNER_SCOPE_KEY`, default `owner`). A guest can neither set nor clear the owner's state. |
| 403 | `PRIVATE_LISTENING_DISABLED` | Switched off on the server. `listening: false` is still accepted. |
| 405 | `METHOD_NOT_ALLOWED` | Anything but `POST`. |
| 429 | `RATE_LIMITED` | More than 60 requests from the device in a minute. |

## Stored shape

`private_listening` (additive):

| Column | |
| --- | --- |
| `scope_key`, `device_id` | primary key: one row per paired device |
| `kind` | `mac` \| `iphone` |
| `since` | first report of the current run |
| `seen_at` | the last report; the row counts while this is at most 45 seconds old |
| `owner_active_at` | nullable |

Rows not reported for a day are deleted at the next report.

## Server switch

`SHANNON_PRIVATE_LISTENING=off` (also `false`, `0`, `disabled`) makes every `listening: true` answer `403 PRIVATE_LISTENING_DISABLED` and nobody counts as privately listening. Unset means on. It is an app setting: a restart applies it.
