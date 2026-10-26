# Minebot's task queue and "continue until" (2026-10-26)

The head's side of the wire between the head (this repo) and the body (Shannon repo, `integration/commonFca/bodyQueue.ts`). Design: Syzygy
`notes/minebot-task-queue-design-2026-10-26.md` (owner's decisions at its end are what counts). Nothing here is switchable: every `mc.act` is a queue item.

- Head: `minecraftLlmcQueue.ts` (the mirror: items, `after`, news, when the next decision is due), `fcaStretch.ts` and `fcaToolRound.ts` (a step that goes on
  while items run and commits when none is open), `fcaMinecraftActItem.ts` (`mc.act` as an item), `minecraftConditions.ts` (the conditions).
- The step holds one lease for the whole stretch (ADR-0014 section 9 is kept): an item is a command of the step's lease, a receipt that cannot be had throws
  in the step, and the step commits only when nothing is unsettled.
- The next decision is asked when no item waits and the running one has T seconds left (T: the median of the last ten decisions, 2 to 8 s).

Worktrees: head `C:\Shannon\shannon-ios-wt\mc-task-queue` (branch codex/shannon/mc-task-queue, base 0f17ef0), body `C:\Shannon\Shannon-mc-task-queue` (same branch name, base 4ac81af).
Everything below is NOT switchable: there is no flag. Every mc.act from the head becomes a queue item (`command.queue` present); a command without `queue` (probe, view, stop, release, capture, older head) keeps working as before.

## 1. Condition JSON (`ActCondition`), the only form the body reads (the head parses text into it; the body never parses text)

```ts
type Dim = 'overworld' | 'the_nether' | 'the_end';
type ActClause =
  | { k: 'have'; item: string; n: number; op?: '>=' | '<' }   // op default '>='. item = id or the end of ids (`log` = any *_log); counts of all matching ids added, worn armour/offhand included. 'gold_armor' = any golden armour piece. Same as head `carried()`.
  | { k: 'food'; n: number }                  // carried food points >= n (body: sum itemFoodPoints*count over the pack, as `carriedFood` of the head)
  | { k: 'hunger'; n: number }                // bot.food >= n   (0..20)
  | { k: 'hp'; n: number }                    // bot.health >= n (0..20)
  | { k: 'dim'; dim: Dim }
  | { k: 'at'; x: number; y: number; z: number; r: number; dim?: Dim }   // feet within r (euclid) of the point; with dim: only in that dimension
  | { k: 'near'; block: string; r: number }   // a block whose name === block or endsWith('_'+block) within r (1..8) of the feet (bot.findBlocks, maxDistance r)
  | { k: 'free'; n: number }                  // free inventory slots >= n
  | { k: 'time'; t: 'day' | 'night' }         // night = the time a bed can be slept in (timeOfDay 12542..23459, or thundering); day = otherwise
  | { k: 'furnace'; x: number; y: number; z: number }  // the furnace the body itself filled at that cell has finished: state.world.jobs entry for that cell with remainingEstimateMs <= 0 (no entry => false)
  | { k: 'safe'; r: number };                 // no hostile within r that can come to her: isThreat(bot, e) && threatExposure(bot, e) !== 'sealed' for every entity within r
type ActCondition = ActClause[][];            // alternatives (OR) of conjunctions (AND). 1..4 alternatives, 1..6 clauses each. Strict: unknown keys are errors.
```
Text form (head only, for the model): clauses joined by `&`, alternatives by `|` (`&` binds first): `have:<item>` `have:<item>>=<n>` `have:<item><<n>` `food>=<n>` `hunger>=<n>` `hp>=<n>` `dim:<overworld|nether|end|the_nether|the_end>` `at:x,y,z[~r][@dim]` (r default 4) `near:<block>[~r]` (r default 4, max 8) `free>=<n>` `time:day` `time:night` `furnace:x,y,z` `safe~<r>`.

## 2. Command: new optional `queue` envelope (kind 'skill', skill 'act' only)

```ts
interface MinecraftQueueEnvelope {
  item: string;            // /^q[0-9]{1,6}$/ ; unique per task
  after: string | null;    // the item that must be the TAIL of this owner's queue when this command arrives (running or waiting). null = the head believes the queue is empty.
  node: string | null;     // plan node id like 'p7' (for the UI), may be null
  pre?: ActCondition;      // checked once, right before the item starts; unmet => item not started, receipt failed/precondition, rest of the queue dropped
  maxMs: number;           // the item's own run limit, counted from the moment the item STARTS (1000..180000)
  startBy: string;         // ISO time; an item still waiting after this is dropped (queue_expired)
}
// MinecraftControlCommand gets  `queue?: MinecraftQueueEnvelope`.
```
`arguments` of the act command = the ordinary act input (hands, stopIf, why, accept, facing) plus two NEW act fields the body's `act` skill takes: `repeat?: number` (integer 2..8) and `done?: ActCondition`. (`pre` and `replace` are NOT act arguments: `pre` lives in `queue.pre`; `replace` is head-only and becomes `cancel`.)
`deadlineAt` of a queue command: the head sets it to (now + the run time of the items ahead + maxMs + 5 s), never more than 630 s ahead. For a command WITH `queue` the body checks only `deadlineAt > now && <= now + 630_000` at accept, and runs the item for `min(queue.maxMs, skill maxDurationMs)` counted from the item's start (ignore `deadlineAt` as the run limit).

## 3. Body queue rules (controlLoop + bodyQueue)

- One owner key (`identity(command)`: lease id/generation/holder/scope/task), as now. One item runs at a time; up to **2 more wait** (so 3 in all). Probes (read-only skills) still run beside the running item, as now.
- accept(queue command) when valid and the body is not `held`, owner matches (or none), lease generation not older:
  - nothing running and nothing waiting: if `after` is null => start now. If `after` is non-null: if it is in `recent` (the last 16 finished items) as ok => start now; as not-ok or unknown => refuse `queue_after_gone`.
  - something running or waiting: `after` must equal the tail item id (last waiting, else the running one); else refuse `queue_after_gone` (after null with a busy queue => refuse `queue_busy`). A 4th item => refuse `queue_full`.
  - a refusal is a receipt `{ outcome:'failed', inputsReleased:true (no hand moved; false only when the body is `held`), failureType:'queue_after_gone'|'queue_busy'|'queue_full', result:<one Japanese sentence> }` and does not change the queue.
- Start of an item: (1) `startBy` passed => receipt cancelled/`queue_expired`, drop the rest. (2) `pre` unmet => receipt `{outcome:'failed', failureType:'precondition', inputsReleased:true, result:'前提を満たさず始めなかった: <words>（手は動かしていない）'}`, drop the rest. `<words>` = clause words like `raw_iron 1/3`, `かまど (x,y,z) が近くに無い`. (3) otherwise run through the existing path (`afterReflex` wait first, then the act). The item's clock starts here.
- When the running item ends:
  - receipt outcome `completed` (act ok: all hands done, or `done` met, or repeats used up — including "done condition still unmet") => the first waiting item starts at once (no poll round trip; < 50 ms).
  - anything else (failed, cancelled, unknown, stopped by reflex/stopIf/…) => every waiting item is dropped, each with receipt `{outcome:'cancelled', inputsReleased:true, failureType:'queue_dropped', result:'捨てた: 前の項目 q12 が止まった（<why: failureType or outcome>）。手は動いていない'}`.
  - `owner` is released only when nothing runs and nothing waits.
- `reply.cancel` containing a waiting item's id => that item is removed with a `cancelled` receipt (`queue_dropped`, result '捨てた: 取り消された。手は動いていない'); a running item is aborted as now (then the rule above drops the rest).
- `stop` / `release` cleanup commands, `abortActive()` (operator stop), `CONTACT_LOSS_MS` silence (15 s), body disconnect: abort the running item AND drop all waiting ones (cancelled receipts as above).
- Contact loss: the 15 s rule now also drops waiting items (they were never running).
- Poll (body -> head) gets two optional fields:
  - `queuedOperationIds?: string[]` — waiting item command ids, in order. `activeOperationIds` keeps meaning: ids running now (the one item + running probes).
  - `queue?: { id: string; hand: number; of: number; iteration: number; repeat: number }` — progress of the running item: `hand` 1-based index of the hand being run in this pass, `of` = hands in the pass, `iteration` 1-based, `repeat` = the item's repeat max (1 when none). Updated at every hand start (from the act's `minebotActStep` event; add `iteration` to the event).
