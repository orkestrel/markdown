import type { MarkdownProjection } from './types.js'

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
