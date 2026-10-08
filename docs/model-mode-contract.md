# Owner-selected primary model mode

Status: implementation and local verification complete on `codex/shannon/model-mode`. The original `45da5323` base was rebased onto maintained main `88438ff7`; reviewed runtime candidate `4269f78d` passes the complete verification command. This document does not assert deployment, live Sonnet readiness, or physical-device acceptance. The owner's 2026-10-09 instruction supersedes the former automatic primary-model selection policy when an explicit mode is selected.

## User job and preservation

The owner changes Shannon's primary reasoning model from the iPhone or Mac settings without editing server environment files or losing conversation history. The same owner setting is shared by both devices.

| Preserve | Change | Do not change |
| --- | --- | --- |
| Native settings, semantic colors, pairing, conversation and memory, tool discovery, streaming, cancellation, budget and permission gates | Add Normal (Haiku 5.5) and High precision (Sonnet 5.5) selection, persisted by the owner-scoped server | Persona, unrelated settings, model weights, daily limits, incomplete action receipts, physical world or automatic game restart |

The primary action is choosing a mode; the secondary action is reloading the confirmed setting after a failure or conflict. The screen distinguishes loading, saving, confirmed, unsupported server, unavailable model, offline and conflicting changes. A failed or uncertain save never displays an unconfirmed value as saved or automatically repeats a PUT.

Selection must be conveyed by text and native selection state, not color alone. Labels wrap at large Dynamic Type sizes. Controls are keyboard and VoiceOver accessible, with saving and unavailable states explained. Reduced Motion requires no animation to understand state.

## Scope and turn boundary

`haiku` selects the primary Haiku model; `sonnet` prefers the configured native Sonnet primary model. Existing safe fallback reports its actual served model. Auxiliary extraction, titles, checking and other bounded helpers retain their intended models. Haiku's medium-effort reconsideration remains available without automatically promoting an explicitly normal-mode primary turn to Sonnet.

Each new conversation turn takes one owner-mode snapshot before asynchronous preparation; all its tool rounds and fallback share that snapshot. A change applies to the next turn, not to an in-flight signed conversation. Own-time planning similarly pins the primary model per paid planning step. Scope, model availability, dedicated own-time credentials and existing spending permissions remain authoritative. Responses advertise only scopes actually connected, rather than claiming a Minecraft setting before the body contract and consumer support are verified.

Minecraft integration requires the owner mode/model/revision on the original queued request and a capable body consumer. An old body must not silently execute a requested Sonnet run with Haiku. The running task must retain its original model through continuations; mode changes apply to a new request. Body compatibility and receipt verification are implementation gates, independent of gameplay resumption.

The body advertises `supportedPrimaryModels` on each authenticated claim. Admission and handoff use that claim's own capabilities, so another concurrent claim cannot lend it support. The original request's `primaryModel` travels through the companion task metadata to `ShannonExecutor`; title and continuation summaries use Haiku. A pinned request cannot fall through to another execution engine on failure. Pre-rollout unpinned requests retain their original compatibility path. The legacy consumer implementation is local commit `0581706002cf2ba41b68e69c8fe8bfca8ff0e9eb` on `codex/shannon/minebot-model-mode`, based on maintained legacy main `e94a236c`; this is independent of the recorded legacy production `f4b2174d`.

## Server authority

`GET /v1/model-mode` reads the paired owner's confirmed snapshot. `PUT /v1/model-mode` accepts `{mode: 'haiku' | 'sonnet', expectedRevision: number}` (the existing same-owner `scopeKey` field is tolerated). No client-supplied scope selects another owner's setting. A saved change increments the durable revision; saving the identical mode at the current revision is idempotent. An unavailable requested model, stale revision, unauthorized owner or storage failure preserves the existing selection.

The response carries `mode`, `revision`, `available`, `models` and `appliesTo`. A late response for different pairing credentials cannot update the current client's settings. An uncertain PUT is reconciled with GET, never blindly replayed. No credential is returned or logged.

Sonnet availability retains the existing `SHANNON_SONNET_ROUTING=on`, stage-2 difficulty and shared Anthropic credential requirements, and the exact `claude-sonnet-5-5` configuration. Turning that server gate off after a saved Sonnet selection blocks the next primary turn; it does not silently rewrite the preference. Own-time planning additionally requires its explicit dedicated credential, with the existing owner-authorized shared-value opt-in. A deliberate older Haiku/GPT/local-stub server override remains operative, but is not presented as an available Haiku 5.5 selection. `models` identifies the actual configured model and the UI distinguishes that override.

## Native cache and model capability

Exact native Haiku 5.5 and Sonnet 5.5 use bounded initial strict tool menus, full discovery through `tool_open`, by-value inline additions, append-only system/tool/history prefixes, and the same native transport. Existing historical model overrides preserve their compatibility profile. Thinking and its signature remain intact through tool results and explicit offer-refusal recovery.

