# People and audience-scoped memory

Status: design note for the owner's decision of 2026-10-02. Implementation authority after merge is
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
2. ライ氏と二人だけの時は全部使い、ほかの人がいる場では、守るべき個人情報を含まないものと、**その場の全員がすでに聞いていたもの**だけを使います。
3. どちらか分からないものは守る側に倒し、開発の作業・ノート・タスクは、ほかの人がいる場では内容に関係なく出しません。

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

Items with no label of their own are judged as unlabelled, that is owner-only and sensitive: rolling thread summaries,
Shannon's private knowledge, interests, the cached active-memory projection, intentions, and summary notes.

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

One pure function, `mayDisclose(disclosure, present)` in `packages/cognition/src/disclosure.ts`, decides it for every
path. `services/api/src/memoryDisclosure.ts` resolves an item's label (stored label, then the owner's control) and calls
that function; text chat, owner voice, 「友人も一緒」 and the platform context route all build their prompt through it.
`prepareTurnCognitiveContext` and the semantic recall stage take `present` as a required argument, so a new path cannot
be added without stating who is present.

```text
present is owner only                → use
item is ordinary                     → use
everyone present is in the audience  → use     (an unidentified guest is never in any audience)
otherwise                            → withhold
```

A completed turn must pass twice: by its own label, and by the labels of the memories that were recalled into its
prompt (its recorded provenance), because a reply written with a protected memory in front of it may restate it in
other words. The owner's own ふつう on the turn overrides the second check.

Applied to: thread history, recalled experiences, full-text hits, semantic hits, thread summaries, profile facts and
relationships, promises, Shannon's private knowledge, the intention frame, and person memories. Agent tasks, Aether
and Voyager projections are withheld whenever anyone else is present, whatever their content. The decision reads
stored labels only; it calls no model and adds no wait to chat or voice.

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
| Sensitivity | sensitive |
| Speaker in a call with anyone else present | the friend, not the owner (no owner fact, promise or goal is extracted) |
| A name that matches more than one remembered person | nobody: Shannon asks, and the call stays `unknownGuest` |
| A guest who never gave a name | `unknownGuest`; the record is usable only when the owner is alone |
| A person record that was deleted or forgotten | absent: nothing about them is used |
| Label unreadable or malformed | owner only, sensitive |

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
| The keyword rules miss sensitive content phrased with none of the listed words | It is labelled ordinary and may be used with others present. The owner can mark it 機微. |
| The rules match harmless text | It is withheld with others present until the owner marks it ふつう. |
| Speech recognition mishears the name | A new person is created or a wrong one matched. The owner renames or merges in 「人」; 「今回は残さない」 removes it. |
| Someone gives another person's name | Shannon believes the words. The owner is present and introduced them; voices are not checked. |
| The owner speaks in a 「友人も一緒」 call | His first-person statement is stored as the friend's fact. The owner can forget that item. |
| The app is killed before the period ends | Nothing of that period is stored. |
| The summary model fails or quotes speech | A deterministic summary without model text is stored. |
| The owner says someone is present but does not switch | Sensitive memories, tasks, notes, intentions and today's focus are withheld; turns are stored as "someone else was present", teach nothing about the owner, do not move Shannon's stored feeling, and are themselves not replayed as history while anyone is listening. The current iPhone build keeps this for the rest of the call. A build that predates it is protected only on the turns whose own words say so. Voice commands still run. |
| A name is mentioned, not introduced (「友達のミキさんが転職したらしい」) | No name is established: only a present-tense introduction or a self-introduction from the start of the utterance counts. |
| A correction changes what a memory says | The corrected wording is judged by the same rules; a memory that was protected stays protected when it is stated again in plainer words. |
| One fact about a person is forgotten | That item and replies that used it are withheld. The call's summary and exchanges that say the same thing in other words stay until they are forgotten too. |

## What is not guaranteed

- A model that was given sensitive content in a permitted context (alone with the owner, or with person A) may
  paraphrase it in its reply. A text reply is protected when the content came through recall (recorded provenance).
  It is not when the content came from the always-present profile block or from the thread history, and voice turns
  record no provenance: those replies are labelled by the keyword rules on their own words only.
- Content already sent to a model in a running call is not retracted when someone joins. The switch affects later turns.
- The rule cannot tell who is physically present. It trusts the mode, the owner's words, and the names said aloud.
- "Everyone present already knows it" is approximated by "was present when it was said to Shannon". What people told
  each other elsewhere is unknown.
- A group conversation is one audience. A member who joined later is treated as having seen earlier messages.
- General knowledge the model has, and the current call's own turns, are not filtered.
- Real two-speaker audio, a noisy room, and the legacy Discord runtime are not exercised by the automated tests.
