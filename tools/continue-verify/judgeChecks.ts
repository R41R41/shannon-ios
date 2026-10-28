/**
 * The conditions of the 10 boundaries, the 8 seams and the 7 scenes of boundary 8 (`e2e/boundaries.json`, chapter 10), read off the joined model of
 * `judge.ts`. Each check names the commands it used; the commands that do not join are failed by the judge itself, not here.
 * Conditions that need a record the folder does not hold FAIL ("not judgeable"), never pass.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Cell, CheckResult, CommandView, Joined, Model, OpLine, ProbeLine, Row, TraceLine } from './judge.js';
import { bodyTimesOf, cmdKey, commandLife, idsOf, itemOf, kindOf, linesOf, ms, sawUnknown, unitOf } from './judge.js';

const ok = (id: string, pass: boolean, detail: string, commands: string[] = []): CheckResult => ({ id, ok: pass, detail, commands });
const find = (model: Model, id: string): CommandView | undefined => model.commands.get(cmdKey(id));
const rowsOf = (model: Model, ev: string): Row[] => model.rows.filter(row => row.ev === ev);
const traceOf = <K extends TraceLine['kind']>(model: Model, kind: K): Extract<TraceLine, { kind: K }>[] =>
  model.trace.filter((line): line is Extract<TraceLine, { kind: K }> => line.kind === kind);
const probesOf = <K extends ProbeLine['kind']>(model: Model, kind: K): Extract<ProbeLine, { kind: K }>[] =>
  model.probes.filter((line): line is Extract<ProbeLine, { kind: K }> => line.kind === kind);
const injections = (model: Model, kind: string) => (model.meta.injections ?? []).filter(item => item.kind === kind);
/** An operation that acted (the motor port did not refuse it, and it is not a place that was held back). */
const acted = (op: OpLine): boolean => op.refused !== true && op.op !== 'place_held_back';
const queueOf = (command: CommandView): { dependsOn?: string[] } => (command.sent[0]?.queue ?? {}) as { dependsOn?: string[] };
const dependsOf = (command: CommandView): string[] | undefined => queueOf(command).dependsOn?.map(itemOf);
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const cellKey = (cell: Cell): string => cell.join(',');

export function runChecks(model: Model, _joined: Joined): CheckResult[] {
  const scene = model.meta.scene;
  const b8 = model.fixtures.boundaries.boundary8Scenes.find(item => item.id === scene);
  if (b8) return boundary8(model, b8);
  const number = Number(/^(?:boundary|seam)-(\d+)$/u.exec(scene)?.[1]);
  if (scene.startsWith('boundary-')) {
    const rules: Record<number, (model: Model) => CheckResult[]> = { 1: boundary1, 2: boundary2, 3: boundary3, 4: boundary4, 5: boundary5, 6: boundary6, 7: boundary7, 9: boundary9, 10: boundary10 };
    if (number === 8) return [ok('boundary-8', false, 'boundary 8 is judged by its scenes (b8-*), one folder for each; run the scenes')];
    if (rules[number]) return rules[number](model);
  }
  if (scene.startsWith('seam-')) {
    const rules: Record<number, (model: Model) => CheckResult[]> = { 1: seam1, 2: seam2, 3: seam3, 4: seam4, 5: boundary3, 6: boundary4, 7: boundary7, 8: boundary10 };
    if (rules[number]) return rules[number](model);
  }
  return [ok('scene', false, `unknown scene "${scene}"`)];
}