Both selectable native models require one-hour stable-prefix and growing-conversation cache controls. Record provider usage before rejecting missing cache evidence or incomplete output. Positive creation or read counts confirm cache use; cache flags alone do not. Warm hits and live native token counts remain separate readiness evidence. Unknown costs and interrupted external actions retain existing conservative treatment.

Cache/usage evidence failure ends that paid round without another output-repair call. If a tool already ran, its receipt and known usage remain recorded and the existing fixed ending is returned; before any tool or visible answer, the existing safe conversation fallback remains available. Ordinary timeouts and explicit schema-offer rejection retain their original recovery paths.

Exact Sonnet 5.5 future usage is estimated at $2/M input, $10/M output, $2.50/M five-minute write, $4/M one-hour write and $0.10/M read. Missing write TTL uses the conservative one-hour rate. Historical saved costs, unknown reservations and older configured model estimates are not rewritten.

## Verification required

Deterministic tests cover scope isolation, persisted revision, concurrent/conflicting changes, unavailable models, uncertain saves, credential-change races, mode pinning across asynchronous preparation and tool rounds, own-time credentials/budgets, and native fixed-prefix/cache/recovery semantics for both 5.5 models.

Apple verification covers shared Swift state, both application builds and synthetic settings flows. The shared state/API tests pass 24 cases. On 2026-10-09, isolated iPhone 17/iOS 26.5 Simulator Light selection and Dark unavailability, plus Mac Debug Light selection/conflict and Dark uncertain-save/reload recovery, were verified by actual operation, accessibility state and visual inspection. The synthetic data never contacts the real API. Large Dynamic Type, Increase Contrast, Reduce Motion, spoken VoiceOver, physical iPhone acceptance and a paired live server round trip remain unverified. Device and production acceptance are reported independently. Minecraft tests cover capability negotiation, original request model pinning and its consumer before adding it to the advertised scope. No gameplay or paid native evaluation is automatically triggered by changing the setting.

## Validation evidence and limits

- Shared Swift tests: 777 XCTest cases and 199 Swift Testing cases passed, including the 24 mode state/API cases. Unsigned generic iOS, iOS Simulator and Mac Debug builds passed; native synthetic screen checks are scoped above.
- Legacy Minecraft consumer: 10 focused files / 182 tests passed; the final narrowed follow-up passed 3 files / 18 tests (overlapping counts, not additive). The common package build and a strict six-module mode-pinning typecheck passed. Full legacy typechecking exhausted 6 GB on both the candidate and unchanged `e94a236c` baseline on VM Node 22.21.1; that global gate is not a pass and produced no semantic conclusion. No game or paid model was started.
- An initial local full check found missing new runtime-path expectations, which were explicitly updated without regenerating historical Stage 2/3 digests. The same run's latency and worker timeouts were reproduced as passing under one worker with the original assertions and timeouts. The new real web tool also required an explicit describing-effect classification and exact registry/surface-count expectations; those were corrected. The final complete run uses one Vitest worker on this 8 GB Mac with unchanged test assertions/timeouts.
- Final `scripts/verify.sh all` passed with exit 0 on `4269f78dcce0bd6f0dea3a7730cfa427e003166c`: API 279 files / 3,712 tests; four shared packages 39 files / 425 tests; Swift 777 XCTest + 199 Swift Testing cases; unsigned iOS Debug build; Mac Debug build/tests; seven restored-inspector launch cases (12 seconds each); eight release-runner cases. The complete command also passed its architecture, product specification and workspace guards. Reviewed files were hash-checked after completion. Local evidence: `/tmp/shannon-model-mode-verify-candidate.json` and `/tmp/shannon-model-mode-all-final.log`.
- The weather repair has 32 deterministic regressions. Independent review checked native actual-result/source evidence, Jev-selected promise-only recovery, discovery after Jev selects no tool, pre-run denial and skipped time/limit/cutoff, signed pause continuations, unknown fee retention, original cancellation, compound-result preservation and safe voice fallback. The final registry follow-up passed 82 overlapping tests. No test response is evidence of an actual external weather search.
- Live Sonnet cold/warm provider-cache evidence, paired owner setting propagation between real devices, physical-device acceptance, signing/archive/distribution and production acceptance remain separate release gates.

## Delivery compatibility

The API, own-time worker and companion consumer form one reviewed delivery set. The new API refuses new pinned game requests until the body advertises support; an older API rejects the new claim field. Upgrade or roll back both producer and consumer before accepting new game work. The additive preference/request columns preserve existing data and pre-rollout requests. An older API produces the app's unsupported-setting state. Deployment must keep the owner's Minecraft pause and the intended next world (`shannon-home`); changing the mode grants no gameplay restart. A live Sonnet cold/warm cache measurement remains a separate readiness check and must not be inferred from deterministic fixtures or earlier Haiku measurements.
