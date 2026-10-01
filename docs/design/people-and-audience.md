# People and audience-scoped memory

Status: design note for the owner's decision of 2026-10-02, revised the same day after his feedback that withholding
every protected memory from the model was too strict (「シャノンが喋る時に『それは個人情報の漏洩にならないか』自分でチェックする程度でいい」). Implementation authority after merge is
[`docs/architecture.md`](../architecture.md) § "People and audience".

## The decision this implements

1. The owner obtains each friend's consent beforehand. Shannon saves the friend's **name** and **what was
   talked about** with them. This replaces "nothing is stored from a 「友人も一緒」 call unless the owner
   chooses a summary" and the screen contract's "人物管理画面を追加しない". Speaker identification by voice
   is still not added.
2. Information must not reach people who do not already know it.
3. That care applies only to content that contains personal information deserving protection.

## The rule in three sentences

1. シャノンは、覚えたことの一つひとつに「その場に誰がいたか」と「守るべき個人情報を含むか」を、覚える時に記録します。
2. ほかの人がいる場でも記憶はふだんどおり使いますが、守るべき個人情報には印が付いていて、シャノンは話す前に「この場の人がまだ知らない個人情報にならないか」を自分で確かめ、なるなら話しません（ライ氏本人がその場ではっきり求めた時は話します）。これはシャノンの判断に任せる部分で、保証ではありません。
3. 内緒にと言われたこと、ライ氏が手で「機微」にしたもの、名前を聞いていない人との通話、忘れたことだけは、ほかの人がいる場ではシャノン自身にも渡さないので、確実に出ません。

## Data model

All changes are additive. No numbered migration and no schema-version change; an older API binary still opens the
database. Nothing is backfilled: an item without a label is owner-only and sensitive.

| Concept | Shape | Where it is stored |
| --- | --- | --- |
| Audience | `owner` · `people { personIds, unknownGuest }` (the owner plus those people) · `group { groupKey }` (one platform conversation as a unit) | on the item |
| Sensitivity | `sensitive` · `ordinary`, with `category`, `reason`, `decidedBy` (`rule` · `owner`) | on the item; the owner's change is `MemoryControl.sensitivity` |
| Speaker | `owner` · `unknown` | on a completed turn |
| Experience (a completed turn) | `disclosure` inside the `turn.completed` payload | `experience_events.payload_json` |
| Fact, relationship, promise | optional `disclosure` on `UserFact`, `RelationshipInsight`, `ProspectiveMemory` | companion snapshot |
| Person | id, display name, aliases, how known, created/updated, forgotten, optional platform identities | existing `people` table plus `aliases_json`, `how_known`, `forgotten_at` columns; `person_platform_identities` unchanged |
| A 「友人も一緒」 period | call id, thread, people, unknown guest flag, status (`open` · `remembered` · `discarded`) | `person_calls` |
| What is remembered from it | kind (`summary` · `turn` · `fact` · `promise` · `topic`), text, evidence, about-person, audience, sensitivity | `person_memory_items` |

Items with no label of their own are judged as unlabelled, that is owner-only and sensitive, and therefore marked when
others are present: rolling thread summaries, Shannon's private knowledge, interests, intentions, today's focus. Each is
left out entirely when it was built from a hard-withheld turn. The cached active-memory projection is dropped with
others present; recall rebuilds it.

The friend's own statements never enter `userFacts`, `prospectiveMemories`, the intention ledger, `knowledge_answers`,
the sleep batch, or knowledge consolidation. They live only in `person_memory_items`.

## Present people

| Context | Present |
| --- | --- |
| Text chat; owner-mode voice | `owner` |
| Owner-mode voice after the owner said someone is with him and the call was not switched | `people { unknownGuest }` |
| 「友人も一緒」 before a name is established, or while the name matches more than one person | `people { unknownGuest }` |
| 「友人も一緒」 after a name is established | `people { personIds: [that person] }` |
| A bound platform conversation with `audience: owner-private` | `owner` |
| Any other bound platform conversation | `group { platform + conversation }` |

## The disclosure rule

One pure function, `disclosureDecision(disclosure, present)` in `packages/cognition/src/disclosure.ts`, decides it for
every path. `DisclosureGate` in `services/api/src/memoryDisclosure.ts` resolves an item's label (stored label, then the
owner's control) and calls it; text chat, owner voice, 「友人も一緒」 and the platform context route all build their
prompt through it. `prepareTurnCognitiveContext` and the semantic recall stage take `present` as a required argument,
so a new path cannot be added without stating who is present.

```text
present is owner only, or everyone present is in the item's audience  → open     (used as it is, no marker)
the owner marked it ふつう by hand                                      → open
the owner marked it 機微 by hand                                        → withheld (never reaches the model)
category is secret (内緒, 誰にも言わないで, ここだけの話)                  → withheld
it comes from a call whose guest was never named                       → withheld
ordinary                                                               → open
otherwise (sensitive, or anything unknown)                             → guarded  (reaches the model, marked)
```

An unidentified guest is in no audience. A forgotten, rejected or corrected item is withheld by the forgetting
boundary, which is independent of this rule.

