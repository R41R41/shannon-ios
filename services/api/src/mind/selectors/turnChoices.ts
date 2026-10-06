import type { JevChooser, JevQuestion } from '../../infra/models/jev/jevChoice.js';
import { TOOL_MENU_NONE, chosenTools, toolMenuQuestions, type MenuCandidate } from './toolMenu.js';

/**
 * The Jev call of one conversation turn beside the voice router (Syzygy ADR-0008 stage 2, `docs/skill-and-routing-contract.md`).
 * Core: response path.
 *
 * Text asks it in parallel with recall; voice asks it in parallel with the router's own call, whose questions are unchanged.
 * It holds the tool menu (only while the turn offers tools) and, from step 4, the difficulty questions. One call, one trace.
 * Jev reads the turn's words (as the voice router always has) and the menu's names and summaries, nothing else.
 *
 * Never throws and never delays a turn by more than Jev's timeout: when Jev fails, `menu` is null (every offered schema goes,
 * exactly as without the menu).
 */
export interface TurnChoiceRequest {
  scopeKey: string;
  surface: 'text' | 'voice';
  words: string;
  /** The tools the turn would offer, as Jev reads them; empty: no menu question. */
  menu: readonly MenuCandidate[];
}

export interface TurnChoices {
  /** The provider names Jev chose (empty: none); null when there was no menu or Jev's answer could not be used. */
  menu: { chosen: readonly string[] } | null;
}

export interface TurnChooser {
  choose(request: TurnChoiceRequest): Promise<TurnChoices>;
}

/** How many characters of the turn's words Jev reads. */
export const TURN_CHOICE_WORDS = 2_000;

export class JevTurnChooser implements TurnChooser {
  constructor(private readonly jev: Pick<JevChooser, 'decide'>, private readonly switches: { toolMenu: boolean }) {}

  async choose(request: TurnChoiceRequest): Promise<TurnChoices> {
    const menu = this.switches.toolMenu && request.menu.length > 0 ? request.menu : null;
    if (!menu) return { menu: null };
    const questions: Record<string, JevQuestion> = { ...toolMenuQuestions(menu) };
    const decided = await this.jev.decide<TurnChoices>({
      scopeKey: request.scopeKey, surface: request.surface, decision: 'tool_menu',
      state: { utterance: request.words.slice(0, TURN_CHOICE_WORDS), surface: request.surface },
      questions,
      parse: answers => ({ menu: { chosen: chosenTools(answers, menu) } }),
      fallback: () => ({ menu: null }),
      traceAnswers: value => ({
        tool: value.menu ? value.menu.chosen[0] ?? TOOL_MENU_NONE : 'all', chosen: value.menu?.chosen.length ?? -1,
        offered: menu.length, groups: Object.keys(toolMenuQuestions(menu)).length,
      }),
    });
    return decided.value;
  }
}
