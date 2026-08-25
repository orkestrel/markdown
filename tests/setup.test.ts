import type { BlockNode, InlineNode, MarkdownProjection } from '@src/core'
import { createProjection, flattenText, htmlToMarkdown } from '@src/core'
import { parseDocument as parseHTML } from '@orkestrel/html'
import { seededRandom } from '@orkestrel/contract'
import { describe, expect, it } from 'vitest'
import {
	MARKDOWN_FIXPOINT_CORPUS,
	PROJECTION_CORPUS,
	TEST_SEED,
	assertBlockquoteNode,
	assertCodeBlockNode,
	assertCodeSpanNode,
	assertEmphasisNode,
	assertHeadingNode,
	assertInlineNode,
	assertLinkNode,
	assertListNode,
	assertParagraphNode,
	assertTableNode,
	buildCyclicNode,
	buildDeepBlockNode,
	buildDeepEmphasisInput,
	buildDeepInlineNode,
	buildDeepListInput,
	buildDeepQuoteInput,
	buildHostileNode,
	buildProjection,
	firstBlock,
	inlineText,
	isBrowserVuePath,
	projectHTML,
} from './setup.js'

// The subject is `tests/setup.ts` — the behavior this workspace's suites import from it,
// and nothing else. Production behavior reached through those helpers (the parser, the
// guards, `flattenText`, `htmlToMarkdown`, `createProjection`) is proved by the `src:core`
// suites; asserting it again here would move that proof to the wrong project. So each case
// below names a contract the setup module itself owns: what a helper returns, what it
// refuses, the shape a builder emits, and the invariants a data table's consumers rely on.
//
// Every expectation is derived by a route the module cannot share — string scanning over a
// builder's output, tag scanning over a corpus entry, parity arithmetic over a requested
// depth, or the production call the wrapper is claimed to compose. The case matrices sit at
// module scope here rather than in a setup module because the setup module is the subject.

// ── Derivation helpers ────────────────────────────────────────────────────────
// The second route each expectation is measured by. None of them import the module
// under proof, and none of them reproduce its implementation.

/** HTML element names that carry no closing tag, excluded from the balance scan. */
const VOID_TAGS: ReadonlySet<string> = new Set(['br', 'hr', 'img'])

/** Every element name opened anywhere in `html`, in no particular order. */
function collectTags(html: string): ReadonlySet<string> {
	const tags = new Set<string>()
	for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b/g)) {
		const [, tag] = match
		if (tag !== undefined) tags.add(tag)
	}
	return tags
}

/** Element names left open (or closed out of order) at the end of `html`. */
function collectUnclosedTags(html: string): readonly string[] {
	const open: string[] = []
	for (const match of html.matchAll(/<(\/?)([a-z][a-z0-9]*)\b[^>]*>/g)) {
		const [, slash, tag] = match
		if (tag === undefined || VOID_TAGS.has(tag)) continue
		if (slash === '') open.push(tag)
		else if (open.pop() !== tag) return [tag]
	}
	return open
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
	return Array.isArray(value)
}

function isRecordLike(
	value: unknown,
): value is { readonly element: unknown; readonly children: unknown } {
	return typeof value === 'object' && value !== null
}

/** The `element` discriminant of a node-like value, or `undefined` when it carries none. */
function readElement(value: unknown): string | undefined {
	if (!isRecordLike(value)) return undefined
	const { element } = value
	return typeof element === 'string' ? element : undefined
}

/** The first entry of a node-like value's `children`, or `undefined` when it has none. */
function readFirstChild(value: unknown): unknown {
	if (!isRecordLike(value)) return undefined
	const { children } = value
	return isUnknownArray(children) ? children[0] : undefined
}

/** How many `wrapper`-element hops separate `value` from the first node that is not one. */
function measureChainDepth(value: unknown, wrapper: string): number {
	let node = value
	let depth = 0
	while (readElement(node) === wrapper) {
		node = readFirstChild(node)
		depth += 1
	}
	return depth
}

/** The innermost node of a `wrapper`-element chain. */
function readChainLeaf(value: unknown, wrapper: string): unknown {
	let node = value
	while (readElement(node) === wrapper) node = readFirstChild(node)
	return node
}

