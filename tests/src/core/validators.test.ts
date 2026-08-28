// Unit tests for the parser validators. Node guards narrow parsed AST nodes by their
// `element` discriminant; the from-unknown guards (isInlineNode / isBlockNode /
// isMarkdownNode / isMarkdownDocument) validate arbitrary `unknown` input against the
// full AST shape. Every guard is total and returns false for non-matches. The line and
// character structural predicates narrow nothing, so they live in helpers.ts and are
// proved in helpers.test.ts.

import type { MarkdownNode } from '@src/core'
import {
	isBlockNode,
	isBlockquoteNode,
	isCodeBlockNode,
	isCodeSpanNode,
	isEmphasisNode,
	isHeadingNode,
	isImageNode,
	isInlineNode,
	isLineBreakNode,
	isLinkNode,
	isListNode,
	isMarkdownDocument,
	isMarkdownNode,
	isParagraphNode,
	isTableNode,
	isTextNode,
	isThematicBreakNode,
	parseDocument,
} from '@src/core'
import { describe, expect, it } from 'vitest'
import {
	assertInlineNode,
	assertListNode,
	buildCyclicNode,
	buildDeepBlockNode,
	buildDeepInlineNode,
	buildHostileNode,
	firstBlock,
} from '../../setup.js'

interface Sample {
	readonly name: string
	readonly node: MarkdownNode
	readonly guard: (node: MarkdownNode) => boolean
}

