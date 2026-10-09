# Mind Observer UI validation

## Common-FCA revision (2026-10-09)

Branch: `codex/shannon/fca-observer`, base `eaf6b84f`. The owner's compact dark
layout, semantic role colours, detailed processors, tool inspection, real
handoff packets, three-second receipt trails and reload retention are preserved.
The change adds task/parent/step/action correlation, seven processing lanes with
38 boxes, representative-path dimming, completed-duration statistics and
independent server/client timelines. The underlying conversation, action gates,
body release acknowledgement and native telemetry protocol remain in place.

| Preserve | Change | Do not change |
| --- | --- | --- |
| Detailed dark map, actual events, auth/audience checks, reload, tool registry and receipt motion | Common-FCA task selection and measured stage/stream/cache evidence | User task execution, permissions, body control or receipt authority |

The root used the actual routes and runtime through `scripts/observer-ui-smoke.ts`
in an isolated Chrome tab. `fca-run` creates real parent/child/sibling tasks in
in-memory stores and admits two FCA segments concurrently. The fixture model
is named `local-ui-fixture-no-provider`; its first decision waits on an explicit
manual gate. `fca-next` releases that gate, exercises a deterministic local
tool result and permits subsequent FCA segments. `fca-finish` completes the
controlled work; the ancestor may correctly return to waiting. These long
manual model intervals are UI test durations, not provider latency samples.
No production data, native client, paid API, external search or game is used.

Browser checks confirm populated parallel task selection, explicit child IDs,
step selection, tool-result projection, measured duration table, active receipt
clock, model-labelled missing cache usage, reload returning to LIVE without a
new code, and representative-path dimming with retained node inspection. At
the normal 1408px width and a temporary 390px viewport, document width equals
viewport width; the detailed map has a separately labelled horizontal scroller
on narrow screens. Audience HELD removes task IDs, inspector values, metrics
and timeline content. Console warnings/errors were absent during those checks.

The inspector and stream table distinguish first decoded reply handed to the
server callback from final usage receipt. Their missing samples remain missing.
Parallel span lengths are never presented as a wall-time sum; origin clocks are
not synchronized by this UI. WAIT is a state checkpoint; no dormant-wait or
acoustic-onset duration is manufactured. Static route choices do not demonstrate
that a path ran or that a legacy path was migrated.

This local record cannot establish live provider cache hits, production speed,
Minecraft internal telemetry or device installation. Production reflection and
live before/after measurements remain separate. The records below describe
earlier Observer revisions, not the new source's deployment.

Integration checks: API typecheck and `verify.sh fast` passed; full API
regression passed 337 files / 4209 tests with one worker (exit 0, 239.68 seconds).
After the final caller-boundary handoff additions, 6 affected files / 86 tests,
API typecheck and fast passed again. The final map/asset/fixture regression passed
4 files / 95 tests, including 41 frontend tests. The screenshots were refreshed
against that final local fixture. Independent review checked scope/task
isolation, others-touch receipt delivery, detached Promise timing, native
request equality, signed history and permission preservation. The reviewed
runtime-closure fixture adds only the new menu/observer modules and their menu
dependency; worker exclusions and import-cycle checks remain enforced.

Jev selection emits context-to-selector and selector-to-context handoffs only
when selection actually runs. Validated recall and committed compaction emit
return edges; reuse, rejected sources and cancelled work do not invent packets.
Reflex entry and touch selection expose their real conditional return paths.

Safe screenshots contain only the controlled local fixture:

- [Common-FCA map and task selection](observer-evidence/fca-overview.jpg)
- [Tool result, measured stages and detailed loop](observer-evidence/fca-tools-timing.jpg)
- [Duration statistics and timeline](observer-evidence/fca-stage-timings.jpg)

Date: 2026-10-08. Branch: `codex/shannon/signal-observer`.

## Scope and preservation

The owner-approved dark signal-map composition is implemented in
`services/api/src/infra/observer/web/`. The page observes Shannon; it does not
start a conversation, execute a tool, or control an existing action.

| Preserve | Change | Do not change |
| --- | --- | --- |
| Approved dark layout, distinct JeV voice/tool selectors, LLM, tools and converters | Replace the prototype's replay with authenticated, measured observer events | Conversation behavior, action permissions, model requests, or data ownership |

The main action is pairing and observing. Selecting a node, run, or individual
span reveals its measured input, output, timestamps, model, parent and source.
The TOOL inspector separates catalog definitions from observed offered,
selected and executed tools. Lines show the fixed architectural map; a packet
is created only for a newly received handoff event. Its 240 ms motion is receipt
feedback, not a representation of network latency.

