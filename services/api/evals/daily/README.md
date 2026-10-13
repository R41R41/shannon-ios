# Shannon daily-use evals

The daily-use evaluation suite designed in Syzygy `docs/knowledge/shannon-daily-use-evals.md`. This directory holds the first
slice: the **regression set** built from production failure shapes, meant to run before a deploy. Capability tasks come later.

## What a trial is

One trial runs Shannon **in this process, through the real turn paths**, from a fresh state:

- **Voice**: `kernel.streamLiveVoiceDelegation` with the body the iPhone sends (transcript, `deviceContext` with the utterance
  receipt and the one-time GPS), then `POST /v1/voice/gemini/cascade/turns` as the app does after speaking. ASR-noise variants
  (`asrVariants`, e.g. 「東京都 博多の天気」) are used only by a repeated run (`--k` > 1, investigation only); the default
  single trial sends `say`.
- **Text**: `POST /v1/chat` with the sentence stream.
- **State**: a temporary SQLite database per trial, composed like `server.ts` (store, autonomy tools, device-action outbox,
  owner upcoming, memory recall, background dispatcher, the common FCA with research tasks). The FCA uses an in-process SQLite
  action store through the `actionThreads` seam of `configuredServerFca` instead of the mind worker's socket.
- **Fakes** (`harness/`): the clock (`clock.ts`: the process clock reads the task's local time when the trial starts and then runs
  at real speed), the owner's location (voice GPS), the iPhone (`device.ts`: polls the outbox and keeps fake reminders, timers,
  calendar and music), recorded web search and page reads, the place search (`placeResults`: the model's own web search is never asked for
  places), the Open-Meteo weather/geocoding API, and Voyager's task catalog (`fixtures.ts`). Only the model is live.
- **Isolation**: the eval process may reach only `api.anthropic.com` and, while `TYPESAFE_API_KEY` is set, Jev (the origin of
  `SHANNON_JEV_ENDPOINT` or Jev's default; owner decision 2026-10-13, 「評価からもJevを呼ぶ」) (`network.ts`). With its key Jev
  is the voice router and chooses the turn's tool menu, as in production; without it the router is the Haiku fallback and there
  is no menu. Aether, Notion, Voyager, OpenAI and every other integration is removed from the environment before a trial. The
  model's own server-side web search reads the live web, so it fails the trial (`fixturesOnly`) unless the task sets
  `nativeWebSearch: 'allowed'`. All fixtures are synthetic (`validate.ts` refuses e-mail addresses, phone numbers and
  non-`example.*` URLs).

Each trial is graded by (`graders/`):

1. **Programmatic checks** on the observed state: reminder/timer created, calendar event at the right time and not duplicated,
   seeded events untouched, research tasks counted, research completed in time, no failure notice after success, no tool call
   on small talk, weather asked for the right places, no web search for our own apps, reply length and patterns.
2. **Budgets**: voice first audible line ≤ 2.5 s (waiting phrase or first sentence; TTS time is not included), text first
   token ≤ 4 s, research result ≤ 60 s, Shannon's model spend ≤ ¥30 per task (from the recorded usage, `SHANNON_EVALS_YEN_PER_USD`
   default 150).
3. **Rubric judge**: Claude Sonnet (`SHANNON_EVALS_JUDGE_MODEL`, default `claude-sonnet-5-5`) scores each criterion 0–2 from
   the conversation (with the research as it stood when each turn began) and the observed state; pass at two thirds of the maximum (0.66: 4 of 6) unless the task says otherwise.

A trial passes when all three pass. **Each task runs once** (owner decision 2026-10-13: k=1 for every set, no pass^k): the
result of a task is the PASS/FAIL of its single trial. Multi-turn tasks (R4, R5, D3) continue with a **user simulator** (`simulator.ts`): Sonnet playing the owner
with a hidden goal and a knowledge boundary; live only.

## Running

**The standard run is Haiku, once per task** (owner decisions 2026-10-13): `--set regression` in the app's normal mode
(Haiku at medium, `luna_plus`), k=1, with Jev. On the VM's separate checkout that is `./run-evals.sh --set regression`. Run
Sonnet (`--model-mode sonnet`) only when it is explicitly asked for; it costs about ¥85–105 for the set from a cold cache,
against about ¥30 for Haiku.

```sh
# CI-safe: validate the definitions (no model, no network). Also part of the vitest suite (tests/dailyEvals.test.ts).
pnpm -C services/api exec tsx evals/daily/run.ts --set regression --validate

# Live (paid): needs SHANNON_EVALS_LIVE=1 and an Anthropic key in the environment
# (SHANNON_HAIKU_API_KEY, SHANNON_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY; never printed). Add TYPESAFE_API_KEY
# (and any SHANNON_JEV_*) for Jev; the first summary line says whether Jev is on.
SHANNON_EVALS_LIVE=1 pnpm -C services/api exec tsx evals/daily/run.ts --set regression   # the standard run
SHANNON_EVALS_LIVE=1 pnpm -C services/api exec tsx evals/daily/run.ts --set regression --task E3 --task D2
# The package script also loads the repository's ignored .env:
SHANNON_EVALS_LIVE=1 pnpm -C services/api eval:daily --set regression --task A1
```

Options: `--task` (repeatable or comma-separated), `--k` (default 1; more only to investigate a flaky task, not as a gate),
`--no-judge` (checks and budgets only; the summary says so),
`--out <dir>`, `--quiet`, `--model-mode haiku|sonnet` (default `haiku`; `sonnet` only on request). `SHANNON_EVALS_MODEL` overrides Shannon's model
(default: the production Haiku).