// ---- 1 results and queue ------------------------------------------------------------------------------------------------------------------------
function dependsChecks(model: Model): CheckResult[] {
  const all = [...model.commands.values()];
  const independent = all.filter(command => dependsOf(command)?.length === 0);
  const ran = independent.filter(command => kindOf(command) !== 'refused_before_start');
  const dropped = all.filter(command => unitOf(command)?.droppedBecause?.code === 'depends_failed');
  const badDrop = dropped.filter(command => {
    const because = unitOf(command)?.droppedBecause?.item?.item;
    return !(dependsOf(command) ?? []).includes(because ? itemOf(because) : '');
  });
  return [
    ok('dependsOn[] has startedAt', ran.length > 0 && ran.every(command => Boolean(unitOf(command)?.startedAt)), `${ran.length} independent item(s) that ran; ${ran.filter(command => !unitOf(command)?.startedAt).map(command => command.id).join(',') || 'all have startedAt'}`, ran.map(command => command.id)),
    ok('only the dependents are dropped', dropped.length > 0 && badDrop.length === 0 && !independent.some(command => dropped.includes(command)),
      `${dropped.length} dropped depends_failed; ${badDrop.length} of them name something their dependsOn does not hold; an independent one dropped: ${independent.some(command => dropped.includes(command))}`, dropped.map(command => command.id)),
  ];
}
function boundary1(model: Model): CheckResult[] {
  const all = [...model.commands.values()];
  const alreadyEat = all.filter(command => linesOf(command).some(line => line.do === 'eat' && line.goal === 'already'));
  const cancelled = all.filter(command => Boolean(unitOf(command)?.startedAt) && (command.receipts.some(receipt => receipt.outcome === 'cancelled')
    || linesOf(command).some(line => line.cutBy === 'cancelled' || line.cutBy === 'operator_stop')));
  return [ok('eat is already', alreadyEat.length > 0, `${alreadyEat.length} act(s) whose eat hand is goal already`, alreadyEat.map(command => command.id)),
    ...dependsChecks(model),
    ok('the head did not cancel a started item', cancelled.length === 0, cancelled.length ? `cancelled after startedAt: ${cancelled.map(command => command.id).join(',')}` : 'none cancelled', cancelled.map(command => command.id))];
}

// ---- 2 progress (the five numbers, each by its own evidence) ---------------------------------------------------------------------------------------
function boundary2(model: Model): CheckResult[] {
  const out: CheckResult[] = [];
  const verticals = [...model.commands.values()].filter(command => command.ops.some(op => op.op === 'foot'));
  if (verticals.length === 0) out.push(ok('vertical commands', false, 'no command with a foot operation in the continuous log'));
  for (const command of verticals) {
    const line = [...linesOf(command)].reverse().find(item => item.progress);
    const steps = command.ops.filter(op => op.op === 'foot' && op.from && op.to && Math.abs(op.to[1] - op.from[1]) === 1);
    const corrections = command.ops.filter(op => op.op === 'block_update' && op.usedForCorrection && op.pos);
    // A step stands on the block under its foot cell and needs its foot cell and the one above clear. An update that takes the floor away (to air), or puts something
    // solid in the foot or head cell, cancels the steps that stood there; an update of any other cell does not (the log's own word for it is block_update).
    const blind = corrections.filter(correction => typeof correction.block !== 'string');
    const touched = new Set<string>();
    for (const step of steps) {
      const foot = step.to as Cell;
      for (const correction of corrections) {
        const pos = correction.pos as Cell, solid = !['air', 'cave_air', 'void_air'].includes(String(correction.block));
        if (pos[0] !== foot[0] || pos[2] !== foot[2]) continue;
        if ((pos[1] === foot[1] - 1 && !solid) || ((pos[1] === foot[1] || pos[1] === foot[1] + 1) && solid)) touched.add(cellKey(foot));
      }
    }
    const moved = steps.length, valid = moved - touched.size;
    const work = line?.progress?.work, count = (kind: string) => command.ops.filter(op => op.op === kind).length;
    const want = { done: valid, dug: count('dig'), placeAttempts: count('place'), placedConfirmed: count('place_confirmed') };
    const have = { done: line?.progress?.done, dug: work?.dug, placeAttempts: work?.placeAttempts, placedConfirmed: work?.placedConfirmed };
    const wrong = (Object.keys(want) as (keyof typeof want)[]).filter(key => want[key] !== have[key]);
    out.push(ok(`numbers ${command.id}`, Boolean(line) && wrong.length === 0 && blind.length === 0, line
      ? `moved ${moved} (feet), stepsValid ${valid} (after ${touched.size} correction(s)); result says ${JSON.stringify(have)}, the log says ${JSON.stringify(want)}${wrong.length ? `; differ: ${wrong.join(',')}` : ''}${blind.length ? '; a block_update has no block (not judgeable)' : ''}`
      : 'the result has no progress to compare', [command.id]));
    if (touched.size > 0) out.push(ok(`moved is not valid ${command.id}`, moved !== have.done, `moved ${moved}, stepsValid ${have.done}: a corrected act must not read them as equal`, [command.id]));
  }
  const resumes = model.meta.resumes ?? [];
  if (resumes.length === 0) out.push(ok('resume pairs', false, 'meta.resumes is empty: the next hand and the dug steps cannot be judged'));
  for (const pair of resumes) {
    const from = find(model, pair.from), to = find(model, pair.to);
    const at = [...linesOf(from ?? ({ receipts: [] } as unknown as CommandView))].reverse().find(line => line.progress?.at)?.progress?.at;
    const start = to?.handStarts[0]?.pos;
    const startsAt = Boolean(at && start) && Math.floor(at!.x) === Math.floor(start!.x) && Math.floor(at!.y) === Math.floor(start!.y) && Math.floor(at!.z) === Math.floor(start!.z);
    const digs = (command?: CommandView) => (command?.ops ?? []).filter(op => op.op === 'dig');
    const missingPos = [...digs(from), ...digs(to)].some(op => !op.pos);
    const before = new Set(digs(from).map(op => cellKey(op.pos ?? [0, 0, 0])));
    const again = digs(to).filter(op => op.pos && before.has(cellKey(op.pos)));
    out.push(ok(`resume ${pair.from} -> ${pair.to}`, startsAt && !missingPos && again.length === 0,
      `next hand starts at progress.at: ${startsAt}; dug again: ${again.length}${missingPos ? '; a dig has no pos (not judgeable)' : ''}`, [pair.from, pair.to]));
  }
  return out;
}

