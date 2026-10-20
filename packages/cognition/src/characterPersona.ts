import { DEFAULT_PERSONALITY, MOOD_AXES, OUTING, type MoodAxis, type SpaceAxis, type SpacePosition } from './characterSpace.js';
import { CHARACTER_REGIONS, REGION_IDS, type CharacterRegion, type RegionId } from './characterRegions.js';
import type { FeelingTurnDecision } from './feelingTurn.js';

/**
 * Where she is in her character space, and who she is there (owner 2026-10-20; `SHANNON_CHARACTER_SPACE`). Pure.
 *
 * - The relationship bends her mood's resting place (her tsundere is 優位 against 好意): the surer and fonder she is of someone, the
 *   lower her pride sits and the warmer her mood (`spacePosition`).
 * - The nearest region (weighted, over the axes it names) is who she is; the next is mixed in when it is nearly as near. A region she
 *   was in a moment ago holds unless another is clearly nearer (`STICKINESS`), so a border does not make her flicker.
 * - The model is shown the region's portrait and lines (`personaBlock`), never a number.
 */
export interface Relation { liking: number; security: number }

export const PERSONA_LIMITS = Object.freeze({
  /** A previous region holds while it is within this of the nearest. */
  stickiness: 0.12,
  /** The second region is mixed in while it is within this of the first. */
  blend: 0.15,
  /** How long a previous region counts as the one she is in. */
  holdMinutes: 30,
  /**
   * Lines of the region shown, and of a mixed-in one: a few, turning with each turn (the sandbox of 2026-10-20: shown eight at once,
   * Sonnet strung them together as its reply).
   */
  samples: 4, mixedSamples: 2,
});

const clamp = (value: number) => Math.max(-1, Math.min(1, value));
const round = (value: number) => Math.round(value * 1000) / 1000;

/** Her place in the space: the mood bent by the relationship (fond and sure: pride lower, mood warmer). */
export function spacePosition(mood: Readonly<Record<MoodAxis, number>>, relation: Relation): SpacePosition {
  const fond = Math.max(0, relation.liking), sure = Math.max(0, relation.security);
  return {
    pleasure: round(clamp(mood.pleasure + 0.2 * fond)), arousal: mood.arousal, dominance: round(clamp(mood.dominance - 0.5 * fond * sure)),
    play: mood.play, liking: relation.liking, security: relation.security,
  };
}

/**
 * A mood axis a region does not name counts a little, toward her default (review 7: a region naming one axis, 眠い or 真面目, must not
 * win wherever that axis alone is near).
 */
export const UNNAMED_WEIGHT = 0.2;

/**
 * `SHANNON_NATURAL_TALK` (owner 2026-10-20): at 本気 and 重い 好意 counts once, not twice, so that with 好意 held at its top she still
 * goes to 照れ, 小悪魔 and はしゃぎ when his words take her there (that day: 本気 or 重い in 14 replies of 16).
 */
export const NATURAL_HELD_LIKING_WEIGHT = 1;
/**
 * And in a turn of play (his words a tease, a bit, a joke, a wish to be held) while he holds 好意 at its top (a held value, not one she
 * reached), the other regions are compared with her by her mood alone: their 好意 does not count (照れ sits at 0.4, so a held 1 kept her
 * from it however flustered she was). A plain turn keeps 好意 in the comparison, so 本気 stays where she rests.
 */
function weightsOf(region: CharacterRegion, natural: 'off' | 'on' | 'held'): CharacterRegion['weights'] {
  if (natural === 'off') return region.weights;
  if (region.requiresMax) return { ...region.weights, liking: NATURAL_HELD_LIKING_WEIGHT };
  return natural === 'held' ? { ...region.weights, liking: 0 } : region.weights;
}

/**
 * A region's distance from a place: over the axes it names, weighted, and her default's mood axes it does not, as a root mean square.
 * `natural` (`SHANNON_NATURAL_TALK`): `on`, or `held` while he holds her 好意 at its top.
 */
export function regionDistance(region: CharacterRegion, position: SpacePosition, natural: 'off' | 'on' | 'held' = 'off'): number {
  const unnamed = MOOD_AXES.filter(axis => region.center[axis] === undefined).map(axis => [axis, DEFAULT_PERSONALITY[axis].base] as [SpaceAxis, number]);
  const weights: Partial<Record<SpaceAxis, number>> = { ...Object.fromEntries(unnamed.map(([axis]) => [axis, UNNAMED_WEIGHT])),
    ...weightsOf(region, natural) };
  const axes = [...Object.entries(region.center) as [SpaceAxis, number][], ...unnamed];
  const total = axes.reduce((sum, [axis]) => sum + (weights[axis] ?? 1), 0);
  const squares = axes.reduce((sum, [axis, center]) => sum + (weights[axis] ?? 1) * (position[axis] - center) ** 2, 0);
  return total ? Math.sqrt(squares / total) : Number.POSITIVE_INFINITY;
}

