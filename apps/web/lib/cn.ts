/**
 * Class name join.
 *
 * Deliberately not `clsx` + `tailwind-merge`. Those exist to reconcile
 * conflicting utilities at runtime — `px-2` losing to a `px-4` passed in from a
 * caller — and the reason this codebase does not need them is that no component
 * below accepts a `className` that fights its own variants: variants own layout
 * and spacing, callers own placement. Adding two dependencies to paper over a
 * conflict that has been designed out would be the wrong trade, and both would
 * be unpinned in a repository whose CLAUDE.md pins everything.
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
