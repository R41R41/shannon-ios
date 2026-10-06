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

- **From the state as written, after it was written.** In the API process and its workers, `SQLiteCompanionRepository.apply` hands the snapshot it just wrote, and the instant the reducer was given, to the recorder: after the state's transaction committed, or, when a caller holds a transaction around that write (the sleep worker applying an outcome, say), inside that transaction, so that the point commits or rolls back with the write. In the activity loop's process, the awake clock (`autonomyAwakeClock.ts`) does the same after its one write commits. These are every change of her state. Creating the first state is not a change and is not recorded. Nothing wakes to record: without a write of the state there is no point.
- **It cannot alter the state.** The recorder is given the committed snapshot, computes a point with pure functions of `@shannon/cognition`, and writes one row of its own table. It never writes `companion_states`, the event log or the prompt projection, and nothing reads its table back into a state, a prompt or a model. The test applies the same writes with and without recording and compares the stored bytes.
- **A failure to record never fails the write.** The state's transaction has committed before the recorder runs; inside a transaction a caller holds, the recorder uses a savepoint and undoes only its own row. An error is logged as `Shannon mood history failed` with the error's name and code only. The one error that is thrown on is SQLite rolling back the caller's whole transaction (a full disk, an I/O error, out of memory): the write is then lost anyway, and the caller fails as it would have at its own next statement instead of going on outside a transaction.
- **Coalesced.** A new point when the quiet face (`expression`, `feeling`) or the present `kind` (including to and from `null`) changed since the last point, when `valence`, `arousal` or `openness` moved by 0.05 or more since the last point, and otherwise at most every 10 minutes while writes happen.
- **Kept 14 days.** Points older than 14 days are deleted when a point is written and whenever a store of the API or its workers opens (a restart of the API or a worker), also while the switch is off (on an index of the time). The activity loop's process never prunes: its awake clock opens no store, and the store it reads the owner's context through is opened with `leavesMoodHistory`, which neither creates, prunes nor records.
- **The owner's scope only** (`SHANNON_OWNER_SCOPE_KEY`, default `owner`).

## Retention: proposal for Syzygy ADR-0006 (owner answer 7, not applied)

The owner decided (ADR-0006, answer 7) that the 14 days are to be lengthened to what fitting the new dynamics needs, the length to be shown in the shadow stage from the uncertainty of the estimate. **Retention is unchanged (14 days) until that is approved**; this section is the proposal.

What the mood history is needed for is θ, σ and the attractor of the core affect (`affectDynamics.ts`), fitted from stretches without events (ADR-0006 §2.6). θ needs the most data. From consecutive points 10 minutes apart with no event between them, the autocorrelation is ρ = e^(−θ·10 min) ≈ 0.926 at the initial θ (0.4 over two hours), its sampling error is √((1 − ρ²)/N), and the relative error of θ̂ is that divided by ρ·θ·10 min (≈ 0.071):

| Relative error of θ | Pairs needed | 3 quiet awake hours a day (18 pairs) | 4 hours (24) | 6 hours (36) |
| --- | --- | --- | --- | --- |
| 20% | ≈ 710 | 39 days | 29 days | 20 days |
| 15% | ≈ 1,260 | 70 days | 52 days | 35 days |

15% is about what it takes to tell whether her θ lies inside the literature range (an autocorrelation of 0.2–0.5 over two hours is θ within roughly ±40% of the initial value), which decides whether a fitted value is applied automatically or needs approval (owner answer 4). The attractor needs far less (its standard error falls below the 0.05 the history resolves within about ten days of four quiet hours), and σ is estimated from the same pairs as θ.

**Proposal: keep 60 days.** That reaches about 15% for θ at four quiet awake hours a day and about 20% at three. The real number of usable pairs a day can be counted once the shadow has run for 14 days: consecutive points of this history with no outcome row of `shannon_prediction_outcomes` between them (the outcome rows say when something happened to her). If that rate is below three hours' worth, the proposal is revised before it is applied. A point holds numbers and a kind only (see above), so the change is a length, not a new kind of data. The shadow's own `awake` rows and comparisons follow whatever length is decided.

## Privacy rule

The rule of 「シャノンのいま」 applies: only the owner's own paired device reads it. A turn with other people present stores nothing of her state today (`audience: "others"` in text, a voice turn not alone, a guest call), so it writes no point either. Should any write of her state happen during such a turn (her activity loop's clock, say), the point is taken from what that write stored, never from the face shown to the people present.

## `GET /v1/shannon/mood-history`

- `Authorization: Bearer <device token>` of a device paired into the **owner's** scope; the scope is the device's own and a `scopeKey` in the query is ignored.
- `hours`: optional. Absent: 24. A whole number from 1; more than 336 is read as 336. The iPhone and the Mac use 1, 24 and 168 (1 added by the owner on 2026-10-06).
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
| `carryIn` | Optional (added 2026-10-05, additive). The newest point stored before the window, in the same shape as a point. It still holds at the window's start, so a client draws it from the start of the window to the first point; a window with no point of its own (she was dormant all of it) still shows her known mood. Absent when nothing was stored before the window, and on a server that predates it. It is not counted in `points`, `maxPoints` or `downsampled`. |
| `downsampled` | More than `maxPoints` (300) points were stored in the window. The answer keeps the first and the last point and every point at which the face or the present kind changed, and spreads the rest of the budget evenly over the points between; only when the changes alone exceed 300 are they thinned evenly too. |
| `limits` | The bounds above, so that a client need not hard-code them. |

A point stands for the state from its `at` until the next point (and `carryIn` from the start of the window until the first point). A gap longer than `everyMinutes` means no write happened (she was dormant, or nobody talked to her); a client draws it as unchanged or as a gap, not as missing data.

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

`SHANNON_MOOD_HISTORY` (default on). `off`, `false`, `0` or `disabled` records nothing, in the API and its workers and in the activity loop's process, and refuses the read. Points already written are deleted once older than 14 days, at the next start of the API or a worker. A restart applies it; all services read the same environment file.

## Table

`shannon_mood_history` (created with `CREATE TABLE IF NOT EXISTS` when a store of the API or its workers opens, outside the numbered migrations; schema version unchanged; the activity loop's process creates nothing, also through the read-only store of its owner context (`leavesMoodHistory`), and skips while it is absent):

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
