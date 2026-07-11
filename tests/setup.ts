// Base test setup — environment-agnostic helpers loaded first by every
// Vitest project (`setupFiles[0]`). Keep this file free of `node:*` and of
// `document` / `window` / Vue: DOM/Vue helpers live in `setupBrowser.ts`.

import type {
	BlockNode,
	BlockquoteNode,
	CodeBlockNode,
	CodeSpanNode,
	EmphasisNode,
	HeadingNode,
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

// ── Deterministic randomness ──────────────────────────────────────────────────
// The single house seed for tests that need generated/random input (contract
// `.generate(random)` calls, fuzz-style fixtures). Suites call
// `seededRandom(TEST_SEED)` directly to get a fresh, deterministic
// `RandomFunction` — keeping the seed centralized here means every suite that
// wants determinism uses the same starting point.
export const TEST_SEED = 42

// ── MarkdownParser AST assertions ─────────────────────────────────────────────
// Assert a parsed node IS a given element kind — throwing if not — and return it
// narrowed, so a test reads the typed node (`assertHeading(block).level`,
// `assertLink(node).href`) without an `as` or an `if`-guarded `expect` (both
// AGENTS-forbidden; §1 / §16). Thin assert-and-narrow wrappers over `@src/core`'s
// `is*` guards — one `assert{Element}` per guard — environment-agnostic, so they
// sit here beside the other base helpers, shared across the MarkdownParser and
// AST-validator unit tests; `inlineText` is additionally reused by the
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

export function assertCodeSpanNode(node: InlineNode | undefined): CodeSpanNode {
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

// ── Adversarial values for guard-totality tests ───────────────────────────────
// The `isInlineNode` / `isBlockNode` / `isMarkdownNode` / `isMarkdownDocument`
// guards must be total — return `false`, never throw — for any `unknown` input,
// including hostile shapes a real parser would never emit. These builders
// produce exactly those shapes.

/**
 * An emphasis-like record whose `children` array contains a reference cycle
 * (the array holds the record itself). Exercises guard totality against
 * cyclic input without relying on structural recursion blowing the stack.
 */
export function buildCyclicNode(): unknown {
	const node: { element: string; children: unknown[] } = { element: 'emphasis', children: [] }
	node.children.push(node)
	return node
}

/**
 * An object shaped like a markdown node whose `element` property is a getter
 * that throws when read. Exercises guard totality against input that throws
 * mid-inspection rather than returning a plain value.
 */
export function buildHostileNode(): unknown {
	return {
		get element(): string {
			throw new Error('hostile getter')
		},
		get children(): unknown {
			throw new Error('hostile getter')
		},
	}
}

/**
 * An emphasis-like inline chain nested `levels` deep, each level's `children`
 * holding exactly the next level, with a text-like record at the innermost
 * leaf. For stack-safety tests on inline guards/traversal.
 */
export function buildDeepInlineNode(levels: number): unknown {
	let node: unknown = { element: 'text', value: 'leaf' }
	for (let depth = 0; depth < levels; depth += 1) {
		node = { element: 'emphasis', children: [node] }
	}
	return node
}

/**
 * A blockquote-like block chain nested `levels` deep, each level's `children`
 * holding exactly the next level, with a paragraph-like record at the
 * innermost leaf. For stack-safety tests on block guards/traversal.
 */
export function buildDeepBlockNode(levels: number): unknown {
	let node: unknown = { element: 'paragraph', children: [] }
	for (let depth = 0; depth < levels; depth += 1) {
		node = { element: 'blockquote', children: [node] }
	}
	return node
}

// ── Deep markdown source for parser stack-safety tests ────────────────────────
// Plain string builders producing markdown input nested `levels` deep, for
// asserting the parser degrades gracefully (never throws) past `MAX_DEPTH`.

/** Markdown source with `levels` leading `>` blockquote markers before `text`. */
export function buildDeepQuoteInput(levels: number, text = 'leaf'): string {
	return `${'> '.repeat(levels)}${text}`
}

/** Markdown source for an `levels`-deep nested list, one indent per level. */
export function buildDeepListInput(levels: number, text = 'leaf'): string {
	const lines: string[] = []
	for (let depth = 0; depth < levels; depth += 1) {
		lines.push(`${'  '.repeat(depth)}- ${depth === levels - 1 ? text : ''}`)
	}
	return lines.join('\n')
}

/** Markdown source with `levels` nested `*emphasis*`/`[link](` inline markers around `text`. */
export function buildDeepEmphasisInput(levels: number, text = 'leaf'): string {
	let source = text
	for (let depth = 0; depth < levels; depth += 1) {
		source = depth % 2 === 0 ? `*${source}*` : `[${source}](url)`
	}
	return source
}