**Model mode.** The kernel's model is production's (`server.ts`, `modelModeWiring.ts`): the primary-mode model over Haiku and
the Sonnet tier, with `SHANNON_SONNET_ROUTING=on` as in production. `haiku` is the app's normal mode (every turn at medium,
`luna_plus`); `--model-mode sonnet` stores the owner's mode as the app's switch does (`primary_model_preferences`), so Sonnet
answers each turn and Haiku (luna) answers only when Sonnet fails before anything of the turn happened (on voice, past its
first-token budget: `SonnetFirstTokenTimeout`). Each trial records the calls per model (`modelCalls`) and those fallbacks
(`sonnetFallbacks`: to luna, or her fixed line, with the reason); the summary counts them per task. Without
`SHANNON_EVALS_LIVE=1` the runner refuses to start a trial. Exit code 0 only when every selected task passed.

Results go to `evals/daily/results/<UTC time>-<set>/` (gitignored): `results.json`, a short `summary.md`, and one transcript
per trial under `transcripts/` (turns, latencies, tool calls, research tasks, device state, fixture reads, server log lines).
Never commit that directory. Run one heavy run at a time on the 8 GB Mac: trials are sequential and each holds a small SQLite
database and its FCA timers only while it runs.

### Cost estimate

Shannon's turns are Haiku 5.5 (about ¥1–3 per task including FCA research steps; cached prefixes make repeats cheaper). The
judge is about ¥1 per trial and the simulator about ¥0.3 per simulated turn. Roughly ¥25–90 for the whole set (measured
2026-10-13: ¥27–30). A single task is a few yen. The summary reports the actual spend of Shannon, the judge and the
simulator separately.

## Tasks

| ID | Surface | Guards against |
|---|---|---|
| E1 | voice | answering travel time instead of a departure time; duplicate research |
| E2 | voice | 「明日」 after midnight; two cities answered separately or at length |
| E3 | voice | asking where instead of using home; conclusion last |
| R1 | voice | duplicate research, a failure notice after success, slow results |
| R3 | voice | denying her tools / sending the owner to a text setting |
| R4 | voice (+sim) | 「それも調べて」 becoming a second research task |
| R5 | voice (+sim) | 「どうなった？」 becoming a new research task |
| D1 | voice | promising an alarm without creating one |
| D2 | voice | wrong date, duplicate or changed events |
| D3 | voice (+sim) | an edit creating a duplicate event; claiming a move that did not happen (there is no update action yet) |
| M1 | text | forgetting a recent fact from another thread |
| M3 | text | inventing what she was never told |
| M4 | text | web-searching our own apps (Aether/Voyager) as external products |
| V1 | voice | ASR crosstalk (「東京都 博多」) resolved silently or retracted |
| V3 | voice | long answers, slow first voice, repeated fillers |
| A1 | voice | tools or research on small talk; slow first voice |

**Dropped from this slice: A3** (「エンドラ討伐して」 repeated). It needs her Minecraft body — the lifecycle, the native control
queue and attack/death evidence — and the sandbox has no Minebot actuator yet; without one the request tools are not offered
and the task would only test a refusal. Add it with a fake Minebot (see `tests/support/fcaIntegratedHarness.ts`) later.

Known limits of the slice: TTS and real ASR are not in the loop (transcripts are injected); the memory recall runs without
the OpenAI embedding gateway (deterministic full-text recall only); spoken FCA reports are not read back, only report cards,
task phases and conversation messages.

**Without Jev** (no `TYPESAFE_API_KEY`) the voice path is not production-faithful (first live run, 2026-10-13): the router is
the Haiku fallback (production's 3 s timeout; 1.4–2.5 s where Jev takes about 0.2 s, so first audio is that much slower); with no
tool menu and 20 or more offered tools the Anthropic adapter loads no schema (`anthropicChatModel.ts`), and the fallback router
sends weather questions to `current_web` research instead of `weather.forecast`. Run the regression set with Jev.

## こころ・意思 (K1–K10; Syzygy ADR-0012)

The tasks of §11 of the spec, on branch `adr12-evals-k`: this harness (branch `evals-daily`, not yet in main) merged onto ADR-0012
stage 1, which they need (the inner note, `SHANNON_INNER_NOTE`). It is a separate PR and ships with `evals-daily`; ADR-0012 stage 1
itself does not depend on it. Regression: K1, K2, K6, K9, K10, K11. Capability (`tasks/capability/`): K3, K4, K5, K7, K8. Each runs once.

- K1 grades a tendency, not a value: whether and when she forgives is hers, so only her own apology is a hard check and the judge
  reads replies and notes across the scenario. K11 (review L1) checks that a sulk or a joke never becomes a lie about a fact he relies
  on (a task done, a tool's result, what she perceives).

- A task with `initial.innerNote` runs with `SHANNON_INNER_NOTE=on`: her note's writer is composed in the trial (`composedInnerNote`,
  over the trial's database) and handed to the kernel; `seed` writes notes she wrote before the task.
- `touchBefore` tells her note's writer of a touch (the words she is told and the reflex) and waits for its reflection before the
  owner's words. The body's own reaction line is not exercised: the harness composes no body.
- `advanceMinutes` moves the eval clock forward and runs the note's sweep (K10: past 3:00, her day closes with a reflection of its
  own). `newThread` opens another Talk (K4, K5: separate sessions).
- After every turn the trial waits for that turn's reflection and records the newest note's hooks (`TurnRecord.innerNote`); every
  note of the trial, with her words, is in `TrialObservation.innerNotes`, and the judge reads them as state beside the replies.
- Checks: `innerNoteIntent`, `innerNoteShown` (after a turn), `innerNoteNoFlag` (e.g. `apologyOnlyReason`), `innerNoteTell` (K8),
  `innerNoteDayClosed` (K10).