/** Count non-overlapping occurrences of `token` in `text`. */
function countToken(text: string, token: string): number {
	return text.split(token).length - 1
}

/** The leading spaces of `line`. */
function measureIndent(line: string): number {
	return line.length - line.trimStart().length
}

/** Three consecutive draws from a fresh generator seeded with `seed`. */
function drawStream(seed: number): readonly number[] {
	const random = seededRandom(seed)
	return [random(), random(), random()]
}

// ── Case matrices ─────────────────────────────────────────────────────────────

/** One markdown source per block element the `assert{Element}Node` family narrows to. */
const BLOCK_CASES: ReadonlyArray<{
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

/** One markdown snippet per inline element the `assert{Element}Node` family narrows to. */
const INLINE_CASES: ReadonlyArray<{
	readonly element: string
	readonly source: string
	readonly narrow: (node: InlineNode | undefined) => InlineNode
}> = [
	{ element: 'emphasis', source: '*e*', narrow: assertEmphasisNode },
	{ element: 'codeSpan', source: '`c`', narrow: assertCodeSpanNode },
	{ element: 'link', source: '[t](/u)', narrow: assertLinkNode },
]

/** The family members that accept a missing node instead of requiring one. */
const OPTIONAL_CASES: ReadonlyArray<{
	readonly element: string
	readonly narrow: (node: undefined) => unknown
}> = [
	{ element: 'paragraph', narrow: assertParagraphNode },
	{ element: 'emphasis', narrow: assertEmphasisNode },
	{ element: 'codeSpan', narrow: assertCodeSpanNode },
	{ element: 'link', narrow: assertLinkNode },
]

/** The chain builders, with the element each wraps with and the element each bottoms out at. */
const CHAIN_CASES: ReadonlyArray<{
	readonly wrapper: string
	readonly leaf: string
	readonly build: (levels: number) => unknown
}> = [
	{ wrapper: 'emphasis', leaf: 'text', build: buildDeepInlineNode },
	{ wrapper: 'blockquote', leaf: 'paragraph', build: buildDeepBlockNode },
]

/** A partial projection whose fields must survive the wrapper unchanged. */
const PROJECTION_PARTS: Partial<MarkdownProjection> = {
	text: 'raw',
	inlines: [{ element: 'text', value: 'x' }],
}

/** Every HTML element the projection corpus must carry an entry for. */
const PROJECTION_CONSTRUCT_TAGS: readonly string[] = [
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

describe('the assert{Element}Node narrowing family', () => {
	it('hands back the very node it was given when the element matches', () => {
		for (const testCase of BLOCK_CASES) {
			const block = firstBlock(testCase.source)
			expect(block.element).toBe(testCase.element)
			expect(testCase.narrow(block)).toBe(block)
		}
		for (const testCase of INLINE_CASES) {
			const node = assertInlineNode(testCase.source)
			expect(node.element).toBe(testCase.element)
			expect(testCase.narrow(node)).toBe(node)
		}
	})

	it('refuses a node of another element and names the element it found', () => {
		const heading = firstBlock('# h')
		const paragraph = firstBlock('para')
		for (const testCase of BLOCK_CASES) {
			const wrong = testCase.element === 'heading' ? paragraph : heading
			expect(() => testCase.narrow(wrong)).toThrow(
				`expected ${testCase.element}, got ${wrong.element}`,
			)
		}
		const text = assertInlineNode('plain')
		for (const testCase of INLINE_CASES) {
			expect(() => testCase.narrow(text)).toThrow(`expected ${testCase.element}, got text`)
		}
	})

	it('refuses a missing node instead of reading through it', () => {
		for (const testCase of OPTIONAL_CASES) {
			expect(() => testCase.narrow(undefined)).toThrow(
				`expected ${testCase.element}, got undefined`,
			)
		}
	})
})

describe('firstBlock', () => {
	it('returns the leading block rather than any later one', () => {
		expect(firstBlock('# h\n\npara').element).toBe('heading')
		expect(firstBlock('para\n\n# h').element).toBe('paragraph')
	})

	it('refuses a source that yields no block', () => {
		expect(() => firstBlock('')).toThrow('expected at least one block')
		expect(() => firstBlock('   ')).toThrow('expected at least one block')
	})
})

describe('assertInlineNode', () => {
	it('unwraps the paragraph and returns its leading inline node', () => {
		// The snippet's leading run is the text `a `, so the emphasis that follows it
		// must not be what comes back.
		expect(flattenText(assertInlineNode('a *b*'))).toBe('a ')
		expect(assertInlineNode('a *b*').element).toBe('text')
		expect(assertInlineNode('*b* a').element).toBe('emphasis')
	})

	it('refuses a snippet that parses to no block at all', () => {
		expect(() => assertInlineNode('')).toThrow('expected at least one block')
	})
})

describe('inlineText', () => {
	it('joins the nodes in order with nothing between them', () => {
		const nodes = assertParagraphNode(firstBlock('a *b* c')).children
		const parts = nodes.map((node) => flattenText(node))
		expect(parts).toEqual(['a ', 'b', ' c'])
		expect(inlineText(nodes)).toBe('a b c')
		expect(inlineText(nodes)).toBe(parts.join(''))
		expect(inlineText([...nodes].reverse())).toBe(' cba ')
	})

	it('returns the empty string for no nodes', () => {
		expect(inlineText([])).toBe('')
	})
})

describe('projectHTML', () => {
	it('applies the HTML parse and the markdown projection, in that order', () => {
		for (const entry of PROJECTION_CORPUS) {
			expect(projectHTML(entry.html)).toEqual(htmlToMarkdown(parseHTML(entry.html)))
		}
	})
})

describe('buildProjection', () => {
	it('carries the given parts through and defaults every field it was not given', () => {
		expect(buildProjection(PROJECTION_PARTS)).toEqual(createProjection(PROJECTION_PARTS))
		expect(buildProjection({})).toEqual(createProjection({}))
		expect(Object.keys(buildProjection(PROJECTION_PARTS))).toEqual(
			Object.keys(createProjection({})),
		)
	})
})

describe('MARKDOWN_FIXPOINT_CORPUS', () => {
	it('names and sources every entry uniquely, so each registers its own case', () => {
		const names = MARKDOWN_FIXPOINT_CORPUS.map((entry) => entry.name)
		const sources = MARKDOWN_FIXPOINT_CORPUS.map((entry) => entry.source)
		expect(MARKDOWN_FIXPOINT_CORPUS.length).toBeGreaterThan(0)
		expect(new Set(names).size).toBe(names.length)
		expect(new Set(sources).size).toBe(sources.length)
		expect(names.every((name) => name.length > 0)).toBe(true)
	})

	it('carries both emphasis marker families in every entry, which is the parity law it anchors', () => {
		for (const entry of MARKDOWN_FIXPOINT_CORPUS) {
			expect(entry.source).toContain('*')
			expect(entry.source).toContain('_')
			expect(entry.rendered).toContain('*')
			expect(entry.rendered).toContain('_')
		}
	})
})

describe('PROJECTION_CORPUS', () => {
	it('names and sources every entry uniquely, so each registers its own case', () => {
		const names = PROJECTION_CORPUS.map((entry) => entry.name)
		const fragments = PROJECTION_CORPUS.map((entry) => entry.html)
		expect(PROJECTION_CORPUS.length).toBeGreaterThan(0)
		expect(new Set(names).size).toBe(names.length)
		expect(new Set(fragments).size).toBe(fragments.length)
		expect(names.every((name) => name.length > 0)).toBe(true)
	})

	it('covers every construct the projection can emit', () => {
		const tags = collectTags(PROJECTION_CORPUS.map((entry) => entry.html).join(''))
		const missing = PROJECTION_CONSTRUCT_TAGS.filter((tag) => !tags.has(tag))
		expect(missing).toEqual([])
	})

	it('closes every element it opens, so the entries concatenate into one document', () => {
		// The anchor law also runs over the whole corpus joined as a single fragment. An
		// entry left open there would take its neighbour's content into its own subtree.
		for (const entry of PROJECTION_CORPUS) {
			expect(collectUnclosedTags(entry.html)).toEqual([])
		}
		expect(collectUnclosedTags(PROJECTION_CORPUS.map((entry) => entry.html).join(''))).toEqual([])
	})
})

describe('the adversarial node builders', () => {
	it('builds a node whose children array holds the node itself', () => {
		const node = buildCyclicNode()
		expect(readElement(node)).toBe('emphasis')
		expect(readFirstChild(node)).toBe(node)
	})

	it('builds a node that throws from each property a guard inspects', () => {
		const node = buildHostileNode()
		expect(() => readElement(node)).toThrow('hostile getter')
		expect(() => readFirstChild(node)).toThrow('hostile getter')
	})

	it('nests exactly the requested number of levels and bottoms out at its leaf', () => {
		for (const chain of CHAIN_CASES) {
			for (const levels of [0, 1, 7]) {
				const node = chain.build(levels)
				expect(measureChainDepth(node, chain.wrapper)).toBe(levels)
				expect(readElement(readChainLeaf(node, chain.wrapper))).toBe(chain.leaf)
			}
		}
	})
})

describe('the deep markdown source builders', () => {
	it('repeats the blockquote marker once per level and ends with the text', () => {
		for (const levels of [0, 1, 5]) {
			const source = buildDeepQuoteInput(levels, 'tail')
			expect(countToken(source, '> ')).toBe(levels)
			expect(source.endsWith('tail')).toBe(true)
			expect(source.length).toBe(levels * 2 + 'tail'.length)
		}
	})

	it('emits one list line per level, indenting two spaces further each time', () => {
		expect(buildDeepListInput(0)).toBe('')
		for (const levels of [1, 5]) {
			const lines = buildDeepListInput(levels, 'tail').split('\n')
			expect(lines.length).toBe(levels)
			lines.forEach((line, index) => {
				expect(measureIndent(line)).toBe(index * 2)
				expect(line.trimStart().startsWith('- ')).toBe(true)
				expect(line.endsWith('tail')).toBe(index === levels - 1)
			})
		}
	})

	it('alternates the emphasis and link wrappers outward from the text', () => {
		for (const levels of [0, 1, 2, 7]) {
			const source = buildDeepEmphasisInput(levels, 'tail')
			// Emphasis wraps the even depths and a link wraps the odd ones, counting
			// outward from the text.
			expect(countToken(source, '*')).toBe(2 * Math.ceil(levels / 2))
			expect(countToken(source, '](url)')).toBe(Math.floor(levels / 2))
			expect(source).toContain('tail')
		}
	})

	it('defaults the text to leaf', () => {
		expect(buildDeepQuoteInput(1)).toBe('> leaf')
		expect(buildDeepListInput(1)).toBe('- leaf')
		expect(buildDeepEmphasisInput(1)).toBe('*leaf*')
	})
})

describe('isBrowserVuePath', () => {
	it('accepts a browser SFC path written with either separator family', () => {
		expect(isBrowserVuePath('app/browser/App.vue')).toBe(true)
		expect(isBrowserVuePath('app\\browser\\App.vue')).toBe(true)
		expect(isBrowserVuePath('app/browser/views/Home.vue')).toBe(true)
		expect(isBrowserVuePath('app\\browser\\views\\Home.vue')).toBe(true)
	})

	it('refuses a sibling environment and a prefix lookalike', () => {
		expect(isBrowserVuePath('app/core/App.vue')).toBe(false)
		expect(isBrowserVuePath('app/server/App.vue')).toBe(false)
		expect(isBrowserVuePath('app/browserish/App.vue')).toBe(false)
		expect(isBrowserVuePath('src/browser/App.vue')).toBe(false)
		expect(isBrowserVuePath('vendor/app/browser/App.vue')).toBe(false)
	})
})

describe('TEST_SEED', () => {
	it('reproduces one stream across calls and diverges from its neighbour', () => {
		// `tests/src/core/shapers.test.ts` asserts a contract generates the same value
		// twice from this seed and a different value from `TEST_SEED + 1`, so the seed
		// itself has to hold both properties.
		expect(drawStream(TEST_SEED)).toEqual(drawStream(TEST_SEED))
		expect(drawStream(TEST_SEED)).not.toEqual(drawStream(TEST_SEED + 1))
	})
})
