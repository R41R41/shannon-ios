import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import type { ControlHolder, ControlView } from '../../contracts/continueContract.js';
import { validControlView } from './minecraftControlValidation.js';

/**
 * Who holds the body, as the head reads it (continue contract 4): the observation's `state.control` (a
 * `ControlView`, the body's own
 * account of its root action), and
 * the words the live state shows for it. **Facts only**: who holds the body and since when, never what to do about it. The live
 * state's owner places the line (it stays
 * in every version of the input, chapter 8's table); this file reads and words it.
 */

/** The body's `state.control`, or null when the observation has none (a body before the contract) or it does not read. */
export function controlOf(observation: BodyObservation | null): ControlView | null {
  const control = (observation?.state as { control?: unknown } | undefined)?.control;
  return validControlView(control) ? control as ControlView : null;
}

const seconds = (from: string, to: string): number | null => {
  const span = Date.parse(to) - Date.parse(from);
  return Number.isFinite(span) ? Math.max(0, Math.round(span / 1000)) : null;
};
const target = (value: number | undefined): string => value !== undefined ? `（相手 #${value}）` : '';

/** The holder as a phrase: 「反射 floor-melee（相手 #2601）」「命令 skill:ab12（q12）」「つなぎ（floor-melee の後、盾を構えている）」「片付け（stop:x）」「いない」. */
export function holderPhrase(holder: ControlHolder): string {
  switch (holder.kind) {
    case 'idle': return 'いない';
    case 'command': return `命令 ${holder.command}${holder.item ? `（${holder.item}）` : ''}`;
    case 'reflex': return `反射 ${holder.reflex}${target(holder.target)}`;
    case 'bridge': {
      const left = seconds(holder.since, holder.until);
      return ("つなぎ（" +
`${holder.after}` +
" の後、" +
`${holder.hold === 'shield' ? '盾を構えている' : '一歩下がっている'}` +
"" +
`${target(holder.target)}` +
"" +
`${left !== null ? `・${left} 秒まで` : ''}` +
"）");
    }
    case 'cleanup': return `片付け（${holder.command} の停止）`;
  }
}

/**
 * 「今の持ち主: 反射 floor-melee（相手 #2601）」, then the parts that are separate facts and not copies of the holder: the
 * reflex's episode that goes on (its hands and
 * hits), the combat mark that stays, and the commands waiting behind a reflex. Each part only when the view has it.
 */
export function holderWords(view: ControlView): string {
  const parts = [`今の持ち主: ${holderPhrase(view.holder)}`];
  const episode = view.reflexEpisode;
  if (episode) parts.push(`反射 ${episode.reflex} の戦いが続いている（手 ${episode.hands}・打ち ${episode.hits}${target(episode.target)}）`);
  if (view.combatMark) parts.push(`戦いの印: ${view.combatMark.skill}${target(view.combatMark.target)}`);
  if (view.waiting.length) parts.push(`反射の後を待っている命令: ${view.waiting.map(entry => `${entry.command}（${entry.behind} の後）`).join('・')}`);
  return parts.join('。');
}
