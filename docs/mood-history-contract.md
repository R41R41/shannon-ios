# Mood history contract (v1)

One read for the owner's own apps (iPhone, Mac, Windows): how Shannon's mood went over the last hours or days, so that a screen can draw its trend. Decided by the owner on 2026-10-05; until then the Windows body app kept such a record on the PC by itself.

The vocabulary and bounds are in `services/api/src/moodHistoryContract.ts`; the recorder is `moodHistory.ts`; the read is `moodHistoryReader.ts` and `serverMoodHistoryRoute.ts`. The contract test is `services/api/tests/moodHistory.test.ts`, and the fixture `services/api/tests/fixtures/mood-history-v1/response.json` is the answer for its deterministic day (regenerate it with `SHANNON_WRITE_FIXTURES=1` only when the contract changes on purpose).

Everything here is additive: one new table, one new route, no existing route, prompt or computation changed.

## What a point holds

| Field | Notes |
| --- | --- |
| `at` | When the state write it was taken from happened. |
| `valence` | Her continuous mood, unpleasant (−1) to pleasant (1), as stored. |
| `arousal` | Quiet (0) to activated (1), as stored. |
| `openness` | Guarded (0) to open (1), as stored. |
| `mood` | The quiet face of that mood, as `GET /v1/shannon/now` names it: `expression` (one of the 22 faces) and `feeling` for a borrowed face. |
| `present` | What she felt at that instant on her awake clock, as `presentShannonFeeling` reads it: `kind` (one of the feeling kinds, `SHANNON_EMOTION_KINDS`) and `intensity` 0–1; `null` when no feeling was showing. |

Values are rounded to 0.01. There is no field for why she felt something, for whom, or for anything anyone said: the point is computed from the mood values and the feeling's kind and strength only.

## How points are written

- **From the state as written, after it was written.** In the API process and its workers, `SQLiteCompanionRepository.apply` hands the snapshot it just committed to the recorder; in the activity loop's process, the awake clock (`autonomyAwakeClock.ts`) does the same after its one write commits. These are every committed change of her state. Creating the first state is not a change and is not recorded. Nothing wakes to record: without a write of the state there is no point.
- **It cannot alter the state.** The recorder is given the committed snapshot, computes a point with pure functions of `@shannon/cognition`, and writes one row of its own table. It never writes `companion_states`, the event log or the prompt projection, and nothing reads its table back into a state, a prompt or a model. The test applies the same writes with and without recording and compares the stored bytes.
- **A failure to record never fails the write.** The state's transaction has committed before the recorder runs (inside a transaction a caller holds, the recorder uses a savepoint and undoes only its own row). An error is logged as `Shannon mood history failed` with the error's name and code only.
- **Coalesced.** A new point when the quiet face (`expression`, `feeling`) or the present `kind` (including to and from `null`) changed since the last point, when `valence`, `arousal` or `openness` moved by 0.05 or more since the last point, and otherwise at most every 10 minutes while writes happen.
- **Kept 14 days.** When a point is written, points older than 14 days are deleted (on an index of the time).
- **The owner's scope only** (`SHANNON_OWNER_SCOPE_KEY`, default `owner`).

## Privacy rule

The rule of 「シャノンのいま」 applies: only the owner's own paired device reads it. A turn with other people present stores nothing of her state today (`audience: "others"` in text, a voice turn not alone, a guest call), so it writes no point either. Should any write of her state happen during such a turn (her activity loop's clock, say), the point is taken from what that write stored, never from the face shown to the people present.

## `GET /v1/shannon/mood-history`

- `Authorization: Bearer <device token>` of a device paired into the **owner's** scope; the scope is the device's own and a `scopeKey` in the query is ignored.
- `hours`: optional. Absent: 24. A whole number from 1; more than 336 is read as 336. Apps use 24 and 168.
- At most 60 reads a minute per device.
- The connection is `query_only`; the read stores nothing and calls no model.

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-05T06:00:00.000Z",
  "hours": 24,
  "points": [
    { "at": "2026-10-05T00:00:00.000Z", "valence": 0, "arousal": 0.3, "openness": 0.35, "mood": { "expression": "calm" }, "present": null },
    { "at": "2026-10-05T00:02:00.000Z", "valence": 0, "arousal": 0.3, "openness": 0.35, "mood": { "expression": "calm" }, "present": { "kind": "happy", "intensity": 0.6 } },
    { "at": "2026-10-05T03:01:00.000Z", "valence": -0.26, "arousal": 0.36, "openness": 0.35, "mood": { "expression": "concerned" }, "present": { "kind": "sulky", "intensity": 0.85 } }
  ],
  "downsampled": false,
  "limits": { "defaultHours": 24, "maxHours": 336, "maxPoints": 300, "keepDays": 14, "everyMinutes": 10, "moodStep": 0.05 }
}
```

(Shortened; the fixture holds the whole answer.)

| Field | Notes |
| --- | --- |
| `hours` | The window applied, ending at `generatedAt`. |
| `points` | Oldest first. Empty when nothing was recorded in the window (also on a server that never recorded). |
| `downsampled` | More than `maxPoints` (300) points were stored in the window. The answer keeps the first and the last point and every point at which the face or the present kind changed, and spreads the rest of the budget evenly over the points between; only when the changes alone exceed 300 are they thinned evenly too. |
| `limits` | The bounds above, so that a client need not hard-code them. |

A point stands for the state from its `at` until the next point. A gap longer than `everyMinutes` means no write happened (she was dormant, or nobody talked to her); a client draws it as unchanged or as a gap, not as missing data.

**A client must tolerate values it does not know**: an `expression`, a `feeling`, a `kind`. It shows a neutral wording for them and never fails the whole view.

| Status | `error` | Meaning |
| --- | --- | --- |
| `400` | `MOOD_HISTORY_HOURS_INVALID` | `hours` is not a whole number from 1. |
| `401` | `PAIRING_REQUIRED` | Missing or wrong credential. |
| `403` | `PAIRED_DEVICE_REQUIRED` | The caller is authorized with the fixed local token and is no paired device. |
| `403` | `MOOD_HISTORY_OWNER_ONLY` | The device is paired into a scope other than the owner's. |
| `403` | `MOOD_HISTORY_DISABLED` | `SHANNON_MOOD_HISTORY=off`. |
| `405` | `METHOD_NOT_ALLOWED` | Not `GET`. |
| `429` | `RATE_LIMITED` | More than 60 reads in a minute from one device. |

An older server answers `404`. On `403` and `404` the app shows its view without the trend (the Windows app may keep its local record as before).

## Server switch

`SHANNON_MOOD_HISTORY` (default on). `off`, `false`, `0` or `disabled` records nothing, in the API and its workers and in the activity loop's process, and refuses the read. Points already written age out after 14 days. A restart applies it; all services read the same environment file.

## Table

`shannon_mood_history` (created with `CREATE TABLE IF NOT EXISTS` when the API's store opens, outside the numbered migrations; schema version unchanged; the activity loop's process creates nothing and skips while it is absent):

| Column | Type |
| --- | --- |
| `point_id` | `INTEGER PRIMARY KEY AUTOINCREMENT` |
| `scope_key` | `TEXT NOT NULL` |
| `recorded_at` | `TEXT NOT NULL` (ISO 8601) |
| `valence`, `arousal`, `openness` | `REAL NOT NULL` (to 0.001) |
| `expression` | `TEXT NOT NULL` |
| `feeling` | `TEXT` |
| `present_kind` | `TEXT` |
| `present_intensity` | `REAL` |

Indexes: `(scope_key, recorded_at)` for the read and the last point, `(recorded_at)` for pruning.
