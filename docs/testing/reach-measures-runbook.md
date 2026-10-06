# Reach measures runbook

到達の物差し (Syzygy ADR-0003, owner decision 2026-10-05). Fixed scenarios run from a clean state and judged from outside; every stop is put down to `tool`, `build`, `model_judgment`, `budget` or `timeout`. The design is in [`../architecture.md`](../architecture.md#reach-measures). This page is how to run it and how to read what it says.

| Scenario | Need / measure | What is judged |
| --- | --- | --- |
| `context.shiritori-60` | 人を理解したい / 文脈を保つ | 60 turns of しりとり through `POST /v1/chat`, then four questions about things said 25 to 48 turns back. Rule validity, no repeated word, the four answers (naming what was asked and no other candidate), and whether every request carried the whole game. |
| `helpful.three-tools` | 人の役に立ちたい / やり切る | One request needing `study.search`, `study.read`, `study.create`. A new note with the source's points exists, the source is unchanged, no reminder was needed, the calls came in order. |
| `growth.autonomy-day` | 自分を成長させたい / 作って、直して、良くなる | One sandbox day of her own time under a 300 yen cap. Every thinking prompt listed her open stories, a story shown, the spend within the cap, sessions ended by her own rest. |
| `cog.*` (8 scenarios, Syzygy ADR-0008 stage 1) | 見込みの当たり方 / 較正 / 版で戻せる / 気分が揺れすぎない | Scenario suite v1 of the cognition ledger (`packages/evaluation/src/reach/cognitionLedger.ts`, driver `services/api/tests/reach/reachCognition.ts`): `cog.night-reply`, `cog.story-reaction`, `cog.reading-used`, `cog.tool-streak`, `cog.rollback`, `cog.kill-switch`, `cog.calibration`, `cog.mood-jitter`. Judged from the ledger tables after a scripted run over a temporary database. Model-free in both modes (no model, 0 yen); `--only cog.` runs them alone. `cog.mood-jitter` simulates the planned step-7 mood exit over the settled choices and applies nothing. See `docs/cognition-ledger-contract.md`. |

## Model-free run (free, every change)

```sh
scripts/reach-measures.sh run
scripts/reach-measures.sh run --only context      # one scenario, by id prefix
```

Every model reply is scripted from the request alone. What a pass proves differs by scenario: for `context.shiritori-60`, a change that drops part of the conversation from the request makes it fail at `build`; for `helpful.three-tools`, nothing of Shannon sits between the stub tools and the scripted player yet, so it checks only the judge and the harness; for `growth.autonomy-day`, it checks that her loop, gate and record carry a day through to a shown story within the cap, and its only context signal is whether each thinking prompt listed her open stories. It makes no network call and needs no credential. The same runs are part of `scripts/verify.sh api` (`services/api/tests/reachMeasures.test.ts`). The exit code is 1 when a scenario failed.

## Real-model run (billable: ask the owner first)

1. Put the credentials in the repository's ignored `.env` (it is read only with `--live`, after the model-free pass, so its settings never shape that pass; settings exported in your shell still apply to both): `OPENAI_API_KEY` for `context.shiritori-60` (the conversation model; `SHANNON_LLM_MODEL` chooses it as in production), and a dedicated `SHANNON_AUTONOMY_GEMINI_API_KEY` or `SHANNON_AUTONOMY_OPENAI_API_KEY` for `growth.autonomy-day`. Set `SHANNON_AUTONOMY_MODEL_PRICES_JSON` if the owner has prices for her models; otherwise the gate charges the fail-safe rate, which makes the sandbox cap bite sooner than real spending would.
2. Print the estimate. Nothing is spent:

   ```sh
   scripts/reach-measures.sh run --live
   ```

   It runs the model-free pass and stops with exit code 1, spending nothing, if that pass failed. Otherwise it prints one line per scenario and a total. At `9505a27` it reads about 22 yen for `context.shiritori-60` (64 calls, estimated at one token per request character and 800 output tokens per call with `gpt-5.6-luna` prices), 0 yen for `helpful.three-tools` (pending until the tool registry is on main), and at most 300 yen for `growth.autonomy-day` (the cap the gate enforces). A scenario without its credential is estimated anyway and marked; it would be recorded as `pending`.
3. Show the owner the total and get a yes for this run.
4. Run it:

   ```sh
   scripts/reach-measures.sh run --live --yes
   ```

   The exit code is 1 when a scenario failed. `context.shiritori-60` takes a few minutes (64 sequential calls); `growth.autonomy-day` is bounded by a 30-minute wall clock and 400 loop ticks. Nothing is fetched from the web: her reading in the sandbox is canned pages. Nothing reaches the owner's devices: the inbox is a recording stand-in.

## Reading a report

Each run writes `artifacts/reach/<time>-<revision>-<mode>.json` and `.md` (ignored by git) and prints the Markdown. A full run (no `--only`) also becomes `artifacts/reach/latest-<mode>.json`, and the next run of that mode is compared with it; `--baseline <file>` compares with another report instead. `scripts/reach-measures.sh compare A.json B.json` compares two reports and exits 1 on a regression.

- **Status**: `passed` (every check at or above its threshold, no stop), `failed`, `pending` (the live requirement is not met; nothing ran or was spent), `invalid` (the harness itself failed; fix the harness, not Shannon).
- **Stopped at**: the run's own stop (wall clock, step or round limit, a provider that failed), else the cause of the first failed check. What to look at for each:
  - `build`: what the model was given. A back-reference whose words were not in the request, a needed tool not offered, a credential or a gate refusing for configuration.
  - `tool`: the procedure or provider of one action (a chat call that failed, a tool returning `unavailable`/`failed`/`timeout`, model calls failing in her own time).
  - `model_judgment`: the model had what it needed. Prompt, model choice, or the measure itself.
  - `budget`: an allowance ran out first (her cap, a session's cap, the rounds of a request).
  - `timeout`: the wall clock or the sandbox day ran out.
- **Checks**: score (0 to 1), result, cause, and a content-free detail (counts, turn numbers). Reports never contain what the owner side or the model said.
- **Cost**: yen and tokens. In the model-free mode it is marked simulated (her sandbox charges the scripted usage through the real gate).
- **Comparison**: `regression` when a passed scenario now fails, or when scores only went down; `improvement` the other way; `incomparable` when the scenario version (definition fingerprint), the mode, or the inputs differ, or a side is pending or invalid. The inputs are fingerprints of the scripts and seeds and, for a live run, the model ids and price settings; `inputs-changed:<names>` says which. Raise a scenario's `version` whenever its checks change. A baseline file is checked down to every run and check before it is compared with; a malformed one stops the run.

## From use (read-only, a copy only)

```sh
scripts/reach-measures.sh usage /path/outside/the/repo/shannon-copy.sqlite --days 30
```

The API may keep running while the copy is made: `VACUUM INTO` reads a consistent snapshot through a read-only connection and writes a new file. For example, on the VM: `node -e "new (require('node:sqlite').DatabaseSync)('/home/azureuser/shannon-ios-data/shannon.sqlite',{readOnly:true}).exec(\"VACUUM INTO '/home/azureuser/shannon-copy.sqlite'\")"`, then copy that file to the Mac outside the repository and delete both copies when done: it holds the owner's conversations. The report refuses the production directory, also through a symbolic link, opens the copy read-only, reads no environment variable, and prints counts, rates, and ISO-week trends (Tokyo time) only (it writes its JSON and Markdown under `artifacts/reach/`). Measures the database cannot give yet are listed as unavailable with the reason.

## Adding a scenario

Define it in `packages/evaluation/src/reach/` (definition, deterministic judge, unit tests in `packages/evaluation/tests/reach.test.ts`), write its driver in `services/api/tests/reach/` with a scripted and a live model, register it in `reachSuite.ts`, and add the model-free run to `services/api/tests/reachMeasures.test.ts`. An `llm` check needs a written rubric and stays skipped unless a live run asks for it; prefer a deterministic check whenever one exists.
