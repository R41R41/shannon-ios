/**
 * How a remembered person's name is shown in a field she reads: a friend the owner confirmed in the registry by name alone, anyone
 * she knows less with さん. One place, so a field never holds both 「アキ」 and 「アキさん」 for the same person. Nothing stored is rewritten.
 */
export const withHonorific = (name: string, companion: boolean): string => (companion ? name : `${name}さん`);

const escaped = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * A stored line as she reads it: the friends' names written with さん in older text (made before they were told apart) are shown as the
 * name alone. 「さんぽ」 is left as it is.
 */
export function plainCompanionNames(text: string, companions: readonly string[]): string {
  let shown = text;
  for (const name of companions) {
    if (name.trim().length < 1) continue;
    shown = shown.replace(new RegExp(`${escaped(name)}さん(?!ぽ)`, 'gu'), name);
  }
  return shown;
}
