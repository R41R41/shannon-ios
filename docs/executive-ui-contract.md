# Executive UI contract (v1): 「ようす › 目標」 and 「ようす › 点検」

The owner's reads and controls behind the two new tabs of 「ようす」 on the iPhone and the Mac (Syzygy ADR-0009 stage 2, step E7; owner's choice 2026-10-13, comparison page §5 option A: いま／目標／学び／気分／点検). The app was built first against fixtures (`apps/ios/Sources/ShannonAppCore/Features/Yousu/ShannonExecutiveFixtures.swift`); the server routes are built to this contract (E1/E2 on branch `adr9-e1-e2`, choices and inspection later).

- App side: DTOs `ShannonExecutiveDTOs.swift`, client `API/ShannonAPIClient+Executive.swift`, model `ShannonExecutiveModel.swift`, pages `ShannonGoalsView.swift` and `ShannonInspectionView.swift`.
- Copy: `design/strings.ja.json`, keys `yousu.tab.goals`, `yousu.tab.inspection` and `executive.*`.

## Rules common to every route

- **Owner only.** Every route answers only the owner's scope from a paired device of the owner (or the developer token), like `GET /v1/autonomy/values`. Anyone else gets `403`. `GET` routes take `scopeKey` as a query parameter; `POST` routes take it in the JSON body (`{"scopeKey": "..."}`), like the existing `POST /v1/autonomy/pursuits/{id}/status`.
- **`404` and `403` mean 「準備中」.** The app shows a part whose route answers `404` or `403` as 「準備中です」 (not a failure), so the routes can ship one at a time. Any other failure keeps the last good answer and adds 「読めませんでした」.
- **Lenient reading.** Every field except an item's `id` is optional on the app side. A list that is missing reads as empty. An item the app cannot read (no `id`, or a field of another type) is dropped on its own; the rest of the list is shown. So the server may add fields freely and may leave out fields it cannot fill yet. Do not send a field with a different type than below (that drops the item).
- **Times** are ISO 8601 with an offset (`2026-10-13T08:00:00.000Z`). **Days** are `YYYY-MM-DD` in the owner's time zone.
- **Words come from the server** where the app cannot know them: a goal's completion condition, a choice's label and reason, a capability's label and purpose. They are plain Japanese for the owner, never internal symbols or JSON. No secret, no private text of other people, and nothing the owner asked to forget.
- **Privacy on the device.** The app offers 目標 and 点検 only on the owner's device (the same gate as 学び) and only while the owner is alone: while the body's audience is `others` or a call others may hear is live, the tabs are not offered and an open one goes back to いま. The server need not do anything for this, but must never put these reads into anything shown to others.
- **Controls are sent once.** 完了を認める, 休める and やめる are each confirmed in the app, then sent once and never retried. When the answer is lost, the app reads the goals again and tells the owner whether the change arrived. So the routes must be idempotent for the same target state (confirming a goal that is already `done` by the owner answers `200` with the view).

## `GET /v1/autonomy/goals?scopeKey=`

