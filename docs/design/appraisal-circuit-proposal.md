# Proposal: one appraisal circuit, with jev for speed (not built)

Status: proposal for the owner (2026-10-06). Nothing here is implemented. It follows Syzygy ADR-0006 stage 2 (candidate B, `docs/testing/prediction-stage2-impact-study.md`): once her stance is the outcome of a touch, how fast that stance is known is how fast her face can change.

## The question

Touch reactions today make one `gpt-5.6-luna` call (effort `none`, at most 160 output tokens, strict schema; `bodyReactionModel.ts`). It decides at once whether she speaks, the line, the feeling and the stance. The body shows its own flinch locally within 100 ms, but her chosen face arrives only with the whole answer. The owner asked whether the fast classifier jev (`JevVoiceDecisionGateway`, Typesafe `jev-latest`, already used for voice turn routing) could decide joy or dislike first, and he proposed this pipeline:

1. jev decides which data the judgement needs.
2. That data is gathered.
3. jev judges the stance and feeling.
4. luna writes the line from that judgement.

## What we know about latency

| Step | Measured or estimated | Source |
| --- | --- | --- |
| jev, one call with ~20 questions | p50 175 ms, p95 207 ms (live run, 21 cases); timeout 900 ms | `docs/testing/conversation-regression-audit.md`; `voiceDecision.ts` |
| luna, one strict structured decision, effort none | about 1.7 s measured for the voice router in production (2026-09-26, which is why that timeout became 3 s) | hub `status/apps/shannon/status.json` deploy note |
| luna, one touch reaction (prompt ~1–1.5k tokens, ≤160 out) | not logged yet; estimate 1–2 s, the same class of call as the router | `bodyReaction.ts` (deadline 3.8 s, the body waits 4.5 s) |
| Local context: closeness, past stances, mood, sitting, last lines | a few SQLite reads, well under 10 ms | `bodyTouch.ts`, `bodyReactionStore.ts` |

The reaction path has no latency log today. Step 0 of any option below is to log content-free timings (model, ms, outcome kind), as voice already does.

One prerequisite needs checking: a production deploy note of 2026-09-26 says the TypeSafe key was absent then. Whether jev is configured on Azure now must be checked before anything relies on it.

## Three options for touch

