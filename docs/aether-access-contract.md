# Aether access: the Shannon side

Contract: `syzygy.aether-shannon-access.v1` (Syzygy hub `contracts/aether-shannon/README.md`) and knowledge search v1 with the optional `scope`, `inShannonFolder` and `inStudy` (hub `contracts/knowledge/`).
Authority: Syzygy ADR-0007 and its revision of 2026-10-06 (owner decision). Shannon is the consumer; Aether is the provider.
State: implemented on the server behind configuration; the apps' screens are unchanged (see "What the apps may change").

## Words

- **シャノン用フォルダ**: where she keeps documents, code and files freely. Three places: one Aether folder (`project_shannon_folder`), and her folders on the owner's Windows PC and MacBook (`docs/host-folder-contract.md`).
- **シャノンの書斎**: her stories. Only in Aether: documents tagged 「書斎」 (type `story`) in the Aether シャノン用フォルダ. That is the canonical copy. Stories are never put in the PC or Mac folder.

## Configuration

| Variable | Meaning |
| --- | --- |
| `SHANNON_AETHER_API_URL` | The Aether authenticated API (`http://127.0.0.1:3007` on the VM, or the public `/aether` path). |
| `SHANNON_AETHER_SHANNON_TOKEN` | The Shannon-scoped token (`node scripts/mobile-auth.cjs issue-shannon-token` on the VM, owner-approved). Never logged, never in an error. |
| `SHANNON_AETHER_TIMEOUT_MS` | One request's timeout, 500–60,000 ms (default 8,000). |
| `SHANNON_AETHER_PROPOSAL_DIR` | The proposal inbox (unchanged; v2 adds `update` and `delete`). |

With the URL or the token unset there is no client (`configuredAetherAccess` returns null): no Aether tool is offered, her study is the SQLite study, the app routes answer exactly as before, and the copy step of her own time is what it was. Set both alike for the API (`server.ts`) and the autonomy service (`autonomyWorker.ts`); the autonomy service never gets the proposal inbox.

## The client (`services/api/src/aetherAccess.ts`)

- `POST api/shannon/v1/knowledge-search`: the knowledge search v1 envelope, `scope` sent unless `all`; the response is parsed by `aetherKnowledgeSearch.ts` and fails closed on any unknown field or another contract.
- `POST api/shannon/v1/document` `read`: `{documentId, offset?, maxChars?}` (1–20,000 code points) or `{documentId, sectionId}`. A missing `inShannonFolder` counts as outside her folder.
- `POST api/shannon/v1/folder` `list` / `create` / `update` / `delete` with `baseVersion` and `idempotencyKey` (`shannon.` + 48 hex characters of a SHA-256 over what makes the write the same write).
- Every response must carry this contract and the expected `kind`; anything else is `CONTRACT_MISMATCH`. Redirects are refused; a response over 4 MB is refused.

| Provider answer | Shannon code | Her tool result |
| --- | --- | --- |
| 409 `STALE_VERSION` | `STALE_VERSION` | `conflict`: read again, write from the new version |
| 403 `OUTSIDE_SHANNON_FOLDER` | `OUTSIDE_SHANNON_FOLDER` | `refused`: propose with `aether.propose` |
| 404 / `NOT_FOUND` | `NOT_FOUND` | `not_found` |
| 409 `IDEMPOTENCY_KEY_REUSED` | `IDEMPOTENCY_KEY_REUSED` | `conflict` |
| 400 / 413 / `INVALID_REQUEST` | `INVALID_REQUEST` | `invalid_input` |
| 401 / other 403 | `UNAUTHORIZED` | `unavailable` (token) |
| timeout | `TIMEOUT` | `timeout`, retryable |
| network, 5xx | `UNAVAILABLE` | `unavailable`, retryable |
| another contract or shape | `CONTRACT_MISMATCH` | `unavailable` |
| (gate) a document outside her folder with others present | `OUTSIDE_AUDIENCE` | `refused`: with the owner alone |

## Her tools (`shannonTools.ts`, `shannonAetherTools.ts`)

| Tool | Effect | Audiences | Surfaces |
| --- | --- | --- | --- |
| `aether.search` (`query`, `scope`, `limit`) | read | owner alone, others | text, voice, own time |
| `aether.read` (`documentId`, `offset`, `maxChars`, `sectionId`) | read | owner alone, others | text, voice, own time |
| `aetherFolder.list` | read | owner alone, others | text, voice, own time |
| `aetherFolder.create` / `update` / `delete` | write | owner alone | text, voice, own time |
| `aether.propose` (`operation`: new-note, append, update, delete) | write | owner alone | text, voice |

Offered only while Aether is configured (`aether.propose` while the inbox is). Gate domain `aether_study` (her own time) and `aether_proposal` (conversation only, never seen by the autonomy gate).