// ---- 3 promises and consumption -----------------------------------------------------------------------------------------------------------------------
const ledgerRows = (model: Model) => rowsOf(model, 'ledger') as unknown as { at: string; ids: { command?: string }; applied: string[]; have: Record<string, number>; observed: Record<string, number>; promiseRev?: number }[];
function ledgerOnce(model: Model, atLeast = 0): CheckResult {
  const seen = new Map<string, number>();
  for (const row of ledgerRows(model)) for (const id of row.applied ?? []) seen.set(id, (seen.get(id) ?? 0) + 1);
  const twice = [...seen].filter(([, count]) => count > 1).map(([id]) => id);
  return ok('ledger event ids applied once', twice.length === 0 && seen.size >= atLeast, twice.length ? `applied more than once: ${twice.join(',')}` : `${seen.size} event id(s), each applied once${seen.size < atLeast ? ` (at least ${atLeast} expected)` : ''}`);
}
function boundary3(model: Model): CheckResult[] {
  const rows = ledgerRows(model);
  const apart = rows.filter(row => [...new Set([...Object.keys(row.have ?? {}), ...Object.keys(row.observed ?? {})])].some(item => (row.have?.[item] ?? 0) !== (row.observed?.[item] ?? 0)));
  const orphan = rows.filter(row => row.ids?.command && !find(model, row.ids.command)?.receipts.length && !find(model, row.ids.command)?.received.length);
  return [ok('ledger rows exist', rows.length > 0, `${rows.length} ledger row(s)`),
    ok('have equals the observation at every receipt', rows.length > 0 && apart.length === 0, apart.length ? `${apart.length} row(s) differ, first at ${apart[0].at}` : 'equal at every row'),
    ok('every ledger row names a command that has a receipt', orphan.length === 0, `${orphan.length} row(s) of no received command`),
    ledgerOnce(model)];
}

// ---- 4 handover ----------------------------------------------------------------------------------------------------------------------------------------
function boundary4(model: Model): CheckResult[] {
  const cases = injections(model, 'handover_case');
  const out: CheckResult[] = [];
  for (const item of cases) {
    const command = find(model, String(item.command));
    const receipt = command?.receipts[command.receipts.length - 1], times = command ? bodyTimesOf(command) : undefined;
    const label = `${String(item.case)} ${item.command}`;
    if (!command || !receipt) { out.push(ok(label, false, 'no receipt for the command')); continue; }
    if (item.case === 'same_target') {
      out.push(ok(label, receipt.handover?.confirmed === true && receipt.handover.shield === 'kept', `handover ${JSON.stringify(receipt.handover ?? null)}`, [command.id]));
    } else if (item.case === 'different_target') {
      const after = traceOf(model, 'reflex_hand').filter(line => (ms(line.at) ?? 0) > (ms(times?.acceptedAt) ?? Infinity));
      out.push(ok(label, !receipt.handover && after.length === 0, `handover ${JSON.stringify(receipt.handover ?? null)}; reflex hands started after the act was accepted: ${after.length}`, [command.id]));
    } else {
      out.push(ok(label, !receipt.handover && (times?.reflexWaitMs ?? 0) > 0, `handover ${JSON.stringify(receipt.handover ?? null)}; waited for the reflex ${times?.reflexWaitMs ?? 0} ms`, [command.id]));
    }
  }
  const kinds = new Set(cases.map(item => item.case));
  out.push(ok('same, different and safety cases', ['same_target', 'different_target', 'safety'].every(name => kinds.has(name)), `cases in the folder: ${[...kinds].join(',') || 'none'}`));
  return out;
}

