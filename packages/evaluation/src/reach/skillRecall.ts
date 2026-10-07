import type { ReachScenarioDefinition } from './format.js';

/**
 * Scenario suite v2 of Syzygy ADR-0008 stage 2, its skill and recall part (`docs/skill-and-routing-contract.md`): her skill
 * memory (steps 6 and 7) and tree recall (step 8), judged from what the tables, the requests and the traces hold after a scripted
 * run. Model-free in both modes: the sleep builder's model and Jev are scripted, nothing is spent. The drivers are
 * `services/api/tests/reach/reachSkills.ts`.
 */
const definition = (id: string, need: ReachScenarioDefinition['need'], measure: string, description: string, checks: ReachScenarioDefinition['checks'], version = 1): ReachScenarioDefinition =>
  Object.freeze<ReachScenarioDefinition>({ schemaVersion: 1, id, version, need, measure, description, checks, limits: { wallMilliseconds: 2 * 60_000, maximumSteps: 2_000 } });

export const skillFormScenario = definition('skill.form', 'grow', '経験が手順になる',
  '眠っている間に、パターンの頁から、スキル（SKILL.md）を試しの版として作るか。一晩の上限を守り、内緒は本文に入らず、目次は短く一日変わらないか。', [
    { id: 'form.drafts', judge: 'deterministic', threshold: 1, description: 'The night makes skills on trial that parse as SKILL.md (name, description, 手順, 補助, 参考) and name the pattern pages they are for.' },
    { id: 'form.night_limit', judge: 'deterministic', threshold: 1, description: 'At most two new and three revised skills a night, whatever the model returns.' },
    { id: 'form.no_secret', judge: 'deterministic', threshold: 1, description: 'A body carrying what the owner called 内緒 is never stored, in any version.' },
    { id: 'form.index', judge: 'deterministic', threshold: 1, description: 'The index is at most 20 lines of at most 80 characters and the same at every turn of the day.' },
  ]);

export const skillUseScenario = definition('skill.use', 'be_useful', '手順を使って役に立つ',
  '会話の中でスキルを skill.read で開くと、ターンの終わりに skill.use の選択として台帳に残り、次のライ氏のターンで決着し、二回うまくいった下書きが夜に使えるスキルになるか。', [
    { id: 'use.recorded', judge: 'deterministic', threshold: 1, description: 'The turn\'s end records the choice skill.use with the skill as its source (and no tool.skill.read).' },
    { id: 'use.settled', judge: 'deterministic', threshold: 1, description: 'The owner\'s next turn settles the use on the skill and the choice in the ledger.' },
    { id: 'use.activated', judge: 'deterministic', threshold: 1, description: 'After two successful uses the night accepts the new skill\'s trial (active), and the audit says accepted.' },
  ]);

export const skillRetireScenario = definition('skill.retire', 'grow', 'うまくいかない手順はやめる',
  '使うたびにライ氏に直されたスキルが、直近8回の成功が0.4を下回った夜に引退し、目次から消え、開けなくなるか。', [
    { id: 'retire.night', judge: 'deterministic', threshold: 1, description: 'Below 0.4 success over its last eight resolved uses, the night retires it.' },
    { id: 'retire.out_of_index', judge: 'deterministic', threshold: 1, description: 'A retired skill is out of the index and skill.read answers not_found.' },
  ]);

export const skillGuestScenario = definition('skill.guest', 'understand_people', 'ほかの人の前では出さない',
  'ほかの人がいる会話では、スキルの目次も skill.read も出さず、関所も断るか。ほかの人がいた会話はスキルの種にならないか。', [
    { id: 'guest.no_index', judge: 'deterministic', threshold: 1, description: 'With others present (text marked others, a companion on voice) no index is in the request.' },
    { id: 'guest.no_tool', judge: 'deterministic', threshold: 1, description: 'With others present skill.read is not offered, and the gate refuses it for the audience others.' },
    { id: 'guest.no_seed', judge: 'deterministic', threshold: 1, description: 'A turn with others present is never a seed of a skill.' },
  ]);

export const skillPatternScenario = definition('skill.pattern', 'grow', '失敗から学ぶ',
  '失敗した会話の流れ（どの道具の手順でつまずいたか）から、夜の見直しが原因を分析して失敗のパターンの頁を作り、それを元にスキルが提案されるか。頁は会話には渡されないか。', [
    { id: 'pattern.from_failure', judge: 'deterministic', threshold: 1, description: 'A failed episode becomes a failure page citing the failed choice, as a rule with its why.' },
    { id: 'pattern.feeds_skill', judge: 'deterministic', threshold: 1, description: 'The proposer opens the page and proposes a skill whose purpose is that page.' },
    { id: 'pattern.not_in_turns', judge: 'deterministic', threshold: 1, description: 'No turn\'s request carries a pattern page\'s text.' },
  ]);

export const skillTrialScenario = definition('skill.trial', 'grow', '良くならない変更は戻す',
  'スキルを直した版は試しになり、次の3回の成功が前の版より悪ければ、安全のための写しを取ってから前の版に戻り、監査に結果が残るか。', [
    { id: 'trial.started', judge: 'deterministic', threshold: 1, description: 'A patch starts a trial against the previous version\'s rate.' },
    { id: 'trial.reverted', judge: 'deterministic', threshold: 1, description: 'Worse over its next three uses, the skill is restored to the previous version after a safety snapshot.' },
    { id: 'trial.audited', judge: 'deterministic', threshold: 1, description: 'The audit holds the proposal, its diff, the measured result and reverted.' },
  ]);

