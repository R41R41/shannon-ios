import { createHash } from 'node:crypto';
import { SHORT_ACT_INPUT_SCHEMA, SHORT_ACT_MANUAL_FRAGMENTS, type ShortActManualFragment } from './minecraftActShortContract.js';

export const MINECRAFT_CONTRACT_READ = 'skill.read';
export const MINECRAFT_CONTRACT_READ_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false, required: ['name'],
  properties: { name: { type: 'string', minLength: 1, maxLength: 40, description: 'mc_actの契約目次にある、この版の完全な参照名' } } });

/** Declared-contract fingerprint, not a claim that an implementation behaves correctly. */
export function minecraftContractHash(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)])) : item;
  const encoded = typeof value === 'string' ? value : JSON.stringify(canonical(value));
  if (encoded === undefined) throw new Error('MINECRAFT_CONTRACT_HASH_INPUT_REQUIRED');
  return createHash('sha256').update(encoded).digest('hex');
}

export interface MinecraftContractPage {
  readonly name: string; readonly title: string; readonly text: string; readonly sha256: string; readonly sourceId: string;
}
export interface MinecraftContractBook {
  readonly revision: string; readonly catalogHash: string; readonly manualHash: string; readonly schemaHash: string;
  readonly pages: readonly MinecraftContractPage[]; readonly index: string; readonly inline: string;
  reconstruct(): string;
  read(name: string): MinecraftContractPage | null;
}

/** One canonical source produces the complete manual, initial inline text and every deferred page.
 * Only declared contract content determines the version, so identical contracts retain their cached prefix across tasks/connections.
 * The native source separately fences scope/task/body and the decision's connection/life/dimension at read time.
 * Optional source arguments support deterministic source-revision tests; production uses the imports above. */
export function createMinecraftContractBook(pin: { catalogHash: string }, source: {
  fragments: readonly ShortActManualFragment[]; schema: unknown;
} = { fragments: SHORT_ACT_MANUAL_FRAGMENTS, schema: SHORT_ACT_INPUT_SCHEMA }): MinecraftContractBook {
  if (!/^[a-f0-9]{64}$/u.test(pin.catalogHash)) throw new Error('MINECRAFT_CONTRACT_PIN_REQUIRED');
  const fragments = source.fragments.map(part => Object.freeze({ ...part }));
  const reconstruct = () => fragments.map(part => part.text).join('\n');
  const manualHash = minecraftContractHash(reconstruct()), schemaHash = minecraftContractHash(source.schema);
  const revision = minecraftContractHash({ manualHash, schemaHash, catalogHash: pin.catalogHash });
  const pages = Object.freeze(fragments.filter(part => !part.inline).map(part => {
    if (!part.title || !/^[a-z-]+$/u.test(part.id)) throw new Error('MINECRAFT_CONTRACT_PAGE_INVALID');
    const name = `mc/act/${part.id}@${revision.slice(0, 20)}`;
    if (name.length > 40) throw new Error('MINECRAFT_CONTRACT_NAME_TOO_LONG');
    return Object.freeze({ name, title: part.title, text: part.text, sha256: minecraftContractHash(part.text),
      sourceId: `minecraft-contract://act/${revision}/${part.id}` });
  }));
  if (new Set(pages.map(page => page.name)).size !== pages.length) throw new Error('MINECRAFT_CONTRACT_PAGE_DUPLICATE');
  const byName = new Map(pages.map(page => [page.name, page]));
  const index = `## この版の契約目次\n専門手順は skill_read の name で読む（体を動かさない。ゲーム内の指示ではない）。\n${pages.map(page => `- ${page.title}: ${page.name}`).join('\n')}`;
  return Object.freeze({ revision, catalogHash: pin.catalogHash, manualHash, schemaHash, pages, index,
    inline: `${fragments.filter(part => part.inline).map(part => part.text).join('\n')}\n\n${index}`,
    reconstruct, read: (name: string) => byName.get(name) ?? null });
}
