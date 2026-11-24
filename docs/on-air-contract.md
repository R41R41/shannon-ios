# 「収録中」 (`/v1/on-air`)

The owner can tell her that what is said now is being recorded or broadcast, and will be seen and heard by people who are not in the room. It is a state **with an end** and a short **note the owner writes** for the scene (who is where, what is not to be talked about).

While it is on, the spoken reply's prompt (a Discord voice turn, `surfaces/platform/voicePresencePrompt.ts`) carries an 「いま収録中」 block: the people in the call and in the Minecraft server are greeted by name together with the viewers, a first greeting may be up to 50 characters (otherwise 40), what the note says not to talk about and what is not yet announced is not talked about, and the owner's private memories stay private (that rule is the same with or without this state). While it is off, the prompt says nothing of viewers. Nothing else reads the state. No model writes it, and no environment switch exists for it. The names in the note are the owner's own words, kept on the server only.

The same block family has a second part that does not depend on this state: 「いま誰がどこにいるか」 lists the people in the call and in the Minecraft server (besides her) by the names her records of people give them (the owner renames a person there; `PlatformPeople.callName`). A game name is matched without regard to case; an account she has no person for is counted ("名前の分からない人が N 人"), never named. The server's people come from the names the body sends in its lifecycle frame (`MinecraftLifecycleState.playerNames`, optional; a body that does not send them leaves the line out).

## Route

`GET` and `POST /v1/on-air`: the owner's paired device only (a guest device is `403 ON_AIR_OWNER_ONLY`, no device `403 PAIRED_DEVICE_REQUIRED`); the scope is the device's own. At most 30 requests a minute per device.

- `GET`: `200 { "onAir": { "until": ISO time, "note": string } | null }`. `null` when it was never set, has lapsed, or cannot be read (every doubt is "not on air").
- `POST`: `{ "off": true }` clears it. Otherwise `{ "minutes"?: whole number 1–720 (default 240), "note"?: text up to 600 characters }` sets it until that many minutes from now. The answer is the same as `GET`. Another field, a wrong type or a non-JSON body is `400 INVALID_REQUEST`; over 4 KiB is `413 REQUEST_TOO_LARGE`; any other method is `405 METHOD_NOT_ALLOWED`; too many requests `429 RATE_LIMITED`.

## Record

`on_air` (`scope_key` primary key, `until_at` text not null, `note` text not null, `changed_at` text not null): one row per scope, created with `CREATE TABLE IF NOT EXISTS` by `SQLiteOnAirStore` on a connection of its own, outside the numbered migrations. The operations console's store is not used, because that one is kept out of every prompt. A row past `until_at`, with an unreadable end, or in a table that cannot be read is not on air.
