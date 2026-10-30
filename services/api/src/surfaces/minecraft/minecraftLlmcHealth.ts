import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import type { ControlHolder, ControlView, LifeView } from '../../contracts/continueContract.js';
import type { ActPos } from '../../contracts/minecraftActContract.js';
import { nearThreats } from './minecraftLlmcThreat.js';

/**
 * The facts a decision must be given whatever version of the input it reads (the continue contract, chapter 8, 「判断に届ける事実」: the
 * normal input, the urgent one, and the
 * one after the live state was shortened). One line each, in the words of what is, and **none says what to do**
 * (the model decides;
 * the instructions' words are not added to).
 *
 * | fact | lines |
 * |---|---|
 * | health, hunger, the food she carries and what eating it gives | `vitalsLine` |
 * | the blows taken in the last 10 s (a count and an amount) | `createHitWatch`: the body's own record `state.combat.recentHits`
 * when the frame has it (the count is a fact, the amounts are the body's estimate); else her health read frame to frame |
 * | who holds the body now and her life's number | `holderLine` (`state.control`, `state.life`) |
 * | the promises | `promiseLines` (four at most) |
 * | the pack's free slots, what the queue's next hands add, what fills it | `packLines` |
 * | the creatures near that she can eat (animals and fish) | `foodCandidates` |
 * | the queue's items with what each hand will do | `queueNowLines` |
 * | where a go or a vertical stopped and how far the goal is from there | `stopFactsOf` (from the act's result, not its words) |
 *
 * The numbers (24 m, three candidates, the 10 s window) are first values and a guess; they are said in the code once (below).
 */
export const FACT_WINDOW_MS = 10_000;

/** A blow is told with the hostile that stood within this many metres when it fell. */
export const HIT_BY_METERS = 6;

export const HITS_KEPT = 16;

export type Rec = Record<string, unknown>;

export const rec = (value: unknown): Rec | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null);

export const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

export const one = (value: number): string => value.toFixed(1);

export const cell = (at: ActPos | null | undefined): string => (at ? `(${at.x},${at.y},${at.z})` : '');

export const world = (observation: BodyObservation | null): Rec => rec(observation?.state.world) ?? {};

// ---- who holds the body, and the life
// -------------------------------------------------------------------------------------------------------

export const HOLDERS: ReadonlySet<string> = new Set(['idle', 'command', 'reflex', 'bridge', 'cleanup']);

/**
 * The body's `state.control` (contract 4), or null when the frame has none. Written for the frame as the body
 * writes it; a field it leaves out is left out here
 * (the reader tolerates a holder without its `since` and ids). The life's own reader may take this over.
 */
export function controlOf(observation: BodyObservation | null): ControlView | null {
  const raw = rec(observation?.state.control),
    holder = rec(raw?.holder);
  if (!raw || !holder || typeof holder.kind !== 'string' || !HOLDERS.has(holder.kind)) return null;
  const episode = rec(raw.reflexEpisode),
    mark = rec(raw.combatMark);
  return {
    holder: holder as unknown as ControlHolder,
    ...(episode && typeof episode.reflex === 'string'
      ? { reflexEpisode: episode as unknown as NonNullable<ControlView['reflexEpisode']> }
      : {}),
    ...(mark && typeof mark.skill === 'string' ? { combatMark: mark as unknown as NonNullable<ControlView['combatMark']> } : {}),
    waiting: (Array.isArray(raw.waiting) ? raw.waiting : []).filter(
      (item): item is ControlView['waiting'][number] => !!rec(item) && typeof rec(item)!.command === 'string',
    ),
  };
}

/** The body's life, `state.life` first and `facts.life` (the bare number) else; null when the frame has neither. */
export function lifeOf(observation: BodyObservation | null): (Pick<LifeView, 'life'> & Partial<LifeView>) | null {
  const raw = rec(observation?.state.life);
  if (raw && Number.isSafeInteger(raw.life)) return raw as unknown as Pick<LifeView, 'life'> & Partial<LifeView>;
  const bare = observation?.facts.life;
  return typeof bare === 'number' && Number.isSafeInteger(bare) ? { life: bare } : null;
}

