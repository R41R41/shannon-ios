/** The normal forms of an agent project's key and its GitHub repository (Syzygy ADR-0008 stage 3, S2: moved unchanged out of the provisioning store, so the Agent Host integration reaches them through the window). */

export function normalizedGitHubRepositoryURL(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 500) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.hostname.toLocaleLowerCase('en-US') !== 'github.com') return null;
    if (url.username || url.password || url.search || url.hash) return null;
    const components = url.pathname.split('/').filter(Boolean);
    if (components.length !== 2) return null;
    const owner = components[0]!;
    const repository = components[1]!.replace(/\.git$/i, '');
    const safeCoordinate = /^[A-Za-z0-9_.-]+$/;
    if (!safeCoordinate.test(owner) || !safeCoordinate.test(repository)
      || owner === '.' || owner === '..' || repository === '.' || repository === '..') return null;
    return `https://github.com/${owner}/${repository}.git`;
  } catch {
    return null;
  }
}

export function normalizedAgentProjectKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLocaleLowerCase('en-US');
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(key) ? key : null;
}
