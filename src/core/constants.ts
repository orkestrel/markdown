import type { MarkdownProjection } from './types.js'

/**
 * The maximum recursion depth the parse pipeline (`parseDocument` and its
 * `parsers.ts` helpers), the `helpers.ts` traversal / projection functions
 * (`markdownToHTML`, `renderMarkdown`, `walkNodes`, `foldNode`, `rewriteDocument`),
 * and the `compilers.ts` renderer (`renderHTML`) honor before degrading. It bounds blockquote nesting, inline
 * nesting (emphasis / links), and traversal / projection recursion so pathological
 * or hostile input cannot exhaust the call stack. {@link htmlToMarkdown} is the
 * inherited exception: its fold and depth cap belong to `@orkestrel/html`.
 */
export const MAX_DEPTH = 64

/**
 * The frozen empty HTML-to-markdown projection from which projection factories
 * default every absent field.
 *
 * @example
 * ```ts
 * EMPTY_PROJECTION.blocks // []
 * Object.isFrozen(EMPTY_PROJECTION) // true
 * ```
 */
export const EMPTY_PROJECTION: MarkdownProjection = Object.freeze({
	blocks: Object.freeze([]),
	inlines: Object.freeze([]),
	text: '',
	cells: Object.freeze([]),
	rows: Object.freeze([]),
})