Her goals (`autonomy_pursuits` with the E2 columns), open and recently closed.

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-13T08:00:00.000Z",
  "activeLimit": 8,
  "goals": [
    {
      "id": "p-…",
      "title": "短い詩集を作る",
      "why": "前に書いた詩をライ氏が喜んでくれたから",
      "status": "active",
      "origin": "self",
      "interest": "詩",
      "progress": 0.6,
      "progressLabel": "3/5",
      "reviewAt": "2026-10-16T00:00:00.000+09:00",
      "lastWorkedAt": "2026-10-12T23:10:00.000+09:00",
      "completion": { "summary": "5篇そろって、ライ氏が読む", "met": false },
      "evidenceCount": 3,
      "closedReason": null,
      "closedAt": null,
      "ownerCanConfirm": true,
      "ownerCanRest": true,
      "ownerCanDrop": true,
      "createdAt": "2026-10-05T10:00:00.000Z",
      "updatedAt": "2026-10-12T14:10:00.000Z"
    }
  ]
}
```

| Field | Notes |
| --- | --- |
| `activeLimit` | How many goals may be active at once (8, plan §3). The header shows 「目標（進めている n/8）」; without it, 「目標」. |
| `status` | `active`, `resting`, `done` or `dropped` (the existing pursuit states). |
| `origin` | `seed`, `conversation` or `self`. |
| `interest` | The interest the goal came from, in words. Optional. |
| `progress` | 0–1. Drawn as a bar for open goals. |
| `progressLabel` | The progress in words (「3/5」). Without it the app shows `progress` as a percentage. |
| `reviewAt` | The next review (E2). Shown as 「次の見直し 10月16日」 for open goals. |
| `completion.summary` | The completion predicate in plain Japanese, rendered by the server from the typed predicate. `null` or missing: 「完了の条件は、まだ決まっていません」. |
| `completion.met` | The evidence suggests the predicate is met. The app then shows 「条件を満たしたかもしれません」 on an active goal; the goal is still not done until the predicate is met by evidence on the server or the owner confirms. |
| `evidenceCount` | How many pieces of evidence the goal has. |
| `closedReason` | Why it was rested, done or dropped, in words (「ライ氏が完了を認めた」). |
| `ownerCanConfirm`, `ownerCanRest`, `ownerCanDrop` | Whether to show 完了を認める, 休める, やめる. Without them the app uses: confirm and rest for an `active` goal that is not a seed, drop for an open (`active` or `resting`) goal that is not a seed (seeds are `PURSUIT_SEED_IMMUTABLE`). |

The app lists open goals (active first, then resting; the nearest review first) and folds `done`/`dropped` goals under 「終えた・やめた目標」. Send closed goals of the last 14 days at most.

## `POST /v1/autonomy/pursuits/{id}/confirm`

The owner confirms that a goal is done. Body `{"scopeKey": "..."}`. Records a pursuit event with actor `owner` and reason `owner_confirmed`, sets `status` to `done`, `closedReason` 「ライ氏が完了を認めた」, `closedAt` now.

- `200`: the same body as `GET /v1/autonomy/goals` after the change (the app shows it at once).
- `200` also when the goal is already `done` (idempotent).
- `404 PURSUIT_NOT_FOUND`; `409 PURSUIT_SEED_IMMUTABLE`, `409 PURSUIT_CLOSED` (dropped) or `409 PURSUIT_NOT_ACTIVE` (resting: decide whether the owner may confirm a resting goal; the app only offers it when `ownerCanConfirm` is true or the goal is active). The app shows 「変更できませんでした。最新の状態を読み直しました。」 on any 4xx and reads the goals again.

## `POST /v1/autonomy/pursuits/{id}/status` (exists)

休める and やめる use the existing route: body `{"scopeKey": "...", "status": "resting" | "dropped"}`, answered with the autonomy overview. The app ignores the body and reads `GET /v1/autonomy/goals` again. Server work: make it write a pursuit event (E2's `autonomy_pursuit_events`, actor `owner`) and set `closedReason` (「ライ氏が休めた」／「ライ氏がやめた」), and make it idempotent for the same status (`resting` → `resting` answers `200`).

## `GET /v1/autonomy/choices?scopeKey=&days=7`

What the executive chose (the `executive_deliberations` rows and their choice-ledger kind `deliberation`), the newest first, at most 50.

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-13T08:00:00.000Z",
  "days": 7,
  "choices": [
    {
      "id": "d-…",
      "at": "2026-10-12T23:10:00.000+09:00",
      "capability": "create",
      "label": "詩を1篇書いた",
      "goalId": "p-…",
      "goalTitle": "短い詩集を作る",
      "reason": "前回ライ氏が喜んでくれたから",
      "outcome": "done",
      "offCandidates": false,
      "topByValue": true
    }
  ]
}
```

