import type { Guard } from '@orkestrel/contract'
import type {
	BlockNode,
	BlockquoteNode,
	CodeBlockNode,
	CodeSpanNode,
	EmphasisNode,
	HeadingNode,
	ImageNode,
	InlineNode,
	LineBreakNode,
	LinkNode,
	ListNode,
	MarkdownDocument,
	MarkdownNode,
	ParagraphNode,
	TableNode,
	TextNode,
	ThematicBreakNode,
} from './types.js'
import {
	arrayOf,
	isBoolean,
	isNumber,
	isString,
	literalOf,
	lazyOf,
	nullableOf,
	recordOf,
	unionOf,
} from '@orkestrel/contract'

// Guards are total. This file owns the type narrowers alone: node guards that
// narrow a MarkdownNode to one parsed block / inline variant by its element tag,
// and the from-unknown guards that validate an arbitrary value against the full
// AST shape. The line / character structural predicates the parser tests raw
// strings with narrow nothing, so they are pure leaves and live in helpers.ts.

// === Block guards

/**
 * Determine whether a node is a heading block.
 *
 * @param node - The AST node to test
 * @returns True if the node is a {@link HeadingNode}; false otherwise
 *
 * @example
 * ```ts
 * isHeadingNode({ element: 'heading', level: 1, children: [] }) // true
 * ```
 */
export function isHeadingNode(node: MarkdownNode): node is HeadingNode {
	return node.element === 'heading'
}

/**
 * Determine whether a node is a paragraph block.
 *
 * @param node - The AST node to test
 * @returns True if the node is a {@link ParagraphNode}; false otherwise
 *
 * @example
 * ```ts
 * isParagraphNode({ element: 'paragraph', children: [] }) // true
 * ```
 */
export function isParagraphNode(node: MarkdownNode): node is ParagraphNode {
	return node.element === 'paragraph'
}

/**
 * Determine whether a node is a list block.
 *
 * @param node - The AST node to test
 * @returns True if the node is a {@link ListNode}; false otherwise
 *
 * @example
 * ```ts
 * isListNode({ element: 'list', ordered: false, start: 1, items: [] }) // true
 * ```
 */
export function isListNode(node: MarkdownNode): node is ListNode {
	return node.element === 'list'
}

/**
 * Determine whether a node is a GFM table block.
 *
 * @param node - The AST node to test
 * @returns True if the node is a {@link TableNode}; false otherwise
 *
 * @example
 * ```ts
 * isTableNode({ element: 'table', header: [], rows: [], align: [] }) // true
 * ```
 */
export function isTableNode(node: MarkdownNode): node is TableNode {
	return node.element === 'table'
}

/**
 * Determine whether a node is a fenced code block.
 *
 * @param node - The AST node to test
 * @returns True if the node is a {@link CodeBlockNode}; false otherwise
 *
 * @example
 * ```ts
 * isCodeBlockNode({ element: 'codeBlock', code: 'x' }) // true
 * ```
 */
export function isCodeBlockNode(node: MarkdownNode): node is CodeBlockNode {
	return node.element === 'codeBlock'
}

/**
 * Determine whether a node is a blockquote block.
 *
 * @param node - The AST node to test
 * @returns True if the node is a {@link BlockquoteNode}; false otherwise
 *
 * @example
 * ```ts
 * isBlockquoteNode({ element: 'blockquote', children: [] }) // true
 * ```
 */
export function isBlockquoteNode(node: MarkdownNode): node is BlockquoteNode {
	return node.element === 'blockquote'
}

/**
 * Determine whether a node is a thematic break (horizontal rule) block.
 *
 * @param node - The AST node to test
 * @returns True if the node is a {@link ThematicBreakNode}; false otherwise
 *
 * @example
 * ```ts
 * isThematicBreakNode({ element: 'thematicBreak' }) // true
 * ```
 */
export function isThematicBreakNode(node: MarkdownNode): node is ThematicBreakNode {
	return node.element === 'thematicBreak'
}

// === Inline guards

/**
 * Determine whether a node is a plain text run.
 *
 * @param node - The AST node to test
 * @returns True if the node is a {@link TextNode}; false otherwise
 *
 * @example
 * ```ts
 * isTextNode({ element: 'text', value: 'hi' }) // true
 * ```
 */
export function isTextNode(node: MarkdownNode): node is TextNode {
	return node.element === 'text'
}

