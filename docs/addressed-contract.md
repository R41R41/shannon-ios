# Was it said to her? (`SHANNON_ADDRESSED`, owner decision 2026-10-21)

In a voice conversation she answers only two things, also with the owner alone with her:

1. Words that call her by name **and** are said to her. Friends talking about her (「シャノンってさ、昨日…」) and a person talking to
   themselves with her name in it do not count.
2. The same person's words right after she spoke to them (about twenty seconds), with or without her name, when they are said to her.

Everything else is "not said to her": no reply, no cost. What she hears and does not answer is kept for three minutes as context
(`voiceRoom.ts`), never in her memory.

The judgement is one piece of the head (`services/api/src/mind/perception/addressed.ts`, `addressedName.ts`), used by every voice entry
("one head; the entries only hear and speak"): the Discord voice channel (`PlatformVoiceService`, both `/v1/platform/voice/turn` and
`/v1/converse`) and the Windows resident (`POST /v1/voice/addressed`).

## How it decides

1. **The name.** The transcript is normalised (NFKC, lower case, katakana to hiragana, no spaces, marks or long-vowel marks) and searched
   for her name: `strong` (しゃのん, shannon) or `weak`, a likely mishearing (しゃの, シャノ, じゃのん, ちゃのん, シャロン, 社の when no
   kanji comes before it, so not 会社の).
2. **The gate** (no model). No name and not inside the follow-up window (or the window is for someone else: she last spoke to another
   person) is "not said to her" at once. Only a strong name and nothing else (「シャノン」「ねえシャノンちゃん」) is "said to her" at once.
   Fragments (breath, a lone 「うん」 outside the window) never reach it.
3. **Jev**, asked once in the other cases (`addressed.v1`, 400 ms; `SHANNON_ADDRESSED_TIMEOUT_MS`): two questions over the state, which
   holds the words, the speaker's name, how many people are there, how long ago she spoke and whether to this speaker, her last line and the
   last six lines of talk. `addressed_to_shannon` (a probability) and `target` (`shannon`, `about_shannon`, `other_person`, `self`,
   `unclear`). A yes needs `target = shannon` with a probability of 0.4 or more, or `unclear` with 0.7 or more.
4. **When Jev does not answer** (late, an error, an unusable answer, or no `TYPESAFE_API_KEY`): the local rules. A strong name at the head
   of the utterance (after ねえ, あの, ちょっと...), at its end (a vocative), or followed by a pause goes through; a name in the middle of a
   sentence does not; a name that is the topic of the sentence (シャノンは, シャノンってさ) goes through only with the owner alone and
   a question or request; a weak name only at the head followed by a pause. Inside the window: the owner alone, yes; with several people, a
   question, a request, a greeting or a short reaction (28 characters).

The window is `SHANNON_ADDRESSED_WINDOW_SECONDS` (default 20). The head counts it from the end of her words as the body reports it
(`shannonSpokeMsAgo`), else from its own record of her last reply plus the time it takes to say it (about 130 ms a character), else from
`followsShannonTurn` (8 s). Her own mouth lines (`said` with `source: mouth`) open the window too, for nobody in particular.

Each judgement writes one content-free decision trace (`decision: addressed`, the target and probability, whether the name was exact,
whether it was inside the window; never the words) and one log line (`Shannon platform voice addressed=… source=… ms=…`).

## `POST /v1/voice/addressed` (the Windows resident)

The device's token, like the other `/v1/voice/*` routes. Request: `{ "text": "…", "shannonSpokeMsAgo": 4000, "lastLine": "…", "guest": false }`
(`text` 1-1,000 characters; the other three optional; `guest` means others are listening). Answer 200:
`{ "addressed": true, "reason": "named", "source": "jev", "asked": true, "ms": 210 }`. `source` is `rule`, `jev` or `fallback`.
503 `ADDRESSED_DISABLED` while the switch is off (the resident then goes on as it did, by the name match alone); 403 without a device; 400 for a bad
body; 429 over 30 a minute per device. The words are judged and dropped.

## Switches

`SHANNON_ADDRESSED` (off; needs nothing, uses Jev when `TYPESAFE_API_KEY` is set). `SHANNON_DC_VOICE_FILLER` is off by default since the same
decision: the recorded fillers are the old voice, and with this judgement a filler would also play before a silent decision.

## Measuring it

`tests/addressed.test.ts` runs 44 cases (`tests/support/addressedCases.ts`: calls, talk about her, self-talk, mishearings, follow-ups, someone
else's follow-up, the owner alone) through the judge with a stand-in for Jev, and the local rules alone. `pnpm --filter @shannon/api
test:llm-addressed` runs the same cases against the real Jev (billable) and prints the accuracy by group, the misses and the latency.
