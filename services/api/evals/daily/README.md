# Shannon daily-use evals

The daily-use evaluation suite designed in Syzygy `docs/knowledge/shannon-daily-use-evals.md`. This directory holds the first
slice: the **regression set** built from production failure shapes, meant to run before a deploy. Capability tasks come later.

## What a trial is

One trial runs Shannon **in this process, through the real turn paths**, from a fresh state:

- **Voice**: `kernel.streamLiveVoiceDelegation` with the body the iPhone sends (transcript, `deviceContext` with the utterance
  receipt and the one-time GPS), then `POST /v1/voice/gemini/cascade/turns` as the app does after speaking. ASR-noise variants
  (`asrVariants`, e.g. 「東京都 博多の天気」) are cycled across trials, so pass^k also covers the noisy forms.
- **Text**: `POST /v1/chat` with the sentence stream.
- **State**: a temporary SQLite database per trial, composed like `server.ts` (store, autonomy tools, device-action outbox,
  owner upcoming, memory recall, background dispatcher, the common FCA with research tasks). The FCA uses an in-process SQLite
  action store through the `actionThreads` seam of `configuredServerFca` instead of the mind worker's socket.
- **Fakes** (`harness/`): the clock (`clock.ts`: the process clock reads the task's local time when the trial starts and then runs
  at real speed), the owner's location (voice GPS), the iPhone (`device.ts`: polls the outbox and keeps fake reminders, timers,
  calendar and music), recorded web search and page reads, the Open-Meteo weather/geocoding API, and Voyager's task catalog
  (`fixtures.ts`). Only the model is live.
- **Isolation**: the eval process may reach only `api.anthropic.com` (`network.ts`). Aether, Notion, Voyager, Jev, OpenAI and
  every other integration is removed from the environment before a trial. All fixtures are synthetic (`validate.ts` refuses
  e-mail addresses, phone numbers and non-`example.*` URLs).

Each trial is graded by (`graders/`):

1. **Programmatic checks** on the observed state: reminder/timer created, calendar event at the right time and not duplicated,
   seeded events untouched, research tasks counted, research completed in time, no failure notice after success, no tool call
   on small talk, weather asked for the right places, no web search for our own apps, reply length and patterns.
2. **Budgets**: voice first audible line ≤ 2.5 s (waiting phrase or first sentence; TTS time is not included), text first
   token ≤ 4 s, research result ≤ 60 s, Shannon's model spend ≤ ¥30 per task (from the recorded usage, `SHANNON_EVALS_YEN_PER_USD`
   default 150).
3. **Rubric judge**: Claude Sonnet (`SHANNON_EVALS_JUDGE_MODEL`, default `claude-sonnet-5-5`) scores each criterion 0–2 from
   the conversation and the observed state; pass at 70 % of the maximum unless the task says otherwise.

A trial passes when all three pass. A task passes the set when **every** trial passes (pass^k; k defaults to 3 for the
regression set). Multi-turn tasks (R4, R5, D3) continue with a **user simulator** (`simulator.ts`): Sonnet playing the owner
with a hidden goal and a knowledge boundary; live only.

## Running

```sh
# CI-safe: validate the definitions (no model, no network). Also part of the vitest suite (tests/dailyEvals.test.ts).
pnpm -C services/api exec tsx evals/daily/run.ts --set regression --validate

# Live (paid): needs SHANNON_EVALS_LIVE=1 and an Anthropic key in the environment
# (SHANNON_HAIKU_API_KEY, SHANNON_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY; never printed).
SHANNON_EVALS_LIVE=1 pnpm -C services/api exec tsx evals/daily/run.ts --set regression --k 3
SHANNON_EVALS_LIVE=1 pnpm -C services/api exec tsx evals/daily/run.ts --set regression --k 1 --task E3 --task D2
# The package script also loads the repository's ignored .env:
SHANNON_EVALS_LIVE=1 pnpm -C services/api eval:daily --set regression --k 1 --task A1
```

Options: `--task` (repeatable or comma-separated), `--k`, `--no-judge` (checks and budgets only; the summary says so),
`--out <dir>`, `--quiet`. `SHANNON_EVALS_MODEL` overrides Shannon's model (default: the production Haiku). Without
`SHANNON_EVALS_LIVE=1` the runner refuses to start a trial. Exit code 0 only when every selected task passed pass^k.

Results go to `evals/daily/results/<UTC time>-<set>/` (gitignored): `results.json`, a short `summary.md`, and one transcript
per trial under `transcripts/` (turns, latencies, tool calls, research tasks, device state, fixture reads, server log lines).
Never commit that directory. Run one heavy run at a time on the 8 GB Mac: trials are sequential and each holds a small SQLite
database and its FCA timers only while it runs.

### Cost estimate

Shannon's turns are Haiku 5.5 (about ¥1–3 per task including FCA research steps; cached prefixes make repeats cheaper). The
judge is about ¥1 per trial and the simulator about ¥0.3 per simulated turn. Roughly ¥40–90 for `--k 1` over the whole set and
¥100–250 for `--k 3`. A single task at `--k 1` is a few yen. The summary reports the actual spend of Shannon, the judge and the
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
the OpenAI embedding gateway (deterministic full-text recall only); Jev is not called (the voice router uses its Haiku
fallback with production's 3 s timeout); spoken FCA reports are not read back, only report cards, task phases and conversation
messages.

**Without Jev the slice is not yet production-faithful (first live run, 2026-10-13):**

- The voice router's Haiku fallback takes 1.4–2.5 s where Jev takes about 0.2 s, so voice first-audio numbers are about
  1.2–2.3 s slower than production (subtract `route=` in a turn's timing line minus ~200 ms to compare).
- Jev's tool menu is absent. With 20 or more offered tools and no menu, the Anthropic adapter loads no schema
  (`anthropicChatModel.ts`): the model sees only `tool_open` (+ always-loaded names), and the device-actions capability line is
  not in its prompt while the 「今はできないこと」 calendar/timer line is. Reminders, timers and calendar writes (D1–D3) are
  therefore refused in the sandbox. A Jev stand-in (a chooser) is needed before D1–D3 measure production behaviour.
- The Haiku router sends weather questions to `current_web` (an FCA research task) instead of `weather.forecast`.

## Adding a task from a production failure

1. Describe the failure in words in `failureShape` — never paste the owner's words or data. Rebuild the situation with
   synthetic fixtures: clock, location, prior threads, calendar/reminders, web results (`example.org` URLs), weather, Voyager.
2. Create `tasks/regression/<ID>.ts` with `defineTask({...})` and add it to `tasks/index.ts` (the definition test fails on a
   file that is not registered).
3. Prefer **state checks** over wording: what must exist (or must not) after the turn. Add reply patterns only for the core
   of the failure (e.g. the first sentence must contain a time). Put the rest in 2–4 rubric criteria.
4. Set budgets only when the task needs a stricter one than the defaults. Research tasks need `settleSeconds` ≥ 45.
5. Run `--validate`, then one live trial with `--k 1 --task <ID>`; read the transcript to see that the checks measure what
   you meant before relying on pass^3.