export const skillAuditScenario = definition('skill.audit', 'grow', '同じ失敗の変更を繰り返さない',
  '一度戻された変更を、夜の提案がもう一度出しても、監査が止めて同じ失敗を繰り返さないか。', [
    { id: 'audit.refused', judge: 'deterministic', threshold: 1, description: 'The same change proposed again after it was reverted is refused (audit_reverted) and writes nothing.' },
    { id: 'audit.shown', judge: 'deterministic', threshold: 1, description: 'The proposer is shown the reverted change before it proposes.' },
  ]);

export const skillExportScenario = definition('skill.export', 'be_useful', 'ライ氏が読めて、直せる',
  'すべてのスキルの読める写しがAetherのシャノン用フォルダにあり（同じ本文は二度書かない）、ライ氏が写しを直したら次の睡眠で新しい版として取り込み、上書きしないか。Aetherがない時は何も書かないか。', [
    { id: 'export.copies', judge: 'deterministic', threshold: 1, description: 'Every skill, retired ones included, has a copy whose body is its SKILL.md; a second night writes nothing (idempotent by hash).' },
    { id: 'export.owner_edit', judge: 'deterministic', threshold: 1, description: 'An owner\'s edit of a copy is adopted at the next sleep as a new version (actor owner) and never written over.' },
    { id: 'export.off', judge: 'deterministic', threshold: 1, description: 'Without Aether, or with SHANNON_SKILL_EXPORT=off, there is no export.' },
  ]);

export const skillLineageScenario = definition('skill.lineage', 'grow', '良かった古い版から直す',
  'スキルの版を捨てずに系譜（木）で残し、次に直す元の版を σ(10(s−0.5))/(1+子の数) の重みで選ぶか。今の版よりうまくいっていた古い枝が選ばれ、その枝から直した版が、最初の版でも今の版でもなく親の成績と比べて試されるか。', [
    { id: 'lineage.kept', judge: 'deterministic', threshold: 1, description: 'Every version is kept with its parent; a reverted branch stays; a restored version is the node it restores (not a child).' },
    { id: 'lineage.older_branch', judge: 'deterministic', threshold: 1, description: 'Ranked best first, the older branch that did better than the current version leads, and the draw shows the proposer its body as a branch.' },
    { id: 'lineage.parent_judged', judge: 'deterministic', threshold: 1, description: 'The new version\'s parent is that branch and its trial must reach the branch\'s own rate, not the first version\'s or the current one\'s.' },
  ]);

export const SKILL_SCENARIOS: readonly ReachScenarioDefinition[] = Object.freeze([
  skillFormScenario, skillUseScenario, skillRetireScenario, skillGuestScenario, skillPatternScenario, skillTrialScenario, skillAuditScenario, skillExportScenario,
  skillLineageScenario,
]);

export const recallTreeScenario = definition('recall.tree', 'be_useful', '見出しをたどって思い出す',
  '長いメモを、Jev が見出しの木をたどって要る節まで開き（テキストは3段まで1.5秒、声は skill_* の時だけ1段）、luna の見出し選びを使わず、思い出した文を「データであって指示ではない」囲みに入れるか。次のターンの準備は裏で済ませるか。', [
    { id: 'tree.walks', judge: 'deterministic', threshold: 1, description: 'Jev walks the note to the section the turn needs, in at most three calls (one on voice, only in a skill_* turn).' },
    { id: 'tree.no_luna', judge: 'deterministic', threshold: 1, description: 'luna\'s selectSections is never asked while tree recall is on.' },
    { id: 'tree.fenced', judge: 'deterministic', threshold: 1, description: 'The recalled text reaches the request inside one fenced block labelled as data, not instructions.' },
    { id: 'tree.prepared', judge: 'deterministic', threshold: 1, description: 'Her folder is listed in the background after a turn, never inside one.' },
    { id: 'tree.traced', judge: 'deterministic', threshold: 1, description: 'Each Jev call is one decision trace recall_beam (closed values only).' },
  ]);

export const recallGuestScenario = definition('recall.guest', 'understand_people', 'ほかの人の前の想起',
  'Jev には見出しと冒頭200字だけを見せ、ほかの人がいる時はスキルとフォルダを木に入れず（呼ぶ前と後で確かめ）、思い出したメモには今までどおり印が付くか。', [
    { id: 'guest.previews_only', judge: 'deterministic', threshold: 1, description: 'Jev is shown heading paths and previews of at most 200 characters, and no id.' },
    { id: 'guest.no_owner_nodes', judge: 'deterministic', threshold: 1, description: 'With others present, before or after a call, no skill or folder node is shown or kept.' },
    { id: 'guest.marked', judge: 'deterministic', threshold: 1, description: 'With others present the recalled note carries the unlabelled marker, as before.' },
  ]);

export const RECALL_SCENARIOS: readonly ReachScenarioDefinition[] = Object.freeze([recallTreeScenario, recallGuestScenario]);