/**
 * Determine whether a node is an emphasis run (`*em*` / `**strong**`).
 *
 * @param node - The AST node to test
 * @returns True if the node is an {@link EmphasisNode}; false otherwise
 *
 * @example
 * ```ts
 * isEmphasisNode({ element: 'emphasis', strong: false, children: [] }) // true
 * ```
 */
export function isEmphasisNode(node: MarkdownNode): node is EmphasisNode {
	return node.element === 'emphasis'
}

/**
 * Determine whether a node is an inline code span.
 *
 * @remarks
 * Narrows to {@link CodeSpanNode} - the node whose `element` discriminant is
 * `'codeSpan'`.
 *
 * @param node - The AST node to test
 * @returns True if the node is a {@link CodeSpanNode}; false otherwise
 *
 * @example
 * ```ts
 * isCodeSpanNode({ element: 'codeSpan', value: 'x' }) // true
 * ```
 */
export function isCodeSpanNode(node: MarkdownNode): node is CodeSpanNode {
	return node.element === 'codeSpan'
}

/**
 * Determine whether a node is a GFM hard line break.
 *
 * @param node - The AST node to test
 * @returns True if the node is a {@link LineBreakNode}; false otherwise
 *
 * @example
 * ```ts
 * isLineBreakNode({ element: 'break' }) // true
 * ```
 */
export function isLineBreakNode(node: MarkdownNode): node is LineBreakNode {
	return node.element === 'break'
}

/**
 * Determine whether a node is a link.
 *
 * @param node - The AST node to test
 * @returns True if the node is a {@link LinkNode}; false otherwise
 *
 * @example
 * ```ts
 * isLinkNode({ element: 'link', href: 'https://example.dev', children: [] }) // true
 * ```
 */
export function isLinkNode(node: MarkdownNode): node is LinkNode {
	return node.element === 'link'
}

/**
 * Determine whether a node is an image.
 *
 * @param node - The AST node to test
 * @returns True if the node is an {@link ImageNode}; false otherwise
 *
 * @example
 * ```ts
 * isImageNode({ element: 'image', src: 'x.png', children: [] }) // true
 * ```
 */
export function isImageNode(node: MarkdownNode): node is ImageNode {
	return node.element === 'image'
}

// === From-unknown AST guards
//
// The node guards above narrow an ALREADY-PARSED MarkdownNode by its `element`
// tag. The guards below instead validate an arbitrary `unknown` value (untrusted
// input - a deserialized AST, a value crossing a process/RPC boundary) against
// the full node shape, field by field, composed from @orkestrel/contract
// combinators. Each guard IS its own hoisted composed value (compiled once at
// module init, not per call); inline<->block recursion (emphasis/link/image children,
// list items, blockquote children) resolves through `lazyOf`, closing over the
// exported guard names themselves - legal because `lazyOf`'s thunk resolves per
// call, strictly after module init has assigned every export. @orkestrel/contract
// guarantees guard totality: `lazyOf`, `unionOf`, `recordOf`, and
// every built-in guard are throw-contained, so a hostile getter, a structural
// cycle, or pathologically deep input returns `false` rather than throwing -
// no additional `attempt` wrapping is needed here.

/**
 * Determine whether an arbitrary value is a valid {@link InlineNode} - a text
 * run, emphasis, code span, hard break, link, or image, recursively validated.
 *
 * @remarks
 * Total: never throws, even on cyclic or pathologically deep input - every
 * combinator involved (`unionOf`, `recordOf`, `arrayOf`, `lazyOf`) is
 * throw-contained per the `@orkestrel/contract` guard contract.
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
	recordOf({ element: literalOf('break') }),
	recordOf({
		element: literalOf('link'),
		href: isString,
		children: arrayOf(lazyOf(() => isInlineNode)),
	}),
	recordOf({
		element: literalOf('image'),
		src: isString,
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
 * throw-contained per the `@orkestrel/contract` guard contract.
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
		align: arrayOf(nullableOf(literalOf('left', 'right', 'center'))),
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
 * throw-contained per the `@orkestrel/contract` guard contract.
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
 * the parsed-AST root {@link parseDocument} returns, recursively
 * validated.
 *
 * @remarks
 * Total: never throws, even on cyclic or pathologically deep input - every
 * combinator involved (`recordOf`, `arrayOf`) is throw-contained per the
 * `@orkestrel/contract` guard contract.
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
