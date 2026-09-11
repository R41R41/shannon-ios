export function discoverFeedLinks(html: string, pageURL: URL): readonly URL[] {
  const links: URL[] = [];
  const pattern = /<link\b[^>]*>/giu;
  for (const [tag] of html.matchAll(pattern)) {
    if (!/rel\s*=\s*["'][^"']*alternate/iu.test(tag) || !/type\s*=\s*["']application\/(?:rss|atom)\+xml/iu.test(tag)) continue;
    const href = tag.match(/href\s*=\s*["']([^"']+)["']/iu)?.[1];
    if (!href) continue;
    try { links.push(new URL(href, pageURL)); } catch { /* Ignore malformed page hints. */ }
  }
  return Object.freeze([...new Map(links.map(url => [url.href, url])).values()]);
}