// ---- 5 death and the async moments (the operation log, never the ring) -----------------------------------------------------------------------------
const MOMENTS = ['running_hand', 'waiting_for_reflex', 'queued', 'awaiting_model'];
function boundary5(model: Model): CheckResult[] {
  const open = traceOf(model, 'trace_open')[0];
  const out: CheckResult[] = [ok('the log is continuous, not the ring', open?.source === 'continuous', open ? `trace_open source ${open.source}` : 'the log has no trace_open line (cannot tell whether it is the ring)')];
  const deaths = model.meta.deaths ?? [];
  const wanted = model.meta.moments ?? MOMENTS;
  const missing = wanted.filter(moment => !deaths.some(death => death.moment === moment));
  out.push(ok('every moment was killed in', missing.length === 0, missing.length ? `not killed in: ${missing.join(',')}` : `moments: ${wanted.join(',')}`));
  for (const death of deaths) {
    const at = ms(death.at) ?? 0, label = `${death.moment} @${death.at}`;
    const old = [...model.commands.values()].filter(command => (commandLife(command) ?? death.lifeBefore) <= death.lifeBefore);
    const after = old.flatMap(command => command.ops.filter(op => (ms(op.at) ?? 0) > at && acted(op)).map(op => `${command.id}:${op.op}@${op.at}`));
    out.push(ok(`no old-life operation after death ${label}`, after.length === 0, after.length ? `${after.length} operation(s) after the death: ${after.slice(0, 5).join(' ')}` : 'none after the death', old.map(command => command.id)));
    const waiting = new Set((death.waiting ?? []).map(cmdKey));
    for (const command of old) {
      const times = bodyTimesOf(command), accepted = ms(times?.acceptedAt), began = ms(times?.startedAt ?? times?.lockAt ?? times?.firstMotorAt);
      if (accepted !== undefined && accepted < at && (began === undefined || began > at) && command.receipts.length > 0) waiting.add(command.id);
    }
    const started = [...waiting].filter(id => {
      const command = find(model, id);
      return Boolean(command) && (command!.handStarts.some(start => (ms(start.at) ?? 0) > at) || ((bodyTimesOf(command!)?.motorOps ?? 0) > 0 && (ms(bodyTimesOf(command!)?.firstMotorAt) ?? 0) > at));
    });
    out.push(ok(`waiting old commands never start ${label}`, started.length === 0, started.length ? `started after the death: ${started.join(',')}` : `${waiting.size} waiting old command(s), none started`, [...waiting]));
    if (death.moment === 'awaiting_model') {
      const flying = death.decision ?? [...model.decisions.values()].find(view => view.request && (ms(view.request.at) ?? 0) < at && (ms(view.response?.at) ?? Infinity) > at)?.id;
      const view = flying ? model.decisions.get(flying) : undefined;
      const discarded = view?.discarded.some(row => row.reason === 'life_changed') === true;
      const sentAfter = (view?.sent ?? []).filter(row => (ms(row.at) ?? 0) > at);
      out.push(ok(`the answer awaited is discarded life_changed ${label}`, Boolean(flying) && discarded && sentAfter.length === 0,
        flying ? `decision ${flying}: discarded life_changed ${discarded}; commands sent after the death ${sentAfter.length}` : 'no decision was in flight at the death'));
    }
  }
  return out;
}

// ---- 6 the old owner ------------------------------------------------------------------------------------------------------------------------------------
function boundary6(model: Model): CheckResult[] {
  const late = injections(model, 'late_cleanup')[0], owner = injections(model, 'new_owner')[0];
  if (!late || !owner) return [ok('injections', false, 'meta.injections needs a new_owner and a late_cleanup')];
  const oldId = cmdKey(String(late.command)), lateAt = ms(late.at) ?? 0, ownerAt = ms(owner.at) ?? 0;
  const acting = (find(model, oldId)?.ops ?? []).filter(op => (ms(op.at) ?? 0) > ownerAt && acted(op));
  const refused = traceOf(model, 'motor_refused').filter(line => cmdKey(line.command) === oldId && (ms(line.at) ?? 0) >= lateAt);
  const calls = (late.calls as string[] | undefined) ?? [];
  const missing = calls.filter(call => !refused.some(line => line.call === call));
  const state = traceOf(model, 'motor_state').filter(line => cmdKey(line.command) === cmdKey(String(owner.command)) && (ms(line.at) ?? 0) >= lateAt).pop();
  return [ok('the old cleanup acted on nothing', acting.length === 0, `${acting.length} operation(s) of ${oldId} after the new owner started`, [oldId]),
    ok('the motor port refused each call', refused.length > 0 && missing.length === 0, `${refused.length} refusal(s)${missing.length ? `; not refused: ${missing.join(',')}` : ''}`, [oldId]),
    ok('the new owner keeps keys, shield and path goal', state?.forward === true && state.shield === true && state.pathGoal === 'kept', `state after the cleanup: ${JSON.stringify(state ?? null)}`, [cmdKey(String(owner.command))])];
}

