import { normalizedNotionId } from './notionClient.js';

/**
 * Pure conversion of Notion API objects to bounded plain text. Nothing here reads the
 * network. Everything produced is the owner's document text and stays untrusted
 * reference material: callers quote it and never treat it as instructions.
 */
export interface NotionBlockNode {
  block: Record<string, unknown>;
  children: readonly NotionBlockNode[];
}

export interface NotionRenderedText {
  text: string;
  /** Blocks of a type this build does not convert (images, files, embeds, equations, …). */
  skippedBlocks: number;
  truncated: boolean;
}

export type NotionParent =
  | { kind: 'workspace' }
  | { kind: 'page' | 'database' | 'block'; id: string };

export function notionRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Control characters are removed so document text cannot break out of the quoted prompt block. */
export function cleanNotionText(value: unknown, maximum: number): string {
  if (typeof value !== 'string') return '';
  const cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '').replace(/\r\n?/gu, '\n').trim();
  const characters = [...cleaned];
  return characters.length > maximum ? `${characters.slice(0, maximum - 1).join('')}…` : cleaned;
}

export function notionRichText(value: unknown, maximum = 2_000): string {
  if (!Array.isArray(value)) return '';
  return cleanNotionText(value.map(item => {
    const text = notionRecord(item)?.plain_text;
    return typeof text === 'string' ? text : '';
  }).join(''), maximum);
}

/** A page's title property, or a database's title. Empty when it has none. */
export function notionTitle(object: Record<string, unknown>): string {
  if (object.object === 'database') return notionRichText(object.title, 200).replace(/\s+/gu, ' ');
  for (const property of Object.values(notionRecord(object.properties) ?? {})) {
    const record = notionRecord(property);
    if (record?.type === 'title') return notionRichText(record.title, 200).replace(/\s+/gu, ' ');
  }
  return '';
}

/** Only a Notion-hosted HTTPS address is kept as a source link. */
export function notionUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 500) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const hosted = ['notion.so', 'notion.com', 'notion.site'].some(domain => host === domain || host.endsWith(`.${domain}`));
    return url.protocol === 'https:' && hosted && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function notionParent(object: Record<string, unknown>): NotionParent | null {
  const parent = notionRecord(object.parent);
  if (!parent) return null;
  if (parent.type === 'workspace') return { kind: 'workspace' };
  const kinds = { page_id: 'page', database_id: 'database', block_id: 'block' } as const;
  const kind = kinds[parent.type as keyof typeof kinds];
  const id = kind ? normalizedNotionId(parent[parent.type as string]) : null;
  return kind && id ? { kind, id } : null;
}

export function notionArchived(object: Record<string, unknown>): boolean {
  return object.archived === true || object.in_trash === true;
}

const SIMPLE_PROPERTY_LIMIT = 8;

/** Title-less, simple property values of a database row: short text, choices, numbers, dates, checkboxes. */
export function notionSimpleProperties(page: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [rawName, property] of Object.entries(notionRecord(page.properties) ?? {})) {
    if (Object.keys(result).length >= SIMPLE_PROPERTY_LIMIT) break;
    const record = notionRecord(property);
    const name = cleanNotionText(rawName, 60);
    const value = record ? simplePropertyValue(record) : '';
    if (name && value) result[name] = value;
  }
  return result;
}

function simplePropertyValue(property: Record<string, unknown>): string {
  const named = (value: unknown) => cleanNotionText(notionRecord(value)?.name, 80);
  switch (property.type) {
    case 'rich_text': return notionRichText(property.rich_text, 240);
    case 'select': return named(property.select);
    case 'status': return named(property.status);
    case 'multi_select':
      return Array.isArray(property.multi_select) ? property.multi_select.map(named).filter(Boolean).slice(0, 8).join('、') : '';
    case 'number': return typeof property.number === 'number' && Number.isFinite(property.number) ? String(property.number) : '';
    case 'checkbox': return typeof property.checkbox === 'boolean' ? (property.checkbox ? 'はい' : 'いいえ') : '';
    case 'date': {
      const date = notionRecord(property.date);
      const start = cleanNotionText(date?.start, 40);
      const end = cleanNotionText(date?.end, 40);
      return start ? (end ? `${start}〜${end}` : start) : '';
    }
    case 'url': return cleanNotionText(property.url, 200);
    case 'formula': {
      const formula = notionRecord(property.formula);
      const value = formula ? formula[formula.type as string] : undefined;
      return typeof value === 'string' ? cleanNotionText(value, 200)
        : typeof value === 'number' && Number.isFinite(value) ? String(value)
          : typeof value === 'boolean' ? (value ? 'はい' : 'いいえ') : '';
    }
    // People, e-mail, phone, files, relations and roll-ups are not projected.
    default: return '';
  }
}

const TEXT_BLOCKS: Readonly<Record<string, (text: string, body: Record<string, unknown>, index: number) => string>> = {
  paragraph: text => text,
  heading_1: text => `# ${text}`,
  heading_2: text => `## ${text}`,
  heading_3: text => `### ${text}`,
  bulleted_list_item: text => `- ${text}`,
  numbered_list_item: (text, _body, index) => `${index}. ${text}`,
  to_do: (text, body) => `- [${body.checked === true ? 'x' : ' '}] ${text}`,
  quote: text => `> ${text}`,
  callout: text => `> ${text}`,
  toggle: text => `▸ ${text}`,
  code: text => `\`\`\`\n${text}\n\`\`\``,
};

/** Containers that carry no text of their own; only their children are read. */
const CONTAINER_BLOCKS = new Set(['column_list', 'column', 'synced_block', 'table']);

/** Converts a block tree to Markdown-like text, at most `maximumCharacters` long. */
export function renderNotionBlocks(nodes: readonly NotionBlockNode[], maximumCharacters: number): NotionRenderedText {
  const lines: string[] = [];
  let skippedBlocks = 0;
  const walk = (items: readonly NotionBlockNode[], depth: number) => {
    let number = 0;
    for (const node of items) {
      const type = typeof node.block.type === 'string' ? node.block.type : '';
      const body = notionRecord(node.block[type]) ?? {};
      const indent = '  '.repeat(Math.min(depth, 4));
      number = type === 'numbered_list_item' ? number + 1 : 0;
      const render = TEXT_BLOCKS[type];
      if (render) {
        const text = notionRichText(body.rich_text);
        if (text) lines.push(...render(text, body, number).split('\n').map(line => `${indent}${line}`));
      } else if (type === 'table_row') {
        const cells = Array.isArray(body.cells) ? body.cells.slice(0, 12).map(cell => notionRichText(cell, 200).replace(/\s+/gu, ' ')) : [];
        if (cells.some(Boolean)) lines.push(`${indent}| ${cells.join(' | ')} |`);
      } else if (type === 'child_page' || type === 'child_database') {
        const title = cleanNotionText(body.title, 200).replace(/\s+/gu, ' ');
        lines.push(`${indent}[${type === 'child_page' ? '子ページ' : 'データベース'}: ${title || '無題'}]`);
        continue;
      } else if (type === 'divider') {
        lines.push(`${indent}---`);
      } else if (!CONTAINER_BLOCKS.has(type)) {
        skippedBlocks += 1;
        continue;
      }
      if (node.children.length) walk(node.children, CONTAINER_BLOCKS.has(type) ? depth : depth + 1);
    }
  };
  walk(nodes, 0);
  const text = lines.join('\n');
  const characters = [...text];
  const truncated = characters.length > maximumCharacters;
  return { text: truncated ? `${characters.slice(0, maximumCharacters - 1).join('')}…` : text, skippedBlocks, truncated };
}
