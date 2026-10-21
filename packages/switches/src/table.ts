/**
 * The one table of the server's switches (Syzygy ADR-0009 stage 1, D9). Each entry names how its value is read (`kind`), what
 * it is when unset (`default`), which part owns it, which switches it needs to have any effect (`requires`), and one line of
 * documentation. `deploy/azure/api.env.example` has a section generated from this table (`scripts/generate-env-example.mjs`).
 *
 * This file imports nothing and uses only erasable TypeScript, so a plain Node script can read it.
 *
 * Kinds (the words each one reads, after trimming; the first three ignore case):
 * - `default_on`: on unless the value is `off`, `false`, `0`, `disabled`, `no` or `none`.
 * - `explicit_on`: off unless the value is `on`, `true`, `1` or `yes`.
 * - `on_only`: off unless the value is `on`.
 * - `true_only`: off unless the value is exactly `true`.
 */
export type SwitchKind = 'default_on' | 'explicit_on' | 'on_only' | 'true_only';

export interface SwitchEntry {
  readonly name: string;
  readonly default: 'on' | 'off';
  readonly kind: SwitchKind;
  readonly owner: string;
  readonly requires: readonly string[];
  readonly doc: string;
  /**
   * The value a new installation sets (`deploy/azure/api.env.example`), when it differs from the code's default: the default
   * stays what the historical OFF profiles read, and the example says what the server needs now.
   */
  readonly setup?: 'on';
}

const STAGE1 = 'SHANNON_ADR8_STAGE1';
const STAGE2 = 'SHANNON_ADR8_STAGE2';
const STAGE3 = 'SHANNON_ADR8_STAGE3';
const STAGE4 = 'SHANNON_ADR8_STAGE4';

