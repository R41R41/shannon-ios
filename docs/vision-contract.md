# Vision pathway (Syzygy ADR-0011, stage 1)

Shannon's general vision pathway: one contract for every source that sees, a separate vision worker that judges frames, and the
camera of the owner's iPhone/Mac app watching while the app is open. Authority: Syzygy ADR-0011 (adopted 2026-10-14) and the
2026-10-14 addendum to ADR-0002. Every switch is off by default.

## Absolute rule

A camera or screen picture is never stored: not in SQLite, the Observer sidecar, a log line, an error report, a note or a
memory. Frames exist in the memory of the device (gate only) and of the vision worker (`VisionFrameHolder`, until the decision
and at most their TTL; the bytes are zeroed when dropped). An escalated frame crosses the bridge socket once as base64 in memory.
`tests/visionWorkerPrivacy.test.ts` sends a synthetic frame with a marker through the real worker, bridge and Observer publisher
and scans every file of the data directory, the logs and the notes for the marker and the frame's base64.

### Provider retention

`POST /v1/decisions` has no `store` option: the API refuses `store: false` and `store: true` with `400 unknown_parameter` (probed with
a synthetic request on 2026-10-14), so the request is sent without it. OpenAI's data-controls page lists `/v1/decisions` as not used
for training, with no application-state retention and abuse-monitoring logs kept up to 30 days; Zero Data Retention is available
only by an agreement on the account. The notice's line is made from the category alone (no image); an escalated frame goes to the
look model, which asks the provider not to keep the request as the existing looks do.

### Deploying the nginx change (VM)

The vision location and the `client_body_buffer_size` lines are in `deploy/azure/nginx-location.conf`. On `azure-constant-server`:

1. Back up the site file that holds the sh4nnon.com TLS server block (`sudo cp /etc/nginx/sites-available/<site> /etc/nginx/sites-available/<site>.bak-$(date +%F)`).
2. Add `client_body_buffer_size 4m;` inside the existing `location ^~ /companion/` block, and add the whole `location ^~ /companion/v1/vision/` block
   above it (it is a longer prefix, so order does not decide, but keeping it first reads clearly).
3. `sudo nginx -t`, then `sudo systemctl reload nginx` (a reload keeps connections; no restart).
4. Check that nothing spills: send a synthetic 3 MB JPEG to a 404 path under `/companion/` with a device token and confirm
   `sudo find /var/lib/nginx/body -type f` (or the distribution's `client_body_temp` directory) stays empty; nginx logs
   `a client request body is buffered to a temporary file` at warn level when it would spill, so `sudo grep -c 'buffered to a temporary file' /var/log/nginx/error.log`
   must not grow.
5. Only then start `shannon-ios-vision.service` and switch `SHANNON_VISION_WORKER=on`.

## Contract (`services/api/src/contracts/visionContract.ts`)

- `vision.frame.v1`: frame id, capture/receive times, source (`app_camera`, `app_look`, `body_look`, `photo`, later `minecraft`,
  `screen`, `stream`), session and generation, privacy (`owner_private`, `shared_room`, `world_shared`, `stream_public`), the
  audience at capture, TTL, encoding (size and byte length only), the device gate's reason, closed scalar state.
- `vision.session.v1`: one bounded run of decisions (goal, parent task, deadline, budget, end reason).
- `vision.decision.v1`: candidate ids, the predicate probability and its threshold, the choice with its probabilities and
  confidence, the outcome (`chosen`, `quiet`, `discarded`, `refused`, `failed`, `skipped`) and why, timings, cost, generation,
  degrade level.
- There is no field that keeps a picture. Any of `persist`, `image`, `bytes`, `base64`, `data`, `jpeg`, `png`, `url`, `pixels`
  at any depth is refused. The Swift mirror is `apps/ios/Sources/ShannonAppCore/API/ShannonVisionContract.swift`; both sides read
  `services/api/tests/fixtures/vision-contract-v1.json`.

## Processes

- **Vision worker** (`services/api/src/visionWorker.ts`, `deploy/azure/shannon-ios-vision.service`, `SHANNON_VISION_WORKER`):
  loopback HTTP on `SHANNON_VISION_PORT` (4320) behind nginx `location ^~ /companion/v1/vision/`, the same device tokens
  (`SQLiteDeviceAuthStore`), the owner's scope only, never the Minecraft body's token. It holds the budget ledger, the frames, the
  sessions/generations, one decision at a time per device, and the reflex loop's home (`createVisionReflexHost`, no source
  registered in stage 1).
- **API bridge** (`wiring/visionBridgeWiring.ts`): an owner-only Unix socket (`mind-runtime/vision-bridge.sock`) served by the API
  over the same framed IPC as the mind worker. Methods: `vision.audience`, `vision.percept`, `vision.presence`, `vision.notice`,
  `vision.escalate`. The API stays the authority on who is present and on what is said. The worker opens two connections, because
  the API answers one connection's requests in order: `fast` (audience, percepts, presence; 400 ms deadlines) and `slow` (a
  notice's line and an escalation, seconds), so a notice never delays an audience check.
- **Two people seen** (`vision.presence`): besides the presence percept, the API writes the device's audience as `others` in the
  body store (`noteAudience`), so the API's own audience is `others` for its freshness window (90 s): every device stops watching
  and no notice or escalation is said. Nobody is named.

## Routes (worker)

