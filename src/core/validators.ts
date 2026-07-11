import type { Guard } from '@orkestrel/contract'
import type {
	BlockNode,
	BlockquoteNode,
	CodeBlockNode,
	CodeSpanNode,
	EmphasisNode,
	HeadingNode,
	InlineNode,
	LinkNode,
	ListItemNode,
	ListNode,
	MarkdownDocument,
	MarkdownNode,
	ParagraphNode,
	TableNode,
	TextNode,
	ThematicBreakNode,
} from './types.js'
import { arrayOf, isBoolean, isNumber, isString, literalOf, lazyOf, recordOf, unionOf } from '@orkestrel/contract'
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
	let index = 0
	while (index < line.length && isFenceWhitespace(line[index])) index++
	let run = 0
	while (index < line.length && line[index] === character) {
		run++
		index++
	}
	if (run < marker.length) return false
	while (index < line.length && isFenceWhitespace(line[index])) index++
	return index === line.length
}

/**
 * Whether `character` is a regex-`\s`-equivalent whitespace character - the
 * character class {@link isFenceClose}'s scan treats as surrounding padding.
 *
 * @param character - The single character to test, or `undefined` past the end of a line
 * @returns `true` when it is whitespace
 */
export function isFenceWhitespace(character: string | undefined): boolean {
	return (
		character === ' ' ||
		character === '\t' ||
		character === '\n' ||
		character === '\r' ||
		character === '\f' ||
		character === '\v'
	)
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

/** Determine whether a node is a thematic break (horizontal rule) block. */
export function isThematicBreakNode(node: MarkdownNode): node is ThematicBreakNode {
	return node.element === 'thematicBreak'
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
 * Narrows to {@link CodeSpanNode} - the node whose `element` discriminant is
 * `'codeSpan'`.
 */
export function isCodeSpanNode(node: MarkdownNode): node is CodeSpanNode {
	return node.element === 'codeSpan'
}

/** Determine whether a node is a link. */
export function isLinkNode(node: MarkdownNode): node is LinkNode {
	return node.element === 'link'
}

// === From-unknown AST guards
//
// The node guards above narrow an ALREADY-PARSED MarkdownNode by its `element`
// tag. The guards below instead validate an arbitrary `unknown` value (untrusted
// input - a deserialized AST, a value crossing a process/RPC boundary) against
// the full node shape, field by field, composed from @orkestrel/contract
// combinators. Each guard IS its own hoisted composed value (compiled once at
// module init, not per call); inline<->block recursion (emphasis/link children,
// list items, blockquote children) resolves through `lazyOf`, closing over the
// exported guard names themselves - legal because `lazyOf`'s thunk resolves per
// call, strictly after module init has assigned every export. @orkestrel/contract
// guarantees guard totality (AGENTS §14): `lazyOf`, `unionOf`, `recordOf`, and
// every built-in guard are throw-contained, so a hostile getter, a structural
// cycle, or pathologically deep input returns `false` rather than throwing -
// no additional `attempt` wrapping is needed here.

/**
 * Determine whether an arbitrary value is a valid {@link InlineNode} - a text
 * run, emphasis, code span, or link, recursively validated.
 *
 * @remarks
 * Total: never throws, even on cyclic or pathologically deep input - every
 * combinator involved (`unionOf`, `recordOf`, `arrayOf`, `lazyOf`) is
 * throw-contained per the `@orkestrel/contract` guard contract (AGENTS §14).
 *
 * @param value - The value to test
 * @returns `true` when `value` is a well-formed {@link InlineNode}
 *
 * @example
 * ```ts
 * import { isInlineNode } from '@orkestrel/markdown'
 *
 * isInlineNode({ element: 'text', value: 'hi' }) // true
 * isInlineNode({ element: 'text' })               // false - missing `value`
 * ```
 */
export const isInlineNode: Guard<InlineNode> = unionOf(
	recordOf({ element: literalOf('text'), value: isString }),
	recordOf({
		element: literalOf('emphasis'),
		strong: isBoolean,
		children: arrayOf(lazyOf(() => isInlineNode)),
	}),
	recordOf({ element: literalOf('codeSpan'), value: isString }),
	recordOf({
		element: literalOf('link'),
		href: isString,
		children: arrayOf(lazyOf(() => isInlineNode)),
	}),
)

/**
 * Determine whether an arbitrary value is a valid {@link BlockNode} - a
 * heading, paragraph, list, table, code block, blockquote, or thematic break,
 * recursively validated.
 *
 * @remarks
 * Total: never throws, even on cyclic or pathologically deep input - every
 * combinator involved (`unionOf`, `recordOf`, `arrayOf`, `lazyOf`) is
 * throw-contained per the `@orkestrel/contract` guard contract (AGENTS §14).
 * A list item's shape is inlined here (and in {@link isMarkdownNode}) rather
 * than named separately - it is used at exactly these two sites.
 *
 * @param value - The value to test
 * @returns `true` when `value` is a well-formed {@link BlockNode}
 *
 * @example
 * ```ts
 * import { isBlockNode } from '@orkestrel/markdown'
 *
 * isBlockNode({ element: 'thematicBreak' }) // true
 * isBlockNode({ element: 'heading' })       // false - missing `level` / `children`
 * ```
 */
export const isBlockNode: Guard<BlockNode> = unionOf(
	recordOf({ element: literalOf('heading'), level: isNumber, children: arrayOf(isInlineNode) }),
	recordOf({ element: literalOf('paragraph'), children: arrayOf(isInlineNode) }),
	recordOf({
		element: literalOf('list'),
		ordered: isBoolean,
		start: isNumber,
		items: arrayOf(
			recordOf({ element: literalOf('listItem'), children: arrayOf(lazyOf(() => isBlockNode)) }),
		),
	}),
	recordOf({
		element: literalOf('table'),
		header: arrayOf(arrayOf(isInlineNode)),
		rows: arrayOf(arrayOf(arrayOf(isInlineNode))),
		align: arrayOf(literalOf('none', 'left', 'right', 'center')),
	}),
	recordOf({ element: literalOf('codeBlock'), lang: isString, code: isString }, ['lang']),
	recordOf({ element: literalOf('blockquote'), children: arrayOf(lazyOf(() => isBlockNode)) }),
	recordOf({ element: literalOf('thematicBreak') }),
)

/**
 * Determine whether an arbitrary value is a valid {@link MarkdownNode} - the
 * {@link MarkdownDocument} root, a {@link BlockNode}, a {@link ListItemNode}, or
 * an {@link InlineNode}, recursively validated.
 *
 * @remarks
 * Total: never throws, even on cyclic or pathologically deep input - every
 * combinator involved (`unionOf`, `recordOf`, `arrayOf`, `lazyOf`) is
 * throw-contained per the `@orkestrel/contract` guard contract (AGENTS §14).
 * A list item's shape is inlined here (and in {@link isBlockNode}) rather than
 * named separately - it is used at exactly these two sites.
 *
 * @param value - The value to test
 * @returns `true` when `value` is a well-formed {@link MarkdownNode}
 *
 * @example
 * ```ts
 * import { isMarkdownNode } from '@orkestrel/markdown'
 *
 * isMarkdownNode({ element: 'text', value: 'hi' }) // true
 * isMarkdownNode({ element: 'bogus' })              // false
 * ```
 */
export const isMarkdownNode: Guard<MarkdownNode> = unionOf(
	lazyOf(() => isMarkdownDocument),
	lazyOf(() => isBlockNode),
	recordOf({ element: literalOf('listItem'), children: arrayOf(lazyOf(() => isBlockNode)) }),
	lazyOf(() => isInlineNode),
)

/**
 * Determine whether an arbitrary value is a valid {@link MarkdownDocument} -
 * the parsed-AST root {@link MarkdownParserInterface.parse} returns, recursively
 * validated.
 *
 * @remarks
 * Total: never throws, even on cyclic or pathologically deep input - every
 * combinator involved (`recordOf`, `arrayOf`) is throw-contained per the
 * `@orkestrel/contract` guard contract (AGENTS §14).
 *
 * @param value - The value to test
 * @returns `true` when `value` is a well-formed {@link MarkdownDocument}
 *
 * @example
 * ```ts
 * import { isMarkdownDocument } from '@orkestrel/markdown'
 *
 * isMarkdownDocument({ element: 'document', children: [] }) // true
 * isMarkdownDocument({ element: 'document' })                 // false - missing `children`
 * ```
 */
export const isMarkdownDocument: Guard<MarkdownDocument> = recordOf({
	element: literalOf('document'),
	children: arrayOf(isBlockNode),
})
