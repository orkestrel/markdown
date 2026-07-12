/**
 * The URL schemes `renderHTML` permits on a link `href` - anything else (notably
 * `javascript:`, `data:`, `vbscript:`, `file:`) is dropped to an empty `href` so a
 * hostile link can never execute. Frozen, lower-case; a relative / anchor /
 * scheme-less `href` (no `scheme:` prefix) is always allowed.
 */
export const SAFE_URL_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'mailto', 'tel'])

/**
 * The maximum recursion depth the parse pipeline (`parseDocument` and its
 * `parsers.ts` helpers) and the `helpers.ts` traversal / render functions
 * (`renderHTML`, `renderMarkdown`, `walkNodes`, `foldNode`) honor before degrading to
 * literal text - bounds blockquote nesting, inline nesting (emphasis / links), and
 * traversal/render recursion so pathological or hostile input (deeply nested
 * blockquotes, runaway emphasis) cannot exhaust the call stack. Past this depth the
 * parser treats the remaining content as literal text instead of recursing further.
 */
export const MAX_DEPTH = 64
