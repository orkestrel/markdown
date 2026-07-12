import {
	createCodeBlockContract,
	createCodeSpanContract,
	createMarkdown,
	createTextContract,
	createThematicBreakContract,
	parseDocument,
	parseInline,
	renderHTML,
} from '@src/core'
import { seededRandom } from '@orkestrel/contract'
import { describe, expect, it } from 'vitest'
import {
	assertCodeBlockNode,
	assertCodeSpanNode,
	assertInlineNode,
	assertParagraphNode,
	firstBlock,
	TEST_SEED,
} from '../../setup.js'

// This file covers createMarkdown (returns a working MarkdownInterface)
// plus the four node-contract factories — createTextContract, createCodeSpanContract,
// createCodeBlockContract, and createThematicBreakContract. Full parse/render behavior
// lives in Markdown.test.ts; shape-level coverage of the node contracts lives in
// shapers.test.ts; here we assert each factory hands back a usable handle.

describe('createMarkdown', () => {
	it('returns a working MarkdownInterface (markdown → AST)', () => {
		const markdown = createMarkdown('# Title\n\nA **bold** word.')

		expect(markdown.document.element).toBe('document')
		expect(markdown.document.children[0]?.element).toBe('heading')
		expect(markdown.document.children[1]?.element).toBe('paragraph')
	})

	it('renders an AST to safe HTML (text escaped, href sanitized)', () => {
		const markdown = createMarkdown('[x](javascript:alert(1)) <b>')
		const html = renderHTML(markdown.document)

		expect(html).toContain('<a href="">x</a>')
		expect(html).toContain('&lt;b&gt;')
		expect(html).not.toContain('javascript:')
	})

	it('parses inline content alone via parseInline', () => {
		const nodes = parseInline('a `code` and *em*')

		expect(nodes.map((node) => node.element)).toEqual(['text', 'codeSpan', 'text', 'emphasis'])
	})

	it('is total — malformed markdown degrades without throwing', () => {
		expect(() => renderHTML(createMarkdown('**[`').document)).not.toThrow()
	})

	it('hands back independent handles (stateless reuse is consistent)', () => {
		const first = createMarkdown('# A')
		const second = createMarkdown('# A')

		expect(renderHTML(first.document)).toBe(renderHTML(second.document))
	})

	it('accepts an already-parsed MarkdownDocument and returns independent instances', () => {
		const document = parseDocument('# A')
		const first = createMarkdown(document)
		const second = createMarkdown(document)

		expect(first.document).toEqual(second.document)
		expect(first).not.toBe(second)
	})
})

// Each createXContract factory compiles its shape into a working
// ContractInterface (AGENTS §14). Full shape behavior (guard/schema/parse/
// generate parity) lives in shapers.test.ts — here we assert the factory
// hands back a usable, independent contract, and that a REAL parser-produced
// leaf node is accepted by its own contract's guard (structural, not a
// hand-built fixture).

describe('createTextContract', () => {
	it('returns a working TextNode contract', () => {
		const contract = createTextContract()

		expect(contract.is({ element: 'text', value: 'hi' })).toBe(true)
		expect(contract.parse({ element: 'text', value: 'hi' })).toEqual({
			element: 'text',
			value: 'hi',
		})
		expect(contract.schema.type).toBe('object')
		expect(contract.is(contract.generate(seededRandom(TEST_SEED)))).toBe(true)
	})

	it('accepts a real parser-produced TextNode', () => {
		const node = assertInlineNode('hello')
		expect(createTextContract().is(node)).toBe(true)
	})

	it('returns independent instances (schema equal, not shared state)', () => {
		const first = createTextContract()
		const second = createTextContract()

		expect(first.schema).toEqual(second.schema)
		expect(first).not.toBe(second)
	})
})

describe('createCodeSpanContract', () => {
	it('returns a working CodeSpanNode contract', () => {
		const contract = createCodeSpanContract()

		expect(contract.is({ element: 'codeSpan', value: 'x' })).toBe(true)
		expect(contract.parse({ element: 'codeSpan', value: 'x' })).toEqual({
			element: 'codeSpan',
			value: 'x',
		})
		expect(contract.schema.type).toBe('object')
		expect(contract.is(contract.generate(seededRandom(TEST_SEED)))).toBe(true)
	})

	it('accepts a real parser-produced CodeSpanNode', () => {
		const paragraph = assertParagraphNode(firstBlock('a `code` b'))
		const node = assertCodeSpanNode(paragraph.children[1])

		expect(createCodeSpanContract().is(node)).toBe(true)
	})

	it('returns independent instances (schema equal, not shared state)', () => {
		const first = createCodeSpanContract()
		const second = createCodeSpanContract()

		expect(first.schema).toEqual(second.schema)
		expect(first).not.toBe(second)
	})
})

describe('createCodeBlockContract', () => {
	it('returns a working CodeBlockNode contract', () => {
		const contract = createCodeBlockContract()

		expect(contract.is({ element: 'codeBlock', code: 'x' })).toBe(true)
		expect(contract.is({ element: 'codeBlock', code: 'x', lang: 'ts' })).toBe(true)
		expect(contract.schema.type).toBe('object')
		expect(contract.is(contract.generate(seededRandom(TEST_SEED)))).toBe(true)
	})

	it('accepts a real parser-produced CodeBlockNode with a language', () => {
		const node = assertCodeBlockNode(firstBlock('```ts\nconst x = 1\n```'))

		expect(node.lang).toBe('ts')
		expect(createCodeBlockContract().is(node)).toBe(true)
	})

	it('accepts a real parser-produced CodeBlockNode without a language', () => {
		const node = assertCodeBlockNode(firstBlock('```\nconst x = 1\n```'))

		expect(node.lang).toBeUndefined()
		expect(createCodeBlockContract().is(node)).toBe(true)
	})

	it('returns independent instances (schema equal, not shared state)', () => {
		const first = createCodeBlockContract()
		const second = createCodeBlockContract()

		expect(first.schema).toEqual(second.schema)
		expect(first).not.toBe(second)
	})
})

describe('createThematicBreakContract', () => {
	it('returns a working ThematicBreakNode contract', () => {
		const contract = createThematicBreakContract()

		expect(contract.is({ element: 'thematicBreak' })).toBe(true)
		expect(contract.parse({ element: 'thematicBreak' })).toEqual({ element: 'thematicBreak' })
		expect(contract.schema.type).toBe('object')
		expect(contract.is(contract.generate(seededRandom(TEST_SEED)))).toBe(true)
	})

	it('accepts a real parser-produced ThematicBreakNode', () => {
		const node = firstBlock('---')

		expect(node.element).toBe('thematicBreak')
		expect(createThematicBreakContract().is(node)).toBe(true)
	})

	it('returns independent instances (schema equal, not shared state)', () => {
		const first = createThematicBreakContract()
		const second = createThematicBreakContract()

		expect(first.schema).toEqual(second.schema)
		expect(first).not.toBe(second)
	})
})