// ---- 7 dimension and respawn ----------------------------------------------------------------------------------------------------------------------------
function boundary7(model: Model): CheckResult[] {
  const lives = traceOf(model, 'life'), deaths = traceOf(model, 'death');
  let portalSame = 0, portalWrong = 0, deathStep = 0, deathWrong = 0;
  for (let index = 1; index < lives.length; index += 1) {
    const before = lives[index - 1], now = lives[index];
    const died = deaths.some(death => (ms(death.at) ?? 0) >= (ms(before.at) ?? 0) && (ms(death.at) ?? 0) <= (ms(now.at) ?? 0));
    if (died) { deathStep += 1; if (now.life !== before.life + 1) deathWrong += 1; }
    else if (now.dimension !== before.dimension) { portalSame += 1; if (now.life !== before.life) portalWrong += 1; }
  }
  const out = [ok('a portal does not change life', portalSame > 0 && portalWrong === 0, `${portalSame} dimension change(s) without a death; life changed in ${portalWrong}`),
    ok('a death adds exactly 1 to life', deathStep > 0 && deathWrong === 0, `${deathStep} death(s); not +1 in ${deathWrong}`)];
  for (const item of injections(model, 'portal_pending')) {
    const command = find(model, String(item.command));
    const dropped = command ? unitOf(command)?.droppedBecause?.code === 'dimension_changed' : false;
    const moved = Boolean(command) && (command!.handStarts.length > 0 || command!.ops.some(acted));
    out.push(ok(`waiting item dropped dimension_changed ${item.command}`, dropped && !moved, `droppedBecause ${JSON.stringify(command ? unitOf(command)?.droppedBecause ?? null : null)}; started: ${moved}`, command ? [command.id] : []));
    if (item.decision) {
      const view = model.decisions.get(String(item.decision));
      out.push(ok(`the answer awaited is discarded dimension_changed ${item.decision}`, view?.discarded.some(row => row.reason === 'dimension_changed') === true, `discarded rows: ${JSON.stringify(view?.discarded.map(row => row.reason) ?? [])}`));
    }
  }
  return out;
}

// ---- 9 plan --------------------------------------------------------------------------------------------------------------------------------------------
function boundary9(model: Model): CheckResult[] {
  const snaps = probesOf(model, 'plan_snapshot'), stages = ['first_plan', 'plan_update', 'saved', 'head_restart', 'read_back'] as const;
  const missing = stages.filter(stage => !snaps.some(snap => snap.stage === stage));
  const first = snaps.find(snap => snap.stage === 'first_plan'), update = snaps.find(snap => snap.stage === 'plan_update') ?? first;
  const lost: string[] = [];
  const differs = (left: { kind?: string; prep?: unknown } | undefined, right: { kind?: string; prep?: unknown }, withPrep: boolean) =>
    !left || !same(left.kind, right.kind) || (withPrep && !same(left.prep ?? null, right.prep ?? null));
  for (const node of first?.nodes ?? []) {
    const written = probesOf(model, 'plan_write').some(write => write.by === 'llm' && write.node === node.id);
    if (!written && differs(update?.nodes.find(item => item.id === node.id), node, true)) lost.push(`plan_update:${node.id}`);
  }
  for (const snap of snaps.filter(item => item.stage === 'saved' || item.stage === 'head_restart' || item.stage === 'read_back')) {
    for (const node of update?.nodes ?? []) if (differs(snap.nodes.find(item => item.id === node.id), node, true)) lost.push(`${snap.stage}:${node.id}`);
  }
  const original = probesOf(model, 'plan_decisions').find(item => item.variant === 'original'), renamed = probesOf(model, 'plan_decisions').find(item => item.variant === 'renamed');
  const differ = model.fixtures.sameDecisions.filter(name => !same(original?.values[name], renamed?.values[name]) || original?.values[name] === undefined);
  const headWrites = probesOf(model, 'plan_write').filter(write => write.by === 'head' && write.fields.includes('prep'));
  return [ok('every stage of the round trip is recorded', missing.length === 0, missing.length ? `missing stages: ${missing.join(',')}` : stages.join(' -> ')),
    ok('kind and prep survive save, head restart and read back', snaps.length > 0 && lost.length === 0, lost.length ? `changed: ${lost.slice(0, 6).join(' ')}` : 'kind/prep equal at every stage'),
    ok('a renamed title leaves the decisions alone', Boolean(original && renamed) && differ.length === 0, original && renamed ? (differ.length ? `differ: ${differ.join(',')}` : `${model.fixtures.sameDecisions.length} values equal`) : 'plan_decisions original/renamed missing'),
    ok('the head does not write prep', headWrites.length === 0, `${headWrites.length} head write(s) of prep`)];
}