| Field | Notes |
| --- | --- |
| `days` | 1–30; the app asks for 7. |
| `capability` | The catalogue id of the capability chosen. |
| `label` | What was chosen, in words (past tense once done). Without it the app shows `capability`. |
| `reason` | Her one-line reason (80 characters at most), as recorded. Leave it out for a choice whose reason was forgotten. |
| `outcome` | `pending`, `running`, `done`, `failed`, `unknown`, `cancelled`, or `none` (nothing to report, e.g. rest). Shown as a chip: これから・進行中・できた・うまくいかなかった・不明・取りやめ; `none` shows no chip; any other value shows 不明. |
| `offCandidates` | Chosen from outside the candidates the code offered (plan §1). |
| `topByValue` | The candidate with the highest value was chosen. Not shown yet; counted in 点検. |

## `GET /v1/autonomy/capabilities?scopeKey=`

The capability catalogue (E1): both layers.

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-13T08:00:00.000Z",
  "capabilities": [
    {
      "id": "create",
      "label": "創作",
      "purpose": "物語や詩を書く・直す",
      "layer": "activity",
      "execution": "procedure",
      "policy": "own_time",
      "value": { "mean": 0.53, "sd": 0.11, "n": 14 },
      "uses7d": 6,
      "usesTotal": 41,
      "lastUsedAt": "2026-10-12T23:10:00.000+09:00"
    }
  ]
}
```

| Field | Notes |
| --- | --- |
| `layer` | `activity` (what the executive chooses) or `tool` (a part used inside an FCA task). The app lists activities, then tools folded under 「道具」. |
| `execution` | `procedure`, `fca` or `none`. Not shown yet. |
| `policy` | `own_time` (自分の時間に使える), `owner_request_only` (頼まれた時だけ) or `off` (使わない). Any other value is shown as sent. |
| `value` | The value table's cell for the capability (after the `cap1` key mapping): `mean` −1…1, `sd` the spread, `n` settled results. `null` or `n` 0: 「手応え まだなし」. The app adds the same word as 学び (よい・まずまず・いまいち・まだ少ない). |
| `uses7d`, `usesTotal` | Times chosen or used in the last 7 days, and in all. |

## `GET /v1/autonomy/inspection?scopeKey=&day=YYYY-MM-DD`

The day's counts (plan §6, E8) and the seven days ending on that day. `day` is optional; without it, today in the owner's time zone.

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-13T08:00:00.000Z",
  "day": "2026-10-13",
  "today": {
    "deliberations": 9,
    "choices": 8,
    "chosenTopValue": 5,
    "offCandidates": 1,
    "distinctCapabilities": 4,
    "goals": { "created": 1, "completed": 0, "rested": 1, "dropped": 0 },
    "notices": { "sent": 2, "answered": 1, "unanswered": 1 },
    "sleepRuns": 0,
    "unknown": 0,
    "spentYen": 312,
    "skillUses": 2,
    "predictions": { "made": 14, "hit": 9 }
  },
  "week": { "…": "the same fields, summed over the 7 days ending on day" }
}
```

| Row in the app | Field |
| --- | --- |
| 考えた回数 | `deliberations` |
| 選んだ回数 | `choices` |
| 価値の一番高い候補を選んだ割合 | `chosenTopValue` / `choices`, shown 「60%（6/10）」 |
| 候補の外から選んだ回数 | `offCandidates` |
| 使った能力の種類 | `distinctCapabilities` |
| 目標を終えた・休めた・やめた | `goals.completed`, `goals.rested`, `goals.dropped` |
| 知らせた回数・知らせて返事があった | `notices.sent`, `notices.answered` |
| スキルを使った回数 | `skillUses` |
| 予測が当たった割合 | `predictions.hit` / `predictions.made` |
| 睡眠 | `sleepRuns` |
| 不明のまま | `unknown` |
| 使った費用 | `spentYen` (her own budget only, not the owner's research budget), shown 「312円」 |

A field that is missing is shown as 「—」 (not counted yet), so E8 can fill the counts one by one. `spentYen` may be a decimal; the app rounds it.

## What is not in v1

- No history of a goal's events, no per-goal evidence list (only `evidenceCount`), no editing of a goal's condition or review date from the app.
- No choice detail page; no inspection of a day other than today from the app (the `day` parameter is for later).
- No Windows surface yet (`windowsNow` 「（無い）」 in the strings).
