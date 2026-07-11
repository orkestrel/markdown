// Base test setup — environment-agnostic helpers loaded first by every
// Vitest project (`setupFiles[0]`). Keep this file free of `node:*` and of
// `document` / `window` / Vue: DOM/Vue helpers live in `setupBrowser.ts`.

import type {
	BlockNode,
	BlockquoteNode,
	CodeBlockNode,
	EmphasisNode,
	HeadingNode,
	InlineCodeNode,
	InlineNode,
	LinkNode,
	ListNode,
	MarkdownParserInterface,
	ParagraphNode,
	TableNode,
} from '@src/core'
import {
	isHeadingNode,
	isListNode,
	isTableNode,
	isParagraphNode,
	isCodeBlockNode,
	isBlockquoteNode,
	isEmphasisNode,
	isCodeSpanNode,
	isLinkNode,
	isTextNode,
} from '@src/core'
import { afterEach, vi } from 'vitest'

afterEach(() => {
	vi.restoreAllMocks()
})

// ── MarkdownParser AST assertions ─────────────────────────────────────────────
// Assert a parsed node IS a given element kind — throwing if not — and return it
// narrowed, so a test reads the typed node (`assertHeading(block).level`,
// `assertLink(node).href`) without an `as` or an `if`-guarded `expect` (both
// AGENTS-forbidden; §1 / §16). Thin assert-and-narrow wrappers over the parsers
// module's `is*` validators — one `assert{Element}` per guard — environment-agnostic,
// so they sit here beside the other base helpers, shared by the MarkdownParser unit
// test and the parser-validators test; `inlineText` is additionally reused by the
// guides-parity extractors in `setupGuides.ts`.

/** Parse `markdown` and narrow its FIRST block, asserting at least one exists. */
export function firstBlock(parser: MarkdownParserInterface, markdown: string): BlockNode {
	const block = parser.parse(markdown).children[0]
	if (block === undefined) throw new Error('expected at least one block')
	return block
}

export function assertHeadingNode(block: BlockNode): HeadingNode {
	if (!isHeadingNode(block)) throw new Error(`expected heading, got ${block.element}`)
	return block
}

export function assertListNode(block: BlockNode): ListNode {
	if (!isListNode(block)) throw new Error(`expected list, got ${block.element}`)
	return block
}

export function assertTableNode(block: BlockNode): TableNode {
	if (!isTableNode(block)) throw new Error(`expected table, got ${block.element}`)
	return block
}

export function assertParagraphNode(block: BlockNode | undefined): ParagraphNode {
	if (block === undefined || !isParagraphNode(block)) {
		throw new Error(`expected paragraph, got ${block?.element}`)
	}
	return block
}

export function assertCodeBlockNode(block: BlockNode): CodeBlockNode {
	if (!isCodeBlockNode(block)) throw new Error(`expected codeBlock, got ${block.element}`)
	return block
}

export function assertBlockquoteNode(block: BlockNode): BlockquoteNode {
	if (!isBlockquoteNode(block)) throw new Error(`expected blockquote, got ${block.element}`)
	return block
}

export function assertEmphasisNode(node: InlineNode | undefined): EmphasisNode {
	if (node === undefined || !isEmphasisNode(node)) {
		throw new Error(`expected emphasis, got ${node?.element}`)
	}
	return node
}

export function assertCodeSpanNode(node: InlineNode | undefined): InlineCodeNode {
	if (node === undefined || !isCodeSpanNode(node)) {
		throw new Error(`expected codeSpan, got ${node?.element}`)
	}
	return node
}

export function assertLinkNode(node: InlineNode | undefined): LinkNode {
	if (node === undefined || !isLinkNode(node))
		throw new Error(`expected link, got ${node?.element}`)
	return node
}

// Parse a single-paragraph markdown snippet, assert it yields exactly one
// paragraph, and return its first inline child narrowed to `InlineNode`.
export function assertInlineNode(parser: MarkdownParserInterface, markdown: string): InlineNode {
	const node = assertParagraphNode(firstBlock(parser, markdown)).children[0]
	if (node === undefined) throw new Error(`no inline node parsed from: ${markdown}`)
	return node
}

// The flattened text content of an inline-node tree (text + code values joined,
// descending through emphasis / link children) — a content assertion independent
// of the exact nesting.
export function inlineText(nodes: readonly InlineNode[]): string {
	return nodes
		.map((node) =>
			isTextNode(node) || isCodeSpanNode(node) ? node.value : inlineText(node.children),
		)
		.join('')
}