// ---- 10 the real LLM input (bytes of the last request) ---------------------------------------------------------------------------------------------------
function boundary10(model: Model): CheckResult[] {
  const out: CheckResult[] = [];
  for (const variant of ['normal', 'urgent', 'compressed'] as const) {
    const probe = probesOf(model, 'request_bytes').find(item => item.variant === variant);
    const bytes = probe?.bytes ?? (probe?.file ? safeRead(model, probe.file) : undefined);
    if (bytes === undefined) { out.push(ok(`last request (${variant})`, false, 'the bytes of the last request are missing')); continue; }
    const absent = model.fixtures.urgentNeedles.filter(needle => !bytes.includes(needle));
    out.push(ok(`last request (${variant})`, absent.length === 0, absent.length ? `not in the bytes: ${absent.join(' | ')}` : `${model.fixtures.urgentNeedles.length} facts present (${bytes.length} chars)`));
  }
  const once = probesOf(model, 'one_time_fact')[0];
  if (!once) out.push(ok('one-time fact', false, 'no one_time_fact probe'));
  else {
    const got = Object.fromEntries(once.perDecision.map(item => [item.d, item.inLastRequest]));
    const delivered = once.perDecision.find(item => item.inLastRequest && !item.compressedOut)?.d;
    const wrong = Object.entries(model.fixtures.oneTime).filter(([d, value]) => got[d] !== value);
    const again = once.perDecision.filter(item => item.inLastRequest && item.d !== delivered && (delivered ? once.perDecision.findIndex(i => i.d === item.d) > once.perDecision.findIndex(i => i.d === delivered) : false));
    out.push(ok('a one-time fact is carried until it is in the last request', wrong.length === 0 && again.length === 0 && Boolean(delivered),
      `delivered at ${delivered ?? 'never'}; differing decisions: ${wrong.map(([d]) => d).join(',') || 'none'}; shown again after delivery: ${again.length}`));
  }
  return out;
}
function safeRead(model: Model, file: string): string | undefined {
  try { return model.dir ? readFileSync(join(model.dir, file), 'utf8') : undefined; } catch { return undefined; }
}

// ---- the seams -----------------------------------------------------------------------------------------------------------------------------------------
function seam1(model: Model): CheckResult[] {
  const item = injections(model, 'independent_started')[0];
  if (!item) return [ok('injection', false, 'meta.injections needs independent_started {started, failed}')];
  const started = find(model, String(item.started)), failed = find(model, String(item.failed));
  const startedAt = ms(unitOf(started ?? ({ receipts: [], received: [] } as unknown as CommandView))?.startedAt);
  const noticeAt = ms(failed?.received[0]?.at);
  const cancelled = Boolean(started) && (started!.receipts.some(receipt => receipt.outcome === 'cancelled') || linesOf(started!).some(line => line.cutBy === 'cancelled'));
  return [ok('the independent item started before the head heard of the failure', startedAt !== undefined && noticeAt !== undefined && startedAt < noticeAt, `startedAt ${startedAt}, failure noticed ${noticeAt}`, [String(item.started), String(item.failed)]),
    ok('the head did not cancel it', !cancelled && Boolean(started), cancelled ? 'cancelled' : 'not cancelled', [String(item.started)])];
}
function seam2(model: Model): CheckResult[] {
  const chain = injections(model, 'chain')[0];
  const out = dependsChecks(model);
  if (!chain) return [...out, ok('injection', false, 'meta.injections needs chain {items: [a, b, c]}')];
  const items = (chain.items as string[]).map(itemOf);
  const wrong = items.slice(1).filter((id, index) => {
    const because = unitOf(find(model, id) ?? ({ receipts: [], received: [] } as unknown as CommandView))?.droppedBecause;
    return because?.code !== 'depends_failed' || itemOf(because.item?.item ?? '') !== items[index];
  });
  return [...out, ok('indirect dependents are dropped one after the other', wrong.length === 0, wrong.length ? `not dropped by the item before: ${wrong.join(',')}` : items.join(' -> '), items)];
}
function seam3(model: Model): CheckResult[] {
  const unknowns = [...model.commands.values()].filter(sawUnknown);
  const notified = new Set(rowsOf(model, 'unknown_notified').map(row => idsOf(row, model.meta).command));
  const resent = unknowns.filter(command => model.rows.some(row => row.ev === 'sent' && row.resumeOf === command.id && !idsOf(row, model.meta).decision));
  const twice = unknowns.filter(command => command.corrected.length > 1);
  return [ok('an unknown was shown to the model', unknowns.length > 0 && unknowns.every(command => notified.has(command.id)), `${unknowns.length} unknown command(s); notified: ${unknowns.filter(command => notified.has(command.id)).length}`, unknowns.map(command => command.id)),
    ok('no unknown is sent again by itself', resent.length === 0, `${resent.length} sent again with no decision`),
    ok('a result received twice corrects once', twice.length === 0, `${twice.length} command(s) corrected more than once`), ledgerOnce(model)];
}
function seam4(model: Model): CheckResult[] {
  const old = injections(model, 'old_rev_result')[0];
  const rows = ledgerRows(model).filter(row => old && cmdKey(row.ids?.command ?? '') === cmdKey(String(old.command)));
  return [...boundary3(model), ok('a result of an older revision is booked on the revision it was sent with', Boolean(old) && rows.length > 0 && rows.every(row => row.promiseRev === old!.rev),
    old ? `rows of ${old.command}: ${JSON.stringify(rows.map(row => row.promiseRev))} (want ${old.rev})` : 'meta.injections needs old_rev_result {command, rev}')];
}