## Deterministic checks

`pnpm exec vitest run services/api/tests/observerWeb.test.ts` passed 22 tests.
These cover incremental ordering and deduplication, overlapping spans, isolated
runs, actual root TURN spans, terminal-only output, failed roots, unknown status
after connection loss, held-state erasure, server restart, cursor expiry,
publisher loss, bounded retention, per-run tool evidence, pairing, late-response
fences, credential replacement, polling pause/resume, backoff and auth refusal.
Correlated voice-response, speech-request and native-playback spans are also
tested: completing an earlier request root does not prematurely close a later
speech root or an active player under the same utterance ID. Only unfinished
children of an actually closed ancestor become unknown.

The selected utterance also includes retained spans explicitly referenced by
handoff `sourceSpanId` or `parentSpanId`. Source-run hints (`captureRunId` and
`utteranceRunId`) disambiguate exact IDs. These referenced spans retain their
original run ID and server/client provenance and are marked `↗ 参照`; the event
list remains scoped to the selected run. Tests verify that the accepted STT
source appears while unrelated session PCM chunks and other transcripts do not.
Missing or ambiguous source references remain unobserved, and timestamps never
establish a link. The final reference resolver was also checked in Chrome with
controlled client events submitted through the real authenticated ingestion
route; this is transport/UI evidence, not a physical microphone capture test.

Provenance tests retain `server` and `client` sources, recover a model explicitly
present in a client payload, and reject a client event that attempts to close a
server run or overwrite an existing span using a different node/source.

## Real browser validation through an isolated fixture

`scripts/observer-ui-smoke.ts` runs the actual asset routes, SQLite pairing and
device authentication, observer context/publisher, catalog, authenticated
event route and native-client ingestion route on a temporary loopback HTTP port.
Both stores are in memory.
It contacts no model, production database, native app or external service.
Server workload IDs are named `UI-FIXTURE-*`. The `client-links` command uses UUIDs
required by the actual client contract, an `isolated-cross-run-ui-fixture` server
surface and `fixture: true` payloads. The screenshot contents are controlled test work, not actual
owner conversation or production activity. No demo data exists in the product
page itself.

The browser was driven through the documented CUA browser interface. No file URL
preview, raw CDP or alternate screenshot mechanism was used. The fixture pairing
code and token are intentionally omitted from this document. To repeat the final
reference check, run the script, pair the browser first, then enter `client-links`
on stdin. Select the printed utterance run and TRANSCRIPTION. Enter `run` for the
overlapping-tool fixture, `finish` to close its spans, and `close` to stop the server.

Verified in the browser:

- Pairing through the real `/v1/pair` route and authenticated polling reaches LIVE.
- The 1280 px desktop, 834 px tablet and 390 px compact view have document widths
  equal to their viewport widths. Compact mode uses two columns; the inspector
  moves below the map at narrower widths.
- Native keyboard Enter selects TOOL. Two active tool spans show `ACTIVE / ×2`;
  a separate background run remains separately selectable.
- Offered-tool filtering, domain expansion, selection and the real tool schema
  render in the inspector. Actual catalog content is read-only.
- The measured span source displays `SERVER / サーバー観測`. The final client
  fixture displays `CLIENT / 端末からの報告 · 別runの参照` and the original capture
  run ID. TRANSCRIPTION shows `DONE / ↗ 参照`; its span picker contains only the
  accepted STT span. The same capture session contains a different transcript
  and a completed PCM chunk, but neither appears in the selected utterance.
- The refreshed native catalog labels PCM, STT, utterance and playback as
  instrumented client nodes. The inspector explicitly states that telemetry
  requires an installed Apple build from this branch. Minecraft and Agent Host
  remain external/unmeasured. No physical Apple client was used for this check.
- Switching the fixture audience to held removes all run identifiers, inputs,
  outputs, events and packets from the DOM. Returning to owner-alone restores
  only data received from the authenticated route.
- Completing the controlled work changes spans to DONE. The decoder's literal
  `<script>` test string remains text; its output element has no child elements.
- Finite bursts of actual fixture `observerHandoff` calls produce packets on
  the orthogonal LLM-to-TOOL route. CUA observed an 8 by 8 px packet in the gap
  between those boxes; the screenshot shows the cyan dot on the wire. The packet
  count returns to zero after the burst. The product motion was not lengthened,
  replayed or given a permanent animation loop for the test.
- No browser warning, error or CSP rejection was reported for the inspected page.
- Stopping the local HTTP fixture while a span is active shows UNKNOWN and
  explicitly unconfirmed output. Disconnecting then removes the run identifiers
  and input/output again. Network-failure console entries during this deliberate
  offline test are expected.