| | A. Today: one luna call | B. Owner's pipeline: jev picks data → gather → jev judges → luna writes | C. Counter-sketch: deterministic gather → jev judges → luna writes |
| --- | --- | --- | --- |
| Face (her chosen feeling) | ~1–2 s | ~0.4 s (two jev calls in series) | ~0.2 s (one jev call) |
| Line | ~1–2 s | ~1.4–2.4 s | ~1.2–2.2 s if luna waits for jev; ~1–2 s in parallel |
| Calls per reaction | 1 luna | 2 jev + 1 luna | 1 jev + 1 luna |
| Cost | luna only (`chat` lane) | + 2 jev (`voice` lane pricing; jev's price is not in `estimatedOpenAICostUsd` yet) | + 1 jev |
| Where her stance comes from (B's outcome) | luna | jev | jev |
| jev down or slow (> its timeout) | — | today's path | today's path |

- **Step 1 of B buys nothing for touch.** Every input a touch needs is local and cheap: closeness, past stances on the part, mood and feeling, the sitting, the last few lines. Fetching all of them costs less than one jev round trip, and the prompt stays small. A model choice of data pays off only when (a) an entry is expensive (an Aether read, a person-memory search, a thread summary that needs a model, game state over the network), or (b) the eligible entries would overflow the prompt, so that leaving one out matters. Neither holds for touch. Both hold for chat, voice and her own time (below).
- **jev's judgement is the real gain.** The face can follow ~0.2 s after the touch instead of ~1.5 s.
- **Consistency.** Recommended: luna writes the line conditioned on jev's stance and feeling (they are given to it as facts: 「いまの受け取り: いや」), so the line cannot contradict the face, at the cost of ~0.2 s on the line only. In the parallel variant, luna's own stance would be discarded and a contradiction rule would be needed (if the signs disagree, stay silent). That is simpler to get wrong.
- **Recording B's outcome.** One source per touch: jev's stance when jev answered, luna's when jev was down, the carried stance otherwise. Add `stance_source` (`jev` | `luna` | `carried`) to `body_touch_outcomes` so that calibration can compare jev's stances with luna's on the same kinds of touch. The intensity stays |w_δ·δ| from the prediction layer and is never chosen by either model.
- **The face before the words needs a wire change.** Today `POST /v1/body/reactions` answers once, with the line and `mood` together. For the face to come first the answer must come in two parts: either a streamed answer (NDJSON: `feeling`, then `said` or `quiet`), or the first answer carrying `mood` and `status: 'speaking'` with the line fetched by id. This is a body-contract change for the desktop, embed and iPhone bodies, and it goes through the body thread first.

**Recommendation for touch: C**, with luna conditioned on jev, and the catalog below already in place. Selection by jev runs as a shadow only (logged, not used) until its value can be measured.

## A common appraisal circuit (all surfaces)

The owner's point stands: what a judgement needs depends on the situation. A touch needs the part, the sitting and her past stances. A conversation needs what was said and the thread. Minecraft needs the game state and who is playing. A story needs the piece and its feedback. The judgement itself, and what follows from it, can be one circuit:

```ts
type Situation = 'touch' | 'chat' | 'voice' | 'game' | 'own_time' | 'study';
interface AppraisalEvent { situation: Situation; kind: string; facts: Readonly<Record<string, string | number | boolean>>; audience: 'owner_alone' | 'others'; at: string }
interface Appraisal {
  outcome: number;          // how good or bad it was for her, on the valence scale: the prediction layer's outcome
  feeling: ShannonEmotionKind; // what she feels: hers, never a table
  stance?: string;          // the situation's own closed scale (a touch's five stances), mapped to `outcome`
  source: 'jev' | 'luna' | 'carried' | 'rule';
}
appraise(event, context: ContextBundle): Promise<Appraisal>   // the only model-facing step
```

- **What follows is shared.** `outcome` goes to the prediction layer under the situation's domain (`body_stance`, `reply_feeling`, and later `game`, `study_feedback`, `reach_out`), and its error moves the one emotion state by B's bounded step (the generalisation of the `touch-appraised` event). The feeling she named becomes her feeling with intensity |w_δ·δ|. Every surface then has the same dynamics, habituation and memory traces. No surface keeps its own strength scale.
- **Surfaces differ only in their context providers** and in the closed vocabulary of `kind` and `stance`.

### The context catalog (first draft, from the code as it is)

Each entry is registered once. The audience filter runs before any model sees the list, so jev can never pick an entry the audience may not have.

| id | Tells about her situation | Situations | Audience | Cost / latency | Output, cap | Source today |
| --- | --- | --- | --- | --- | --- | --- |
| `closeness` | how close she and the owner are (0–1) | touch, chat, voice, own_time | owner_alone | local, < 1 ms | 1 line | `packages/cognition/src/temperament.ts` (`calibrateTemperament`) |
| `part_stances` | how she took touches on this part before | touch | owner_alone | local SQLite | 1 line | `bodyReactionStore.ts` `stanceHistory`, `bodyReactionPrompt.ts` `stanceHistoryLine` |
| `feeling_now` | her present feeling and mood | all | safe (cause only owner_alone) | local | 1 line | `emotionContinuity.ts` `presentShannonFeeling`; `moodHistory.ts` |
| `sitting` | what happened to her body this sitting, what she said | touch | safe (lines said in front of others only) | local SQLite | ≤ 4 lines | `bodyTouch.ts` `sitting` |
| `recent_lines` | the last N lines of the conversation in progress | touch, chat, voice | owner_alone | local SQLite | ≤ 4 lines × 160 chars | `memoryVisibility.ts` `visibleReplayMessages` (as `bodyReaction.ts` uses it) |
| `thread_summary` | what this Talk has been about | chat, voice, own_time | owner_alone | local; a model when stale | ≤ 400 chars | `conversationReplaySummary.ts`, `sqliteReplaySummary.ts` |
| `person_memory` | who a named person is to her | chat, voice, game | owner_alone (guests: names only) | local search; embedding when configured | ≤ 3 lines | `peopleMemory.ts`, `peopleMemoryStore.ts`, `platformPeople.ts` |
| `game_state` | Minecraft: where she is, health, what is happening, who is playing | game | safe | local (last state) | ≤ 4 lines | `minecraftBodyState.ts`, `gameBodyMemory.ts` |
| `story_feedback` | a piece of hers and the owner's reaction | study, own_time | owner_alone | local SQLite; Aether read when stored there | title + reaction | `studyStore.ts` (`study_feedback`), `studyAether.ts` |
| `pursuits` | what she is pursuing | own_time, study | owner_alone | local | ≤ 3 lines | `autonomyPursuits.ts` |
| `time_presence` | time of day; whether the owner is there or away | all | safe | local | 1 line | `predictionShadowReadings.ts` `dayBand`; `shannonBody.ts` presence; `ownerCallElsewhere.ts` |
| `audience` | who can hear: the owner alone, others, a guest | all | safe | local | 1 word | `chatAudience.ts`, `bodyContract.ts` (`audience`) |
| `expectation` | what she expected of this kind of event (prediction layer) | all | owner-related keys owner_alone | local | 1 line | `prediction.ts` `predictOutcome` via the prediction record |

### Selection

- **Deterministic minimum per situation**, always fetched. Touch: `feeling_now`, `sitting`, `audience`, and with the owner alone `closeness`, `part_stances`, `recent_lines`. Chat and voice: `feeling_now`, `recent_lines`, `audience`, `time_presence`. Game: `game_state`, `audience`. Study: `story_feedback`.
- **jev on top, the existing pattern.** As `jevWaitingQuestions` and the `skill__*` nouls do in `voiceDecision.ts`, every eligible entry outside the minimum becomes one `noul` question (「Is X needed to judge how she takes this?」), asked in the same jev call that judges the event. Entries above the threshold are fetched, up to a cap on total characters.
- **The threshold is not a new magic number.** The voice skills use `SHANNON_VOICE_SKILL_THRESHOLD`, 0.85, a value calibrated live against labelled cases. The catalog needs its own calibration. **Open question for the owner:** run selection as a shadow first (log the probabilities, fetch only the minimum), then choose the threshold that maximises agreement with a labelled set (does the judgement change when the entry is withheld?), the way 0.85 was set for the skills.
- **The cap** is the prompt budget of the calling path (the touch prompt's limits in `BODY_REACTION_LIMITS`), a technical bound as ADR-0006 allows.

### Fallback and logging

- jev down, slow (its 900 ms timeout) or unconfigured: the per-situation minimum, and luna decides the stance as today. Nothing waits on jev beyond its timeout.
- Each appraisal is logged with ids and numbers only: the situation, the chosen entry ids and their probabilities, the stance source, and timings. That record later drives the live architecture map (`ShannonMap.touch(nodeId)` for each provider consulted) and shows whether jev's choices change judgements.

### Where jev adds value, honestly

- **Judging fast** (stance, feeling and outcome as closed choices): yes, everywhere a face or voice tone should move before words. Voice already asks jev for `affect` and `affect_intensity` in its routing call, so adding an outcome question there costs nothing extra.
- **Choosing context:** only where entries are costly or crowd the prompt, that is chat, voice and her own time. For touch and game the deterministic minimum is all there is.

## Staged path

1. **Stage 2b, touch** (after stage 2 has run): timing logs; jev judges stance and feeling with the deterministic minimum; luna writes the line conditioned on it; `stance_source` added; the two-part answer agreed with the body thread. Catalog selection runs as a shadow.
2. **Stage 3, chat and voice reply feelings** (ADR-0006 stage 3): the reply feeling's outcome comes from the same `appraise` (voice: one more question in the existing jev routing call; text: the chat model's decided feeling as now, mapped to an outcome). The half-life table gives way to the dynamics. Catalog selection goes live for chat and voice once its threshold is calibrated.
3. **Stage 4, her own time:** the outcomes of her steps (a reply to her message, feedback on a story, a game event) through `appraise`, with `pursuits`, `story_feedback` and `game_state` as providers.
