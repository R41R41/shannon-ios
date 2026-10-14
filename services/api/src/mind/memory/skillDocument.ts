import { createHash } from 'node:crypto';
import { looksSecret, parseKnowledgeHeadingTree } from '@shannon/cognition';
import { injectionThreats } from './injectionGuard.js';
export { injectionThreats } from './injectionGuard.js';

/**
 * A skill of hers as a document (Syzygy ADR-0008 stage 2, step 6; `docs/skill-and-routing-contract.md`, 「スキル記憶」). Core: memory.
 * Pure: no database, clock or network.
 *
 * SKILL.md is a frontmatter of two fields, `name` and `description`, then three sections in this order: `## 手順` (what she
 * does, step by step; never empty), `## 補助` (what helps: her tools, checks, what to watch for) and `## 参考` (where it came
 * from, in her words). It is the one shape of a skill: the database keeps it, `skill.read` opens it, the index lists its
 * name and description, and its copy in Aether's シャノン用フォルダ is this text (step 7), so the owner can read and edit it.
 */
export const SKILL_SECTIONS = Object.freeze(['手順', '補助', '参考'] as const);
export type SkillSection = typeof SKILL_SECTIONS[number];

export const SKILL_LIMITS = Object.freeze({
  /** `name`: lower-case ASCII words joined by `-` (a closed symbol: it may enter the ledgers as a subject). */
  name: 40,
  /** `description`: one line, so the index line `- name: description` stays within 80 characters. */
  description: 36,
  steps: 2_000,
  aids: 1_200,
  references: 800,
  body: 4_200,
});

export const SKILL_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

export interface SkillDocument {
  name: string;
  description: string;
  steps: string;
  aids: string;
  references: string;
}

export type SkillProblem =
  | 'no_frontmatter' | 'frontmatter_fields' | 'name' | 'description' | 'sections' | 'empty_steps' | 'too_long' | 'secret_like' | 'threat';

/** The SKILL.md text of a skill. `parseSkill(encodeSkill(skill))` gives the skill back. */
export function encodeSkill(skill: SkillDocument): string {
  const section = (title: SkillSection, text: string) => `## ${title}\n${text.trim() || 'なし'}\n`;
  return [
    '---', `name: ${skill.name}`, `description: ${oneLine(skill.description)}`, '---', '',
    section('手順', skill.steps), section('補助', skill.aids), section('参考', skill.references),
  ].join('\n').replace(/\n+$/u, '\n');
}