The initial runtime check exposed a locale-format issue (milliseconds without
hours) and the absence of root run spans on TURN; both were corrected before
the completed-state and provenance captures.

## Visual evidence

These versioned screenshots contain only controlled, isolated fixture data.
Pairing codes and tokens are absent. Final desktop and compact captures were
repeated after the native catalog and cross-run reference changes:

- [Desktop: referenced STT, original source run and client provenance](observer-evidence/desktop-client-reference.jpg)
- [390 px compact: the same reference, with the inspector below the map](observer-evidence/compact-client-reference.jpg)
- [Desktop: two active tools, offered catalog and separate background run](observer-evidence/desktop-tools-active.jpg)
- [Earlier packet check: measured handoff receipt on the LLM-to-TOOL wire](observer-evidence/desktop-handoff-packet.jpg)

The packet image predates the final client coverage labels; it records only the
unchanged receipt-animation behavior. The other three captures reflect the final
UI. The final Chrome pass reported no warning, error or CSP rejection; widths
were exactly 1280 and 390 px with no horizontal document overflow.

## Limits and remaining release evidence

This validation covers the browser surface and real local observer transport
using deterministic work. It does not establish live model behavior, Apple audio
capture/playback, deployed server availability, or physical-device behavior.
Native telemetry and its correlation require the app-owned Swift checks and
runtime release gates. Reduced Motion and increased-contrast CSS are present,
but OS-level accessibility variants and screen-reader operation were not
manually exercised in this fixture. Dark appearance is the owner's selected
operator-surface design; a Light variant was not introduced.

The catalog's source paths and coverage labels must continue to distinguish
server observations, native client reports and unconnected external bodies.
Workspace observations describe projection/render operations; they do not
measure every internal lease operation of the separate mind worker.

The fixture server was stopped after validation, the test browser tab closed,
and the temporary viewport override reset. Its former temporary URL is
not a product endpoint. For a real observation session, open `/observer` (or
`/companion/observer` behind the existing proxy) on the running Shannon API and
pair there. The validation script is only for repeating this isolated check.

## Role colours and three-second receipt trails (2026-10-09)

The owner's reference uses dark boxes, light text and consistent coloured
circuits. The viewer now assigns stable role colours: gold for input/perception,
coral for Jev/context/response reasoning, mint for tools/control/execution,
blue for reply/audio output, and lavender for memory/learning. Node type labels,
box borders and backgrounds, inspector headings and event labels retain this
role even when state changes. Wires, arrowheads and receipt packets use the
sending node's role. A text legend explains the colours; state still has a
symbol and label, so colour is not the only source of information.

Each newly received selected-run event illuminates its observed node. A handoff
also illuminates its two endpoints and its actual wire. The glow fades linearly
from 0.7 opacity to zero over the owner's requested 3000ms; another receipt
renews the window without adding another animation for that box/wire. At most
96 trails exist. The existing 240ms packet motion remains separate. Opacity-only
glow is retained under Reduced Motion while moving packets stay suppressed.
History loading, gaps, losses and server changes do not replay trails. Run
changes, disconnection, audience hold, resize and page hiding clear them.

The isolated fixture's `handoff-burst` sends 30 actual fixture handoffs at 250ms
intervals, then stops. Browser inspection showed the LLM-to-TOOL wire and both
halos at opacity 0.676649 during receipts, and zero halos/no overlay paths after
the window. There were no browser warning/error entries. The existing TOOL
view retained two concurrent ACTIVE spans and offered-tool filtering. The
1280px desktop and 390px compact viewports had no horizontal document overflow;
all compact boxes fitted within the viewport. Audience hold during a receipt
burst removed every trail, packet, lit halo and private run option. Evidence:
[Role colours and actual receipt glow](observer-evidence/desktop-colors-receipt-glow.png).
This is controlled local transport evidence, not a production flow or model call.

The independent review found that the old packet predicate (also used by the
first glow implementation) treated page two of retained history as live. A
receipt catch-up gate now drains every full 200-event page before enabling
effects. Deterministic regression covers 201 old events, subsequent fresh
handoffs, gap/loss/restart and reconnect. No event time is used as causation.

The owner also requested reload without entering another code. The browser now
keeps only the token/expiry in tab-scoped sessionStorage, never pairing codes or
observed payloads. Controlled fixture pairing reached LIVE; reload returned to
LIVE with the pairing panel hidden and no historic trails; explicit disconnect
followed by reload stayed disconnected. Tests cover restored credentials,
one-time-code reuse avoidance, revoked/expired/malformed credentials and blocked
storage. The original authentication and audience checks remain in force.
