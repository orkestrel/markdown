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
	MarkdownDocument,
	MarkdownProjection,
	ParagraphNode,
	TableNode,
} from '@src/core'
import {
	Markdown,
	createProjection,
	flattenText,
	htmlToMarkdown,
	isHeadingNode,
	isListNode,
	isTableNode,
	isParagraphNode,
	isCodeBlockNode,
	isBlockquoteNode,
	isEmphasisNode,
	isCodeSpanNode,
	isLinkNode,
} from '@src/core'
import { parseDocument as parseHTML } from '@orkestrel/html'
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

// ── Markdown AST assertions ────────────────────────────────────────────────────
// Assert a parsed node IS a given element kind — throwing if not — and return it
// narrowed, so a test reads the typed node (`assertHeading(block).level`,
// `assertLink(node).href`) without an `as` or an `if`-guarded `expect` (both
// AGENTS-forbidden; §1 / §16). Thin assert-and-narrow wrappers over `@src/core`'s
// `is*` guards — one `assert{Element}` per guard — environment-agnostic, so they
// sit here beside the other base helpers, shared across the Markdown and
// AST-validator unit tests.

/** Parse `markdown` and narrow its FIRST block, asserting at least one exists. */
export function firstBlock(markdown: string): BlockNode {
	const block = new Markdown(markdown).document.children[0]
	if (block === undefined) throw new Error('expected at least one block')
	return block
}

export function assertHeadingNode(block: BlockNode | undefined): HeadingNode {
	if (block === undefined || !isHeadingNode(block)) {
		throw new Error(`expected heading, got ${block?.element}`)
	}
	return block
}

export function assertListNode(block: BlockNode | undefined): ListNode {
	if (block === undefined || !isListNode(block)) {
		throw new Error(`expected list, got ${block?.element}`)
	}
	return block
}

export function assertTableNode(block: BlockNode | undefined): TableNode {
	if (block === undefined || !isTableNode(block)) {
		throw new Error(`expected table, got ${block?.element}`)
	}
	return block
}

export function assertParagraphNode(block: BlockNode | undefined): ParagraphNode {
	if (block === undefined || !isParagraphNode(block)) {
		throw new Error(`expected paragraph, got ${block?.element}`)
	}
	return block
}

export function assertCodeBlockNode(block: BlockNode | undefined): CodeBlockNode {
	if (block === undefined || !isCodeBlockNode(block)) {
		throw new Error(`expected codeBlock, got ${block?.element}`)
	}
	return block
}

export function assertBlockquoteNode(block: BlockNode | undefined): BlockquoteNode {
	if (block === undefined || !isBlockquoteNode(block)) {
		throw new Error(`expected blockquote, got ${block?.element}`)
	}
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
export function assertInlineNode(markdown: string): InlineNode {
	const node = assertParagraphNode(firstBlock(markdown)).children[0]
	if (node === undefined) throw new Error(`no inline node parsed from: ${markdown}`)
	return node
}

// The flattened text content of a LIST of inline nodes (a paragraph's `children`,
// say) — the array-shaped convenience test suites call over `@src/core`'s
// `flattenText(node)` (which flattens a single node's descendants), joining each
// node's flattened text in order.
export function inlineText(nodes: readonly InlineNode[]): string {
	return nodes.map((node) => flattenText(node)).join('')
}

// ── HTML → markdown projection fixtures ───────────────────────────────────────
// `htmlToMarkdown` reads an `@orkestrel/html` AST, so its tests start from HTML
// source. `projectHTML` is the one parse-then-project step every projection test
// shares, and `PROJECTION_CORPUS` is the document set the round-trip anchor law
// (`parseDocument(renderMarkdown(projection))` deep-equals `projection`) is proved
// over — one entry per markdown construct the projection can emit.

/** A {@link MarkdownProjection} with every field defaulted — the projection leaves' test input. */
export function buildProjection(parts: Partial<MarkdownProjection>): MarkdownProjection {
	return createProjection(parts)
}

/** Parse `html` with `@orkestrel/html` and project it to a markdown document. */
export function projectHTML(html: string): MarkdownDocument {
	return htmlToMarkdown(parseHTML(html))
}

/** Markdown sources whose parsed AST must survive canonical rendering and reparsing. */
export const MARKDOWN_FIXPOINT_CORPUS: ReadonlyArray<{
	readonly name: string
	readonly source: string
	readonly rendered: string
}> = [
	{
		name: 'emphasis containing strong',
		source: '_a **c** b_',
		rendered: '*a __c__ b*',
	},
	{
		name: 'strong with nested emphasis at its tail',
		source: '**b _c_**',
		rendered: '**b _c_**',
	},
	{
		name: 'triple-nested emphasis',
		source: '*x _a **c** b_ y*',
		rendered: '*x _a **c** b_ y*',
	},
]

/** The HTML documents the projection's round-trip anchor law is proved over. */
export const PROJECTION_CORPUS: ReadonlyArray<{ readonly name: string; readonly html: string }> = [
	{ name: 'headings', html: '<h1>Title</h1><h2>Sub &amp; more</h2><h6>Deep</h6>' },
	{ name: 'emphasis nesting', html: '<p>a <strong><em>c</em> and b</strong> d</p>' },
	{
		name: 'triple-nested emphasis',
		html: '<p><em>x <em>a <strong>c</strong> b</em> y</em></p>',
	},
	{ name: 'inline code with backticks', html: '<p>use <code>a`b</code> now</p>' },
	{
		name: 'fenced code with a language',
		html: '<pre><code class="language-ts">const a = 1</code></pre>',
	},
	{ name: 'fenced code without a language', html: '<pre>plain\n  block</pre>' },
	{ name: 'link kept', html: '<p>see <a href="/guide">the guide</a>.</p>' },
	{ name: 'link refused', html: '<p>see <a href="javascript:alert(1)">the guide</a>.</p>' },
	{ name: 'image kept', html: '<p><img src="shot.png" alt="a shot"> after</p>' },
	{ name: 'image refused', html: '<p><img src="data:text/html,x" alt=""> after</p>' },
	{ name: 'hard break', html: '<p>one<br>two</p>' },
	{ name: 'nested list', html: '<ul><li>a<ul><li>b</li></ul></li></ul>' },
	{
		name: 'table-first list item',
		html: '<ul><li><table><tr><th>h</th></tr><tr><td>x</td></tr></table></li></ul>',
	},
	{ name: 'ordered list with start', html: '<ol start="3"><li>a</li><li>b</li></ol>' },
	{ name: 'blockquote with blank lines', html: '<blockquote><p>a</p><p>b</p></blockquote>' },
	{
		name: 'aligned table',
		html: '<table><tr><th align="right">a</th><th align="center">b</th></tr><tr><td>1</td><td>2</td></tr></table>',
	},
	{ name: 'unaligned table', html: '<table><tr><th>a</th></tr><tr><td>1</td></tr></table>' },
	{ name: 'unknown wrappers', html: '<section><div>text</div><p>para</p></section>' },
	{ name: 'unsafe subtree', html: '<div><script>alert(1)</script><p>kept</p></div>' },
	{ name: 'thematic break', html: '<p>a</p><hr><p>b</p>' },
	{
		name: 'mixed document',
		html: '<h1>Doc</h1><p>Intro with <code>x</code> and <a href="/a">a link</a>.</p><blockquote><p>Quoted</p></blockquote><ul><li>one</li><li>two</li></ul><pre><code class="language-js">go()</code></pre>',
	},
]

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
