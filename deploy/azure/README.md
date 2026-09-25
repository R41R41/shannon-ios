# Azure deployment contract

This directory is a reviewable template. Applying it to the VM is a separate,
explicit release operation.

- Repository: `/home/azureuser/shannon-ios`
- Writable data only: `/home/azureuser/shannon-ios-data`
- Secrets only: `/home/azureuser/.config/shannon-ios/api.env` (`0600`)
- Isolated Node 24 runtime: `/home/azureuser/shannon-ios-runtime/bin/node`
- Loopback API: `127.0.0.1:4319`
- Optional private Gemini Voice Lab: `127.0.0.1:4322` (SSH tunnel only; no Nginx route)
- Public HTTPS base: `https://sh4nnon.com/companion`
- Services: `shannon-ios.service` (response lane) and `shannon-ios-worker.service` (background/sleep lane)

## Optional private Gemini Voice Lab

`shannon-gemini-voice-lab.service` runs the browser listening workbench from
`/home/azureuser/shannon-voice-lab`. It reuses only `GEMINI_API_KEY` from the
mode-0600 API environment file. It has no public Nginx location, binds only to
loopback, writes no samples, transcripts, or tokens to disk, and does not access
Shannon's database.

From the trusted Mac, open an authenticated SSH tunnel and the default browser:

```sh
pnpm voice:gemini:web
```

Keep that terminal open while using the lab. Closing it removes browser access.
Normal TTS samples live only as in-memory browser object URLs. Voice Design is the
one explicit exception: after a confirmation checkbox, Google stores the resulting
Voice ID in the API project for up to one year. Deletion requires the exact ID.
Gemini Live receives a single-use, short-lived token; the permanent API key is never
returned to the browser.

## Optional cloud Agent Host

`shannon-agent-host.service` moves user-directed Codex work off the Mac. It uses:

- a dedicated writable checkout at `/home/azureuser/shannon-agent-workspace/shannon-ios`
- durable host/Codex state under `/home/azureuser/shannon-agent-data`
- dynamically added GitHub repositories under `/home/azureuser/shannon-agent-workspace`
- a dedicated Codex executable under `/home/azureuser/shannon-agent-runtime`
- secrets in `/home/azureuser/.config/shannon-agent-host/agent-host.env` (`0600`)

Do not point the Agent Host at `/home/azureuser/shannon-ios`, because that tree is
the running API deployment. The worktree and production deployment must remain
separate so an unfinished edit cannot change the live service.

The Development screen accepts only an HTTPS `github.com/<owner>/<repository>`
coordinate and a bounded alias. The API assigns the request to one available
host; the host supplies its own GitHub credential, clones into the dedicated
workspace root, and advertises the alias only after clone completion. Do not put
GitHub tokens in the request or in Shannon's database.

The API setting `SHANNON_AGENT_DEFAULT_HOST=shannon-cloud` should be enabled only
after the cloud host heartbeat and a harmless end-to-end task succeed. Until then,
leave it unset so task proposals continue to target `shannon-mac`.

The cloud host needs two independent, revocable credentials: Codex/OpenAI access
and write access to the private GitHub repository. Never reuse or copy the Mac's
personal Codex login directory. Xcode Cloud remains responsible for iOS builds,
signing, and internal TestFlight distribution after a reviewed commit reaches GitHub.

The VM's system Node is currently v20 and cannot run `node:sqlite`. Do not
upgrade it in place because existing Shannon and Aether services use it. Install
an isolated Node 24 LTS runtime at the path above and verify its checksum before
the first release.

After the reviewed release is installed, an operator issues a 30-minute,
single-use code without printing any secret other than that code:

```sh
cd /home/azureuser/shannon-ios
set -a
. /home/azureuser/.config/shannon-ios/api.env
set +a
export SHANNON_DATABASE_PATH=/home/azureuser/shannon-ios-data/shannon.sqlite
/home/azureuser/shannon-ios-runtime/bin/node --import tsx services/api/src/authCli.ts issue-code owner
```

The command prints a `shannon://connect?...` link for one-tap setup. During a
trusted development-device install, pass the one-time code to the app process as
`SHANNON_PAIRING_CODE`; the app consumes it once and stores only the resulting
device token in Keychain. Never omit `SHANNON_DATABASE_PATH`: paired-mode CLI
commands fail closed when it is absent so they cannot silently write to the
repository-local development database.

List or revoke devices with `list` and `revoke <device-id>`. The database stores
only HMAC digests of codes and tokens. Back up `shannon.sqlite` and its WAL/SHM
files as one SQLite backup unit while preserving mode `0600`.

The API and worker deliberately share only the SQLite file. Install and enable
both unit templates together at the eventual reviewed release; do not run the
new API without the worker, because queued affect and memory updates would then
remain pending. The worker schedules one sleep job per owner/day; transient
failures can retry it up to five times. It uses `SHANNON_SLEEP_TIMEZONE` /
`SHANNON_SLEEP_HOUR` from its unit environment.

## Optional legacy-platform bridge

`POST /v1/platform/turns` is a service-to-service ingestion boundary for the
existing Discord, LINE, Minecraft, X, and YouTube runtimes. It does not replace
their transports or tools. It mirrors a completed owner-authored turn into the
canonical Shannon conversation store and queues the normal memory refinement.

`POST /v1/platform/context` uses the same credential and owner binding to return
a read-only, 2,400-character maximum projection of current temperament,
emotion, interests, owner facts, relationship guidance, and active memories.
It returns no scope key or conversation history and performs no database write.
Legacy response generation must fall back to its existing prompt when this
optional read is unavailable.

The route is disabled unless its token, canonical owner scope, and JSON binding
list are all present. Every binding fixes one platform conversation to one
external owner ID and a safe thread title. Discord may additionally bind one
exact guild prefix (`discord:<guild-id>:`) so that future channels are covered
without admitting another guild; the external owner ID remains exact. Unknown
conversations and actors fail closed. The request cannot choose a Shannon scope, retries are idempotent by
platform plus request ID, and the database stores only a hash-derived thread ID
rather than the raw external conversation ID. Give the legacy runtime a
dedicated revocable token; never reuse a paired-device or Agent Host credential.

## Owner-managed person identities

Authenticated owner clients manage the Phase 3 identity registry through
`GET /v1/people`, `GET /v1/people/audit`, `POST /v1/people/candidates`, the
`/v1/people/identities/{confirm,correct,revoke}` actions, and
`POST /v1/people/delete`. Paired authentication binds every request to the owner
scope; Discord IDs are never accepted from the public platform bridge as automatic
relationship memory.

New Discord IDs start as candidates. Confirmation is explicit, correction of the
ID returns it to candidate status, and stale revisions fail closed. Deleting a person
removes the name and raw Discord ID while retaining a content-free audit event. The
SQLite tables are created additively when the API starts; back up the production
database before the first restart that includes this schema.
