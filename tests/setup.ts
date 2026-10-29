import type { HTMLNode } from '@orkestrel/html'
// Base test setup — environment-agnostic helpers loaded first by every
// Vitest project (`setupFiles[0]`). Keep this file free of `node:*` and of
// `document` / `window` / Vue.

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
	MarkdownNode,
	MarkdownHandlerMap,
	MarkdownProjection,
	ParagraphNode,
	TableNode,
} from '@src/core'
import {
	Markdown,
	MAX_DEPTH,
	createProjection,
	flattenText,
	htmlToMarkdown,
	isHeadingNode,
	isThematicBreakNode,
	isLineBreakNode,
	isImageNode,
	isTextNode,
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
import { seededRandom } from '@orkestrel/contract'
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
// `assertLink(node).href`) without an `as` or an `if`-guarded `expect` narrowing
// with a non-null assertion. Thin assert-and-narrow wrappers over `@src/core`'s
// `is*` guards — one `assert{Element}` per guard — environment-agnostic, so they
// sit here beside the other base helpers, shared across the Markdown and
// AST-validator unit tests.

/** Parses `markdown` and narrows its FIRST block, asserting at least one exists. */
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

/** Builds a {@link MarkdownProjection} with every field defaulted — the projection leaves' test input. */
export function buildProjection(parts: Partial<MarkdownProjection>): MarkdownProjection {
	return createProjection(parts)
}

/** Parses `html` with `@orkestrel/html` and projects it to a markdown document. */
export function projectHTML(html: string): MarkdownDocument {
	return htmlToMarkdown(parseHTML(html))
}

/** Lists markdown sources whose parsed AST must survive canonical rendering and reparsing. */
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

/** Lists the HTML documents the projection's round-trip anchor law is proved over. */
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
 * Builds an emphasis-like record whose `children` array contains a reference cycle
 * (the array holds the record itself). Exercises guard totality against
 * cyclic input without relying on structural recursion blowing the stack.
 */
export function buildCyclicNode(): unknown {
	const node: { element: string; children: unknown[] } = { element: 'emphasis', children: [] }
	node.children.push(node)
	return node
}

/**
 * Builds an object shaped like a markdown node whose `element` property is a getter
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
 * Builds an emphasis-like inline chain nested `levels` deep, each level's `children`
 * holding exactly the next level, with a text-like record at the innermost
 * leaf. For stack-safety tests on inline guards/traversal.
 */
export function buildDeepInlineNode(levels: number): unknown {
	return Array.from({ length: Math.ceil(levels) }).reduce<unknown>(
		(node) => ({ element: 'emphasis', children: [node] }),
		{ element: 'text', value: 'leaf' },
	)
}

/**
 * Builds a blockquote-like block chain nested `levels` deep, each level's `children`
 * holding exactly the next level, with a paragraph-like record at the
 * innermost leaf. For stack-safety tests on block guards/traversal.
 */
export function buildDeepBlockNode(levels: number): unknown {
	return Array.from({ length: Math.ceil(levels) }).reduce<unknown>(
		(node) => ({ element: 'blockquote', children: [node] }),
		{ element: 'paragraph', children: [] },
	)
}

// ── Deep markdown source for parser stack-safety tests ────────────────────────
// Plain string builders producing markdown input nested `levels` deep, for
// asserting the parser degrades gracefully (never throws) past `MAX_DEPTH`.

/** Builds markdown source with `levels` leading `>` blockquote markers before `text`. */
export function buildDeepQuoteInput(levels: number, text = 'leaf'): string {
	return `${'> '.repeat(levels)}${text}`
}

/** Builds markdown source for an `levels`-deep nested list, one indent per level. */
export function buildDeepListInput(levels: number, text = 'leaf'): string {
	return Array.from(
		{ length: Math.ceil(levels) },
		(_, depth) => `${'  '.repeat(depth)}- ${depth === levels - 1 ? text : ''}`,
	).join('\n')
}

/** Builds markdown source with `levels` nested `*emphasis*`/`[link](` inline markers around `text`. */
export function buildDeepEmphasisInput(levels: number, text = 'leaf'): string {
	const depths = Array.from({ length: Math.ceil(levels) }, (_, depth) => depth)
	return [
		...depths.toReversed().map((depth) => (depth % 2 === 0 ? '*' : '[')),
		text,
		...depths.map((depth) => (depth % 2 === 0 ? '*' : '](url)')),
	].join('')
}

export const countHandlers: MarkdownHandlerMap<number> = {
	document: (_node, children) => 1 + children.reduce((sum, value) => sum + value, 0),
	heading: (_node, children) => 1 + children.reduce((sum, value) => sum + value, 0),
	paragraph: (_node, children) => 1 + children.reduce((sum, value) => sum + value, 0),
	thematicBreak: () => 1,
	blockquote: (_node, children) => 1 + children.reduce((sum, value) => sum + value, 0),
	codeBlock: () => 1,
	list: (_node, children) => 1 + children.reduce((sum, value) => sum + value, 0),
	listItem: (_node, children) => 1 + children.reduce((sum, value) => sum + value, 0),
	table: (_node, children) => 1 + children.reduce((sum, value) => sum + value, 0),
	text: () => 1,
	emphasis: (_node, children) => 1 + children.reduce((sum, value) => sum + value, 0),
	codeSpan: () => 1,
	break: () => 1,
	link: (_node, children) => 1 + children.reduce((sum, value) => sum + value, 0),
	image: (_node, children) => 1 + children.reduce((sum, value) => sum + value, 0),
}

export const cellHandlers: MarkdownHandlerMap<string> = {
	document: (_node, children) => children.join(''),
	heading: (_node, children) => children.join(''),
	paragraph: (_node, children) => children.join(''),
	thematicBreak: () => '',
	blockquote: (_node, children) => children.join(''),
	codeBlock: () => '',
	list: (_node, children) => children.join(''),
	listItem: (_node, children) => children.join(''),
	table: (_node, children) => children.join(','),
	text: (node) => node.value,
	emphasis: (_node, children) => children.join(''),
	codeSpan: () => '',
	break: () => '',
	link: (_node, children) => children.join(''),
	image: (_node, children) => children.join(''),
}

export const htmlLikeHandlers: MarkdownHandlerMap<string> = {
	document: (_node, children) => children.join('\n'),
	heading: (node, children) => `<h${node.level}>${children.join('')}</h${node.level}>`,
	paragraph: (_node, children) => `<p>${children.join('')}</p>`,
	thematicBreak: () => '<hr>',
	blockquote: (_node, children) => children.join(''),
	codeBlock: () => '',
	list: (_node, children) => children.join(''),
	listItem: (_node, children) => children.join(''),
	table: (_node, children) => children.join(''),
	text: (node) => node.value,
	emphasis: (_node, children) => children.join(''),
	codeSpan: () => '',
	break: () => '<br>',
	link: (_node, children) => children.join(''),
	image: (_node, children) => children.join(''),
}

export function upper(node: MarkdownNode): MarkdownNode {
	return isTextNode(node) ? { element: 'text', value: node.value.toUpperCase() } : node
}

export function shout(node: MarkdownNode): MarkdownNode {
	return isTextNode(node) ? { element: 'text', value: `${node.value}!` } : node
}

export function createCappedHandlers(seenEmptyChildren: boolean[]): MarkdownHandlerMap<number> {
	return {
		document: (_node, children) => children.length,
		heading: (_node, children) => children.length,
		paragraph: (_node, children) => children.length,
		thematicBreak: () => 0,
		blockquote: (_node, children) => {
			seenEmptyChildren.push(children.length === 0)
			return children.length === 0 ? 0 : Math.max(...children)
		},
		codeBlock: () => 0,
		list: (_node, children) => children.length,
		listItem: (_node, children) => children.length,
		table: (_node, children) => children.length,
		text: () => 0,
		emphasis: (_node, children) => children.length,
		codeSpan: () => 0,
		break: () => 0,
		link: (_node, children) => children.length,
		image: (_node, children) => children.length,
	}
}

export async function countNodes(source: Iterable<MarkdownNode>): Promise<number> {
	const nodes: MarkdownNode[] = []
	for await (const node of source) nodes.push(node)
	return nodes.filter((node) => node !== undefined).length
}

export async function collectThroughHeading(
	source: Iterable<MarkdownNode>,
	collected: MarkdownNode[],
): Promise<void> {
	for await (const node of source) {
		collected.push(node)
		if (node.element === 'heading') break
	}
}

export function createOrderHandlers(order: string[]): MarkdownHandlerMap<string> {
	return {
		document: (node) => {
			order.push(node.element)
			return node.element
		},
		heading: (node) => {
			order.push(node.element)
			return node.element
		},
		paragraph: (node) => {
			order.push(node.element)
			return node.element
		},
		thematicBreak: (node) => {
			order.push(node.element)
			return node.element
		},
		blockquote: (node) => {
			order.push(node.element)
			return node.element
		},
		codeBlock: (node) => {
			order.push(node.element)
			return node.element
		},
		list: (node) => {
			order.push(node.element)
			return node.element
		},
		listItem: (node) => {
			order.push(node.element)
			return node.element
		},
		table: (node) => {
			order.push(node.element)
			return node.element
		},
		text: (node) => {
			order.push(node.element)
			return node.element
		},
		emphasis: (node) => {
			order.push(node.element)
			return node.element
		},
		codeSpan: (node) => {
			order.push(node.element)
			return node.element
		},
		break: (node) => {
			order.push(node.element)
			return node.element
		},
		link: (node) => {
			order.push(node.element)
			return node.element
		},
		image: (node) => {
			order.push(node.element)
			return node.element
		},
	}
}

export function createTextHandlers(cells: string[]): MarkdownHandlerMap<string> {
	return {
		document: (_, children) => children.join(''),
		heading: (_, children) => children.join(''),
		paragraph: (_, children) => children.join(''),
		thematicBreak: () => '',
		blockquote: (_, children) => children.join(''),
		codeBlock: () => '',
		list: (_, children) => children.join(''),
		listItem: (_, children) => children.join(''),
		table: (_, children) => {
			cells.push(...children)
			return children.join(',')
		},
		text: (node) => node.value,
		emphasis: (_, children) => children.join(''),
		codeSpan: (node) => node.value,
		break: () => '',
		link: (_, children) => children.join(''),
		image: (_, children) => children.join(''),
	}
}

export function rewrite(node: MarkdownNode): MarkdownNode {
	return node.element === 'text' ? { element: 'text', value: 'X' } : node
}

export function countQuoteDepth(block: BlockNode | undefined): number {
	return block?.element === 'blockquote' ? 1 + countQuoteDepth(block.children[0]) : 0
}

export const HEADING_LEVELS = Object.freeze([1, 2, 3, 4, 5, 6])

export function readQuoteLeaf(
	node: BlockNode | undefined,
	remaining: number,
): BlockNode | undefined {
	return node?.element === 'blockquote' && remaining > 0
		? readQuoteLeaf(node.children[0], remaining - 1)
		: node
}

export function readListChain(node: BlockNode): readonly [BlockNode, number] {
	if (node.element !== 'list') return [node, 0]
	const item = assertListNode(node).items[0]
	if (item === undefined) throw new Error('expected a nested list item')
	const child = item.children[0]
	if (child === undefined) throw new Error('expected nested list content')
	const [leaf, depth] = readListChain(child)
	return [leaf, depth + 1]
}

export function isFabricatedNode(value: unknown): value is MarkdownDocument {
	return typeof value === 'object' && value !== null
}

export function isFabricatedTable(value: unknown): value is TableNode {
	return typeof value === 'object' && value !== null
}

export function narrowFixture<T>(value: unknown, guard: (candidate: unknown) => candidate is T): T {
	if (!guard(value)) throw new Error('fixture did not match the expected fabricated shape')
	return value
}

export const toHTML: MarkdownHandlerMap<string> = {
	document: (_, children) => children.join('\n'),
	heading: (node, children) => `<h${node.level}>${children.join('')}</h${node.level}>`,
	paragraph: (_, children) => `<p>${children.join('')}</p>`,
	thematicBreak: () => '<hr>',
	blockquote: (_, children) => `<blockquote>${children.join('\n')}</blockquote>`,
	codeBlock: (node) => `<pre><code>${node.code}</code></pre>`,
	list: (node, children) =>
		node.ordered ? `<ol>${children.join('')}</ol>` : `<ul>${children.join('')}</ul>`,
	listItem: (_, children) => `<li>${children.join('')}</li>`,
	table: (_, children) => `<table>${children.join('')}</table>`,
	text: (node) => node.value,
	emphasis: (node, children) =>
		node.strong ? `<strong>${children.join('')}</strong>` : `<em>${children.join('')}</em>`,
	codeSpan: (node) => `<code>${node.value}</code>`,
	break: () => '<br>',
	link: (node, children) => `<a href="${node.href}">${children.join('')}</a>`,
	image: (node, children) => `<img src="${node.src}" alt="${children.join('')}">`,
}

export const guideCountHandlers: MarkdownHandlerMap<number> = {
	document: (_, children) => children.reduce((a, b) => a + b, 0),
	heading: (_, children) => 1 + children.reduce((a, b) => a + b, 0),
	paragraph: (_, children) => 1 + children.reduce((a, b) => a + b, 0),
	thematicBreak: () => 1,
	blockquote: (_, children) => 1 + children.reduce((a, b) => a + b, 0),
	codeBlock: () => 1,
	list: (_, children) => 1 + children.reduce((a, b) => a + b, 0),
	listItem: (_, children) => 1 + children.reduce((a, b) => a + b, 0),
	table: (_, children) => 1 + children.reduce((a, b) => a + b, 0),
	text: () => 1,
	emphasis: (_, children) => 1 + children.reduce((a, b) => a + b, 0),
	codeSpan: () => 1,
	break: () => 1,
	link: (_, children) => 1 + children.reduce((a, b) => a + b, 0),
	image: (_, children) => 1 + children.reduce((a, b) => a + b, 0),
}

/** Lists HTML void elements excluded from the balance scan. */
export const VOID_TAGS: ReadonlySet<string> = new Set(['br', 'hr', 'img'])

/** Collects element names opened anywhere in HTML. */
export function collectTags(html: string): ReadonlySet<string> {
	return new Set(
		Iterator.from(html.matchAll(/<([a-z][a-z0-9]*)\b/g))
			.map((match) => match[1])
			.filter((tag) => tag !== undefined),
	)
}

/** Collects element names left open or closed out of order. */
export function collectUnclosedTags(html: string): readonly string[] {
	const open: string[] = []
	for (const match of html.matchAll(/<(\/?)([a-z][a-z0-9]*)\b[^>]*>/g)) {
		const [, slash, tag] = match
		if (tag === undefined || VOID_TAGS.has(tag)) continue
		if (slash === '') open.push(tag)
		else if (open.pop() !== tag) return [tag]
	}
	return open
}

export function isUnknownArray(value: unknown): value is readonly unknown[] {
	return Array.isArray(value)
}

export function isRecordLike(
	value: unknown,
): value is { readonly element: unknown; readonly children: unknown } {
	return typeof value === 'object' && value !== null
}

/** Reads the element discriminant of a node-like value. */
export function readElement(value: unknown): string | undefined {
	if (!isRecordLike(value)) return undefined
	const { element } = value
	return typeof element === 'string' ? element : undefined
}

/** Reads the first child of a node-like value. */
export function readFirstChild(value: unknown): unknown {
	if (!isRecordLike(value)) return undefined
	const { children } = value
	return isUnknownArray(children) ? children[0] : undefined
}

/** Measures the depth of a chain of wrapper elements. */
export function measureChainDepth(value: unknown, wrapper: string): number {
	return readElement(value) === wrapper ? 1 + measureChainDepth(readFirstChild(value), wrapper) : 0
}

/** Reads the innermost node of a wrapper chain. */
export function readChainLeaf(value: unknown, wrapper: string): unknown {
	return readElement(value) === wrapper ? readChainLeaf(readFirstChild(value), wrapper) : value
}

/** Counts non-overlapping token occurrences. */
export function countToken(text: string, token: string): number {
	return text.split(token).length - 1
}

/** Measures leading whitespace. */
export function measureIndent(line: string): number {
	return line.length - line.trimStart().length
}

/** Draws consecutive values from a fresh seeded generator. */
export function drawStream(seed: number): readonly number[] {
	const random = seededRandom(seed)
	return [random(), random(), random()]
}

// ── Case matrices ─────────────────────────────────────────────────────────────

/** Lists block sources and their narrowing functions. */
export const BLOCK_CASES: ReadonlyArray<{
	readonly element: string
	readonly source: string
	readonly narrow: (block: BlockNode) => BlockNode
}> = [
	{ element: 'heading', source: '# h', narrow: assertHeadingNode },
	{ element: 'list', source: '- a', narrow: assertListNode },
	{ element: 'table', source: '| a |\n| --- |\n| 1 |', narrow: assertTableNode },
	{ element: 'paragraph', source: 'para', narrow: assertParagraphNode },
	{ element: 'codeBlock', source: '```\nx\n```', narrow: assertCodeBlockNode },
	{ element: 'blockquote', source: '> q', narrow: assertBlockquoteNode },
]

/** Lists inline sources and their narrowing functions. */
export const INLINE_CASES: ReadonlyArray<{
	readonly element: string
	readonly source: string
	readonly narrow: (node: InlineNode | undefined) => InlineNode
}> = [
	{ element: 'emphasis', source: '*e*', narrow: assertEmphasisNode },
	{ element: 'codeSpan', source: '`c`', narrow: assertCodeSpanNode },
	{ element: 'link', source: '[t](/u)', narrow: assertLinkNode },
]

/** Lists narrowers that accept a missing node. */
export const OPTIONAL_CASES: ReadonlyArray<{
	readonly element: string
	readonly narrow: (node: undefined) => unknown
}> = [
	{ element: 'paragraph', narrow: assertParagraphNode },
	{ element: 'emphasis', narrow: assertEmphasisNode },
	{ element: 'codeSpan', narrow: assertCodeSpanNode },
	{ element: 'link', narrow: assertLinkNode },
]

/** Lists chain builders and their wrapper and leaf elements. */
export const CHAIN_CASES: ReadonlyArray<{
	readonly wrapper: string
	readonly leaf: string
	readonly build: (levels: number) => unknown
}> = [
	{ wrapper: 'emphasis', leaf: 'text', build: buildDeepInlineNode },
	{ wrapper: 'blockquote', leaf: 'paragraph', build: buildDeepBlockNode },
]

/** Supplies projection fields retained by the wrapper. */
export const PROJECTION_PARTS: Partial<MarkdownProjection> = {
	text: 'raw',
	inlines: [{ element: 'text', value: 'x' }],
}

/** Lists HTML elements required in the projection corpus. */
export const PROJECTION_CONSTRUCT_TAGS: readonly string[] = [
	'a',
	'blockquote',
	'br',
	'code',
	'em',
	'h1',
	'hr',
	'img',
	'li',
	'ol',
	'p',
	'pre',
	'strong',
	'table',
	'td',
	'th',
	'tr',
	'ul',
]

export interface Sample {
	readonly name: string
	readonly node: MarkdownNode
	readonly guard: (node: MarkdownNode) => boolean
}

export const samples: readonly Sample[] = [
	{ name: 'heading', node: firstBlock('# H'), guard: isHeadingNode },
	{ name: 'paragraph', node: firstBlock('text'), guard: isParagraphNode },
	{ name: 'list', node: firstBlock('- a'), guard: isListNode },
	{
		name: 'table',
		node: firstBlock('| a | b |\n| --- | --- |\n| 1 | 2 |'),
		guard: isTableNode,
	},
	{ name: 'codeBlock', node: firstBlock('```\ncode\n```'), guard: isCodeBlockNode },
	{ name: 'blockquote', node: firstBlock('> q'), guard: isBlockquoteNode },
	{ name: 'thematicBreak', node: firstBlock('---'), guard: isThematicBreakNode },
	{ name: 'text', node: assertInlineNode('plain'), guard: isTextNode },
	{ name: 'emphasis', node: assertInlineNode('*em*'), guard: isEmphasisNode },
	{ name: 'codeSpan', node: assertInlineNode('`code`'), guard: isCodeSpanNode },
	{ name: 'break', node: { element: 'break' }, guard: isLineBreakNode },
	{ name: 'link', node: assertInlineNode('[t](https://example.com)'), guard: isLinkNode },
	{ name: 'image', node: assertInlineNode('![alt](image.png)'), guard: isImageNode },
]

export const blockCases: ReadonlyArray<{
	readonly markdown: string
	readonly kinds: readonly string[]
}> = [
	{ markdown: 'para\n```\ncode\n```', kinds: ['paragraph', 'codeBlock'] },
	{ markdown: 'para\n---', kinds: ['paragraph', 'thematicBreak'] },
	{ markdown: 'para\n> quote', kinds: ['paragraph', 'blockquote'] },
	{ markdown: 'para\n- item', kinds: ['paragraph', 'list'] },
	{ markdown: 'para\n| a | b |\n| - | - |', kinds: ['paragraph', 'table'] },
]

export const cases = [
	'',
	'   ',
	'\n\n\n',
	'**',
	'`',
	'[',
	'](',
	'| | |',
	'```',
	'> > > deeply nested',
	'#'.repeat(100),
	'*'.repeat(1000), // adversarial run — must stay linear-time (no ReDoS) and not throw
	'[a](javascript:alert(1))',
	'a\0b￿',
]

export function buildWideBlocks(): readonly BlockNode[] {
	return Array.from({ length: 150_000 }, (): BlockNode => ({
		element: 'thematicBreak',
	}))
}

export function buildHTMLChain(): HTMLNode {
	return Array.from({ length: 200 }).reduce<HTMLNode>(
		(child) => ({ category: 'element', name: 'blockquote', attributes: [], children: [child] }),
		{ category: 'text', value: 'leaf' },
	)
}

export function buildWideHTML(): readonly HTMLNode[] {
	return Array.from({ length: 20_000 }, (): HTMLNode => ({
		category: 'element',
		name: 'hr',
		attributes: [],
		children: [],
	}))
}

export function readCapNode(node: BlockNode | undefined): BlockNode | undefined {
	return Array.from({ length: MAX_DEPTH }).reduce<BlockNode | undefined>((block) => {
		if (block === undefined || block.element !== 'blockquote')
			throw new Error('unreachable — chain is a pure blockquote run down to the cap')
		return block.children[0]
	}, node)
}