// ---- boundary 8: the scenes ------------------------------------------------------------------------------------------------------------------------------
export function boundary8(model: Model, scene: Model['fixtures']['boundaries']['boundary8Scenes'][number]): CheckResult[] {
  const ids = scene.command.split(',').map(cmdKey);
  const all = [...model.commands.values()];
  const split = all.filter(command => new Set(command.ops.map(op => op.exec).filter(Boolean)).size > 1
    || command.handStarts.some((start, index) => command.handStarts.findIndex(other => other.ids.hand === start.ids.hand && (other.ids.pass ?? 0) === (start.ids.pass ?? 0)) !== index));
  const resent = all.filter(sawUnknown).filter(command => model.rows.some(row => row.ev === 'sent' && row.resumeOf === command.id && !idsOf(row, model.meta).decision));
  const corrected = ids.reduce((sum, id) => sum + (find(model, id)?.corrected.length ?? 0), 0);
  const q = (id: string) => find(model, id);
  const out: CheckResult[] = [
    ok('no command runs in two executions', split.length === 0, split.length ? `split: ${split.map(command => command.id).join(',')}` : 'one execution each', split.map(command => command.id)),
    ok('no unknown item is sent again by itself', resent.length === 0, `${resent.length} sent again with no decision`),
    ledgerOnce(model),
    ok(`corrections = ${scene.corrections}`, corrected === scene.corrections, `${corrected} corrected row(s) for ${scene.command}`, ids),
  ];
  const within = (from: unknown, to: unknown, limit: number) => (ms(to) ?? Infinity) - (ms(from) ?? -Infinity) <= limit;
  const unknownRow = (id: string) => q(id)?.received.find(row => { const receipt = row.receipt as { outcome?: string } | undefined; return receipt?.outcome === 'unknown'; });
  const cleanupAfter = (from: unknown, id?: string) => rowsOf(model, 'released').find(row => row.by === 'cleanup' && row.ok === true && (id === undefined || idsOf(row, model.meta).command === id) && within(from, row.at, 5000) && (ms(row.at) ?? 0) >= (ms(from) ?? 0));
  const boot = rowsOf(model, 'head_boot').at(-1);
  const first = ids[0], second = ids[1];
  switch (scene.id) {
    case 'b8-lost-receipt': {
      const row = unknownRow(first), released = cleanupAfter(row?.at, first), fixed = q(first)?.corrected[0];
      out.push(ok('unknown, then released by the cleanup within 5 s, then corrected', Boolean(row && released && fixed) && (ms(fixed?.at) ?? 0) >= (ms(released?.at) ?? Infinity),
        `unknown ${row?.at ?? '-'} released ${released?.at ?? '-'} corrected ${fixed?.at ?? '-'}`, ids));
      break;
    }
    case 'b8-dup-poll': {
      const deliveries = (q(first)?.receipts.length ?? 0), applied = q(first)?.received.length ?? 0;
      out.push(ok('the receipt came twice and was applied once', deliveries >= 2 && applied === 1, `${deliveries} delivery(ies), ${applied} applied`, ids), ledgerOnce(model, 1));
      break;
    }
    case 'b8-reconnect': {
      const at = ms(injections(model, 'reconnect')[0]?.at), poll = traceOf(model, 'poll').find(line => line.first === true && (ms(line.at) ?? 0) >= (at ?? Infinity));
      const queued = second ? q(second) : undefined;
      out.push(ok('the new connection\'s first poll', Boolean(poll), poll ? `first poll ${poll.at}` : 'no first poll after the reconnect'),
        ok('the running item is released and stays unknown', Boolean(q(first)?.released.length) && !q(first)?.corrected.length && unitOf(q(first)!)?.goal === 'unknown', `released ${q(first)?.released.length ?? 0}, unit ${JSON.stringify(q(first) ? unitOf(q(first)!) : null)}`, [first]),
        ok('the waiting item is dropped connection_changed and never starts', Boolean(queued) && unitOf(queued!)?.droppedBecause?.code === 'connection_changed' && queued!.handStarts.length === 0 && !queued!.ops.some(acted),
          `droppedBecause ${JSON.stringify(queued ? unitOf(queued)?.droppedBecause ?? null : null)}`, second ? [second] : []));
      break;
    }
    case 'b8-head-restart-unacked': {
      const released = boot ? cleanupAfter(boot.at) : undefined, command = q(first);
      const finalUnit = command ? unitOf(command) : undefined;
      out.push(ok('the head registered its boot', Boolean(boot), boot ? `head_boot ${String(boot.at)}` : 'no head_boot row'),
        ok('the cleanup at start released within 5 s', Boolean(released), released ? `released ${String(released.at)}` : 'no released(cleanup) within 5 s of the boot'),
        ok('the resent receipt settles normally (unknown was never told)', Boolean(command?.receipts.length) && finalUnit?.goal !== 'unknown' && !rowsOf(model, 'unknown_notified').length,
          `final unit ${JSON.stringify(finalUnit ?? null)}; unknown_notified rows ${rowsOf(model, 'unknown_notified').length}`, ids));
      break;
    }
    case 'b8-head-restart-notified': {
      const told = rowsOf(model, 'unknown_notified').find(row => idsOf(row, model.meta).command === first), fixed = q(first)?.corrected[0];
      const released = boot ? cleanupAfter(boot.at) : undefined;
      out.push(ok('the model was told before the head stopped', Boolean(told && boot) && (ms(told!.at) ?? Infinity) < (ms(boot!.at) ?? 0), `notified ${String(told?.at ?? '-')} boot ${String(boot?.at ?? '-')}`),
        ok('the cleanup after start released within 5 s', Boolean(released), released ? `released ${String(released.at)}` : 'none'),
        ok('the correction came after the start', Boolean(fixed && boot) && (ms(fixed!.at) ?? 0) >= (ms(boot!.at) ?? Infinity), `corrected ${String(fixed?.at ?? '-')}`, ids));
      break;
    }
    case 'b8-body-restart': {
      const at = ms(injections(model, 'body_restart')[0]?.at), poll = traceOf(model, 'poll').find(line => line.first === true && (ms(line.at) ?? 0) >= (at ?? Infinity));
      const lost = rowsOf(model, 'events').some(row => row.lost === true && idsOf(row, model.meta).command === first);
      out.push(ok('the new body\'s first poll', Boolean(poll), poll ? `first poll ${poll.at}` : 'none'),
        ok('released, goal unknown, events lost, an unexplained difference only', Boolean(q(first)?.released.length) && unitOf(q(first)!)?.goal === 'unknown' && lost && rowsOf(model, 'ledger_unexplained').length > 0,
          `released ${q(first)?.released.length ?? 0}; events lost ${lost}; ledger_unexplained rows ${rowsOf(model, 'ledger_unexplained').length}`, ids));
      break;
    }
    case 'b8-lease-swap': {
      const command = q(first), times = command ? bodyTimesOf(command) : undefined;
      const cut = command ? unitOf(command)?.droppedBecause?.code === 'lease_expired' || linesOf(command).some(line => line.cutBy === 'lease_expired') : false;
      out.push(ok('q2 is cut lease_expired and never moved', cut && (times?.motorOps ?? 0) === 0 && !command!.ops.some(acted), `lease_expired ${cut}; motorOps ${times?.motorOps ?? 0}`, ids));
      break;
    }
  }
  return out;
}