/** A SKILL.md text as a skill, or what is wrong with it. Strict: what the sleep builder writes must pass it. */
export function parseSkill(text: string): { skill: SkillDocument } | { problem: SkillProblem } {
  const normalized = text.replace(/\r\n?/gu, '\n');
  const front = /^---\n([\s\S]*?)\n---\n?/u.exec(normalized);
  if (!front) return { problem: 'no_frontmatter' };
  const fields = new Map<string, string>();
  for (const line of front[1]!.split('\n')) {
    if (!line.trim()) continue;
    const match = /^([a-z]+):\s*(.*)$/u.exec(line.trim());
    if (!match || fields.has(match[1]!)) return { problem: 'frontmatter_fields' };
    fields.set(match[1]!, match[2]!.trim());
  }
  if (fields.size !== 2 || !fields.has('name') || !fields.has('description')) return { problem: 'frontmatter_fields' };
  const body = normalized.slice(front[0].length);
  const headings = parseKnowledgeHeadingTree(body).filter(node => node.level === 2);
  if (headings.length !== SKILL_SECTIONS.length || headings.some((node, index) => node.title !== SKILL_SECTIONS[index])
    || body.slice(0, headings[0]?.start ?? 0).trim()) return { problem: 'sections' };
  const sectionText = (index: number) => {
    const node = headings[index]!;
    return body.slice(node.start, node.end).replace(/^##[^\n]*\n?/u, '').trim();
  };
  return checked({ name: fields.get('name')!, description: fields.get('description')!, steps: sectionText(0), aids: sectionText(1), references: sectionText(2) });
}

/** The rules every skill keeps, whoever wrote it (the builder's draft is checked before it is encoded). */
export function checked(skill: SkillDocument): { skill: SkillDocument } | { problem: SkillProblem } {
  const normalized: SkillDocument = {
    name: skill.name.trim(), description: oneLine(skill.description), steps: skill.steps.trim(), aids: skill.aids.trim(), references: skill.references.trim(),
  };
  if (normalized.name.length > SKILL_LIMITS.name || !SKILL_NAME.test(normalized.name)) return { problem: 'name' };
  if (!normalized.description || [...normalized.description].length > SKILL_LIMITS.description) return { problem: 'description' };
  if (!normalized.steps || normalized.steps === 'なし') return { problem: 'empty_steps' };
  if (normalized.steps.length > SKILL_LIMITS.steps || normalized.aids.length > SKILL_LIMITS.aids || normalized.references.length > SKILL_LIMITS.references) return { problem: 'too_long' };
  const text = encodeSkill(normalized);
  if (text.length > SKILL_LIMITS.body) return { problem: 'too_long' };
  if (looksSecret(text)) return { problem: 'secret_like' };
  if (injectionThreats(text).length) return { problem: 'threat' };
  return { skill: normalized };
}

/** The sections of a SKILL.md (or of any Markdown an owner's edit left): title and text, in order. */
export function skillSections(text: string): Array<{ title: string; text: string }> {
  const normalized = text.replace(/\r\n?/gu, '\n');
  const front = /^---\n[\s\S]*?\n---\n?/u.exec(normalized);
  const body = front ? normalized.slice(front[0].length) : normalized;
  return parseKnowledgeHeadingTree(body).filter(node => node.level <= 2).map(node => ({
    title: node.title, text: body.slice(node.start, node.end).replace(/^#+[^\n]*\n?/u, '').trim(),
  }));
}

/** The digest a body is compared by (export, an owner's edit): its text with line ends and trailing space normalized. */
export function skillHash(text: string): string {
  const normalized = text.replace(/\r\n?/gu, '\n').split('\n').map(line => line.replace(/\s+$/u, '')).join('\n').trim();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

/**
 * The index of her skills for the profile layer (ADR-0008 §8 「目次は毎回、中身は必要なとき」): a header with how full it is
 * (`n/25`, Hermes Agent's capacity line) and one line per skill, at most `SKILL_INDEX_LINES` lines of at most `SKILL_INDEX_WIDTH`
 * characters. It is built only from what changes at night (the status, the name, the description, the order of creation), so it
 * stays the same all day and the provider's cache of the prompt's start holds. Skills on trial are listed (marked 試し) so that they
 * can be used and judged. The builder keeps the count within the capacity (consolidating in one batch); if it is ever over, the
 * last line says how many did not fit: nothing is cut off silently.
 */
// Owner decision 2026-10-14: 19 → 25 skills, so the six legacy Minecraft procedures fit beside the standard pack.
export const SKILL_INDEX_LINES = 26;
export const SKILL_INDEX_WIDTH = 80;
/** How many skills fit the index (one line is its header). */
export const SKILL_CAPACITY = SKILL_INDEX_LINES - 1;
/** The start of the index's header (the count follows). */
export const SKILL_INDEX_HEADER = '[ボクのスキル';

export function skillIndexHeader(count: number): string {
  return `${SKILL_INDEX_HEADER} ${count}/${SKILL_CAPACITY}（目次。中身は skill_read で開く）]`;
}

export interface SkillIndexEntry { name: string; description: string; status: 'trial' | 'active'; createdAt: string; origin?: 'operator_authored' }

export function skillIndex(entries: readonly SkillIndexEntry[]): string {
  if (!entries.length) return '';
  const ordered = [...entries].sort((left, right) => (left.status === right.status ? 0 : left.status === 'active' ? -1 : 1)
    || left.createdAt.localeCompare(right.createdAt) || left.name.localeCompare(right.name));
  const fits = ordered.length <= SKILL_CAPACITY ? ordered : ordered.slice(0, SKILL_CAPACITY - 1);
  const lines = fits.map(entry => clipWidth(`- ${entry.name}${entry.status === 'trial' ? '（試し）' : ''}${entry.origin === 'operator_authored' ? '（運用作成）' : ''}: ${oneLine(entry.description)}`));
  if (fits.length < ordered.length) lines.push(`- （ほか${ordered.length - fits.length}件は目次に入りきらない。夜にまとめる）`);
  return [skillIndexHeader(ordered.length), ...lines].join('\n');
}

function clipWidth(line: string): string {
  const characters = [...line];
  return characters.length > SKILL_INDEX_WIDTH ? `${characters.slice(0, SKILL_INDEX_WIDTH - 1).join('')}…` : line;
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/**
 * The lifecycle (owner-approved plan, with WikiSkill's acceptance gate, coordinator 2026-10-07). Every new skill and every
 * patched version starts on **trial**. A new skill is accepted (active) after two successful uses, and retired if its first three
 * uses bring fewer. A patched version is judged after three uses: kept when its success is at least the rate of the version
 * before it (`baselineRate`), else the skill reverts to that version; the audit records which. An active skill retires when the
 * success of its last eight resolved uses falls below 0.4 (at least five of them: a modelling assumption, so that one early failure
 * does not retire it). A use's outcome is the tier outcome rule (`tierOutcome`): it went well by itself (G ≥ ⅔) and the owner's next
 * turn was not a retry or a correction.
 */
export const SKILL_LIFECYCLE = Object.freeze({
  trialUses: 3,
  newSkillSuccesses: 2,
  window: 8,
  retireBelow: 0.4,
  retireMinimumUses: 5,
  /** At most this many new skills and patched skills a night (per owner-local day). */
  newPerNight: 2,
  updatesPerNight: 3,
  /** How many times the proposer is asked for one change a night, and how many pattern edits the maintainer may make. */
  proposerRuns: 3,
  patternEditsPerNight: 6,
});

export type SkillStatus = 'trial' | 'active' | 'retired';

/** What a trial has shown: accept, revert, or not yet. `base` is null for a new skill. */
export function trialVerdict(trial: { base: number | null; baseline: number | null; outcomes: readonly (0 | 1)[] }): 'accept' | 'revert' | null {
  // Review (low): the trial is its first three uses, in order; later ones never change its verdict.
  const outcomes = trial.outcomes.slice(0, SKILL_LIFECYCLE.trialUses);
  const successes = outcomes.reduce<number>((sum, value) => sum + value, 0);
  if (trial.base === null) {
    if (successes >= SKILL_LIFECYCLE.newSkillSuccesses) return 'accept';
    return outcomes.length >= SKILL_LIFECYCLE.trialUses ? 'revert' : null;
  }
  if (outcomes.length < SKILL_LIFECYCLE.trialUses) return null;
  return successes / outcomes.length >= (trial.baseline ?? SKILL_LIFECYCLE.newSkillSuccesses / SKILL_LIFECYCLE.trialUses) ? 'accept' : 'revert';
}

/** The rate a patched version must reach: its predecessor's success over its resolved uses, or ⅔ (the new-skill rule) with fewer than three. */
export function baselineRate(outcomes: readonly (0 | 1)[]): number {
  if (outcomes.length < SKILL_LIFECYCLE.trialUses) return SKILL_LIFECYCLE.newSkillSuccesses / SKILL_LIFECYCLE.trialUses;
  return outcomes.reduce<number>((sum, value) => sum + value, 0) / outcomes.length;
}

/** Whether an active skill retires: its last eight resolved uses (at least five) succeeded less than 0.4 of the time. */
export function retiresForLowSuccess(recent: readonly (0 | 1)[]): boolean {
  const window = recent.slice(-SKILL_LIFECYCLE.window);
  return window.length >= SKILL_LIFECYCLE.retireMinimumUses && window.reduce<number>((sum, value) => sum + value, 0) / window.length < SKILL_LIFECYCLE.retireBelow;
}

/** The audit's diff of two bodies: the lines that went (`-`) and came (`+`), at most 2,000 characters. */
export function lineDiff(before: string, after: string): string {
  const old = before.split('\n');
  const next = after.split('\n');
  const lines = [...old.filter(line => !next.includes(line)).map(line => `- ${line}`), ...next.filter(line => !old.includes(line)).map(line => `+ ${line}`)].join('\n');
  return lines.length > 2_000 ? `${lines.slice(0, 1_999)}…` : lines;
}

/**
 * Lint warnings of a body (Hermes Agent's lesson layer, adapted): a body shaped like an incident log (dates, "today", "UPDATE"
 * sections; a skill is a method, not a diary), and an oversized body. Warnings are recorded with the change in the audit.
 */
export const SKILL_LINT_OVERSIZED = 3_000;

export function skillLint(text: string): string[] {
  const codes: string[] = [];
  const incident = (text.match(/\d{4}-\d{2}-\d{2}|\d{1,2}月\d{1,2}日|昨日|今日|今朝|さっき|先ほど/gu) ?? []).length;
  if (incident >= 2) codes.push('incident_log');
  if (/^#+\s*(?:UPDATE|Update|更新|追記)/mu.test(text) || /\bUPDATE\b/u.test(text)) codes.push('update_section');
  if (text.length > SKILL_LINT_OVERSIZED) codes.push('oversized');
  return codes;
}

/**
 * A targeted patch (Hermes Agent: fix a skill in place): each replacement's `find` must occur exactly once in the text as it is
 * now, and is replaced by `replace`, in order. The result is the patched text, or why it could not be applied.
 */
export function applyReplacements(text: string, replacements: readonly { find: string; replace: string }[]): { text: string } | { problem: 'no_replacements' | 'not_found' | 'ambiguous' } {
  if (!replacements.length) return { problem: 'no_replacements' };
  let current = text;
  for (const { find, replace } of replacements) {
    if (!find) return { problem: 'not_found' };
    const first = current.indexOf(find);
    if (first < 0) return { problem: 'not_found' };
    if (current.indexOf(find, first + 1) >= 0) return { problem: 'ambiguous' };
    current = `${current.slice(0, first)}${replace}${current.slice(first + find.length)}`;
  }
  return { text: current };
}
