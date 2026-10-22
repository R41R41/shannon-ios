import { shannonTool } from '../../tools/toolRegistryPorts.js';
import type { FcaReadReceipt, FcaObservedSources } from './fcaConversationPorts.js';

/** Trusted executor receipts only. Unknown or missing private read metadata is explicit, never treated as public. */
export function fcaReadReceiptSources(receipt: FcaReadReceipt): FcaObservedSources {
  if (!receipt.ok) return {};
  const tool = shannonTool(receipt.name);
  // Public reads: the web, places, the weather and a rough route carry nothing of the owner's; nor does the Minecraft servers' state
  // (`minecraft.lifecycle_status`: Minecraft run 11, 2026-10-14, its first FCA call was read as an unresolved private receipt, the
  // task's sources were held after the call and the step closed unknown), as her body's own observations carry none.
  if (tool?.domain === 'task_runtime' || tool?.domain === 'minecraft_lifecycle'
    || ['web.search', 'web.read', 'places.search', 'weather.forecast', 'route.estimate'].includes(receipt.name)) return {};
  const documents = receipt.documents?.sourceIds ?? receipt.documents?.read;
  if (!documents) return tool?.effect === 'read'
    ? { readSourceIds: [`fca-unresolved://${receipt.name}`] } : {};
  const ids = documents.map(id => {
    if (typeof id !== 'string' || !id || id.length > 200) return 'fca-unresolved://invalid-receipt';
    if (/^(?:shannon-study|aether-document|notion-page|voyager-task|calendar-item|shannon-folder|shannon-skill):\/\//u.test(id)) return id;
    return receipt.name.startsWith('aether') || receipt.name.startsWith('ownerDocs.')
      ? `aether-document://${encodeURIComponent(id)}` : 'fca-unresolved://unknown-receipt';
  });
  return { readSourceIds: [...new Set(ids)] };
}