**Who may read what** is decided at the gate (`shannonToolGate.ts`), not in the prompt: with the owner alone in a conversation everything may be searched and read; with anyone else present (others in text, another voice, a call with someone listening, what the server knows of her body) and in her own time, `authorizeToolInput` refuses `aether.search` unless `scope` is `shannonFolder` or `study`, and `gatedAether` hands the executor a client that keeps only hits placed in her folder and reads a document only after a one-character read showed it is in her folder. In a turn with others present only these three reading tools are offered, with their own instruction (no reciting an unshown work to others). A guest-only turn (`ownerAlone: false`, 「友人も一緒」) still gets no tool. Her own time reads only her folder because its gate domain is her study; reading the owner's documents in her own time would need a domain in `packages/cognition/src/autonomy.ts` (core).

Nothing she reads is stored: results live in the turn (or until her next thought in her own time), traces keep ids and counts only, and the activity record names no document text and no title of her study.

## Her study in Aether (`studyAether.ts`, `studyAetherLinks.ts`)

- A story is a document with `inStudy: true` (tag 書斎, type `story`); a note one with `inStudy: false`. Her notes about a look at the room and what she jotted after an unanswered message never move (with others present her Aether folder may be read).
- A write goes to Aether first (create, or update with `baseVersion` = the Aether version she last saw, or delete into Recently Deleted), then her local version and its link commit in the transaction that records the step or call. Aether refused: nothing is written in Shannon. A stale version brings the newer Aether text in as her next local version (change note 「Aetherの側で変わった版です…」) before the write fails, so the next try starts from it.
- `study_aether_links` (insert-only): local version ↔ Aether document and version. Shannon keeps what Aether does not: the stage (下書き, 見せてもいい, 見せた, しまった), the version the owner reads, every version with what changed and why, and the owner's reactions (`study_feedback.aether_document_id`, `aether_version`).
- Every study tool call first syncs (`StudyAether.sync`, at most 4 s): newer Aether versions are adopted, a document gone from Aether, or moved out of her folder (Aether answers it with `inShannonFolder: false`), puts the piece in her trash and nothing of its text is kept, one the owner restored takes it back out, and an unknown story in her study (a write whose local half was lost) is adopted as a draft. Unreachable Aether: reads answer from Shannon's copy and say so; writes fail.
- `study.restore` of a piece in Aether is refused: the owner restores it in Aether (Recently Deleted on iPhone, or by moving it back into her folder), and the next sync brings it back.
- Her own time: `note`, `draft` and `revise` write to Aether first (`aether_*` reason codes when they cannot); `show` and `put_away` change Shannon's stage only. The v1 step that copies a piece to the PC folder is neither offered nor prepared while Aether is configured, and her folder tools refuse a file that carries a run of one of her stories.
- A piece that has not moved yet (no link) stays in Shannon and is written there until the migration moves it.

## App-facing routes (unchanged paths, additive fields)

- `GET /v1/autonomy/study`: with Aether, syncs first (4 s), then the same body plus `source: { kind: "aether", reached }`. Each readable card may carry `aetherDocumentId` and `aetherVersion` (the Aether version of the version he reads). A hidden card carries neither.
- `GET /v1/autonomy/study/pieces/{id}`: `{id}` may be the piece id or its Aether document id; refreshes that piece first. `feedback[]` items may carry `aetherDocumentId`, `aetherVersion`.
- `POST …/{id}/reaction` and `POST …/{id}/put-away`: `{id}` as above; the reaction is stored in Shannon with the Aether document and version.
- Piece ids, `shannon-study://<id>` links in her messages, and every existing field keep their meaning.

## Migration (`services/api/scripts/migrate-study-to-aether.ts`, `studyMigration.ts`)

`pnpm --filter @shannon/api migrate:study-to-aether` (dry run) prints, per scope, the counts and one line per piece: kind, title, length, stage, whether the owner has seen it, and where it goes (or why it stays). No body is printed. `--apply` (Aether configured) creates one document per piece from its current version with the key `study / scope / migration / piece / version`, links it, names its reactions' document, and appends one line to the activity record. Run again after an interruption; nothing moves twice. `--scope` and `--database` narrow it. Back up the database first; show the owner the dry run before `--apply`.

## What the apps may change (next step)

See the report of this change in the Syzygy hub; in short: read `source.reached` to say when Aether could not be reached, keep using piece ids, optionally open a story in Aether by `aetherDocumentId`, and show that a deleted story is restored from Aether's Recently Deleted.

## Asked of the provider (not blocking)

- `list` entries with `status` (or without deleted documents), so a deleted document is not read to find out it is deleted.
- A `restore` kind, if Shannon should take a piece back out of Recently Deleted herself.
