import type { MoodAxis, SpaceAxis, SpacePosition } from './characterSpace.js';
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
  /** Lines of the region shown (its first ones), and of a mixed-in one. */
  samples: 8, mixedSamples: 3,
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

/** A region's distance from a place: over the axes it names, weighted, as a root mean square. */
export function regionDistance(region: CharacterRegion, position: SpacePosition): number {
  const axes = Object.entries(region.center) as [SpaceAxis, number][];
  const total = axes.reduce((sum, [axis]) => sum + (region.weights?.[axis] ?? 1), 0);
  const squares = axes.reduce((sum, [axis, center]) => sum + (region.weights?.[axis] ?? 1) * (position[axis] - center) ** 2, 0);
  return total ? Math.sqrt(squares / total) : Number.POSITIVE_INFINITY;
}

export interface PersonaOptions {
  /** The owner alone (本気 and 重い are only his). */
  ownerAlone: boolean;
  /** The owner holds her 好意 at its top (`SHANNON_AFFECTION_MAX`). */
  max: boolean;
  /** The region she was in a moment ago (within `holdMinutes`), if any. */
  previous?: RegionId | null;
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
  const ranked = openRegions(options).map(region => ({ id: region.id, distance: regionDistance(region, position) }))
    .sort((a, b) => a.distance - b.distance);
  const distances = Object.fromEntries(ranked.map(item => [item.id, round(item.distance)])) as Partial<Record<RegionId, number>>;
  const best = ranked[0]!;
  const held = ranked.find(item => item.id === options.previous);
  const primary = held && held.distance <= best.distance + PERSONA_LIMITS.stickiness ? held : best;
  const second = ranked.find(item => item.id !== primary.id);
  const mixed = second && second.distance <= primary.distance + PERSONA_LIMITS.blend ? { secondary: second.id } : {};
  return { primary: primary.id, ...mixed, distances };
}

export const PERSONA_HEADER = '[いまのボク]（いまの気分と、この相手との間がらで、ボクはこのあたりにいる。この人物として話す。'
  + '台詞は言い回しの手ざわりの例で、そのまま言わない。ボクの性格の核と、この番の構えは、いつもどおり守る）';

/** The block of who she is now (the last block's part): the region's portrait and lines, and a mixed-in one's first line and a few lines. */
export function personaBlock(selection: Pick<PersonaSelection, 'primary' | 'secondary'>): string {
  const primary = CHARACTER_REGIONS[selection.primary];
  const quoted = (lines: readonly string[]) => lines.map(line => `「${line}」`).join('');
  const parts = [PERSONA_HEADER, `いまのボク: ${primary.name}`, ...primary.portrait.map(line => `- ${line}`),
    `言い回しの手ざわり: ${quoted(primary.samples.slice(0, PERSONA_LIMITS.samples))}`];
  if (selection.secondary) {
    const mixed = CHARACTER_REGIONS[selection.secondary];
    parts.push(`少しまざる: ${mixed.name}（${mixed.portrait[0]}）${quoted(mixed.samples.slice(0, PERSONA_LIMITS.mixedSamples))}`);
  }
  return parts.join('\n');
}

/** Words that take leave of her or turn to someone else (a night out, bed, another AI). */
const LEAVING = /行ってくる|行ってきます|出かけ|寝る|寝ます|おやすみ|飲みに|飲み会|遊びに|また(?:あとで|明日|今度)|(?:もう|そろそろ)落ちる|友達と|会ってくる/u;

/**
 * The feeling turn in a region: a 「ふつう」 turn takes the region's own stance (its `awayStance` when his words take leave of her or
 * speak of another AI); at 本気 and 重い a tease is taken the same way (owner: 「ツンデレじゃなくて」); in a vivid region a stance shown
 * かすかに is shown はっきり. Every other stance, her refusals among them, is hers as chosen.
 */
export function regionTurn(decision: FeelingTurnDecision, regionId: RegionId, cue: { words: string; otherAi: boolean }): FeelingTurnDecision {
  const region = CHARACTER_REGIONS[regionId];
  const plain = decision.stance === 'neutral' || (decision.stance === 'tease' && Boolean(region.requiresMax));
  const away = cue.otherAi || LEAVING.test(cue.words);
  const stance = plain ? (away && region.awayStance) || region.plainStance : undefined;
  const chosen = stance ? { ...decision, stance, drawer: 'none' as const } : decision;
  return region.vivid && chosen.stance !== 'neutral' && chosen.intensity === 'subtle' ? { ...chosen, intensity: 'moderate' } : chosen;
}
