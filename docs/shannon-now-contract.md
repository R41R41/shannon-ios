# 「シャノンのいま」 contract (v1)

One read for the owner's own app: how Shannon is right now, as far as the server already knows it. The iPhone screen 「ようす › シャノンのいま」 is built against this document and the contract test `services/api/tests/shannonNow.test.ts`. The vocabulary and bounds are in `services/api/src/shannonNowContract.ts`; the route is `serverShannonNowRoute.ts`; the queries are in `shannonNowReader.ts`.

Everything here is additive. No existing route, table, or prompt wording changed, and no table was added.

## Privacy rule

The answer holds facts with a closed vocabulary: identifiers, timestamps, numbers, and names from fixed lists. It has no field for

- an image or a frame, or her note of what she saw;
- anything anyone said: not the words of a message she started, not her line after a touch, not a Talk;
- why she feels something. A feeling is a face and a strength. Its cause stays in the Talk where it arose.

The server reads these tables through a connection that cannot write (`PRAGMA query_only`), selects no text column, stores nothing, calls no model, and gives the answer to no other module: it is in no prompt, and the kernel, the workers, the platform bridge and her activity loop do not hold the reader (asserted in the test).

## `GET /v1/shannon/now`

- `Authorization: Bearer <device token>` of a device paired into the **owner's** scope (`SHANNON_OWNER_SCOPE_KEY`, default `owner`).
- The scope is the device's own. A `scopeKey` in the query is ignored.
- At most 60 reads a minute per device. The app reads when the screen appears and when the owner pulls to refresh.

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-03T07:00:00.000Z",
  "feeling": {
    "mood": { "expression": "calm" },
    "present": { "expression": "joyful", "intensity": 0.62 },
    "lingering": [ { "expression": "sad", "strength": 0.31, "startedAt": "2026-10-03T05:00:00.000Z" } ]
  },
  "body": { "known": true, "present": true, "lastReadAt": "2026-10-03T06:59:50.000Z", "freshSeconds": 75, "camera": true },
  "looks": [
    { "id": "…", "at": "2026-10-03T06:40:00.000Z", "askedBy": "owner", "surface": "body", "outcome": "seen" },
    { "id": "…", "at": "2026-10-03T04:05:00.000Z", "askedBy": "herself", "surface": "body", "outcome": "refused", "code": "camera_off" }
  ],
  "touches": [ { "id": "…", "at": "2026-10-03T06:12:00.000Z", "kind": "pet", "count": 2, "answered": true } ],
  "reachOuts": [
    { "id": "…", "at": "2026-10-03T05:50:00.000Z", "reason": "share",
      "deliveries": [ { "surface": "body", "outcome": "spoken", "at": "2026-10-03T05:50:04.000Z" },
                      { "surface": "app", "outcome": "read", "at": "2026-10-03T06:20:00.000Z" } ] }
  ],
  "limits": { "items": 30, "days": 14 }
}
```

| Field | Notes |
| --- | --- |
| `feeling.mood` | The quiet face of her continuous mood: `expression` is one of the 22 faces, `feeling` the name of a borrowed face (`proud`, `flustered`, `apologetic`) when it applies. |
| `feeling.present` | What she feels at this instant on her awake clock, or `null` when no feeling is showing. `intensity` 0–1. |
| `feeling.lingering` | What still lies underneath, strongest first, at most 3: a face, its present `strength` (0–1), and `startedAt`. Empty under `SHANNON_EMOTION_CLOCK=wall`. The feeling in `present` is not repeated here. |
| `body.known` | `false` while no body ever read presence (or the server notes none): the app says that nothing was reported, not that the body is away. |
| `body.present` | A registered body read `GET /v1/body/presence` in the last `freshSeconds` (75). |
| `body.lastReadAt` | The newest such read, or `null`. |
| `body.camera` | Whether a registered body said it may use its camera (`flags.camera`); `null` when no body is registered. A phone registered only to feel touch (`flags.touchOnly`, `docs/body-contract.md`) is not her desktop body: it is not counted here, and it never reads presence, so it cannot make `known` or `present` true. |
| `looks[]` | Looks through her body's camera (`body_looks`) and through the app's (`app_looks`), newest first. `askedBy`: `owner`, `herself`, or `unknown` (an app look does not record it). `outcome`: `looking`, `seen`, `refused`, `discarded`, `expired`, `failed`. `code`: the closed codes of `docs/body-contract.md`. |
| `touches[]` | Runs of touches of one kind (`body_touch_bursts`), newest first: `kind` (`pet`, `tickle`, `poke`, `carry`, `holdHand`), `count`, and `answered` (she said a line; the line is not here). Added 2026-10-03, all optional: `region` (`head`, `face`, `side`, `hand`, `body`) and `surface` (`windows`, `mac`, `iphone`) while every touch of the run named the same one, `phrase` — the way of touching and the part in the words she is told (頭をなでられた, 頬をつつかれた, …; `bodyTouchWords.ts`), absent without a part — and `place` (（iPhoneで）／（Windowsで）／（Macで）), absent without a surface. A client shows `phrase` in place of its own name for `kind`, and `place` after it. |
| `reachOuts[]` | Messages she started on her own, newest first. `reason`: `share`, `wonder`, `upcoming`, `saw`, `follow_up`, or absent. |
| `reachOuts[].deliveries[]` | How it reached him, oldest first. `surface: "body"` with `outcome` `spoken`, `shown`, `away`, `hidden`, `muted` (one per body that reported); `surface: "earphones"` with `outcome: "spoken"` and `device` `mac` or `iphone` when that app said it in his earphones (private listening); `surface: "call"` with `outcome` `ringing`, `answered`, `declined`, `unanswered` or `failed` when she rang his iPhone with it (`incoming_calls`; an answered call replaces the iPhone's `earphones` entry for the same message); `surface: "app"` with `outcome: "read"` when he opened it in a Talk. Empty while nothing was reported. |
| `limits` | Each list holds at most `items` (30) entries, none older than `days` (14). |

**A client must tolerate values it does not know**: a `surface`, an `outcome`, a `code`, a `reason`, a touch `kind`, an `expression`. It shows a neutral wording for them and never fails the whole page.

A feature that was never switched on, or a table a later change adds, is an empty list and not an error. The same holds for a table in a shape the reader does not know. Before any state was stored for the owner, `feeling` is a neutral mood with nothing present and nothing lingering; the read does not create a state.

| Status | `error` | Meaning |
| --- | --- | --- |
| `401` | `PAIRING_REQUIRED` | Missing or wrong credential. |
| `403` | `PAIRED_DEVICE_REQUIRED` | The caller is authorized with the fixed local token and is no paired device. |
| `403` | `SHANNON_NOW_OWNER_ONLY` | The device is paired into a scope other than the owner's. |
| `403` | `SHANNON_NOW_DISABLED` | `SHANNON_NOW_READ=off`. |
| `405` | `METHOD_NOT_ALLOWED` | Not `GET`. |
| `429` | `RATE_LIMITED` | More than 60 reads in a minute from one device. |

An older server answers `404`. On `403` and `404` the app shows the page without these parts.

## Server switch

`SHANNON_NOW_READ` (default on). `off`, `false`, `0` or `disabled` refuses the read. A restart applies it. Nothing else changes: no table is written by this route, so switching it off loses nothing.

## Adding a delivery surface

`shannonNowReader.ts` holds `REACH_OUT_DELIVERY_SOURCES`: one function per surface, each reading its own table and returning nothing while that table does not exist. A new surface adds one function that maps its rows to `{ id, surface, outcome, at }`. A source that throws is left out of the answer; the rest of the page still arrives.

## Her mood over time

How her mood went over hours or days is a read of its own: `GET /v1/shannon/mood-history` (`docs/mood-history-contract.md`), with the same callers, codes and rate limit as this one.

## Not built

- The Live2D body on iPhone, and reading or changing the desktop body's settings from the phone (that needs a body-side contract).
- Her note of a look. It is shown where it already is (her study), not here.
- `askedBy` for a look through the app: the row does not record whether the owner asked.