const samples: readonly Sample[] = [
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

describe('parser AST validators', () => {
	for (const sample of samples) {
		it(`matches only ${sample.name}`, () => {
			expect(sample.guard(sample.node)).toBe(true)
			for (const other of samples) {
				if (other.name === sample.name) continue
				expect(sample.guard(other.node)).toBe(false)
			}
		})
	}

	it('stays total across the container nodes no guard covers', () => {
		const document = parseDocument('# H')
		const item = assertListNode(firstBlock('- a')).items[0]
		if (item === undefined) throw new Error('expected a list item')
		for (const { guard } of samples) {
			expect(guard(document)).toBe(false)
			expect(guard(item)).toBe(false)
		}
	})
})

describe('from-unknown AST guards: acceptance against a real parsed document', () => {
	const richSource = [
		'# Heading',
		'',
		'A paragraph with *em*, **strong**, `code`, and [a link](https://example.com).',
		'',
		'- one',
		'- two',
		'',
		'| a | b |',
		'| --- | --- |',
		'| 1 | 2 |',
		'',
		'> a quote',
		'',
		'```js',
		'code here',
		'```',
		'',
		'---',
	].join('\n')

	const document = parseDocument(richSource)

	it('accepts the whole document as a MarkdownDocument', () => {
		expect(isMarkdownDocument(document)).toBe(true)
		expect(isMarkdownNode(document)).toBe(true)
	})

	it('accepts every top-level block as a BlockNode and a MarkdownNode, never as an InlineNode', () => {
		expect(document.children.length).toBeGreaterThan(0)
		for (const block of document.children) {
			expect(isBlockNode(block)).toBe(true)
			expect(isMarkdownNode(block)).toBe(true)
			expect(isInlineNode(block)).toBe(false)
		}
	})

	it('accepts inline children of the paragraph as InlineNode and MarkdownNode, never as BlockNode', () => {
		const paragraph = assertInlineNode('plain')
		expect(isInlineNode(paragraph)).toBe(true)
		expect(isMarkdownNode(paragraph)).toBe(true)
		expect(isBlockNode(paragraph)).toBe(false)

		// pull the rich paragraph's inline children (emphasis / strong / codeSpan / link)
		const richParagraph = document.children.find((block): boolean => block.element === 'paragraph')
		if (richParagraph === undefined || !('children' in richParagraph)) {
			throw new Error('expected a paragraph with children')
		}
		for (const inline of richParagraph.children) {
			expect(isInlineNode(inline)).toBe(true)
			expect(isMarkdownNode(inline)).toBe(true)
			expect(isBlockNode(inline)).toBe(false)
		}
	})

	it('accepts a list item as a MarkdownNode but not as a BlockNode or InlineNode', () => {
		const list = assertListNode(firstBlock('- a\n- b'))
		const item = list.items[0]
		if (item === undefined) throw new Error('expected a list item')
		expect(isMarkdownNode(item)).toBe(true)
		expect(isBlockNode(item)).toBe(false)
		expect(isInlineNode(item)).toBe(false)
	})
})

describe('from-unknown AST guards: rejection of non-node values', () => {
	const nonNodes: readonly unknown[] = [
		null,
		undefined,
		0,
		1,
		'',
		'text',
		true,
		false,
		[],
		[1, 2, 3],
		{},
		Symbol('x'),
	]

	const guards: ReadonlyArray<(value: unknown) => boolean> = [
		isInlineNode,
		isBlockNode,
		isMarkdownNode,
		isMarkdownDocument,
	]
	for (const guard of guards) {
		it(`${guard.name} rejects null/undefined/primitives/arrays/empty object`, () => {
			for (const value of nonNodes) {
				expect(guard(value)).toBe(false)
			}
		})
	}
})

describe('from-unknown AST guards: near-miss rejection', () => {
	it('isInlineNode rejects a text node missing its required value field', () => {
		expect(isInlineNode({ element: 'text' })).toBe(false)
	})

	it('isInlineNode rejects an unknown element string', () => {
		expect(isInlineNode({ element: 'bogus', value: 'x' })).toBe(false)
	})

	it('isInlineNode rejects a text node whose value has the wrong field type', () => {
		expect(isInlineNode({ element: 'text', value: 42 })).toBe(false)
	})

	it('isInlineNode rejects a text node with an EXTRA unknown key (recordOf exactness)', () => {
		expect(isInlineNode({ element: 'text', value: 'hi', extra: true })).toBe(false)
	})

	it('accepts exact image and line-break shapes and rejects their near misses', () => {
		expect(
			isInlineNode({
				element: 'image',
				src: 'image.png',
				children: [{ element: 'text', value: 'alt' }],
			}),
		).toBe(true)
		expect(isInlineNode({ element: 'image', children: [] })).toBe(false)
		expect(isInlineNode({ element: 'image', src: 1, children: [] })).toBe(false)
		expect(isInlineNode({ element: 'image', src: 'x', children: 'alt' })).toBe(false)
		expect(isInlineNode({ element: 'break' })).toBe(true)
		expect(isInlineNode({ element: 'break', extra: true })).toBe(false)
	})

	it('isBlockNode rejects a heading missing its required level field', () => {
		expect(isBlockNode({ element: 'heading', children: [] })).toBe(false)
	})

	it('isBlockNode rejects a heading with the wrong field type for level', () => {
		expect(isBlockNode({ element: 'heading', level: '1', children: [] })).toBe(false)
	})

	it('isBlockNode rejects a thematicBreak with an EXTRA unknown key (recordOf exactness)', () => {
		expect(isBlockNode({ element: 'thematicBreak', extra: true })).toBe(false)
	})

	it('isBlockNode accepts a codeBlock without lang (optional) but rejects one with an extra key', () => {
		expect(isBlockNode({ element: 'codeBlock', code: 'x' })).toBe(true)
		expect(isBlockNode({ element: 'codeBlock', code: 'x', extra: true })).toBe(false)
	})

	it('isMarkdownDocument rejects a document missing children', () => {
		expect(isMarkdownDocument({ element: 'document' })).toBe(false)
	})

	it('isMarkdownDocument rejects a document with an EXTRA unknown key (recordOf exactness)', () => {
		expect(isMarkdownDocument({ element: 'document', children: [], extra: true })).toBe(false)
	})

	it('isMarkdownDocument rejects wrong-typed children (not an array of blocks)', () => {
		expect(isMarkdownDocument({ element: 'document', children: 'nope' })).toBe(false)
	})

	it('isMarkdownNode rejects a nested corruption: valid emphasis whose deep child is malformed', () => {
		const corrupted = {
			element: 'emphasis',
			strong: false,
			children: [{ element: 'emphasis', strong: false, children: [{ element: 'text' }] }],
		}
		expect(isInlineNode(corrupted)).toBe(false)
		expect(isMarkdownNode(corrupted)).toBe(false)
	})

	it('isBlockNode rejects nested corruption inside a blockquote child', () => {
		const corrupted = {
			element: 'blockquote',
			children: [{ element: 'paragraph', children: [{ element: 'text', value: 1 }] }],
		}
		expect(isBlockNode(corrupted)).toBe(false)
	})
})

describe('from-unknown AST guards: totality against adversarial input', () => {
	it('returns false, never throws, for a cyclic node', () => {
		const cyclic = buildCyclicNode()
		expect(() => isMarkdownNode(cyclic)).not.toThrow()
		expect(isMarkdownNode(cyclic)).toBe(false)
		expect(() => isInlineNode(cyclic)).not.toThrow()
		expect(isInlineNode(cyclic)).toBe(false)
	})

	it('returns false, never throws, for a cyclic image alternative tree', () => {
		const children: unknown[] = []
		const cyclic = { element: 'image', src: 'x.png', children }
		children.push(cyclic)
		expect(() => isInlineNode(cyclic)).not.toThrow()
		expect(isInlineNode(cyclic)).toBe(false)
	})

	it('returns false, never throws, for image-like records with hostile prototypes', () => {
		const prototype = {
			get element(): string {
				throw new Error('hostile prototype')
			},
		}
		const hostile: unknown = Object.create(prototype)
		expect(() => isInlineNode(hostile)).not.toThrow()
		expect(isInlineNode(hostile)).toBe(false)
	})

	it('returns false, never throws, for a node with throwing getters', () => {
		const hostile = buildHostileNode()
		expect(() => isMarkdownNode(hostile)).not.toThrow()
		expect(isMarkdownNode(hostile)).toBe(false)
		expect(() => isBlockNode(hostile)).not.toThrow()
		expect(isBlockNode(hostile)).toBe(false)
		expect(() => isInlineNode(hostile)).not.toThrow()
		expect(isInlineNode(hostile)).toBe(false)
	})

	it('does not throw on a pathologically deep inline chain, and returns a boolean', () => {
		const deep = buildDeepInlineNode(100000)
		let result: boolean = false
		expect(() => {
			result = isInlineNode(deep)
		}).not.toThrow()
		// Extreme depth may legitimately fail containment (recursion depth cap) -
		// only the no-throw + boolean-return contract is asserted here.
		expect(typeof result).toBe('boolean')
	})

	it('does not throw on a pathologically deep block chain, and returns a boolean', () => {
		const deep = buildDeepBlockNode(100000)
		let result: boolean = false
		expect(() => {
			result = isBlockNode(deep)
		}).not.toThrow()
		// Extreme depth may legitimately fail containment (recursion depth cap) -
		// only the no-throw + boolean-return contract is asserted here.
		expect(typeof result).toBe('boolean')
	})

	it('rejects a modest-depth (10) chain built by buildDeepInlineNode (the fixture omits emphasis`s required `strong` field - it is a stack-safety shape, not a valid-node shape) but still does not throw', () => {
		const modest = buildDeepInlineNode(10)
		expect(() => isInlineNode(modest)).not.toThrow()
		expect(isInlineNode(modest)).toBe(false)
		expect(() => isMarkdownNode(modest)).not.toThrow()
		expect(isMarkdownNode(modest)).toBe(false)
	})

	it('accepts a modest-depth (10) valid block chain', () => {
		const modest = buildDeepBlockNode(10)
		expect(isBlockNode(modest)).toBe(true)
		expect(isMarkdownNode(modest)).toBe(true)
	})
})

describe('parse <-> guard consistency', () => {
	it('for real parsed nodes, isMarkdownNode implies the matching narrowing guard also matches', () => {
		for (const sample of samples) {
			expect(isMarkdownNode(sample.node)).toBe(true)
			expect(sample.guard(sample.node)).toBe(true)
		}
	})

	it('the document root satisfies isMarkdownDocument and isMarkdownNode together', () => {
		const document = parseDocument('# H\n\ntext')
		expect(isMarkdownDocument(document)).toBe(true)
		expect(isMarkdownNode(document)).toBe(true)
		expect(isBlockNode(document)).toBe(false)
		expect(isInlineNode(document)).toBe(false)
	})
})