| Route | Body | Answer |
|---|---|---|
| `GET /v1/vision/status` | — | `vision.status.v1`: `watchAllowed`, `reason` (`audience`, `degraded`, `disabled`, `budget`), degrade level, limits |
| `POST /v1/vision/frames` | JPEG (≤ 160 KB, long side ≤ 512 px), header `x-shannon-vision-frame`: `vision.frame.v1` | `vision.frame.reply.v1`: `watch`, `stopReason`, outcome, `candidateId`, `reaction`, `nextFrameNotBefore`; 429 too soon, 409 stale generation |
| `POST /v1/vision/presence` | `{ personCount, at }` | `{ watch }`; 2 or more people stop the device and send a presence candidate |

## 「見て気づく」 (camera notice)

One Decisions request (`infra/models/openAIVisionDecisions.ts`, `gpt-6-luna`, `detail: low`) asks the predicate
`needs_response` and the choice `vision_notice` together. Candidates: `quiet`, `react:<smile|surprised|curious|tender|concerned>`,
`notice:<owner_returned|owner_waved|showing_something|new_object|owner_looks_tired>`, `escalate` (only with
`SHANNON_VISION_ESCALATE` at level 0) and `other`. Initial thresholds (`VISION_NOTICE_THRESHOLDS`): predicate ≥ 0.7 (0.85 at
level 1), confidence ≥ 0.6, the same candidate not again within 60 s (react) or 30 min (notice, escalate), and at most 4 notices
and escalations together in any hour; anything else is quiet. What was chosen is kept in `vision_choices` (schema step
`vision/002_vision_choices`, closed ids and times), so the cooldowns and the cap survive a restart. A camera frame is never used
past 4 s, whatever TTL the device sent.
After the answer the worker checks again: the session generation, the frame's TTL and the audience (from the API) — a change
discards the answer, which is never acted on or re-asked.

- `react` returns in the frame reply; the app shows the expression at once.
- `notice` goes to the API: `VisionNoticeSpeaker` makes one short line from the category alone with the voice path's model
  (`vision_notice` background route, `SHANNON_ONE_LINE_VOICE` and the room-look rules), checks the audience before and after,
  holds while the owner wrote or spoke within 20 s or a voice call with her is going on (the kernel's owner-call watch, whose words
  may not be in the Talk yet), waits for the foreground speaking right (the `respond` slot a turn holds, stage 4), drops a notice
  older than 10 s, and writes her note once in the latest Talk,
  marked owner-alone (`vision-notice`). A delivered notice is also a small appraisal (`applyFcaAffectEvidence`, `vision:<id>`).
- `escalate` goes to the API under the same rules as a notice (the owner alone, not just spoken, no call going on, the foreground
  speaking right): the look model sees the frame once with no Talk context.
- Every non-quiet decision and every degrade change is a `percept` in the workspace (below).

## Workspace percept

`mind.event.v1` gains kind `percept`, surface `vision` and a `percept: { ttlMs, privacy, frameRef }` field present only on that
kind (`frameRef` names a frame in a process's memory, `frame:<id>`, never a picture). Attention reads it through the salience
input `percept` (its probability, weight 0.75). The workspace drops a percept at its TTL (`perceptExpired`), apart from
`noticeMinutes`, and renders only its closed code (`[いまの場] 目：…`); an `owner_private` percept has the owner's audience and is
never shown with anyone else present.

## look(source, purpose)

`mind/perception/visionLook.ts` is the one shape of a used look: an app look, a body look, a shared photo in a call and an
escalation each record `vision.frame.v1` metadata, one `look` percept and one Observer line. The audience and forgetting are applied
when the frame is used: `surfaces/body/lookContext.ts` gives a look's model the Talk through `visibleReplayMessages` (no forgotten
turn) and nothing while anyone else may be present (`ShannonBody.useAudience`); an app or body look that was opened with the owner
alone and used with others present gets no Talk lines at all; a shared photo with others present gets a guest's context only.
An FCA-callable `look` tool and `vision.session.start` for the deliberate loop are stage 1 follow-ups.

## Budget and degrade

`vision_budget_reservations` (schema step `vision/001_vision_budget`): every paid vision call reserves before it is sent
(Decisions $0.001, a notice's line $0.003, an escalation $0.01), settles with the measured cost, or is held at its reservation
when the usage is unknown. Daily cap ¥300 at ¥150/$ (owner's day). Levels: 0 normal; 1 at 80 % of the cap or a decision p95
above 4 s, a timeout counting its whole wait (fewer notices, no escalation); 2 at the cap or 3 failures in a row within 5 min (no image decisions, devices told to
stop); 3 with `SHANNON_VISION_HALT` (nothing decides). A level change is a percept (`degrade:N`).

## Observer

Nodes `visionGate`, `visionDecision`, `visionAct` (block 「目（視覚）」): the gate's stop reason, each Decisions call's predicate,
choice, confidence, input tokens, cost and time, the `vision.decision.v1` record (candidates, probabilities, discards, generation)
and each look's frame metadata. Never an image or screen text.

## Switches

| Switch | Default | Effect |
|---|---|---|
| `SHANNON_VISION_WORKER` | off | the worker and the API's bridge socket |
| `SHANNON_VISION_CAMERA` | off | camera frames are judged; off, devices are told to stop |
| `SHANNON_VISION_ESCALATE` | off | `escalate` is offered |
| `SHANNON_VISION_HALT` | off | level 3: every decision stops |