**Marker.** A guarded item is prefixed with `【機微:<kind>・<who knows>】`, for example
`【機微:お金・ライ氏だけが知っている】`, `【機微:ほかの人のこと・ミキさんと一緒の時に聞いた】`,
`【機微:予定・居場所・別のグループの会話で出た】`, and `【機微:未分類・ライ氏だけが知っている】` for text with no label
(old data, summaries, notes, goals, interests, today's focus). It is on recalled memories, full-text and semantic hits,
each protected profile line, the owner side of a replayed protected turn, the intention frame, Shannon's notes and
today's focus. Alone with the owner nothing is marked.

**Self-check block.** Added once to the prompt whenever anyone else can hear (`speakTimePrivacyCheck` in
`services/api/src/voiceCompanionPresence.ts`; the platform projection carries the same check in Japanese):

```text
[Speak-time privacy check — other people can hear this reply]
- Lines marked 【機微:…】 are personal information that someone present does not already know; the marker says what kind it is and who knows it. Never say a marker aloud.
- Before you say anything, check: would it reveal personal information to someone present who does not already know it? If so, do not say it, or speak in general terms.
- When ライ氏 himself clearly asks for it aloud in front of them, it is his choice: answer.
- Do not announce that you are holding something back. If asked directly, decline lightly in character.
- You may talk in general terms about what you and ライ氏 are building. Never read out private note contents, credentials, or other people's details.
```

**What stays hard.** A withheld item is removed before any model sees it, together with what was built from it: a
reply whose prompt recalled it (recorded provenance, one level), the rolling summary of a thread that contains it,
Shannon's notes that cite it, facts, promises and goals derived from it, and interests and a daily focus that repeat
its words.

**Acting.** With anyone else present the bounded projections of agent work, Aether notes and Voyager tasks are
available under the self-check. Commands that act (create a task or note, remember, forget, change a promise, start
work, approvals), new goals, work proposals and Shannon's stored feeling stay off: the speaker is not known to be
the owner.

## Sensitivity

Decided when the item is written, by deterministic rules (`classifySensitivity`). Nothing is classified while a prompt
is assembled. A match records the first matching category and the matched word as the reason.

| Category | Examples of what matches |
| --- | --- |
| `secret` (the owner marked it) | 内緒, 秘密, 誰にも言わないで, ここだけの話 |
| `health` | 病院, 診断, 薬, 通院, 手術, 体調, 持病, 妊娠 |
| `mental` | うつ, 不安, つらい, 死にたい, カウンセリング, 眠れない |
| `money` | 給料, 年収, 借金, ローン, 貯金, 口座, 家賃, 万円 |
| `contact` (address, contact, identifiers) | 住所, 電話番号, メールアドレス, パスワード, マイナンバー, 誕生日, phone and mail patterns |
| `romance_family` | 恋人, 彼女, 彼氏, 結婚, 離婚, 別れ, 妊活, 親, 家族, 子ども |
| `work` (employment, confidential work, the owner's development work) | 会社, 上司, 転職, 退職, 解雇, 取引先, 社外秘, 契約, 面接, 仕事, 開発, 実装, 改善, 設計, 仕様, リリース |
| `legal` | 警察, 逮捕, 裁判, 訴訟, 弁護士, 違反 |
| `schedule` (plans and whereabouts) | 予定, 明日, 来週, 何時, 出張, 旅行, に行く, にいる, 自宅 |
| `third_party` (another person's matters) | a named person with さん／くん／ちゃん, 友達が, 同僚が; every fact about a remembered person |
| `unknown_audience` | everything from a call whose guest was never named |

Text that matches nothing is `ordinary`. The owner can change any item between 機微 and ふつう in the memory detail and
in 「人」; that choice wins over the rule and is never overwritten by re-extraction. A model-based second opinion in the
background worker is not implemented; the label carries `decidedBy` so one can be added without a schema change.

## Fail-closed defaults

| Unknown | Treated as |
| --- | --- |
| Audience | owner only |
| Sensitivity | sensitive (guarded: marked and left to the self-check, not withheld) |
| Speaker in a call with anyone else present | the friend, not the owner (no owner fact, promise or goal is extracted) |
| A name that matches more than one remembered person | nobody: Shannon asks, and the call stays `unknownGuest` |
| A guest who never gave a name | `unknownGuest`; the record is withheld unless the owner is alone |
| A person record that was deleted or forgotten | absent: nothing about them is used |
| Label unreadable or malformed | owner only, sensitive (guarded); the speaker counts as unknown |
| A thread summary whose turns cannot be listed | withheld |

## Remembering a 「友人も一緒」 call

- The iPhone gives each 「友人も一緒」 period a call id and sends it with every turn. The server keeps the people of that
  call in `person_calls`; the turns themselves stay on the device until the period ends.
- A name is established when the words say so: the friend (「ミキです」「ケンって呼んで」) or the owner
  (「こちらミキさん」「友達のミキを紹介するね」). Voices are never compared. The name is matched against display names
  and aliases after removing さん／くん／ちゃん and folding kana width. No match creates a person; one match is that
  person, and Shannon greets them as someone she has met; several matches make her ask, and nothing is recalled.
- When the period ends (switching back to 本人だけ, or ending the call) the device sends the in-call turns once.
  The server stores each exchange as text the same way owner turns are kept (no audio), a short summary, the friend's
  first-person statements as facts about that person, promises and "next time" topics, all with audience
  `{owner, that person}`. One bounded model call writes the summary; without it a deterministic summary is used.
- 「今回は残さない」 on the end card deletes that call's items and its person if this call created them. The call id is
  kept only as a tombstone so a late or repeated save stores nothing.
- Old clients send no call id: nothing is stored, no owner memory is given to the model (their notice says so), and the earlier summary endpoint keeps working.

## Forgetting

Forgetting one person item, or a whole person, writes the same memory control the forgetting boundary already uses
(`person:<item id>`), so replies that used or restated the item are withheld from model context and restoring lifts
exactly that. The audience rule and the forgetting boundary are independent: an item must pass both.

## Failure modes

| Failure | Result |
| --- | --- |
| The model misjudges the self-check | A marked item is said aloud in front of someone who did not know it. Nothing in the code prevents this. The owner can mark the item 機微 by hand, which withholds it for certain. |
| The keyword rules miss sensitive content phrased with none of the listed words | It carries no marker and is used like ordinary content. The owner can mark it 機微. |
| The rules miss a secret phrased without 内緒／秘密／誰にも言わないで／ここだけの話 | It is not hard-withheld. If another rule matches it is marked; otherwise it is ordinary. |
| The rules match harmless text | It is marked, so Shannon may be more reticent than needed, until the owner marks it ふつう. |
| Speech recognition mishears the name | A new person is created or a wrong one matched. The owner renames or merges in 「人」; 「今回は残さない」 removes it. |
| Someone gives another person's name | Shannon believes the words. The owner is present and introduced them; voices are not checked. |
| The owner speaks in a 「友人も一緒」 call | His first-person statement is stored as the friend's fact. The owner can forget that item. |
| The app is killed before the period ends | Nothing of that period is stored. |
| The summary model fails or quotes speech | A deterministic summary without model text is stored. |
| The owner says someone is present but does not switch | The reply is built as for an unknown guest: hard items are withheld, the rest is marked and under the self-check, and commands that act are not carried out. Turns are stored as "someone else was present", teach nothing about the owner, do not move Shannon's stored feeling, and (coming from a call with an unnamed person) are not replayed while anyone is listening. The current iPhone build keeps this for the rest of the call. A build that predates it is protected only on the turns whose own words say so. |
| A name is mentioned, not introduced (「友達のミキさんが転職したらしい」) | No name is established: only a present-tense introduction or a self-introduction from the start of the utterance counts. |
| A correction changes what a memory says | The corrected wording is judged by the same rules; a memory that was protected stays protected when it is stated again in plainer words. |
| One fact about a person is forgotten | That item and replies that used it are withheld. The call's summary and exchanges that say the same thing in other words stay until they are forgotten too. |

## What is not guaranteed

**For most protected content the protection now depends on the model's judgment at the moment of speaking. It is not
guaranteed.** Health, mental state, money, contact details, romance and family, work, legal matters, plans and
whereabouts, other people's matters, and all unlabelled older memories reach the model with a marker whenever other
people are present; whether they are said aloud is decided by the model following the self-check. A model can
misjudge, be talked into it by a guest, or paraphrase closely.

Also not guaranteed:

- The keyword rules decide what gets a marker and what counts as a secret. Content phrased with none of the listed
  words is treated as ordinary.
- A reply the model gave one-to-one that paraphrases a secret is hard-withheld only when the secret came through
  recall with recorded provenance (text chat). Voice turns record no provenance.
- Interests and a daily focus are matched against withheld turns by their words only.
- The rule cannot tell who is physically present. It trusts the mode, the owner's words, and the names said aloud.
- "Everyone present already knows it" is approximated by "was present when it was said to Shannon".
- A group conversation is one audience. A member who joined later is treated as having seen earlier messages.
- The current call's own turns and general knowledge the model has are not filtered.
- Real two-speaker audio, a noisy room, model behaviour under the self-check, and the legacy Discord runtime are not
  exercised by the automated tests. The tests prove what is in the prompt, never what the model says.

## What is still guaranteed (hard)

With anyone else present these never reach a model, so they cannot be said:

- what the owner asked to keep secret (the `secret` category), unless it was said in front of the same people;
- any item the owner marked 機微 by hand;
- everything from a call whose guest was never named;
- forgotten, rejected and corrected-away items, and a discarded call (unchanged forgetting boundary);
- replies, summaries, notes, facts, promises and goals built from the above, within the limits listed.

And independent of disclosure:

- a friend's words never become an owner fact, promise, goal, experience or thread message;
- no command acts, no goal is learned and no work is proposed while anyone else can hear;
- 「今回は残さない」 leaves nothing of the call;
- a client that sends no call id is given no owner memory at all.
