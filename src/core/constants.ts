import type { MarkdownProjection } from './types.js'

/**
 * Holds the frozen empty HTML-to-markdown projection from which projection factories
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
