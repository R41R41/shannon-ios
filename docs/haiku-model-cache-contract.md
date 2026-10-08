# Haiku model and cache contract

Status: implementation authority for the Haiku migration candidate. Production activation and Apple delivery require their own verified gates and owner approval; this contract does not assert that the candidate is deployed. Own-time shared-key activation requires a separate verified environment receipt.

This contract owns the current small-model provider, credentials, cache and cost boundary. [architecture.md](architecture.md) owns response/worker boundaries, [skill-and-routing-contract.md](skill-and-routing-contract.md) owns logical tier selection, and [self-improvement-runbook.md](self-improvement-runbook.md) owns delivery.

## Selection and compatibility

`DEFAULT_HAIKU_MODEL` in `infra/models/anthropic/haikuConfig.ts` is `claude-haiku-5-5`. Normal factories resolve an absent setting or the replaced `gpt-5.6-luna` family, including dated suffixes, to Haiku. Other deliberately configured model IDs remain unchanged. Existing own-time preferences retain their stored model ID, reason and timestamp: the registry resolves an old Luna preference to equivalent Haiku research/reading or planning at use time, without rewriting the preference. Gemini prose/critique and GPT Terra/Sol registry entries retain their behavior.

Text, voice reply, Jev's lightweight fallback and the migrated small-model background paths use the official `@anthropic-ai/sdk` native Messages API when they resolve to Haiku. Explicit non-Haiku models use their existing provider path; OpenAI transcription, embeddings, explicit Terra/Sol and Gemini synthesis/vision remain separate capabilities. The pattern-wiki maintainer retains its explicit Terra default.

`luna`, `luna_plus`, `luna_weak` and `judgedBy: luna` are durable logical symbols in existing policies and ledgers. Preserve them and historical rows; actual model fields identify the model that was asked. Haiku and Sonnet both use provider `mode: anthropic`, so `servedTier` independently identifies which logical tier answered. `SHANNON_SONNET_ROUTING=off` blocks the Sonnet conversation tier and leaves the Haiku base model available. The separately gated sleep proposer keeps its existing Sonnet rule.

## Credentials and native transport

| Path | Credential | Boundary |
| --- | --- | --- |
| Regular Haiku | `SHANNON_HAIKU_API_KEY`, else `SHANNON_ANTHROPIC_API_KEY`, else `ANTHROPIC_API_KEY` | The first setting is Haiku-only; the existing shared-key fallback remains for compatibility. Server only; no key is returned to a client or prompt. |
| Existing Sonnet hooks | `SHANNON_ANTHROPIC_API_KEY`, else `ANTHROPIC_API_KEY` | Haiku-only key addition does not activate Sonnet routing or the sleep proposer; their existing gates and Terra fallback remain. |
| Own-time Haiku | `SHANNON_AUTONOMY_ANTHROPIC_API_KEY` only | The setting is always required explicitly. Equality with any of the three regular Haiku/Anthropic values is unavailable by default; only owner-authorized `SHANNON_AUTONOMY_ANTHROPIC_SHARED_KEY=on` permits equality. There is no regular-key fallback. |
| Own-time Gemini/GPT | Their existing `SHANNON_AUTONOMY_GEMINI_API_KEY` / `SHANNON_AUTONOMY_OPENAI_API_KEY` | Existing dedicated-key, distinct-value and registry boundaries remain; the Anthropic opt-in does not apply to Google/OpenAI. |

The owner's current instruction may authorize the Anthropic same-value opt-in above; it does not authorize regular-key fallback or a different provider's sharing. The shared key's provider cap is not a separate own-time-only spending limit. Existing application daily/session budgets, reservations, caller stop checks, unknown outcomes and mandatory cache requirements still apply.

Native clients explicitly select the official API origin, `authToken: null`, `webhookKey: null`, `logLevel: off` and `maxRetries: 0`. Ambient SDK bearer-token/base-URL/log settings must not change the credential or transport boundary. Model failures expose closed codes, never SDK error text containing request material or a credential.

The own-time adapter combines request, current-action and timeout cancellation signals and rechecks the live action permit immediately before its only request. It uses adaptive thinking at low effort while retaining the existing maximum output-token ceiling; thinking consumes that same output budget. No request is resent automatically after an uncertain outside result. Existing stop, scope, audience, approval and permission gates remain authoritative.

## Mandatory useful one-hour cache

Every Haiku Messages request passes through `cacheHaikuRequest` in `haikuCache.ts`. It adds a stable, useful transport protocol describing quoted reference material, task/schema fidelity, uncertainty and separation of thinking from the final result. It does not replace Shannon's canonical persona or grant a new ability. Task-specific instructions and variable input retain their existing authority and meaning.