export interface PersonaOptions {
  /** The owner alone (本気 and 重い are only his). */
  ownerAlone: boolean;
  /** The owner holds her 好意 at its top (`SHANNON_AFFECTION_MAX`). */
  max: boolean;
  /** The region she was in a moment ago (within `holdMinutes`), if any. */
  previous?: RegionId | null;
  /** `SHANNON_NATURAL_TALK`: 好意 counts once at 本気 and 重い; `play`, a turn of play (`weightsOf`). */
  natural?: 'on' | 'play';
}

export interface PersonaSelection {
  primary: RegionId;
  /** Mixed in when nearly as near (absent otherwise). */
  secondary?: RegionId;
  distances: Readonly<Partial<Record<RegionId, number>>>;
}

/** The regions open to her here: 本気 and 重い only with the owner alone and only while he holds her 好意 at its top. */
export function openRegions(options: Pick<PersonaOptions, 'ownerAlone' | 'max'>): CharacterRegion[] {
  return REGION_IDS.map(id => CHARACTER_REGIONS[id]).filter(region => (!region.ownerOnly || options.ownerAlone) && (!region.requiresMax || options.max));
}

/** Who she is at a place: the nearest open region (a previous one holds within the stickiness), and a nearly as near one mixed in. */
export function selectPersona(position: SpacePosition, options: PersonaOptions): PersonaSelection {
  const natural = !options.natural ? 'off' : options.max && options.natural === 'play' ? 'held' : 'on';
  const ranked = openRegions(options).map(region => ({ id: region.id, distance: regionDistance(region, position, natural) }))
    .sort((a, b) => a.distance - b.distance);
  const distances = Object.fromEntries(ranked.map(item => [item.id, round(item.distance)])) as Partial<Record<RegionId, number>>;
  const best = ranked[0]!;
  // A turn of play moves her at once (`SHANNON_NATURAL_TALK`): the region of a moment ago does not hold.
  const held = options.natural === 'play' ? undefined : ranked.find(item => item.id === options.previous);
  const primary = held && held.distance <= best.distance + PERSONA_LIMITS.stickiness ? held : best;
  const second = ranked.find(item => item.id !== primary.id);
  const mixed = second && second.distance <= primary.distance + PERSONA_LIMITS.blend ? { secondary: second.id } : {};
  return { primary: primary.id, ...mixed, distances };
}

export const PERSONA_HEADER = '[いまのボク]（いまの気分と、この相手との間がらで、ボクはこのあたりにいる。この人物として話す。'
  + '台詞は声の手ざわりの例。同じ言い回しは使わず、いまの話に合わせて自分の言葉で言う。ボクの性格の核と、この番の構えは、いつもどおり守る）';

/** A few of a region's lines, turning with 	urn (any whole number: the turn's minute), so the same few are not shown every turn. */
function someOf(lines: readonly string[], count: number, turn: number): string[] {
  const start = ((Math.trunc(turn) % lines.length) + lines.length) % lines.length;
  return Array.from({ length: Math.min(count, lines.length) }, (_, index) => lines[(start + index) % lines.length]!);
}

/**
 * The block of who she is now (the last block's part): the region's portrait and a few of its lines, and a mixed-in one's first line and
 * fewer lines; `turn` turns which lines are shown.
 */
export function personaBlock(selection: Pick<PersonaSelection, 'primary' | 'secondary'>, turn = 0): string {
  const primary = CHARACTER_REGIONS[selection.primary];
  const quoted = (lines: readonly string[]) => lines.map(line => `「${line}」`).join('');
  const parts = [PERSONA_HEADER, `いまのボク: ${primary.name}`, ...primary.portrait.map(line => `- ${line}`),
    `声の手ざわり: ${quoted(someOf(primary.samples, PERSONA_LIMITS.samples, turn))}`];
  if (selection.secondary) {
    const mixed = CHARACTER_REGIONS[selection.secondary];
    parts.push(`少しまざる: ${mixed.name}（${mixed.portrait[0]}）${quoted(someOf(mixed.samples, PERSONA_LIMITS.mixedSamples, turn))}`);
  }
  return parts.join('\n');
}


/**
 * The feeling turn in a region: a 「ふつう」 turn takes the region's own stance (its `awayStance` when he goes out somewhere or speaks of
 * another AI; going to bed is not that, review 3); at 本気 and 重い a tease is taken the same way (owner: 「ツンデレじゃなくて」); in a vivid region a stance shown
 * かすかに is shown はっきり. Every other stance, her refusals among them, is hers as chosen.
 */
export function regionTurn(decision: FeelingTurnDecision, regionId: RegionId, cue: { words: string; otherAi: boolean }): FeelingTurnDecision {
  const region = CHARACTER_REGIONS[regionId];
  const plain = decision.stance === 'neutral' || (decision.stance === 'tease' && Boolean(region.requiresMax));
  const away = cue.otherAi || OUTING.test(cue.words);
  const stance = plain ? (away && region.awayStance) || region.plainStance : undefined;
  const chosen = stance ? { ...decision, stance, drawer: 'none' as const } : decision;
  return region.vivid && chosen.stance !== 'neutral' && chosen.intensity === 'subtle' ? { ...chosen, intensity: 'moderate' } : chosen;
}
