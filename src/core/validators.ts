import type {
	BlockquoteNode,
	CodeBlockNode,
	EmphasisNode,
	HeadingNode,
	InlineCodeNode,
	LinkNode,
	ListNode,
	MarkdownNode,
	ParagraphNode,
	TableNode,
	TextNode,
} from './types.js'
import { splitTableRow } from './helpers.js'

// AGENTS section 14: guards are total. This file owns two predicate families:
// line / string structural predicates that test raw strings during parsing
// (isWhitespace, isEscapable, isQuote, isFenceClose, isThematicBreak,
// isTableStart), and node guards that narrow a MarkdownNode to one parsed
// block / inline variant by its element tag.

/**
 * Whether `character` is an inline whitespace character (space / tab / newline) - the
 * emphasis flanking rule's space test.
 *
 * @param character - The character to test
 * @returns `true` when it is inline whitespace
 */
export function isWhitespace(character: string): boolean {
	return character === ' ' || character === '\t' || character === '\n'
}

/**
 * Whether `character` is escapable by a leading backslash - the ASCII punctuation
 * markdown gives meaning to (so `\*` becomes `*` but `\.` stays `\.`).
 *
 * @param character - The single character after a backslash
 * @returns `true` when a backslash before it is an escape
 */
export function isEscapable(character: string): boolean {
	return /[\\`*_{}[\]()#+\-.!>~|]/.test(character)
}

/**
 * Whether `line` is a blockquote line (`>` optionally indented up to three spaces) -
 * its content is de-quoted by {@link stripQuote}.
 *
 * @param line - The candidate line
 * @returns `true` when the line begins a blockquote
 */
export function isQuote(line: string): boolean {
	return /^\s{0,3}>/.test(line)
}

/**
 * Whether `line` closes a fence opened by `marker` - the same fence character, a run
 * at least as long, and nothing else but surrounding whitespace.
 *
 * @param line - The candidate closing line
 * @param marker - The opening fence's marker run (from {@link extractFence})
 * @returns `true` when `line` closes the fence
 */
export function isFenceClose(line: string, marker: string): boolean {
	const character = marker[0] === '~' ? '~' : '`'
	return new RegExp(`^\\s*${character}{${marker.length},}\\s*$`).test(line)
}

/**
 * Whether `line` is a thematic break (horizontal rule) - three or more of the SAME
 * marker `-`, `*`, or `_` (optionally space-separated) and nothing else (`---`,
 * `***`, `___`, `- - -`).
 *
 * @param line - The candidate line
 * @returns `true` when the line is a thematic break
 */
export function isThematicBreak(line: string): boolean {
	const stripped = line.trim().replace(/\s+/g, '')
	if (stripped.length < 3) return false
	const marker = stripped[0]
	if (marker !== '-' && marker !== '*' && marker !== '_') return false
	return [...stripped].every((character) => character === marker)
}

/**
 * Whether the pair (`header`, `delimiter`) opens a GFM table - `delimiter` is a row of
 * `|`-separated cells each matching `:?-+:?`, the GFM rule that a table requires a
 * header row IMMEDIATELY followed by a delimiter row.
 *
 * @param header - The candidate header line
 * @param delimiter - The line after it (the candidate delimiter)
 * @returns `true` when the two lines open a table
 */
export function isTableStart(header: string, delimiter: string | undefined): boolean {
	if (delimiter === undefined || !header.includes('|')) return false
	const cells = splitTableRow(delimiter)
	if (cells.length === 0) return false
	return cells.every((cell) => /^:?-+:?$/.test(cell.trim()))
}

// === Block guards

/** Determine whether a node is a heading block. */
export function isHeadingNode(node: MarkdownNode): node is HeadingNode {
	return node.element === 'heading'
}

/** Determine whether a node is a paragraph block. */
export function isParagraphNode(node: MarkdownNode): node is ParagraphNode {
	return node.element === 'paragraph'
}

/** Determine whether a node is a list block. */
export function isListNode(node: MarkdownNode): node is ListNode {
	return node.element === 'list'
}

/** Determine whether a node is a GFM table block. */
export function isTableNode(node: MarkdownNode): node is TableNode {
	return node.element === 'table'
}

/** Determine whether a node is a fenced code block. */
export function isCodeBlockNode(node: MarkdownNode): node is CodeBlockNode {
	return node.element === 'codeBlock'
}

/** Determine whether a node is a blockquote block. */
export function isBlockquoteNode(node: MarkdownNode): node is BlockquoteNode {
	return node.element === 'blockquote'
}

// === Inline guards

/** Determine whether a node is a plain text run. */
export function isTextNode(node: MarkdownNode): node is TextNode {
	return node.element === 'text'
}

/** Determine whether a node is an emphasis run (`*em*` / `**strong**`). */
export function isEmphasisNode(node: MarkdownNode): node is EmphasisNode {
	return node.element === 'emphasis'
}

/**
 * Determine whether a node is an inline code span.
 *
 * @remarks
 * Narrows to {@link InlineCodeNode} - the node whose `element` discriminant is
 * `'codeSpan'`.
 */
export function isCodeSpanNode(node: MarkdownNode): node is InlineCodeNode {
	return node.element === 'codeSpan'
}

/** Determine whether a node is a link. */
export function isLinkNode(node: MarkdownNode): node is LinkNode {
	return node.element === 'link'
}