The stable prefix must reach at least 512 Haiku model tokens, verified with the native token-count API rather than character count. Its explicit cache breakpoint and automatic conversation caching both use `ttl: 1h`. Existing breakpoints are checked for compatible TTL and the native breakpoint limit; repeated application does not duplicate the prefix. Tools/system precede changing conversation material so repeated requests can reuse the stable part.

A cache-control block alone is not proof of caching. After a real response, require safe, nonnegative integer input, output, cache-creation and cache-read counts and positive creation or read usage. A response with known zero creation and zero read fails closed after recording its actual spent usage. Missing/null/malformed required counts leave the usage unknown; an own-time reservation is not settled as zero. Known refusal, truncation, empty output or a cache-contract failure retains known tokens and cost. Returned task text excludes internal thinking.

Requests use one-hour cache controls. Provider server tools can additionally produce five-minute cache writes; valid native five-minute/one-hour usage breakdowns are accepted and charged at their actual TTL. An absent breakdown uses the conservative one-hour write price for Haiku. This preserves existing web-search/tool behavior. See the [official prompt caching documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

## Cost and budget accounting

The implementation's Haiku prices are USD per million tokens, selected by total input = uncached + cache creation + cache read:

| Total input | Uncached input | Output, including thinking | Five-minute write | One-hour write | Cache read |
| --- | --- | --- | --- | --- | --- |
| At most 100,000 | 0.10 | 0.50 | 0.125 | 0.20 | 0.01 |
| More than 100,000 | 0.50 | 2.50 | 0.625 | 1.00 | 0.05 |

`estimatedAnthropicCostUsd` applies the selected tier to actual uncached, write, read and output counts, plus the existing web-search charge. Valid TTL subtotals must sum to cache creation. The own-time `AutonomyModelUsage` carries those counts through errors as well as successful results; its existing spend table retains total token counts and the resulting cost without a new cache column.

Before an own-time paid action, `paidCall` includes the stable prefix in its conservative input estimate and reserves all estimated input at the one-hour write rate plus the maximum output/thinking cost. Configured own-time prices are treated as base input/output rates with the corresponding cache multipliers and long-context tier. Old Luna price settings resolve to Haiku; an explicit Haiku setting wins if both are supplied. Permission is refused before any RPC when that reservation exceeds the existing cap. A cache hit never waives the budget gate.

On a closed response, charge actual ordinary input, write/read and output. On an incomplete usage receipt or interrupted call, retain the original unknown-action/reservation handling; do not fabricate an acknowledged zero. Background/main usage likewise records known lower-bound spend and a conservative bound when complete native counts are unavailable, so a malformed receipt cannot free budget. The conversation token bound includes the separately acknowledged web-search fee; taking the larger token estimate must not absorb that fee. Historical Luna cost examples in earlier architecture sections are historical estimates, not current Haiku prices.

## OFF proofs and verification

Stage2/3 switches control those architecture features, independently of the intentional model/provider migration. Existing OFF byte goldens use an explicit historical GPT provider/model profile; Stage3's test-only pure registry/default/estimate/price policy is pinned to that historical profile while the real loop, gate, store and feature wiring run. Do not regenerate the old digests, alter expected receipts, add a production legacy mode or mock away a feature boundary to make the historical proof pass.

Deterministic verification covers native Messages/cache shape, credentials, unconditional low effort, required usage counts, paid error outcomes, action stop/abort, no retry, configured prices, long-context tiers, real budget refusal and the historical OFF proofs. These mocked/offline checks cannot establish live provider availability or cache reuse.

For readiness in the intended environment, retain content-free receipts for the native model/API response, native prefix token count, a real cache creation and a repeated-request cache read. Distinguish the Haiku-only/shared regular credential's proof from own-time dedicated-key readiness. Prefer the Haiku-only setting for a Luna-to-Haiku deployment so installing its key does not enable an otherwise unavailable Sonnet hook. A regular/Minebot key probe does not establish that own-time Haiku is configured. Until the explicit own-time key and its policy are installed and verified (a distinct value by default, or the owner-authorized same-value opt-in), own-time Haiku remains unavailable and configured Gemini behavior continues under the existing registry selection rule. Same-value sharing readiness must not be described as a separate provider spending cap or inferred from a regular-key probe alone.

Production deployment and a main push remain separate from implementation/testing. Present the exact candidate, scope, full verification and credential readiness for owner approval according to the runbook. A server-only main push can start Xcode Cloud/TestFlight and therefore needs the same explicit delivery decision.