export const SWITCHES = [
  {
    name: STAGE1, default: 'on', kind: 'default_on', owner: 'learning', requires: [],
    doc: 'ADR-0008 stage 1 master switch: the prediction and choice ledgers, the value table and decision traces.',
  },
  {
    name: 'SHANNON_PREDICTION_SHADOW', default: 'on', kind: 'default_on', owner: 'learning', requires: [],
    doc: 'ADR-0006 stage 1 prediction shadow; the prediction ledger needs it.',
  },
  {
    name: 'SHANNON_PREDICTION_LEDGER', default: 'on', kind: 'default_on', owner: 'learning',
    requires: [STAGE1, 'SHANNON_PREDICTION_SHADOW'],
    doc: 'Predictions opened before an outcome and settled against it.',
  },
  {
    name: 'SHANNON_CHOICE_LEDGER', default: 'on', kind: 'default_on', owner: 'learning', requires: [STAGE1],
    doc: 'Her choices, their reward and the value table.',
  },
  {
    name: 'SHANNON_REWARD_MOOD', default: 'on', kind: 'default_on', owner: 'learning', requires: ['SHANNON_CHOICE_LEDGER'],
    doc: 'A settled choice moves her mood (choice-appraised).',
  },
  {
    name: 'SHANNON_VALUE_FACTS', default: 'on', kind: 'default_on', owner: 'learning', requires: ['SHANNON_CHOICE_LEDGER'],
    doc: 'The value-table lines in her thinking prompt.',
  },
  {
    name: 'SHANNON_DECISION_TRACES', default: 'on', kind: 'default_on', owner: 'learning', requires: [STAGE1],
    doc: 'One content-free trace per decision.',
  },
  {
    name: STAGE2, default: 'on', kind: 'default_on', owner: 'routing', requires: [],
    doc: 'ADR-0008 stage 2 master switch: tool menu, read tools, difficulty, verifier, skills, tree recall.',
  },
  {
    name: 'SHANNON_TOOL_MENU', default: 'on', kind: 'default_on', owner: 'routing', requires: [STAGE2],
    doc: 'Jev chooses the tool schemas a turn is offered.',
  },
  {
    name: 'SHANNON_READ_TOOLS', default: 'on', kind: 'default_on', owner: 'routing', requires: [STAGE2],
    doc: 'Notion, Voyager tasks, the schedule and place search as gated registry tools.',
  },
  {
    name: 'SHANNON_DIFFICULTY', default: 'on', kind: 'default_on', owner: 'routing', requires: [STAGE2],
    doc: 'Difficulty questions, the tier policy and the competence table.',
  },
  {
    name: 'SHANNON_TURN_VERIFY', default: 'on', kind: 'default_on', owner: 'routing', requires: [STAGE2],
    doc: 'The turn verifier (write claims against write results).',
  },
  {
    name: 'SHANNON_SKILLS', default: 'on', kind: 'default_on', owner: 'routing', requires: [STAGE2],
    doc: 'Skill memory.',
  },
  {
    name: 'SHANNON_SKILL_EXPORT', default: 'on', kind: 'default_on', owner: 'routing', requires: ['SHANNON_SKILLS'],
    doc: 'Readable copies of her skills in her Aether folder.',
  },
  {
    name: 'SHANNON_TREE_RECALL', default: 'on', kind: 'default_on', owner: 'routing', requires: [STAGE2],
    doc: 'Beam search over headings for recall.',
  },
  {
    name: 'SHANNON_SONNET_ROUTING', default: 'off', kind: 'explicit_on', owner: 'routing', requires: ['SHANNON_DIFFICULTY'],
    doc: 'The sonnet tier may leave for Anthropic (also needs the Anthropic key).',
  },
  {
    name: 'SHANNON_CONVERSATION_REWARD', default: 'on', kind: 'default_on', owner: 'routing', requires: [STAGE2, 'SHANNON_CHOICE_LEDGER'],
    doc: 'Conversation tool calls and tier choices go into reward, mood and the value table.',
  },
  {
    name: STAGE3, default: 'on', kind: 'default_on', owner: 'mind', requires: [],
    doc: 'ADR-0008 stage 3 master switch: perception, attention, the workspace and the memory writer.',
  },
  {
    name: 'SHANNON_MIND_EVENTS', default: 'on', kind: 'default_on', owner: 'mind', requires: [STAGE3],
    doc: 'Every surface hands what it perceived to the mind as one event.',
  },
  {
    name: 'SHANNON_ATTENTION', default: 'on', kind: 'default_on', owner: 'mind', requires: ['SHANNON_MIND_EVENTS'],
    doc: 'Salience orders the events.',
  },
  {
    name: 'SHANNON_WORKSPACE', default: 'on', kind: 'default_on', owner: 'mind', requires: ['SHANNON_ATTENTION'],
    doc: 'The shared place and the notices of a turn prompt.',
  },
  {
    name: 'SHANNON_DATA_FRAMES', default: 'on', kind: 'default_on', owner: 'mind', requires: [STAGE3],
    doc: 'Untrusted text reaches a prompt inside data frames.',
  },
  {
    name: 'SHANNON_PROACTIVE_GATE', default: 'on', kind: 'default_on', owner: 'mind', requires: [STAGE3],
    doc: 'Intent repeat, intent expiry and topic reuse checks on her own messages.',
  },
  {
    name: 'SHANNON_MEMORY_OUTBOX', default: 'on', kind: 'default_on', owner: 'mind', requires: [STAGE3],
    doc: 'Memory proposals go to the outbox and one writer applies them.',
  },
  {
    name: 'SHANNON_TEMPORAL_FACTS', default: 'on', kind: 'default_on', owner: 'mind', requires: ['SHANNON_MEMORY_OUTBOX'],
    doc: 'People facts carry validity times.',
  },
  {
    name: 'SHANNON_EVIDENCE_DECAY', default: 'off', kind: 'explicit_on', owner: 'mind', requires: [STAGE3],
    doc: 'Two-clock evidence decay replaces the fading of impressions.',
  },
  {
    name: 'SHANNON_IDENTITY_TIERS', default: 'on', kind: 'default_on', owner: 'mind', requires: [STAGE3],
    doc: 'Identity tiers suggest a merge; the owner merges.',
  },
  {
    name: 'SHANNON_TRUST_LEDGER', default: 'on', kind: 'default_on', owner: 'mind', requires: [STAGE3],
    doc: 'The trust ledger records its closed kinds.',
  },
  {
    name: 'SHANNON_STRUCTURED_COMPACTION', default: 'on', kind: 'default_on', owner: 'mind', requires: [STAGE3],
    doc: 'The replay summary is a template rendered by code.',
  },
  {
    name: STAGE4, default: 'off', kind: 'explicit_on', owner: 'actions', requires: ['SHANNON_WORKSPACE'], setup: 'on',
    doc: 'ADR-0008 stage 4 action threads in the mind worker. Required: the common task runtime is always on (ADR-0009 S9), '
      + 'so the API stops at start without it (FCA_ACTION_THREADS_REQUIRED); run the mind worker (worker:mind) beside the API.',
  },
  {
    name: 'SHANNON_ADR8_STAGE5', default: 'off', kind: 'on_only', owner: 'tasks', requires: [],
    doc: 'ADR-0008 stage 5 ports: self interests, task trees, reply-bound feedback, gated self revision.',
  },
  {
    name: 'SHANNON_FCA_PROVENANCE_REFS', default: 'on', kind: 'default_on', owner: 'fca', requires: [],
    doc: 'A Minecraft task inherits only the asking conversation\'s sources, and FCA step records keep sources by reference '
      + '(execution/013_fca_provenance_sets). off: whole parent set and copies; rows by reference stay readable.',
  },
  {
    name: 'SHANNON_FCA_TOUCH', default: 'off', kind: 'on_only', owner: 'fca', requires: [STAGE4],
    doc: 'Touch reflexes run under the FCA runtime.',
  },
  {
    name: 'SHANNON_FCA_BODY_RECALL_JEV', default: 'off', kind: 'on_only', owner: 'fca', requires: [],
    doc: '2026-10-19: a body task\'s recall asks Jev which of its best 24 memories help the decision now and keeps only those (none '
      + 'is allowed); a timeout or failure keeps the situation order. Off until Jev\'s speed and price are measured (SHANNON_JEV_USD_PER_CALL).',
  },
  {
    name: 'SHANNON_FCA_SKILL_GIST', default: 'on', kind: 'default_on', owner: 'minecraft', requires: ['SHANNON_SKILLS'],
    doc: 'Owner 2026-10-15: a body task\'s skill pointer carries a gist of that skill\'s first steps (no skill.read needed); off, the pointer alone.',
  },
  {
    name: 'SHANNON_MINECRAFT_LIFECYCLE', default: 'off', kind: 'on_only', owner: 'minecraft', requires: [STAGE4],
    doc: 'Registered Minecraft start and stop tools under the action gate.',
  },
  {
    name: 'SHANNON_MINECRAFT_FAST_JUDGMENT', default: 'off', kind: 'on_only', owner: 'minecraft', requires: [],
    doc: 'Image-free fast judgment of danger for a Minecraft body: fight, flee or shelter from its own state (Syzygy ADR-0011 stage 2).',
  },
  {
    name: 'SHANNON_MINECRAFT_ROUTE_PLAN', default: 'off', kind: 'on_only', owner: 'minecraft', requires: [],
    doc: 'Owner 2026-10-20: a strong model (SHANNON_MINECRAFT_ROUTE_MODEL, Opus 5.5) plans a body task\'s route to the Nether once, and when late.',
  },
  {
    name: 'SHANNON_MINECRAFT_WORKING_EVENTS', default: 'off', kind: 'on_only', owner: 'minecraft', requires: [],
    doc: 'What a Minecraft body tells while it works cuts a stalled command or a calm wait with a need in reach (mb-arch stage 1).',
  },
  {
    name: 'SHANNON_MINECRAFT_AGENDA', default: 'off', kind: 'on_only', owner: 'minecraft', requires: [],
    doc: 'A Minecraft task plans ahead while its body works, fills waits, takes nearby needs and resumes (mb-arch); with the working events.',
  },
  {
    name: 'SHANNON_MINECRAFT_LLM_CENTRIC', default: 'off', kind: 'on_only', owner: 'minecraft', requires: [],
    doc: 'Design mb-llm-centric (2026-10-21): a Minecraft task decides in small steps from a map of the blocks around her (mc.act, mc.view), '
      + 'keeps its own plan tree (plan.update), and runs no procedure, agenda detour or fast judgment. Models: SHANNON_MINECRAFT_LLMC_MODEL, '
      + '_ESCALATE_MODEL, _PLAN_MODEL. The body must run MINEBOT_LLM_CENTRIC=on. Off: as before.',
  },
  {
    name: 'SHANNON_MINECRAFT_LLMC_PROBE', default: 'off', kind: 'on_only', owner: 'minecraft', requires: ['SHANNON_MINECRAFT_LLM_CENTRIC'],
    doc: 'mb-llmc r4 (owner 2026-10-22): a surprise (health, a fall, air, the same stop twice, no hit) has the body probed before the decision '
      + 'and said first in its live state; the model gets mc.probe, the body\'s world scan goes to the first plan and the live state, plan '
      + 'nodes carry forbid and caution, and the knowledge says how to look when stuck. Needs the body\'s probe skill. Off: as r3.',
  },
  {
    name: 'SHANNON_MINECRAFT_LIVE', default: 'off', kind: 'on_only', owner: 'minecraft', requires: [],
    doc: 'Owner 2026-10-20 (dc-live): every conversation (the app, Discord text and calls) is given her Minecraft body\'s present from its latest frame '
      + '(task, step against its target seconds, health, hunger, danger, items, map); the moments her frames show are noticed.',
  },
  {
    name: 'SHANNON_MINECRAFT_LIVE_SPEECH', default: 'off', kind: 'on_only', owner: 'minecraft', requires: ['SHANNON_MINECRAFT_LIVE'],
    doc: 'Owner 2026-10-20 (dc-live): she says a word of her own about a moment of her Minecraft body (a diamond, the armour, a near death, '
      + 'the night) in the voice channel she is in or the body\'s text channel, one or two a minute at most and never over someone who is '
      + 'talking. The body must be set to speak (MINEBOT_LIVE_*).',
  },
  {
    name: 'SHANNON_TEMPORAL_KNOWLEDGE_RECALL', default: 'off', kind: 'on_only', owner: 'recall', requires: [],
    doc: 'Conversation recall reads temporal knowledge.',
  },
  {
    name: 'SHANNON_ANTHROPIC_STRICT_REJECTIONS', default: 'off', kind: 'explicit_on', owner: 'model', requires: [],
    doc: 'Only a 400 naming the offered tools or schemas earns the tool-less answer (off: any non-auth 4xx does, as before).',
  },
  {
    name: 'SHANNON_CLAUDE_CACHE_PLAN', default: 'off', kind: 'explicit_on', owner: 'model', requires: [],
    doc: 'Foreground text turns of Claude 5.5 keep one cached prefix (fixed tools, schema and system; per-turn lines after the words).',
  },
  {
    name: 'SHANNON_CLAUDE_CACHE_PLAN_VOICE', default: 'off', kind: 'explicit_on', owner: 'model', requires: [],
    doc: 'Claude 5.5 voice turns keep the same cached prefix (fixed tools and system; per-turn lines after the words), canaried apart from text.',
  },
  {
    name: 'SHANNON_STRICT_CONVERSATION_TOOLS', default: 'off', kind: 'explicit_on', owner: 'model', requires: [],
    doc: 'Claude 5.5 conversation tools go strict within the grammar budget (off: native non-strict tools; a new strict tool set cost 5-8 s to compile).',
  },
  {
    name: 'SHANNON_HAIKU_VOICE_THINKING', default: 'off', kind: 'explicit_on', owner: 'model', requires: [],
    doc: 'Haiku voice turns think adaptively before speaking (off: thinking disabled, owner-approved 2026-10-13; it cost 2-3 s before the first word).',
  },
  {
    name: 'SHANNON_TEXT_LIGHT_NO_THINKING', default: 'on', kind: 'default_on', owner: 'model', requires: [],
    doc: 'Light or read-aloud text turns answer without thinking unless hard or research (owner 2026-10-14; off: text always thinks).',
  },
  {
    name: 'SHANNON_REPLAY_EPOCHS', default: 'off', kind: 'explicit_on', owner: 'model', requires: ['SHANNON_CLAUDE_CACHE_PLAN'],
    doc: 'Replayed history is rendered once per epoch and only appended to until its budget is passed (text; voice also needs the voice plan).',
  },
  {
    name: 'SHANNON_VOICE_HISTORY_SUMMARY', default: 'on', kind: 'default_on', owner: 'model',
    requires: ['SHANNON_REPLAY_EPOCHS', 'SHANNON_CLAUDE_CACHE_PLAN_VOICE'],
    doc: 'Voice replays the last 4-8 exchanges after a summary of the call before them, frozen per epoch (owner 2026-10-14; off: the budget window).',
  },
  {
    name: 'SHANNON_MORNING_BRIEF', default: 'off', kind: 'explicit_on', owner: 'outreach', requires: [],
    doc: 'Morning brief (home weather, today\'s schedule, headlines) as the day\'s initiative, 07-10 owner time; needs SHANNON_OWNER_HOME_LOCATION.',
  },
  {
    name: 'SHANNON_INNER_NOTE', default: 'off', kind: 'explicit_on', owner: 'emotion', requires: [],
    doc: 'ADR-0012 stage 1: her inner note (reflection after salient events), character core and prompt cleanup; off, every prompt is as it was.',
  },
  {
    name: 'SHANNON_FEELING_EVENTS', default: 'off', kind: 'explicit_on', owner: 'emotion', requires: [],
    doc: 'ADR-0013 stage 1: every touch, word and reply of hers is a feeling event; the day\'s episode ledger; wordless touches. Off: as it was.',
  },
  {
    name: 'SHANNON_SINGLE_FACE', default: 'off', kind: 'explicit_on', owner: 'emotion', requires: ['SHANNON_FEELING_EVENTS'],
    doc: 'ADR-0013 stage 1: one face function (faceFor) for replies, touches and presence; her own apology words no longer take the face.',
  },
  {
    name: 'SHANNON_FEELING_TURN', default: 'off', kind: 'explicit_on', owner: 'emotion', requires: ['SHANNON_FEELING_EVENTS'],
    doc: 'ADR-0013 stage 1: Jev picks her stance, strength and comeback drawer before she replies; the last, strongest block of the prompt.',
  },
  {
    name: 'SHANNON_FEELING_STRONG_REPLY_MODEL', default: 'off', kind: 'explicit_on', owner: 'emotion', requires: ['SHANNON_FEELING_TURN'],
    doc: 'Owner 2026-10-14: a strong feeling turn\'s text reply goes to Sonnet (capped a day by SHANNON_FEELING_STRONG_REPLY_DAILY_CAP); else Haiku.',
  },
  {
    name: 'SHANNON_CORE_AFFECT', default: 'off', kind: 'explicit_on', owner: 'emotion', requires: ['SHANNON_FEELING_EVENTS'],
    doc: 'ADR-0013 stage 2 shadow: appraisal, core affect, blame and composure folded from her events and recorded beside the current state; no behaviour.',
  },
  {
    name: 'SHANNON_REPLY_CHECK', default: 'off', kind: 'explicit_on', owner: 'emotion', requires: ['SHANNON_FEELING_TURN'],
    doc: 'ADR-0013 stage 2: her reply is checked (giving in, lecture, AI tone…); strong, order and public text turns before sending, one rewrite.',
  },
  {
    name: 'SHANNON_FEELING_SENTENCE', default: 'off', kind: 'explicit_on', owner: 'emotion', requires: ['SHANNON_CORE_AFFECT', 'SHANNON_FEELING_TURN'],
    doc: 'ADR-0013 D7: in a strong scene (fast layer past her band, or blame), Haiku writes her feeling in 2-3 lines before a text reply; owner alone.',
  },
  {
    name: 'SHANNON_FEELING_MEANING', default: 'off', kind: 'explicit_on', owner: 'emotion', requires: ['SHANNON_CORE_AFFECT', 'SHANNON_FEELING_TURN'],
    doc: 'ADR-0013 D3.1: the feeling turn\'s Jev call also asks whether his words were meant or teasing (feeling_meaning.v1, voice_route.v7).',
  },
  {
    name: 'SHANNON_RELATIONSHIP_LEDGER', default: 'off', kind: 'explicit_on', owner: 'emotion', requires: ['SHANNON_FEELING_EVENTS'],
    doc: 'ADR-0013 stage 3: trust, liking, respect and irritation per person, moved nightly from her closed days (drops fast, recovers slowly, floor).',
  },
  {
    name: 'SHANNON_EPISODE_MEMORY', default: 'off', kind: 'explicit_on', owner: 'emotion', requires: ['SHANNON_FEELING_EVENTS'],
    doc: 'ADR-0013 stage 3: a closed day\'s incidents become episodes she recalls later (yesterday\'s, older ones when their subject comes up).',
  },
  {
    name: 'SHANNON_BOUNDARY_MEMORY', default: 'off', kind: 'explicit_on', owner: 'emotion', requires: ['SHANNON_FEELING_EVENTS'],
    doc: 'ADR-0013 stage 3: her boundaries with their basis and origin (self or told); a told one is hers only once she endorses it in reflection.',
  },
  {
    name: 'SHANNON_FEELING_AUDIENCE', default: 'off', kind: 'explicit_on', owner: 'emotion', requires: ['SHANNON_FEELING_EVENTS', 'SHANNON_REPLY_CHECK'],
    doc: 'ADR-0013 stage 4: events keyed by who wrote (account, never name), friend and light ledgers, audience layers, source cap, audience checks.',
  },
  {
    name: 'SHANNON_FEELING_STREAM', default: 'off', kind: 'explicit_on', owner: 'emotion', requires: ['SHANNON_FEELING_AUDIENCE'],
    doc: 'ADR-0013 stage 5: comments move her (crowd, caps, repeats collapsed), harassment ladder and floor, say-only moderation, stream register.',
  },
  {
    name: 'SHANNON_TEXT_REGISTER', default: 'off', kind: 'explicit_on', owner: 'emotion', requires: ['SHANNON_FEELING_TURN'],
    doc: 'ADR-0013 item 10 (owner: B): text reply form (length, emoji, endings) and pacing (typing, split in two, sulk pause ≤20 s) from her feeling.',
  },
  {
    name: 'SHANNON_INNER_NARRATOR', default: 'off', kind: 'explicit_on', owner: 'emotion', requires: ['SHANNON_CORE_AFFECT', 'SHANNON_INNER_NOTE'],
    doc: 'ADR-0013 §6: her inner note reads the fast layer and the ledger as narrator (honne not from her replies); intent and until unchanged.',
  },
  {
    name: 'SHANNON_CHARACTER_SPACE', default: 'off', kind: 'explicit_on', owner: 'emotion',
    requires: ['SHANNON_FEELING_TURN', 'SHANNON_INNER_NOTE', 'SHANNON_REPLY_CHECK'],
    doc: 'Owner 2026-10-20: six axes (mood: 快 覚醒 優位 遊び; per person: 好意 安心) pick her region (portrait, lines, face); text replies on Sonnet.',
  },
  {
    name: 'SHANNON_AFFECTION_MAX', default: 'off', kind: 'explicit_on', owner: 'emotion', requires: ['SHANNON_CHARACTER_SPACE'],
    doc: 'Owner 2026-10-20: the owner holds her 好意 at its top; 本気 and 重い open with him alone (never reached by the value).',
  },
  {
    name: 'SHANNON_NATURAL_TALK', default: 'off', kind: 'explicit_on', owner: 'emotion', requires: ['SHANNON_CHARACTER_SPACE'],
    doc: 'Owner 2026-10-20: with the owner alone she talks, not reports: plays along, short replies, touch facts only when they matter.',
  },
  {
    name: 'SHANNON_VOICE_AUDIO_TAGS', default: 'off', kind: 'explicit_on', owner: 'emotion', requires: [], setup: 'on',
    doc: 'Owner 2026-10-20: her spoken replies may carry ElevenLabs audio tags ([whispers] [laughs] [sighs]…) for the voice only; off, no tag line.',
  },
  {
    name: 'SHANNON_DC_VOICE', default: 'off', kind: 'explicit_on', owner: 'platform', requires: [],
    doc: 'Owner 2026-10-20: a Discord voice channel is answered by her one mind (/v1/platform/voice/*): turn, speech, mouth. '
      + 'Needs SHANNON_PLATFORM_REPLY, the bridge and an ElevenLabs voice. Off: 503 PLATFORM_VOICE_DISABLED, the bot answers as before.',
  },
  {
    name: 'SHANNON_DC_VOICE_FILLER', default: 'off', kind: 'explicit_on', owner: 'platform', requires: ['SHANNON_DC_VOICE'],
    doc: 'Owner 2026-10-21: off. A voice channel turn may name a short filler (うん。 えっと、) for the bot to say at once while the reply is written '
      + '(the recorded fillers are the old voice; with 「話しかけられたか」 on, a filler would also play before a silent decision).',
  },
  {
    name: 'SHANNON_ADDRESSED', default: 'off', kind: 'explicit_on', owner: 'platform', requires: [],
    doc: 'Owner 2026-10-21 (「話しかけられたか」): in a voice conversation (Discord voice channel, Windows resident\'s name call, '
      + 'POST /v1/voice/addressed) she answers only words that call her by name and are said to her, and the same person\'s follow-up '
      + 'within ~20 s of her last words; Jev judges when her name is in the text or inside that window (400 ms, local rules when it does '
      + 'not answer). Off: the shared-table rules (Discord) and the name match (resident) as before.',
  },
  {
    name: 'SHANNON_DC_VOICE_MINECRAFT', default: 'on', kind: 'default_on', owner: 'platform', requires: ['SHANNON_DC_VOICE'],
    doc: 'The owner\'s spoken request in a voice channel reaches her Minecraft body: '
      + 'a message to the task under way, a stop, or (alone) a new task.',
  },
  {
    name: 'SHANNON_DC_VOICE_MOUTH', default: 'on', kind: 'default_on', owner: 'platform', requires: ['SHANNON_DC_VOICE'],
    doc: 'Her mouth in the voice channel: say / poll / result / wording / said, so other parts can make her say a line there.',
  },
  {
    name: 'SHANNON_ONE_HEAD', default: 'off', kind: 'explicit_on', owner: 'platform', requires: [],
    doc: 'Owner 2026-10-20 (one head, entries only hear and speak): POST /v1/converse; Discord voice through the app voice turn; '
      + 'unbound Discord conversations and strangers answered; her character space and guard lines on voice too.',
  },
  {
    name: 'SHANNON_REPLY_SONNET', default: 'off', kind: 'explicit_on', owner: 'model', requires: [], setup: 'on',
    doc: 'Owner 2026-10-21: every reply, voice and text (apps, Windows, Discord, game chat; anyone), is Sonnet 5.5, prefix cached; Haiku '
      + 'past SHANNON_REPLY_SONNET_DAILY_CAP a day (voice and text together) or when a voice first word is late; the router and helpers unchanged.',
  },
  {
    name: 'SHANNON_DEVICE_ACTIONS', default: 'on', kind: 'default_on', owner: 'device', requires: [],
    doc: 'Reminders, timers, calendar events and Apple Music done by the owner\'s own app through the device-action outbox.',
  },
  {
    name: 'SHANNON_AUTONOMY_ENABLED', default: 'off', kind: 'true_only', owner: 'autonomy', requires: [],
    doc: 'Her own-time activity loop (also needs its own model credential and an unpaused owner switch).',
  },
  {
    name: 'SHANNON_PROACTIVE_MOMENTS', default: 'on', kind: 'default_on', owner: 'autonomy', requires: ['SHANNON_AUTONOMY_ENABLED', 'SHANNON_PROACTIVE_GATE'],
    doc: 'Owner 2026-10-14: moments she perceives (he came back, a long quiet, morning, late night, a story waiting) may lead her to speak in her own words.',
  },
  {
    name: 'SHANNON_PROACTIVE_SELF', default: 'on', kind: 'default_on', owner: 'autonomy', requires: ['SHANNON_PROACTIVE_MOMENTS'],
    doc: 'Owner 2026-10-14 (form): she decides herself whether to speak at a moment (core, inner note, her day, recent talk); off, the Jev judge.',
  },
  {
    name: 'SHANNON_PROMISE_ON_TIME', default: 'on', kind: 'default_on', owner: 'outreach', requires: [],
    doc: 'A due promise is told at its time, apart from the day\'s topic slot and the 90-minute topic cooldown, in her words; off, as before.',
  },
  {
    name: 'SHANNON_STUDY_SHOWING_LINE', default: 'off', kind: 'explicit_on', owner: 'autonomy', requires: [],
    doc: 'Owner 2026-10-14: off, telling him a piece writes no fixed line (the piece is readable; a story waiting is a moment of hers).',
  },
  {
    name: 'SHANNON_BODY_INITIATIVE_FRESHNESS', default: 'on', kind: 'default_on', owner: 'outreach', requires: [],
    doc: 'A body is handed an initiative to say aloud only while it is fresh (morning brief in its hours; topics within the gate\'s intent expiry).',
  },
  {
    name: 'SHANNON_EXECUTIVE', default: 'off', kind: 'explicit_on', owner: 'autonomy', requires: ['SHANNON_AUTONOMY_ENABLED'],
    doc: 'ADR-0009 stage 2: the Executive decides her own time (one deliberation, one capability); off, the old own-time loop thinks.',
  },
  {
    name: 'SHANNON_OPERATOR_MINECRAFT', default: 'off', kind: 'explicit_on', owner: 'minecraft', requires: [],
    doc: 'Owner 2026-10-14: a VM operator may ask, over a service-user socket, for Minecraft lifecycle or one request (operator-minecraft-contract).',
  },
  {
    name: 'SHANNON_OPERATOR_TALK_NOTES', default: 'off', kind: 'explicit_on', owner: 'minecraft', requires: ['SHANNON_OPERATOR_MINECRAFT'],
    doc: 'Owner 2026-10-19: off, an operator\'s Minecraft action stays in the audit and the activity record; on, it is also noted in his Talk.',
  },
] as const satisfies readonly SwitchEntry[];

export type SwitchName = (typeof SWITCHES)[number]['name'];