/** The holder in words: 「反射 floor-melee（相手 #2601）」, 「命令 q52（attack）」, 「無し」. */
export function holderWords(holder: ControlHolder, view?: ControlView | null): string {
  switch (holder.kind) {
    case 'idle':
      return '無し（止まっている）';
    case 'command':
      return `命令 ${holder.command}${holder.item ? `（${holder.item}）` : ''}`;
    case 'reflex': {
      const fight = view?.reflexEpisode ? `。この戦いで ${view.reflexEpisode.hands} 手・${view.reflexEpisode.hits} 打` : '';
      return (
        '反射 ' +
        `${holder.reflex}` +
        '' +
        `${holder.target !== undefined ? `（相手 #${holder.target}）` : ''}` +
        '' +
        `${holder.episode && !fight ? '（戦いが続いている）' : ''}` +
        '' +
        `${fight}` +
        ''
      );
    }
    case 'bridge':
      return `反射の後のつなぎ（${
        holder.hold === 'shield' ? '盾を構えている' : '一歩下がっている'
      }・${holder.after} の後${holder.target !== undefined ? `・相手 #${holder.target}` : ''}）`;
    case 'cleanup':
      return `片付け（${holder.command}）`;
    default:
      return '不明';
  }
}

/** 「体を動かしている物: 反射 floor-melee（相手 #2601）・命 3」; null when the frame says neither the holder nor the life. */
export function holderLine(observation: BodyObservation | null): string | null {
  const control = controlOf(observation),
    life = lifeOf(observation),
    episode = control?.reflexEpisode;
  const parts = [
    ...(control ? [`体を動かしている物: ${holderWords(control.holder, control)}`] : []),
    // The reflex's fight goes on while it lets the lock go for a moment (the holder is then not the reflex): it is
    // told beside the holder.
    ...(control && episode && control.holder.kind !== 'reflex'
      ? [
          `反射 ${episode.reflex} の戦いが続いている（${episode.target !== undefined ? `相手 #${episode.target}・` : ''}${episode.hands} 手・${episode.hits} 打）`,
        ]
      : []),
    ...(life ? [`命 ${life.life}`] : []),
    ...(control?.waiting.length ? [`${control.waiting.length} 件が反射の後を待っている`] : []),
  ];
  return parts.length ? parts.join('・') : null;
}

// ---- the blows of the last ten seconds
// --------------------------------------------------------------------------------------------------------

export interface Hit {
  at: number;
  amount: number;
  by: string | null;
}

/**
 * The blows of the last `FACT_WINDOW_MS`.
 *
 * - **The body's record, when the frame has one.** From A-4 the body puts `state.combat.recentHits` in its
 * frame: `{at, attackerId, attackerType, damage, life}`, the last 10 s, 20 at the
 *   most, oldest first. The count is what happened; `damage` is the body's estimate (the health lost after a blow,
 * shared among the blows that waited for the same update). A frame that has
 *   this record replaces whatever the watch estimated: it is the fact, and the line says the amounts are an
 * estimate. The blows of another life than the frame's own are not told.
 * - **The estimate from her health, only when the frame has no `state.combat.recentHits`** (a body before A-4,
 * or a frame the body did not fill): the health lost from frame to frame is one
 *   blow each (two blows between two frames are one: the amount is right, the count may be short). It does not say
 * what hit her; the hostile that stood near when it fell is said beside it.
 *   This is the head filling in what the body does not tell; it is not kept beside the body's record.
 *
 * Fed by every frame the step reads (`note`), whatever reads it.
 */