- Receipts of dropped/refused items are sent in the next poll like any receipt (hurry).
- A repeated command id still returns only its first receipt (tombstones, as now).

## 4. `act` skill changes (body, instantSkills/act.ts + utils/actReport)

- New params: `repeat` (number, integer 2..8) and `done` (json, ActCondition). Absent => behaviour byte-identical to today.
- `done` is evaluated at every watch tick (100 ms, same clock as stopIf) and between hands. When it holds: the act ends ok at once ("済む条件を満たした"), remaining hands/iterations skipped. A `done` that holds before the first hand => ends ok immediately with 0 hands done (result says so).
- `repeat n`: run the hand list up to n passes. A pass that completes without changing ANY of: feet cell, inventory signature (name:count list), count of blocks dug by this act, => stop the act: failed, `failureType:'no_progress'`, stoppedBy 'noProgress', stoppedWhy `進まない: 2 回目が 1 回目と同じ所で何も変えなかった`. After the n-th pass: ok (even if `done` is still unmet; the result says `済む条件は未`).
- `repeat` with absolute coordinates is refused by the head before sending; the body does not check.
- New stops, ALWAYS active (also with no repeat/done): **hurt**: health lost >= 4 within this act (cumulative drop from the act's start high-water mark, i.e. `startHealth - minHealthSeen >= 4`), damage not attributable to an `accept` kind (if an accepted-kind hostile is within 6 m, that loss is not counted) => stoppedBy 'damage', failureType 'damage_taken', why `被弾: 体力 20 → 15`. **fall**: she left the ground and landed (or is falling) >= 4 blocks below the highest y of that airborne spell => stoppedBy 'fall', failureType 'fell', why `落下: 5 段`. Reflex-caused movement counts the same. Both stop like stopIf (watch tick).
- ActResult (JSON, `v:1`) new optional fields: `repeat?: { done: number; of: number }` (passes completed / max), `doneMet?: string` (the compact text of the satisfied alternative's clauses with their values, e.g. `have:log 10/10`; absent when not met), and `stoppedBy` gains `'noProgress' | 'damage' | 'fall'`. With repeat: `of` = hands per pass × n, `done` = hands done over all passes; `lines` = the LAST pass's lines only (and the stopped/failed hand); first line text unchanged. `ok` true when the passes ended well or `done` was met.
- Result text rendering stays the body's `renderActReport`; the head renders its own wording from the JSON.
- `maxDurationMs` of the act stays 180 s.

## 5. Head-only pieces (not on the wire)
mc.act model input (short form) gets `pre`, `done` (condition text), `repeat`, `replace` (array of item ids, or ['all']). After the head's preparation: `arguments` = act input with `done` (JSON) and `repeat`; `queue.pre` = pre JSON; `replace` is applied by the head.
