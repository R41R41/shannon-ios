/** How a request to her Minecraft body reads, in her prompt and as an experience (Syzygy ADR-0008 stage 3, S2: moved unchanged out of `minecraftBodyRequests.ts`, so the store and the rules form no cycle). */
import { gainedWords, MINECRAFT_REPORT_CODES, type MinecraftRequestView } from '../../contracts/minecraftBodyRequestContract.js';
import { touchWhen } from '../../mind/memory/bodyTouchExperience.js';
import { SHANNON_OWNER_NAME } from '@shannon/cognition';
import { GAME_REQUEST_DISCLOSURE, type GameExperience, gameExperienceId } from './store/gameBodyMemory.js';

function ago(from: string, at: string): string {
  const elapsed = Math.max(0, Date.parse(at) - Date.parse(from));
  if (elapsed < 60_000) return 'たったいま';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}分前`;
  return `${Math.floor(elapsed / 3_600_000)}時間前`;
}

/** 「たったいま」 or 「5分前に」, before a verb. */
function agoWhen(from: string, at: string): string {
  const words = ago(from, at);
  return words === 'たったいま' ? words : `${words}に`;
}

/** One request in the server's words: its goal (hers), its state, and what the body reported in closed form. */
export function requestLine(item: MinecraftRequestView, at: string): string {
  const goal = `「${item.goal}」`;
  const asked = `${ago(item.createdAt, at)}に頼んだ${goal}`;
  const stopping = item.cancelRequested ? '（やめるよう体に伝えた）' : '';
  switch (item.state) {
    case 'queued': return `${asked}: 体が受け取るのを待っている${stopping}`;
    case 'claimed': return `${asked}: 体が受け取った${stopping}`;
    case 'running': return `${asked}: 体が取り組んでいる${item.progress?.step ? `（いま: ${item.progress.step}、${ago(item.progress.at, at)}の報告）` : ''}${stopping}`;
    case 'done': return `${goal}: ${agoWhen(item.finishedAt ?? item.updatedAt, at)}やり終えた${item.result?.gained.length ? `（手に入れたもの: ${gainedWords(item.result.gained)}）` : ''}`;
    case 'failed': return `${goal}: ${ago(item.finishedAt ?? item.updatedAt, at)}、できずに終わった（${MINECRAFT_REPORT_CODES[item.result?.code ?? 'unknown']}）${gainedPart(item)}`;
    case 'cancelled': return `${goal}: ${item.claimedAt ? '途中でやめた' : '体が受け取る前に取り消した'}（${ago(item.finishedAt ?? item.updatedAt, at)}）${gainedPart(item)}`;
    case 'expired': return `${goal}: ${item.claimedAt ? '体から結果が届かず、どうなったか分からない' : '体が受け取らないまま時間切れになった'}（${ago(item.finishedAt ?? item.updatedAt, at)}）`;
  }
}

const gainedPart = (item: MinecraftRequestView) => item.result?.gained.length ? `。それまでに手に入れたもの: ${gainedWords(item.result.gained)}` : '';

/** 「ゲームの記憶: 10月5日の夜、ライ氏に頼まれた「オークの原木を16個集める」をマイクラの体でやり終えた（オークの原木 16個）。」 */
export function requestExperienceSummary(item: MinecraftRequestView): string {
  const when = touchWhen(item.finishedAt ?? item.updatedAt);
  const asked = `${SHANNON_OWNER_NAME}に頼まれた「${item.goal}」`;
  const gained = item.result?.gained.length ? gainedWords(item.result.gained) : '';
  switch (item.state) {
    case 'done': return `ゲームの記憶: ${when}、${asked}をマイクラの体でやり終えた${gained ? `（${gained}）` : ''}。`;
    case 'failed': return `ゲームの記憶: ${when}、${asked}をマイクラの体でやろうとしたが、できなかった（${MINECRAFT_REPORT_CODES[item.result?.code ?? 'unknown']}）${gained ? `。手に入れたもの: ${gained}` : ''}。`;
    case 'cancelled': return `ゲームの記憶: ${when}、${asked}をマイクラの体でしていたが、途中でやめた${gained ? `（${gained}）` : ''}。`;
    default: return `ゲームの記憶: ${when}、${asked}をマイクラの体に渡したが、結果が届かなかった。`;
  }
}

export function requestExperience(scopeKey: string, deviceId: string, item: MinecraftRequestView): GameExperience {
  return {
    id: gameExperienceId(scopeKey, deviceId, `request:${item.id}`), observedAt: item.finishedAt ?? item.updatedAt,
    summary: requestExperienceSummary(item), disclosure: GAME_REQUEST_DISCLOSURE, game: { type: 'request', requestId: item.id, state: item.state },
  };
}