export function createHitWatch(now: () => number = Date.now) {
  let last: { health: number; at: number } | null = null,
    lastSeq: number | null = null,
    lastRun: string | null = null;
  const hits: Hit[] = [];
  let fromBody: Hit[] | null = null;
  const within = (at: number): Hit[] => (fromBody ?? hits).filter((hit) => at - hit.at <= FACT_WINDOW_MS);
  const keep = (at: number) => {
    while (hits.length && at - hits[0]!.at > FACT_WINDOW_MS) hits.shift();
    while (hits.length > HITS_KEPT) hits.shift();
  };
  const bodyRecord = (observation: BodyObservation): Hit[] | null => {
    const combat = rec(observation.state.combat);
    if (!combat || !Array.isArray(combat.recentHits)) return null;
    const life = lifeOf(observation)?.life;
    return combat.recentHits.flatMap((item): Hit[] => {
      const entry = rec(item),
        damage = finite(entry?.damage),
        at = typeof entry?.at === 'string' ? Date.parse(entry.at) : finite(entry?.at);
      if (!entry || damage === null || at === null || Number.isNaN(at)) return [];
      if (life !== undefined && Number.isSafeInteger(entry.life) && entry.life !== life) return [];
      const kind = typeof entry.attackerType === 'string' && entry.attackerType ? entry.attackerType : null,
        id = Number.isInteger(entry.attackerId) ? (entry.attackerId as number) : null;
      return [{ at, amount: damage, by: kind ? `${kind}${id !== null ? ` #${id}` : ''}` : id !== null ? `#${id}` : null }];
    });
  };
  const sameFrameOrder = (observation: BodyObservation): boolean => {
    // A frame of another connection starts again; an older frame of the same connection is not read (a late frame
    // would be read twice).
    const run = rec(observation.state.bodyRun),
      key = `${String(run?.bodyBoot ?? '')}/${String(run?.connectionId ?? '')}`;
    if (lastRun !== null && key !== lastRun) {
      last = null;
      fromBody = null;
    } else if (lastSeq !== null && observation.sequence < lastSeq) return false;
    lastRun = key;
    return true;
  };
  return {
    note(observation: BodyObservation | null, at: number = now()): void {
      if (!observation) return;
      const reported = bodyRecord(observation);
      if (reported) {
        if (!sameFrameOrder(observation)) return;
        lastSeq = observation.sequence;
        fromBody = reported;
        last = null; // when a frame comes without the record, the estimate starts from that frame: no blow is read across the gap
        hits.length = 0;
        return;
      }
      const health = finite(world(observation).health);
      if (health === null) return;
      fromBody = null;
      // A frame of another connection starts the count again (no blow is read across it); an older frame of the same
      // connection is not read (a late frame would read as health lost twice).
      const run = rec(observation.state.bodyRun),
        key = `${String(run?.bodyBoot ?? '')}/${String(run?.connectionId ?? '')}`;
      const olderHealthFrame = () =>
        lastSeq !== null && observation.sequence <= lastSeq && last && (observation.sequence < lastSeq || last.health === health);
      if (lastRun !== null && key !== lastRun) last = null;
      else if (olderHealthFrame()) return;
      lastRun = key;
      lastSeq = observation.sequence;
      if (last && health < last.health - 0.04) {
        const near = nearThreats(observation).find((threat) => threat.distance <= HIT_BY_METERS);
        hits.push({
          at,
          amount: last.health - health,
          by: near ? `${near.name}${near.id !== null ? ` #${near.id}` : ''} ${one(near.distance)}m` : null,
        });
      }
      last = { health, at };
      keep(at);
    },
    /** The blows still in the window at `at`, oldest first (the body's record when the last frame had one, else the estimate). */
    recent(at: number = now()): Hit[] {
      return within(at);
    },
    /** Whether the blows are the body's record (the amounts an estimate of the body's) or the head's own reading of her health. */
    source(): 'body' | 'health' {
      return fromBody ? 'body' : 'health';
    },
    /**
     * 「直近 10 秒で 2 回ダメージを受けた（合計 10.2: 5.3（9 秒前）・4.9（4 秒前））。その時近くにいた敵: zombie #2601 2.1m」 from her health; from the body's record
     * 「直近 10 秒で 2 回ダメージを受けた（体の記録。量は体力の落ちからの推定: 合計 10.2: 5.3（9 秒前）・4.9（4 秒前））。打った相手: zombie #2601」. Null when there was none.
     */
    line(at: number = now()): string | null {
      const list = within(at);
      if (!list.length) return null;
      const total = list.reduce((sum, hit) => sum + hit.amount, 0);
      const each = list.map((hit) => `${one(hit.amount)}（${Math.max(0, Math.round((at - hit.at) / 1000))} 秒前）`).join('・');
      const by = [...new Set(list.flatMap((hit) => (hit.by ? [hit.by] : [])))].slice(0, 3);
      if (fromBody)
        return `直近 ${FACT_WINDOW_MS / 1000} 秒で ${list.length} 回ダメージを受けた（体の記録。量は体力の落ちからの推定: 合計 ${one(
          total,
        )}: ${each}）${by.length ? `。打った相手: ${by.join('・')}` : ''}`;
      return (
        `直近 ${FACT_WINDOW_MS / 1000} 秒で ${list.length} 回ダメージを受けた（合計 ${one(total)}: ${each}）` +
        `${by.length ? `。その時近くにいた敵: ${by.join('・')}` : ''}`
      );
    },
  };
}

export type HitWatch = ReturnType<typeof createHitWatch>;
