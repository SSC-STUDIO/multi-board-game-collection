/** Works at the site root, on GitHub Pages subpaths and in the unbundled server. */
export function publicUrl(path) {
  if (/^(?:https?:|data:|blob:)/i.test(path)) return path;
  return `${import.meta.env?.BASE_URL ?? '/'}${path.replace(/^\/+/, '')}`;
}
