import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { OWNER_AUDIENCE, type MemoryDisclosure } from '@shannon/cognition';
import type { BodyEvent } from '../../../contracts/bodyContract.js';
import { touchWhen } from '../../../mind/memory/bodyTouchExperience.js';

/**
 * What happened to her Minecraft body as something she remembers (phase 1: only that she died, and of what).
 *
 * Stored where every experience is (`experience_events`, type `turn.completed`) with the source label
 * `body.game`, as a touch is (`bodyTouchMemory.ts`), so recall, search, embedding, the Memory screen and
 * forgetting treat it like any other experience. The wording is the server's, from a closed table of
 * causes: nothing the body sends becomes words. It has no conversation message and no owner words
 * (`speaker: unknown`), so nothing is learned about him from it. It moves no feeling yet (phase 2).
 */
export const BODY_GAME_SOURCE = 'body.game';

export interface GameExperience {
  id: string;
  observedAt: string;
  summary: string;
  disclosure: MemoryDisclosure;
  /** `died`: phase 1. `request`: phase 4, a request to her Minecraft body that finished (`minecraftBodyRequests.ts`). */
  game: { type: 'died'; cause: string } | { type: 'request'; requestId: string; state: string };
}

export interface GameExperienceWriter {
  /** Writes the experience once. False when there is nowhere to remember (no experience table) or it is already there. */
  write(scopeKey: string, experience: GameExperience): boolean;
}

/** Minecraft's death causes (damage types) in her words. Anything else is remembered without a cause. */
const MINECRAFT_CAUSES: Readonly<Record<string, string>> = Object.freeze({
  lava: '溶岩', in_fire: '火', on_fire: '火', hot_floor: 'マグマブロック', campfire: '焚き火',
  drown: '溺れて', fall: '落下', fly_into_wall: '壁にぶつかって', stalagmite: '鍾乳石', falling_stalactite: '落ちてきた鍾乳石',
  falling_block: '落ちてきたブロック', falling_anvil: '金床', cactus: 'サボテン', sweet_berry_bush: 'スイートベリーの茂み',
  in_wall: '窒息', cramming: '押しつぶされて', starve: '空腹', freeze: '凍えて', lightning_bolt: '雷', out_of_world: '奈落',
  outside_border: 'ワールドの境界', magic: '魔法', indirect_magic: '魔法', wither: 'ウィザー効果', dragon_breath: 'ドラゴンブレス',
  explosion: '爆発', player_explosion: '爆発', bad_respawn_point: 'ベッドの爆発', fireworks: '花火', sonic_boom: 'ウォーデンの衝撃波',
  mob_attack: 'モンスター', mob_attack_no_aggro: 'モンスター', mob_projectile: 'モンスターの飛び道具', arrow: '矢', trident: 'トライデント',
  fireball: '火の玉', unattributed_fireball: '火の玉', wither_skull: 'ウィザーの頭蓋骨', sting: 'ハチ', thorns: '棘の鎧',
  player_attack: 'ほかのプレイヤー', thrown: '投げられたもの', generic: '', generic_kill: '', mace_smash: 'メイス',
});

/** The cause in her words, or empty when the game's id is not one she knows. */
export function gameCauseWords(cause: string): string {
  const [namespace, path] = cause.split(':', 2);
  return namespace === 'minecraft' && path ? MINECRAFT_CAUSES[path] ?? '' : '';
}

/** 「ゲームの記憶: 10月5日の夜、マイクラで死んだ（溶岩）。」 */
export function gameDeathSummary(cause: string, at: string): string {
  const words = gameCauseWords(cause);
  return `ゲームの記憶: ${touchWhen(at)}、マイクラで死んだ${words ? `（${words}）` : ''}。`;
}

/** A stable experience id per scope, device and event id, shaped like the other experience ids. */
export function gameExperienceId(scopeKey: string, deviceId: string, eventId: string): string {
  const hex = createHash('sha256').update(`body.game\u0000${scopeKey}\u0000${deviceId}\u0000${eventId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${(8 | (Number.parseInt(hex[16]!, 16) & 3)).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** What stands where a turn has the owner's words: a token unique to the event, found in no reply (see `touchEvidence`). */
export function gameEvidence(experienceId: string): string {
  return `body-game-${Array.from(experienceId.replace(/[^0-9a-f]/gu, ''), digit => String.fromCharCode(97 + Number.parseInt(digit, 16))).join('')}`;
}

/**
 * The disclosure of her death in the game: the owner's, ordinary, decided by rule, and no words of his. Ordinary because
 * the game itself tells everyone on the server that she died, and of what (its death message).
 */
export const GAME_DISCLOSURE: MemoryDisclosure = Object.freeze({
  audience: OWNER_AUDIENCE, sensitivity: 'ordinary' as const, reason: 'マイクラの体に起きたこと', decidedBy: 'rule' as const, speaker: 'unknown' as const,
});

/**
 * The disclosure of a request that finished (review S4, 2026-10-06): what the owner asked her body for is his matter, so
 * it is sensitive. Used freely while he alone reads the reply; with others it is guarded (marked, for his own turn in a
 * shared chat) and left out of any turn someone else wrote (`openOnly`).
 */
export const GAME_REQUEST_DISCLOSURE: MemoryDisclosure = Object.freeze({
  audience: OWNER_AUDIENCE, sensitivity: 'sensitive' as const, reason: 'ライ氏がマイクラの体に頼んだこと', decidedBy: 'rule' as const, speaker: 'unknown' as const,
});

export function gameDeathExperience(scopeKey: string, deviceId: string, event: BodyEvent & { cause: string }): GameExperience {
  return {
    id: gameExperienceId(scopeKey, deviceId, event.id), observedAt: event.occurredAt, summary: gameDeathSummary(event.cause, event.occurredAt),
    disclosure: GAME_DISCLOSURE,
    game: { type: 'died', cause: event.cause },
  };
}

export class SQLiteGameExperiences implements GameExperienceWriter {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  }

  write(scopeKey: string, experience: GameExperience): boolean {
    // The experience table belongs to the conversation store.
    if (!this.database.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'experience_events'").get()) return false;
    const payload = JSON.stringify({
      userMessage: gameEvidence(experience.id), shannonReply: '', summary: experience.summary, disclosure: experience.disclosure,
      source: BODY_GAME_SOURCE, game: experience.game,
    });
    // An event is written once: the body's retry of the same id finds it there.
    const inserted = this.database.prepare(`
      INSERT OR IGNORE INTO experience_events (event_id, scope_key, event_type, observed_at, payload_json) VALUES (?, ?, 'turn.completed', ?, ?)
    `).run(experience.id, scopeKey, experience.observedAt, payload);
    return Number(inserted.changes) > 0;
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }
}
