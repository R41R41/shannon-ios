import type { FcaExternalTools, FcaToolDefinition } from '../../mind/action/fca/fcaPorts.js';
import type { MinecraftSkillDefinition } from '../../contracts/minecraftControlContract.js';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import type { MadeIn } from '../../contracts/continueContract.js';
import { createMinecraftContractBook, minecraftContractHash, MINECRAFT_CONTRACT_READ, MINECRAFT_CONTRACT_READ_SCHEMA,
  type MinecraftContractBook } from '../../contracts/minecraftContractBook.js';
import { authorizeToolCall } from '../../mind/inhibition/toolGatePorts.js';
import { toolFailure, toolOk } from '../../mind/tools/shannonTools.js';
import { driftOf, madeInOf } from './minecraftMadeIn.js';

const sources = new WeakMap<FcaToolDefinition, MinecraftContractRead>();
interface ContractFrame { connectionId: string; skills: readonly MinecraftSkillDefinition[]; observation: BodyObservation }
export interface MinecraftContractRead extends FcaExternalTools { book(): MinecraftContractBook | null }

/** Only definitions created here acquire this native source. A general/private skill.read with the same name does not. */
function nativeSource(definitions: readonly FcaToolDefinition[]): MinecraftContractRead | null {
  for (const definition of definitions) {
    const port = sources.get(definition);
    if (port) return port;
  }
  return null;
}

function isContractPageInput(input: unknown): input is { name: string } {
  const named = input as { name?: unknown } | null;
  return !!named && typeof named === 'object' && !Array.isArray(named)
    && !Object.keys(named).some(key => key !== 'name') && typeof named.name === 'string'
    && named.name.length >= 1 && named.name.length <= 40;
}

/** A task-bound source of immutable head input contracts, tied to the catalog the actual native connection sent.
 * No skill store, file opener, recall, learned-skill use ledger or caller-selected path is consulted. */
export function createMinecraftContractRead(parts: { scopeKey: string; taskId: string; bodyId: string;
  frame(): ContractFrame | null; boundBody(): string | null; sourcesVisible(): boolean; ownerAlone(): boolean; gameplayAllowed?(): boolean;
  decisionRead?(): MadeIn | null;
}): MinecraftContractRead {
  let cached: { key: string; book: MinecraftContractBook; definitions: readonly FcaToolDefinition[] } | null = null;
  let openedConnection: string | null = null;
  const current = () => {
    const frame = parts.frame(), bound = parts.boundBody();
    if (!frame || bound && bound !== parts.bodyId || !frame.skills.some(skill => skill.name === 'act' && !skill.readOnly)) return null;
    openedConnection ??= frame.connectionId;
    const catalogHash = minecraftContractHash(frame.skills);
    const publicGameplay = parts.gameplayAllowed?.() === true;
    const key = `${catalogHash}:${publicGameplay}`;
    if (cached?.key === key) return { ...cached, frame };
    const book = createMinecraftContractBook({ catalogHash });
    const definition: FcaToolDefinition = { name: MINECRAFT_CONTRACT_READ,
      description: `このMinecraft課題の入力契約を1ページ読む。mc_actの完全な参照名をnameに書く。個人のスキルやファイルは開かない。\n${book.index}`,
      input: { type: 'object', properties: {}, required: [], additionalProperties: false }, nativeInputSchema: MINECRAFT_CONTRACT_READ_SCHEMA,
      domain: 'minecraft_body', effect: 'read', cost: 'none', audiences: publicGameplay ? ['owner_alone', 'others'] : ['owner_alone'], surfaces: ['text'] };
    cached = { key, book, definitions: Object.freeze([definition]) };
    sources.set(definition, port);
    return { ...cached, frame };
  };
  const port: MinecraftContractRead = {
    get definitions() { return current()?.definitions ?? []; },
    book: () => current()?.book ?? null,
    async execute(call) {
      call.signal.throwIfAborted();
      if (call.scopeKey !== parts.scopeKey || call.taskId !== parts.taskId || !parts.sourcesVisible()) throw new Error('FCA_SOURCE_WITHHELD');
      const state = current();
      const denied = authorizeToolCall(state?.definitions[0] ?? null,
        { scopeKey: call.scopeKey, surface: 'text', audience: parts.ownerAlone() ? 'owner_alone' : 'others' });
      if (denied) return denied;
      if (call.name !== MINECRAFT_CONTRACT_READ || !state) return toolFailure('unavailable', 'この体の契約をいまは読めない。', { retryable: false });
      const read = parts.decisionRead?.();
      const stale = read ? read.connectionId !== state.frame.connectionId || !madeInOf(state.frame.observation, read.headBoot)
        || driftOf(read, state.frame.observation) !== null : openedConnection !== state.frame.connectionId;
      if (stale) return toolFailure('conflict', '契約readが読んだ接続・命・次元の観測は失効した。新しい観測の判断から読み直す。', { retryable: false });
      const input = call.input;
      if (!isContractPageInput(input)) return toolFailure('invalid_input', 'nameに契約目次の完全な参照名を1つ書く。', { retryable: false });
      const page = state.book.read(input.name);
      if (!page) return toolFailure('not_found', `この版の契約目次にその参照名は無い。別の版へ読み替えない。\n${state.book.index}`, { retryable: false });
      call.signal.throwIfAborted();
      return toolOk(JSON.stringify({ kind: 'minecraft_contract', book: state.book.revision, catalogHash: state.book.catalogHash,
        catalogHashSource: 'head_actual_poll_skills_canonical_sha256',
        manualHash: state.book.manualHash, schemaHash: state.book.schemaHash, connectionId: state.frame.connectionId, ...page }));
    },
  };
  return port;
}

/** Used at both V2's final menu and the game-only boundary. It bypasses a same-named personal reader in combined ports.
 * Dynamic native definitions refresh independently of upstream wrappers' static definition arrays. */
export function minecraftContractMenu(tools: FcaExternalTools, allowed: (tool: Pick<FcaToolDefinition, 'name'>) => boolean): FcaExternalTools {
  const source = nativeSource(tools.definitions);
  const ordinary = tools.definitions.filter(tool => tool.name !== MINECRAFT_CONTRACT_READ && allowed(tool));
  let lastBook: MinecraftContractBook | null | undefined, lastDefinitions: readonly FcaToolDefinition[] = [];
  return { ...tools,
    // This read has no independent action-lease acquisition. A same-named personal executor's permit claim must not bypass the runner's gate.
    permitsItself: name => name !== MINECRAFT_CONTRACT_READ && tools.permitsItself?.(name) === true,
    get definitions() {
      const book = source?.book() ?? null;
      if (book === lastBook) return lastDefinitions;
      lastBook = book;
      lastDefinitions = [...ordinary.map(tool => tool.name === 'mc.act' && book ? { ...tool, description: book.inline } : tool),
        ...(source?.definitions ?? [])];
      return lastDefinitions;
    },
    async execute(call) {
      if (call.name === MINECRAFT_CONTRACT_READ) {
        if (!source) throw new Error('FCA_TOOL_NOT_OFFERED');
        return source.execute(call);
      }
      return tools.execute(call);
    },
  };
}
